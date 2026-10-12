import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../git';
import { authorArgs, buildFilterArgs, keepsGraph, normalizeFilter } from '../logFilter';
import { mapSignature } from '../signature';

test('buildFilterArgs: maps every field', () => {
  const r = buildFilterArgs(
    { author: 'ann', since: '2.weeks.ago', until: '2026-01-01', message: 'fix', paths: ['a/b', 'c.txt'], refs: ['main', 'origin/dev'], noMerges: true, firstParent: true, mine: true },
    'me@x.io'
  );
  assert.deepEqual(r.args, ['--since=2.weeks.ago', '--until=2026-01-01', '--grep=fix', '--regexp-ignore-case', '--no-merges', '--first-parent']);
  assert.deepEqual(r.authors, ['ann']);
  assert.deepEqual(r.emails, ['me@x.io']);
  assert.deepEqual(r.pathspec, ['a/b', 'c.txt']);
  assert.deepEqual(r.refs, ['main', 'origin/dev']);
});

test('authorArgs: one pattern is a plain --author, several are AND-ed via PCRE', () => {
  assert.deepEqual(authorArgs([], []), []);
  assert.deepEqual(authorArgs(['ann'], []), ['--author=ann']);
  assert.deepEqual(authorArgs([], ['me@x.io']), ['--author=<me@x\\.io>']);
  assert.deepEqual(authorArgs(['ann'], ['me@x.io']), ['--perl-regexp', '--author=^(?=.*ann)(?=.*<me\\@x\\.io>)']);
});

test('buildFilterArgs: empty filter adds nothing', () => {
  assert.deepEqual(buildFilterArgs(null), { args: [], pathspec: [], refs: [], authors: [], emails: [] });
  assert.deepEqual(buildFilterArgs({}), { args: [], pathspec: [], refs: [], authors: [], emails: [] });
});

test('normalizeFilter: trims, drops empties, refuses option-like values', () => {
  assert.equal(normalizeFilter({ author: ' ', paths: [] }), null);
  assert.deepEqual(normalizeFilter({ author: ' ann ', paths: ['x', ' '], noMerges: true, mine: false }), { author: 'ann', paths: ['x'], noMerges: true });
  assert.throws(() => normalizeFilter({ since: '--output=/tmp/x' }));
  assert.throws(() => normalizeFilter({ refs: ['--all'] }));
  assert.throws(() => normalizeFilter({ author: '-x' }));
  assert.throws(() => buildFilterArgs({ until: '-1' }));
});

test('keepsGraph: only branch/parent filters keep the real graph', () => {
  assert.equal(keepsGraph(null), true);
  assert.equal(keepsGraph({ refs: ['main'], noMerges: true, firstParent: true }), true);
  for (const f of [{ author: 'a' }, { since: 'x' }, { until: 'x' }, { message: 'x' }, { paths: ['p'] }, { mine: true }]) assert.equal(keepsGraph(f), false);
});

test('mapSignature: every %G? code', () => {
  assert.deepEqual(mapSignature('G', 'Ann <a@x>', 'ABCD'), { state: 'good', label: 'Verified', signer: 'Ann <a@x>', key: 'ABCD' });
  assert.equal(mapSignature('B').state, 'bad');
  assert.equal(mapSignature('U').state, 'unknown');
  assert.equal(mapSignature('X').state, 'expired');
  assert.equal(mapSignature('Y').state, 'expired');
  assert.equal(mapSignature('R').state, 'revoked');
  assert.equal(mapSignature('E').state, 'error');
  assert.equal(mapSignature('N').state, 'none');
  assert.equal(mapSignature('').state, 'none');
  assert.deepEqual(mapSignature('E', '', ' '), { state: 'error', label: "Can't verify signature" });
});

// ---- real git

let tmp: string;
let dir: string;
let git: GitCli;
const env = { ...process.env, GIT_EDITOR: ':', GIT_CONFIG_NOSYSTEM: '1' };
const g = (...args: string[]) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
const commit = (file: string, msg: string, author?: string, date?: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), msg + '\n', { flag: 'a' });
  g('add', '.');
  const e = { ...env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  cp.execFileSync('git', [...(author ? ['-c', `user.name=${author}`, '-c', `user.email=${author.toLowerCase()}@x.io`] : []), 'commit', '-q', '-m', msg], { cwd: dir, env: e });
};
const subjects = (r: { commits: { subject: string }[] }) => r.commits.map(c => c.subject);
const log = (filter: Parameters<GitCli['log']>[0]['filter'], query?: Parameters<GitCli['log']>[0]['query'], all = true) => git.log({ limit: 50, all, filter, query });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-filter-'));
  dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'me@x.io');
  g('config', 'user.name', 'Me');
  g('config', 'commit.gpgsign', 'false');
  commit('a.txt', 'old work', 'Bob', '2020-01-01T12:00:00');
  commit('src/b.txt', 'bob feature', 'Bob', '2020-06-01T12:00:00');
  commit('a.txt', 'mine fix', undefined, '2024-01-01T12:00:00');
  g('checkout', '-q', '-b', 'topic');
  commit('t.txt', 'topic work', 'Ann', '2024-02-01T12:00:00');
  g('checkout', '-q', 'main');
  commit('a.txt', 'main work', undefined, '2024-03-01T12:00:00');
  g('merge', '-q', '--no-ff', '-m', 'merge topic', 'topic');
  git = new GitCli('git', dir);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('filter: author', async () => {
  assert.deepEqual(subjects(await log({ author: 'Bob' })).sort(), ['bob feature', 'old work']);
});

test('filter: mine resolves user.email', async () => {
  assert.deepEqual(subjects(await log({ mine: true, noMerges: true })).sort(), ['main work', 'mine fix']);
});

test('filter: since / until', async () => {
  assert.deepEqual(subjects(await log({ until: '2021-01-01' })).sort(), ['bob feature', 'old work']);
  assert.deepEqual(subjects(await log({ since: '2024-01-15', until: '2024-02-15' })), ['topic work']);
});

test('filter: path', async () => {
  assert.deepEqual(subjects(await log({ paths: ['src'] })), ['bob feature']);
  assert.deepEqual(subjects(await log({ paths: ['src/b.txt', 't.txt'] })).sort(), ['bob feature', 'topic work']);
});

test('filter: message', async () => {
  assert.deepEqual(subjects(await log({ message: 'WORK' })).sort(), ['main work', 'old work', 'topic work']);
});

test('filter: refs replace All/HEAD', async () => {
  g('checkout', '-q', 'topic');
  try {
    // HEAD is topic, but only main is requested
    const s = subjects(await log({ refs: ['main'] }, null, false));
    assert.ok(s.includes('main work'));
    assert.ok(s.includes('merge topic'));
  } finally {
    g('checkout', '-q', 'main');
  }
  g('checkout', '-q', '-b', 'lonely', 'main~3');
  commit('l.txt', 'lonely commit');
  g('checkout', '-q', 'main');
  assert.deepEqual(subjects(await log({ refs: ['lonely'] })), ['lonely commit', 'bob feature', 'old work']);
  assert.ok(!subjects(await log({ refs: ['topic'] })).includes('main work'));
});

test('filter: noMerges / firstParent', async () => {
  assert.ok(subjects(await log({})).includes('merge topic'));
  assert.ok(!subjects(await log({ noMerges: true })).includes('merge topic'));
  const fp = subjects(await log({ firstParent: true }, null, false));
  assert.ok(fp.includes('merge topic') && fp.includes('main work'));
  assert.ok(!fp.includes('topic work'));
});

test('filter: combined with a query and each other', async () => {
  assert.deepEqual(subjects(await log({ author: 'Bob' }, { kind: 'message', value: 'feature' })), ['bob feature']);
  assert.deepEqual(subjects(await log({ since: '2024-01-01', noMerges: true }, { kind: 'author', value: 'ann' })), ['topic work']);
  // query message AND filter message must both match
  assert.deepEqual(subjects(await log({ message: 'work' }, { kind: 'message', value: 'main' })), ['main work']);
  // author filter AND author query (PCRE lookaheads)
  assert.deepEqual(subjects(await log({ mine: true, noMerges: true }, { kind: 'author', value: 'me' })).sort(), ['lonely commit', 'main work', 'mine fix']);
  assert.deepEqual(subjects(await log({ author: 'Bob' }, { kind: 'author', value: 'ann' })), []);
  // 'any' search keeps the filter
  assert.deepEqual(subjects(await log({ author: 'Bob' }, { kind: 'any', value: 'old' })), ['old work']);
  // exact-path query with filter paths does not break on --follow
  const r = await log({ paths: ['t.txt'] }, { kind: 'path', value: 'a.txt', exact: true });
  assert.ok(r.commits.length > 0);
});

test('commit(): unsigned commit has no signature; message stays intact', async () => {
  const head = (await git.log({ limit: 1, all: false })).commits[0];
  const d = await git.commit(head.hash);
  assert.equal(d.signature.state, 'none');
  assert.equal(d.message, 'merge topic');
});
