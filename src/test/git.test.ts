import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli, splitRemoteRef } from '../git';
import { layout } from '../graph';

// Integration tests against a real throwaway repository with a bare "remote".
let tmp: string;
let dir: string;
let git: GitCli;
const env = { ...process.env, GIT_EDITOR: ':', GIT_CONFIG_NOSYSTEM: '1' };
const g = (...args: string[]) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
const commit = (file: string, msg: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), msg + '\n', { flag: 'a' });
  g('add', '.');
  g('commit', '-q', '-m', msg);
};
const subjects = (r: { commits: { subject: string }[] }) => r.commits.map(c => c.subject);

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-test-'));
  dir = path.join(tmp, 'repo');
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(dir);
  cp.execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'Tester');
  g('config', 'core.autocrlf', 'false');
  commit('README.md', 'init');
  commit('src/panelView.js', 'add panel view');
  commit('lib/util.js', 'utils');
  g('remote', 'add', 'origin', bare);
  g('push', '-q', '-u', 'origin', 'main');
  g('remote', 'set-head', 'origin', 'main');
  g('tag', '-a', 'v1.9', '-m', 'release 1.9');
  g('tag', 'v1.10');
  g('push', '-q', 'origin', 'v1.9');
  // stack: main <- s1 <- s2, HEAD on s1
  g('checkout', '-q', '-b', 's1');
  commit('s1.txt', 's1 a');
  commit('s1.txt', 's1 b');
  g('checkout', '-q', '-b', 's2');
  commit('s2.txt', 's2 a');
  g('checkout', '-q', 's1');
  git = new GitCli('git', dir);
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows sometimes keeps a handle open for a moment; the OS cleans temp eventually.
  }
});

test('refs: remotes, annotated and lightweight tags, branch metadata', async () => {
  const refs = await git.refs();
  assert.equal(refs.remoteInfo[0].name, 'origin');
  assert.match(refs.remoteInfo[0].fetchUrl, /remote\.git$/);
  const v19 = refs.tags.find(t => t.name === 'v1.9');
  assert.equal(v19?.annotated, true);
  assert.equal(v19?.message, 'release 1.9');
  assert.equal(refs.tags.find(t => t.name === 'v1.10')?.annotated, false);
  const s1 = refs.local.find(b => b.name === 's1');
  assert.ok(s1?.isHead && s1.worktree && s1.date > 0);
});

test('remoteTags peels annotated tags', async () => {
  const refs = await git.refs();
  const rt = await git.remoteTags('origin');
  assert.equal(rt['v1.9'], refs.tags.find(t => t.name === 'v1.9')?.sha);
  assert.ok(!('v1.10' in rt));
});

test('defaultBase and stack', async () => {
  const base = await git.defaultBase('');
  assert.equal(base, 'origin/main');
  const stack = await git.stack(base!);
  assert.deepEqual(stack, [
    { name: 's1', count: 2 },
    { name: 's2', count: 3 },
  ]);
  assert.deepEqual(await git.mergedInto(base!), ['main']);
});

test('defaultBase is cached per configured value and re-checked', async () => {
  assert.equal(await git.defaultBase('main'), 'main');
  assert.equal(await git.defaultBase(''), 'origin/main');
  assert.equal(await git.defaultBase('does-not-exist'), 'origin/main');
});

test('splitRemoteRef prefers the longest remote name', () => {
  assert.deepEqual(splitRemoteRef('origin/feature/x', ['origin']), { remote: 'origin', branch: 'feature/x' });
  assert.deepEqual(splitRemoteRef('team/a/b', ['team', 'team/a']), { remote: 'team/a', branch: 'b' });
  assert.equal(splitRemoteRef('other/x', ['origin']), null);
});

test('rangeCommits and mergeCount', async () => {
  const commits = await git.rangeCommits('main..s2');
  assert.deepEqual(commits.map(c => c.subject), ['s1 a', 's1 b', 's2 a']);
  assert.equal(commits[0].author, 'Tester');
  assert.match(commits[0].hash, /^[0-9a-f]{40}$/);
  assert.equal(await git.mergeCount('main..s2'), 0);
});

test('search: file names, folders, exact paths, any, message, pickaxe', async () => {
  const q = (kind: 'any' | 'path' | 'message' | 'pickaxe', value: string, exact = false) => git.log({ limit: 50, all: true, query: { kind, value, exact } });
  assert.deepEqual(subjects(await q('path', 'PANEL')), ['add panel view']);
  assert.ok(subjects(await q('path', 'lib')).includes('utils'));
  assert.deepEqual(subjects(await q('path', 's1.txt', true)), ['s1 b', 's1 a']);
  assert.ok(subjects(await q('any', 'util')).includes('utils'));
  assert.ok((await q('any', 'tester')).commits.length >= 6);
  assert.deepEqual(subjects(await q('message', 'S1 A')), ['s1 a']);
  assert.deepEqual(subjects(await q('pickaxe', 's2 a')), ['s2 a']);
});

test('search results draw as one lane', async () => {
  const r = await git.log({ limit: 50, all: true, query: { kind: 'path', value: 'txt' } });
  const linear = r.commits.map((c, i, a) => ({ ...c, graphParents: a[i + 1] ? [a[i + 1].hash] : [] }));
  assert.equal(layout(linear).maxLanes, 1);
});

test('blame, including unsaved contents', async () => {
  const head = g('rev-parse', 'HEAD').trim();
  assert.equal(await git.blameLine('s1.txt', 2), head);
  assert.equal(await git.blameLine('s1.txt', 3, 's1 a\ns1 b\nnew line\n'), null);
});

test('worktrees', async () => {
  const wtPath = path.join(tmp, 'repo-s2');
  g('worktree', 'add', '-q', wtPath, 's2');
  try {
    const wts = await git.worktrees();
    assert.equal(wts.length, 2);
    assert.equal(wts[1].branch, 's2');
    assert.ok((await git.refs()).local.find(b => b.name === 's2')?.worktree?.toLowerCase().includes('repo-s2'));
  } finally {
    g('worktree', 'remove', wtPath);
  }
});

test('reflog has selectors and dates', async () => {
  const rl = await git.reflog(10);
  assert.ok(rl.length > 3);
  assert.deepEqual(rl.slice(0, 3).map(e => e.selector), ['HEAD@{0}', 'HEAD@{1}', 'HEAD@{2}']);
  assert.ok(rl.every(e => e.date > 1e9 && /^[0-9a-f]{40}$/.test(e.hash) && e.action));
});

test('rebase with a prepared todo (reorder, reword) and opState on conflict', async () => {
  g('checkout', '-q', '-b', 'rb', 'main');
  commit('r1.txt', 'r1');
  commit('r2.txt', 'r2');
  const [r1, r2] = g('log', '--reverse', '--format=%H', 'main..HEAD').trim().split('\n');
  const work = fs.mkdtempSync(path.join(tmp, 'todo-'));
  const fwd = (p: string) => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(work, 'msg.txt'), 'R2 reworded');
  fs.writeFileSync(path.join(work, 'todo'), [`pick ${r2} r2`, `exec git commit --amend --only --allow-empty --no-verify -F '${fwd(work)}/msg.txt'`, `pick ${r1} r1`, ''].join('\n'));
  await git.run(['rebase', '-i', 'main'], { env: { GIT_SEQUENCE_EDITOR: `cp '${fwd(path.join(work, 'todo'))}'`, GIT_EDITOR: ':' } });
  assert.deepEqual(g('log', '--format=%s', 'main..HEAD').trim().split('\n'), ['r1', 'R2 reworded']);

  g('checkout', '-q', 'main');
  commit('r1.txt', 'conflicting');
  g('checkout', '-q', 'rb');
  await assert.rejects(git.run(['rebase', 'main'], { env: { GIT_EDITOR: ':' } }));
  const op = await git.opState();
  assert.equal(op?.kind, 'rebase');
  assert.deepEqual(op?.conflicts, ['r1.txt']);
  await git.run(['rebase', '--abort']);
  assert.equal(await git.opState(), null);
});

test('reword after a stopped step reads its message file from the git dir on --continue', async () => {
  g('checkout', '-q', '-b', 'rb2', 'main');
  commit('e1.txt', 'e1');
  commit('e2.txt', 'e2');
  const [e1, e2] = g('log', '--reverse', '--format=%H', 'main..HEAD').trim().split('\n');
  const work = path.join(await git.gitDir(), 'gitst8-rebase');
  fs.mkdirSync(work, { recursive: true });
  const fwd = (p: string) => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(work, 'msg-1.txt'), 'E2 reworded');
  fs.writeFileSync(path.join(work, 'todo'), [`edit ${e1} e1`, `pick ${e2} e2`, `exec git commit --amend --only --allow-empty --no-verify -F '${fwd(work)}/msg-1.txt'`, ''].join('\n'));
  await git.run(['rebase', '-i', 'main'], { env: { GIT_SEQUENCE_EDITOR: `cp '${fwd(path.join(work, 'todo'))}'`, GIT_EDITOR: ':' } });
  assert.equal((await git.opState())?.kind, 'rebase'); // stopped at "edit"
  await git.run(['rebase', '--continue'], { env: { GIT_EDITOR: ':' } });
  assert.deepEqual(g('log', '--format=%s', 'main..HEAD').trim().split('\n'), ['E2 reworded', 'e1']);
  fs.rmSync(work, { recursive: true, force: true });
});
