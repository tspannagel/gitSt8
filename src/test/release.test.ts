import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../git';
import { classifyCommit, classifyCommits, compareVersions, latestVersion, nextVersion, parseVersionTag, renderChangelog, suggestBump } from '../release';

const c = (subject: string, body = '', hash = 'abcdef1234567890') => classifyCommit({ hash, subject, body });

test('parseVersionTag accepts semver with prefixes, prerelease and build', () => {
  assert.deepEqual(
    { ...parseVersionTag('v1.2.3')!, name: '' },
    { prefix: 'v', major: 1, minor: 2, patch: 3, prerelease: [], build: '', name: '' }
  );
  assert.equal(parseVersionTag('1.0.0')!.prefix, '');
  assert.equal(parseVersionTag('release-2.0.1')!.prefix, 'release-');
  const p = parseVersionTag('v1.0.0-rc.1+build.5')!;
  assert.deepEqual(p.prerelease, ['rc', '1']);
  assert.equal(p.build, 'build.5');
});

test('parseVersionTag rejects non-semver', () => {
  for (const n of ['v1.2', '1.2.3.4', 'latest', 'v01.2.3', 'foo', 'v1.2.x', '', '-1.2.3', 'release/1.2']) assert.equal(parseVersionTag(n), null, n);
  assert.equal(parseVersionTag('rel/1.2.3')!.prefix, 'rel/');
});

test('compareVersions follows semver precedence', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  const vs = order.map(n => parseVersionTag(n)!);
  for (let i = 0; i < vs.length - 1; i++) assert.ok(compareVersions(vs[i], vs[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
  assert.equal(compareVersions(parseVersionTag('v1.0.0+a')!, parseVersionTag('1.0.0+b')!), 0);
  assert.ok(compareVersions(parseVersionTag('1.10.0')!, parseVersionTag('1.9.0')!) > 0);
});

test('latestVersion picks the highest and ignores non-semver tags', () => {
  assert.equal(latestVersion(['v1.9.0', 'v1.10.0', 'v2.0.0-rc.1', 'foo', 'v1.2.0'])!.name, 'v2.0.0-rc.1');
  assert.equal(latestVersion(['v2.0.0-rc.1', 'v2.0.0', 'v1.0.0'])!.name, 'v2.0.0');
  assert.equal(latestVersion(['foo', 'bar']), null);
  assert.equal(latestVersion([]), null);
});

test('classifyCommit: types, scopes, breaking markers', () => {
  assert.deepEqual(
    { ...c('feat(ui): add button') },
    { hash: 'abcdef1234567890', type: 'feat', scope: 'ui', description: 'add button', breaking: false, breakingNote: '', section: 'feat' }
  );
  assert.equal(c('fix: crash').section, 'fix');
  assert.equal(c('perf(core): faster').section, 'perf');
  assert.equal(c('refactor: tidy').section, 'other');
  assert.equal(c('docs: readme').type, 'docs');
  assert.equal(c('chore(deps): bump').section, 'other');
  const bang = c('feat(api)!: drop v1');
  assert.ok(bang.breaking);
  assert.equal(bang.section, 'breaking');
  assert.equal(bang.type, 'feat');
  const footer = c('fix: change format', 'Some text.\n\nBREAKING CHANGE: output is JSON now\nsecond line\n\nRefs: #4');
  assert.ok(footer.breaking);
  assert.equal(footer.breakingNote, 'output is JSON now\nsecond line');
  assert.ok(c('feat: x', 'BREAKING-CHANGE: y').breaking);
});

test('classifyCommit: non-conventional commits go to Other', () => {
  assert.equal(c('Update readme').section, 'other');
  assert.equal(c('wip: stuff').section, 'other');
  assert.equal(c('wip: stuff').description, 'wip: stuff');
  assert.equal(c('fix something').section, 'other');
  assert.equal(c('Update thing', 'BREAKING CHANGE: gone').section, 'breaking');
});

test('suggestBump', () => {
  assert.equal(suggestBump(classifyCommits([])), 'patch');
  assert.equal(suggestBump([c('fix: a'), c('docs: b')]), 'patch');
  assert.equal(suggestBump([c('fix: a'), c('feat: b')]), 'minor');
  assert.equal(suggestBump([c('feat: b'), c('fix!: c')]), 'major');
  assert.equal(suggestBump([c('fix: a', 'BREAKING CHANGE: x')], 1), 'major');
  // pre-1.0: breaking changes only bump minor
  assert.equal(suggestBump([c('feat!: b')], 0), 'minor');
  assert.equal(suggestBump([c('fix: a')], 0), 'patch');
});

test('nextVersion', () => {
  const v = parseVersionTag('v1.2.3')!;
  assert.equal(nextVersion(v, 'patch'), 'v1.2.4');
  assert.equal(nextVersion(v, 'minor'), 'v1.3.0');
  assert.equal(nextVersion(v, 'major'), 'v2.0.0');
  assert.equal(nextVersion(parseVersionTag('1.2.3-rc.1')!, 'patch'), '1.2.4');
  assert.equal(nextVersion(parseVersionTag('release-0.4.0')!, 'minor'), 'release-0.5.0');
  assert.equal(nextVersion(v, 'patch', 'x-'), 'x-1.2.4');
  assert.equal(nextVersion(null, 'minor'), 'v0.1.0');
  assert.equal(nextVersion(null, 'major'), 'v1.0.0');
});

test('renderChangelog groups sections and omits empty ones', () => {
  const commits = classifyCommits([
    { hash: '1111111aaaa', subject: 'fix(parser): handle empty input', body: '' },
    { hash: '2222222bbbb', subject: 'feat!: new config', body: 'BREAKING CHANGE: config moved' },
    { hash: '3333333cccc', subject: 'feat(ui): add panel', body: '' },
    { hash: '4444444dddd', subject: 'perf: cache lookups', body: '' },
    { hash: '5555555eeee', subject: 'tidy things', body: '' },
    { hash: '6666666ffff', subject: 'docs: update', body: '' },
  ]);
  assert.equal(
    renderChangelog({ version: 'v1.0.0', date: '2026-01-02', commits }),
    [
      '## v1.0.0 (2026-01-02)', '',
      '### Breaking changes', '', '- new config - config moved (2222222)', '',
      '### Features', '', '- **ui:** add panel (3333333)', '',
      '### Fixes', '', '- **parser:** handle empty input (1111111)', '',
      '### Performance', '', '- cache lookups (4444444)', '',
      '### Other', '', '- tidy things (5555555)', '- update (6666666)', '',
    ].join('\n')
  );
  assert.equal(
    renderChangelog({ version: 'v1.0.1', date: '2026-01-03', commits: [], compareUrl: 'https://x/compare/a...b' }),
    '## [v1.0.1](https://x/compare/a...b) (2026-01-03)\n'
  );
});

// ---- real git

let tmp: string;
let dir: string;
let git: GitCli;
const env = { ...process.env, GIT_EDITOR: ':', GIT_CONFIG_NOSYSTEM: '1' };
const g = (...args: string[]) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
const commit = (msg: string, extra: string[] = []) => {
  fs.writeFileSync(path.join(dir, 'f.txt'), msg + '\n', { flag: 'a' });
  g('add', '.');
  g('commit', '-q', '-m', msg, ...extra);
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-release-'));
  dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'Tester');
  git = new GitCli('git', dir);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('tagsMerged and commitsInRange against a real repo', async () => {
  commit('chore: init');
  g('tag', 'v0.1.0');
  commit('feat(core): first feature', ['-m', 'Body line', '-m', 'BREAKING CHANGE: api changed']);
  commit('fix: a bug');
  g('tag', '-a', 'v0.2.0', '-m', 'second');
  g('checkout', '-q', '-b', 'side');
  commit('side work');
  g('tag', 'v9.9.9');
  g('checkout', '-q', 'main');
  commit('docs: later');
  g('tag', 'not-a-version');

  const merged = (await git.tagsMerged('HEAD')).sort();
  assert.deepEqual(merged, ['not-a-version', 'v0.1.0', 'v0.2.0']); // v9.9.9 is on an unmerged branch
  assert.equal(latestVersion(merged)!.name, 'v0.2.0');
  assert.deepEqual(await git.tagsMerged('v0.1.0'), ['v0.1.0']);
  assert.deepEqual(await git.tagsMerged('does-not-exist'), []);

  const range = await git.commitsInRange('v0.1.0', 'HEAD');
  assert.deepEqual(range.map(r => r.subject), ['docs: later', 'fix: a bug', 'feat(core): first feature']);
  assert.match(range[2].body, /Body line/);
  assert.match(range[2].body, /BREAKING CHANGE: api changed/);
  assert.equal(range[0].hash.length, 40);
  const cls = classifyCommits(range);
  assert.equal(suggestBump(cls, 0), 'minor');
  assert.equal(suggestBump(cls, 1), 'major');

  assert.deepEqual((await git.commitsInRange('v0.2.0', 'HEAD')).map(r => r.subject), ['docs: later']);
  assert.equal((await git.commitsInRange('', 'HEAD')).length, 4);
  assert.deepEqual(await git.commitsInRange('v0.2.0', 'v0.2.0'), []);
});

test('commitsInRange skips merge commits', async () => {
  g('merge', '--no-ff', '-q', '-X', 'ours', '-m', 'Merge side', 'side');
  const subjects = (await git.commitsInRange('v0.2.0', 'HEAD')).map(r => r.subject);
  assert.ok(!subjects.includes('Merge side'));
  assert.ok(subjects.includes('side work'));
});
