import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../git';
import { HunkSelectionError, buildPatch, hunkSignature, parseDiff } from '../hunks';

// ---------------------------------------------------------------- parser / builder (pure)

const SAMPLE = [
  'diff --git a/f.txt b/f.txt',
  'index 111..222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,4 +1,5 @@ function a',
  ' one',
  '-two',
  '+TWO',
  '+extra',
  ' three',
  ' four',
  '@@ -20,2 +21,2 @@',
  ' x',
  '-y',
  '+Y',
  '',
].join('\n');

test('parseDiff reads header, hunks and line kinds', () => {
  const f = parseDiff(SAMPLE);
  assert.equal(f.header.length, 4);
  assert.equal(f.hunks.length, 2);
  const h = f.hunks[0];
  assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [1, 4, 1, 5]);
  assert.equal(h.header, '@@ -1,4 +1,5 @@ function a');
  assert.deepEqual(h.lines.map(l => l.kind).join(''), ' -++  ');
  assert.equal(h.lines[2].text, 'TWO');
  assert.equal(hunkSignature(f.hunks[1]), '20,2,21,2');
  assert.equal(f.binary, false);
});

test('parseDiff handles empty output, binary, mode-only and new/deleted files', () => {
  assert.deepEqual(parseDiff('').hunks, []);
  const bin = parseDiff('diff --git a/x.bin b/x.bin\nindex 1..2 100644\nBinary files a/x.bin and b/x.bin differ\n');
  assert.equal(bin.binary, true);
  assert.equal(bin.hunks.length, 0);
  const mode = parseDiff('diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n');
  assert.equal(mode.hunks.length, 0);
  assert.equal(mode.binary, false);
  const added = parseDiff('diff --git a/n b/n\nnew file mode 100755\nindex 0..1\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n');
  assert.equal(added.isNew, true);
  assert.equal(added.mode, '100755');
  assert.deepEqual([added.hunks[0].oldStart, added.hunks[0].oldLines, added.hunks[0].newLines], [0, 0, 2]);
  const del = parseDiff('diff --git a/n b/n\ndeleted file mode 100644\nindex 1..0\n--- a/n\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n');
  assert.equal(del.isDeleted, true);
  assert.equal(del.hunks[0].oldLines, 1);
});

test('parseDiff keeps CR, marks no-EOL lines and ignores header-like content', () => {
  const f = parseDiff('diff --git a/c b/c\n--- a/c\n+++ b/c\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n\\ No newline at end of file\n');
  const h = f.hunks[0];
  assert.equal(h.lines[0].text, 'a\r');
  assert.equal(h.lines[2].text, 'B\r');
  assert.equal(h.lines[2].noEol, true);
  assert.equal(h.lines[1].noEol, undefined);
  // content lines that start like file headers are still content
  const g = parseDiff('diff --git a/c b/c\n--- a/c\n+++ b/c\n@@ -1,2 +1,2 @@\n ctx\n--- removed dashes\n+++ added pluses\n');
  assert.equal(g.hunks.length, 1);
  assert.deepEqual(g.hunks[0].lines.map(l => l.text), ['ctx', '-- removed dashes', '++ added pluses']);
});

test('buildPatch: whole hunk, forward, reproduces the hunk', () => {
  const f = parseDiff(SAMPLE);
  const p = buildPatch(f, { hunk: 0 }, { reverse: false, path: 'f.txt' });
  assert.equal(p, 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,5 @@ function a\n one\n-two\n+TWO\n+extra\n three\n four\n');
});

test('buildPatch: second hunk keeps its own base offsets (no shift from the skipped first hunk)', () => {
  const f = parseDiff(SAMPLE);
  const fwd = buildPatch(f, { hunk: 1 }, { reverse: false, path: 'f.txt' });
  assert.match(fwd, /@@ -20,2 \+20,2 @@/);
  const rev = buildPatch(f, { hunk: 1 }, { reverse: true, path: 'f.txt' });
  assert.match(rev, /@@ -21,2 \+21,2 @@/);
});

test('buildPatch: forward selection turns unselected - into context and drops unselected +', () => {
  const f = parseDiff(SAMPLE);
  // select only "+TWO" (index 2): "-two" becomes context, "+extra" dropped
  const p = buildPatch(f, { hunk: 0, lines: [2] }, { reverse: false, path: 'f.txt' });
  assert.equal(p, 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,5 @@ function a\n one\n two\n+TWO\n three\n four\n');
  // select only "-two": +TWO and +extra dropped
  const q = buildPatch(f, { hunk: 0, lines: [1] }, { reverse: false, path: 'f.txt' });
  assert.match(q, /@@ -1,4 \+1,3 @@ function a\n one\n-two\n three\n four\n$/);
});

test('buildPatch: reverse selection turns unselected + into context and drops unselected -', () => {
  const f = parseDiff(SAMPLE);
  // unstage only "+extra" (index 3): TWO stays as context in the index, "-two" dropped
  const p = buildPatch(f, { hunk: 0, lines: [3] }, { reverse: true, path: 'f.txt' });
  assert.match(p, /@@ -1,4 \+1,5 @@ function a\n one\n TWO\n\+extra\n three\n four\n$/);
});

test('buildPatch: no-EOL markers follow their line, dropped lines take theirs with them', () => {
  const f = parseDiff('diff --git a/n b/n\n--- a/n\n+++ b/n\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n');
  const h = f.hunks[0];
  assert.equal(h.lines[1].noEol, true);
  assert.equal(h.lines[2].noEol, true);
  const all = buildPatch(f, { hunk: 0 }, { reverse: false, path: 'n' });
  assert.match(all, / a\n-b\n\\ No newline at end of file\n\+c\n\\ No newline at end of file\n$/);
  // select "-b" only: "+c" and its marker are gone
  const only = buildPatch(f, { hunk: 0, lines: [1] }, { reverse: false, path: 'n' });
  assert.match(only, /@@ -1,2 \+1 @@\n a\n-b\n\\ No newline at end of file\n$/);
  // select "+c" only: "-b" becomes context but keeps its marker
  const plus = buildPatch(f, { hunk: 0, lines: [2] }, { reverse: false, path: 'n' });
  assert.match(plus, /@@ -1,2 \+1,3 @@\n a\n b\n\\ No newline at end of file\n\+c\n\\ No newline at end of file\n$/);
});

test('buildPatch: CR in content is preserved', () => {
  const f = parseDiff('diff --git a/c b/c\n--- a/c\n+++ b/c\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n');
  assert.ok(buildPatch(f, { hunk: 0 }, { reverse: false, path: 'c' }).includes('-b\r\n+B\r\n'));
});

test('buildPatch: new and deleted files keep creation/deletion only when everything is selected', () => {
  const added = parseDiff('diff --git a/n b/n\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n');
  const whole = buildPatch(added, { hunk: 0 }, { reverse: false, path: 'n' });
  assert.equal(whole, 'diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n');
  const part = buildPatch(added, { hunk: 0, lines: [1] }, { reverse: false, path: 'n' });
  assert.equal(part, 'diff --git a/n b/n\n--- a/n\n+++ b/n\n@@ -0,0 +1 @@\n+b\n');
  const unstagePart = buildPatch(added, { hunk: 0, lines: [1] }, { reverse: true, path: 'n' });
  assert.equal(unstagePart, 'diff --git a/n b/n\n--- a/n\n+++ b/n\n@@ -1,2 +1,3 @@\n a\n+b\n c\n');
  const del = parseDiff('diff --git a/n b/n\ndeleted file mode 100644\nindex 1..0\n--- a/n\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n');
  assert.equal(buildPatch(del, { hunk: 0 }, { reverse: false, path: 'n' }), 'diff --git a/n b/n\ndeleted file mode 100644\n--- a/n\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n');
});

test('buildPatch: paths with special characters are quoted', () => {
  const f = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
  const p = buildPatch(f, { hunk: 0 }, { reverse: false, path: 'we"ird\tname' });
  assert.ok(p.includes('--- "a/we\\"ird\\tname"\n'));
});

test('buildPatch rejects stale or invalid selections', () => {
  const f = parseDiff(SAMPLE);
  const fail = (sel: Parameters<typeof buildPatch>[1]) => assert.throws(() => buildPatch(f, sel, { reverse: false, path: 'f.txt' }), HunkSelectionError);
  fail({ hunk: 5 });
  fail({ hunk: 0, lines: [] });
  fail({ hunk: 0, lines: [0] }); // context line
  fail({ hunk: 0, lines: [99] });
  fail({ hunk: 0, sig: '9,9,9,9' });
  assert.doesNotThrow(() => buildPatch(f, { hunk: 0, sig: '1,4,1,5' }, { reverse: false, path: 'f.txt' }));
  assert.throws(() => buildPatch({ ...f, binary: true }, { hunk: 0 }, { reverse: false, path: 'f.txt' }), HunkSelectionError);
});

// ---------------------------------------------------------------- real git

let tmp: string;
let dir: string;
let cli: GitCli;
const env = { ...process.env, GIT_EDITOR: ':', GIT_CONFIG_NOSYSTEM: '1' };
const g = (...args: string[]) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const join = (l: string[]) => l.join('\n') + '\n';
/** 30 lines, with two distant edits (line 3 and line 27) so they form two hunks, plus a 2-line addition in the first. */
const edited = () => {
  const l = numbered(30);
  l[2] = 'line 3 changed';
  l.splice(3, 0, 'inserted A', 'inserted B');
  l[28] = 'line 27 changed'; // index shifted by 2
  return join(l);
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-hunks-'));
  dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'Tester');
  g('config', 'core.autocrlf', 'false');
  write('a.txt', join(numbered(30)));
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  cli = new GitCli('git', dir);
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // temp dir cleanup is best effort
  }
});

const reset = () => {
  g('reset', '-q', '--hard');
  g('clean', '-fdq');
};
const stat = (args: string[]) => g('diff', ...args, '--numstat').trim();

test('git: stage one of two hunks', async () => {
  reset();
  write('a.txt', edited());
  const f = await cli.fileHunks('a.txt', false);
  assert.equal(f.hunks.length, 2);
  await cli.applyPatch(buildPatch(f, { hunk: 1, sig: hunkSignature(f.hunks[1]) }, { reverse: false, path: 'a.txt' }), { cached: true, reverse: false });
  const staged = await cli.fileHunks('a.txt', true);
  assert.equal(staged.hunks.length, 1);
  assert.deepEqual(staged.hunks[0].lines.filter(l => l.kind !== ' ').map(l => l.kind + l.text), ['-line 27', '+line 27 changed']);
  const rest = await cli.fileHunks('a.txt', false);
  assert.equal(rest.hunks.length, 1);
  assert.equal(read('a.txt'), edited()); // working tree untouched
});

test('git: stage selected lines, then the hunk after a partially staged hunk', async () => {
  reset();
  write('a.txt', edited());
  let f = await cli.fileHunks('a.txt', false);
  const h = f.hunks[0];
  const idx = (kind: string, text: string) => h.lines.findIndex(l => l.kind === kind && l.text === text);
  // stage only "inserted A" and the replacement of line 3 (+ side), leave "-line 3" unselected... select both - and +
  const sel = [idx('-', 'line 3'), idx('+', 'line 3 changed'), idx('+', 'inserted A')];
  await cli.applyPatch(buildPatch(f, { hunk: 0, lines: sel }, { reverse: false, path: 'a.txt' }), { cached: true, reverse: false });
  const cached = await cli.fileHunks('a.txt', true);
  assert.deepEqual(cached.hunks[0].lines.filter(l => l.kind !== ' ').map(l => l.kind + l.text), ['-line 3', '+line 3 changed', '+inserted A']);
  // what remains unstaged in the first hunk: "inserted B"
  f = await cli.fileHunks('a.txt', false);
  assert.equal(f.hunks.length, 2);
  assert.deepEqual(f.hunks[0].lines.filter(l => l.kind !== ' ').map(l => l.kind + l.text), ['+inserted B']);
  // second hunk is still stageable although the index shifted by earlier staging
  await cli.applyPatch(buildPatch(f, { hunk: 1 }, { reverse: false, path: 'a.txt' }), { cached: true, reverse: false });
  assert.equal(stat([]), '1\t0\ta.txt');
  assert.equal(g('show', ':a.txt').includes('line 27 changed'), true);
});

test('git: stage a single + line leaves the - line in place', async () => {
  reset();
  write('a.txt', join(numbered(30).map(l => (l === 'line 10' ? 'line 10 new' : l))));
  const f = await cli.fileHunks('a.txt', false);
  const plus = f.hunks[0].lines.findIndex(l => l.kind === '+');
  await cli.applyPatch(buildPatch(f, { hunk: 0, lines: [plus] }, { reverse: false, path: 'a.txt' }), { cached: true, reverse: false });
  const idx = g('show', ':a.txt').split('\n');
  assert.ok(idx.includes('line 10') && idx.includes('line 10 new'));
});

test('git: unstage a hunk and unstage selected lines', async () => {
  reset();
  write('a.txt', edited());
  g('add', 'a.txt');
  let f = await cli.fileHunks('a.txt', true);
  assert.equal(f.hunks.length, 2);
  await cli.applyPatch(buildPatch(f, { hunk: 0 }, { reverse: true, path: 'a.txt' }), { cached: true, reverse: true });
  f = await cli.fileHunks('a.txt', true);
  assert.equal(f.hunks.length, 1);
  assert.equal((await cli.fileHunks('a.txt', false)).hunks.length, 1);
  assert.equal(read('a.txt'), edited());
  // unstage only the "+line 27 changed" line: the "-line 27" stays staged as a deletion
  const plus = f.hunks[0].lines.findIndex(l => l.kind === '+');
  await cli.applyPatch(buildPatch(f, { hunk: 0, lines: [plus] }, { reverse: true, path: 'a.txt' }), { cached: true, reverse: true });
  const after = await cli.fileHunks('a.txt', true);
  assert.deepEqual(after.hunks[0].lines.filter(l => l.kind !== ' ').map(l => l.kind + l.text), ['-line 27']);
  assert.equal(read('a.txt'), edited());
});

test('git: discard a hunk and selected lines from the working tree', async () => {
  reset();
  write('a.txt', edited());
  let f = await cli.fileHunks('a.txt', false);
  await cli.applyPatch(buildPatch(f, { hunk: 1 }, { reverse: true, path: 'a.txt' }), { cached: false, reverse: true });
  assert.ok(read('a.txt').includes('line 27\n') && !read('a.txt').includes('line 27 changed'));
  assert.ok(read('a.txt').includes('inserted A'));
  // discard only "inserted B" from the first hunk
  f = await cli.fileHunks('a.txt', false);
  const b = f.hunks[0].lines.findIndex(l => l.text === 'inserted B');
  await cli.applyPatch(buildPatch(f, { hunk: 0, lines: [b] }, { reverse: true, path: 'a.txt' }), { cached: false, reverse: true });
  const txt = read('a.txt');
  assert.ok(txt.includes('inserted A') && !txt.includes('inserted B') && txt.includes('line 3 changed'));
  assert.equal(g('diff', '--cached', '--stat').trim(), '');
});

test('git: files without trailing newline and with CRLF', async () => {
  reset();
  write('e.txt', 'a\nb\nc'); // no EOL
  write('crlf.txt', 'x\r\ny\r\nz\r\n');
  g('add', '.');
  g('commit', '-q', '-m', 'files');
  write('e.txt', 'a\nB\nc\nd'); // changes the last line's EOL status too
  write('crlf.txt', 'x\r\nY\r\nz\r\nw\r\n');
  let f = await cli.fileHunks('e.txt', false);
  await cli.applyPatch(buildPatch(f, { hunk: 0 }, { reverse: false, path: 'e.txt' }), { cached: true, reverse: false });
  assert.equal(g('show', ':e.txt'), 'a\nB\nc\nd');
  f = await cli.fileHunks('crlf.txt', false);
  const y = f.hunks[0].lines.findIndex(l => l.kind === '+' && l.text === 'Y\r');
  const minus = f.hunks[0].lines.findIndex(l => l.kind === '-');
  await cli.applyPatch(buildPatch(f, { hunk: 0, lines: [minus, y] }, { reverse: false, path: 'crlf.txt' }), { cached: true, reverse: false });
  assert.equal(g('show', ':crlf.txt'), 'x\r\nY\r\nz\r\n');
  assert.equal(read('crlf.txt'), 'x\r\nY\r\nz\r\nw\r\n');
});

test('git: stage, unstage and discard in a new (intent-to-add) and a deleted file', async () => {
  reset();
  write('new.txt', 'n1\nn2\nn3\n');
  g('add', 'new.txt');
  // staged new file: unstage the middle line only
  let f = await cli.fileHunks('new.txt', true);
  assert.equal(f.isNew, true);
  const mid = f.hunks[0].lines.findIndex(l => l.text === 'n2');
  await cli.applyPatch(buildPatch(f, { hunk: 0, lines: [mid] }, { reverse: true, path: 'new.txt' }), { cached: true, reverse: true });
  assert.equal(g('show', ':new.txt'), 'n1\nn3\n');
  // unstage everything that is left: the file leaves the index
  f = await cli.fileHunks('new.txt', true);
  await cli.applyPatch(buildPatch(f, { hunk: 0 }, { reverse: true, path: 'new.txt' }), { cached: true, reverse: true });
  assert.equal(g('ls-files', 'new.txt').trim(), '');
  assert.equal(read('new.txt'), 'n1\nn2\nn3\n');
  // deleted file: stage the deletion hunk
  fs.rmSync(path.join(dir, 'a.txt'));
  f = await cli.fileHunks('a.txt', false);
  assert.equal(f.isDeleted, true);
  await cli.applyPatch(buildPatch(f, { hunk: 0 }, { reverse: false, path: 'a.txt' }), { cached: true, reverse: false });
  assert.equal(g('ls-files', 'a.txt').trim(), '');
});

test('git: mode changes are untouched and a stale selection is refused', async () => {
  reset();
  write('a.txt', edited());
  fs.chmodSync(path.join(dir, 'a.txt'), 0o755);
  const f = await cli.fileHunks('a.txt', false);
  const sig = hunkSignature(f.hunks[0]);
  await cli.applyPatch(buildPatch(f, { hunk: 0, sig }, { reverse: false, path: 'a.txt' }), { cached: true, reverse: false });
  assert.match(g('ls-files', '-s', 'a.txt'), /^100644/);
  // the file changes underneath: the old signature no longer matches
  write('a.txt', join(numbered(30).map(l => (l === 'line 3' ? 'something else' : l))));
  const now = await cli.fileHunks('a.txt', false);
  assert.throws(() => buildPatch(now, { hunk: 0, sig }, { reverse: false, path: 'a.txt' }), HunkSelectionError);
});
