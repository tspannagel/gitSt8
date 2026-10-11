import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../git';
import { mergeSubmodules, parseGitlinks, parseGitmodules, parseSubmoduleStatus } from '../submodules';
import { parseLfsFiles, summarizeLfs, usesLfs } from '../lfs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('parseSubmoduleStatus reads all state prefixes, paths with spaces and missing describe', () => {
  const out = [` ${A} libs/ok (v1.0-2-gabc)`, `-${B} libs/not init`, `+${C} libs/mod (heads/main)`, `U${A} libs/conf`, ''].join('\n');
  assert.deepEqual(
    parseSubmoduleStatus(out).map(e => [e.state, e.sha, e.path, e.describe]),
    [
      ['ok', A, 'libs/ok', 'v1.0-2-gabc'],
      ['uninitialized', B, 'libs/not init', undefined],
      ['modified', C, 'libs/mod', 'heads/main'],
      ['conflict', A, 'libs/conf', undefined],
    ]
  );
});

test('parseGitmodules handles dotted names, optional branch and -z records', () => {
  const out = 'submodule.a.b.path\nlibs/ab\0submodule.a.b.url\nhttps://x/ab.git\0submodule.a.b.branch\ndev\0submodule.c.path\nc\0submodule.c.url\n../c\0';
  assert.deepEqual(parseGitmodules(out), [
    { name: 'a.b', path: 'libs/ab', url: 'https://x/ab.git', branch: 'dev' },
    { name: 'c', path: 'c', url: '../c' },
  ]);
});

test('mergeSubmodules combines status, .gitmodules and index gitlinks', () => {
  const links = parseGitlinks(`160000 ${A} 0\tlibs/mod\x00100644 ${B} 0\tfile\x00`);
  assert.equal(links.get('libs/mod'), A);
  assert.equal(links.size, 1);
  const list = mergeSubmodules(
    parseSubmoduleStatus(`+${C} libs/mod (x)\n-${B} libs/new\n`),
    [{ name: 'mod', path: 'libs/mod', url: 'u1', branch: 'main' }, { name: 'new', path: 'libs/new', url: 'u2' }],
    links
  );
  assert.deepEqual(list[0], { name: 'mod', path: 'libs/mod', url: 'u1', branch: 'main', recorded: A, checkedOut: C, state: 'modified' });
  assert.deepEqual(list[1], { name: 'new', path: 'libs/new', url: 'u2', recorded: B, state: 'uninitialized' });
});

test('parseLfsFiles and summary', () => {
  const out = ['f1d2d2f924 * assets/a.png', '0123456789 - docs/big file.psd', 'garbage', ''].join('\n');
  const files = parseLfsFiles(out);
  assert.deepEqual(files, [
    { oid: 'f1d2d2f924', path: 'assets/a.png', downloaded: true },
    { oid: '0123456789', path: 'docs/big file.psd', downloaded: false },
  ]);
  assert.deepEqual(summarizeLfs(files), { total: 2, missing: 1 });
});

test('usesLfs detects the filter in .gitattributes', () => {
  assert.equal(usesLfs('*.png filter=lfs diff=lfs merge=lfs -text\n'), true);
  assert.equal(usesLfs('# *.png filter=lfs\n*.txt text\n'), false);
  assert.equal(usesLfs(''), false);
});

// Integration: real superproject with a file-URL submodule.
let tmp: string;
let sup: string;
let sub: string;
const env = { ...process.env, GIT_EDITOR: ':', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' };
const run = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-sub-'));
  sub = path.join(tmp, 'sub');
  sup = path.join(tmp, 'sup');
  for (const d of [sub, sup]) {
    fs.mkdirSync(d);
    run(d, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(d, 'f.txt'), 'one\n');
    run(d, 'add', '.');
    run(d, 'commit', '-q', '-m', 'init');
  }
  run(sup, 'submodule', 'add', '-q', '-b', 'main', sub, 'libs/sub');
  run(sup, 'commit', '-q', '-m', 'add submodule');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('GitCli.submodules reports ok, modified and uninitialized states', async () => {
  const git = new GitCli('git', sup);
  const [ok] = await git.submodules();
  assert.equal(ok.path, 'libs/sub');
  assert.equal(ok.name, 'libs/sub');
  assert.equal(ok.url, sub);
  assert.equal(ok.branch, 'main');
  assert.equal(ok.state, 'ok');
  assert.equal(ok.checkedOut, ok.recorded);

  // New commit inside the submodule: checked-out differs from the recorded one.
  const subWt = path.join(sup, 'libs/sub');
  fs.writeFileSync(path.join(subWt, 'g.txt'), 'two\n');
  run(subWt, 'add', '.');
  run(subWt, 'commit', '-q', '-m', 'second');
  const [mod] = await git.submodules();
  assert.equal(mod.state, 'modified');
  assert.notEqual(mod.checkedOut, mod.recorded);
  assert.equal(mod.checkedOut, run(subWt, 'rev-parse', 'HEAD').trim());

  // Update to the recorded commit resets it.
  await git.run(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--', 'libs/sub']);
  assert.equal((await git.submodules())[0].state, 'ok');

  // A fresh clone has the submodule uninitialized.
  const clone = path.join(tmp, 'clone');
  run(tmp, 'clone', '-q', sup, clone);
  const [un] = await new GitCli('git', clone).submodules();
  assert.equal(un.state, 'uninitialized');
  assert.equal(un.checkedOut, undefined);
  assert.equal(un.recorded, ok.recorded);
  await new GitCli('git', clone).run(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive']);
  assert.equal((await new GitCli('git', clone).submodules())[0].state, 'ok');
});

test('GitCli.submodules is empty without .gitmodules and lfsSummary is null without LFS attributes', async () => {
  const git = new GitCli('git', sub);
  assert.deepEqual(await git.submodules(), []);
  assert.equal(await git.lfsSummary(null), null);
});
