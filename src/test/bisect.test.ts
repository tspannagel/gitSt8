import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../git';
import { parseBisectRefs, parseBisectTerms, parseBisectVars, parseFirstBad, readBisect } from '../bisect';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('parseBisectRefs sorts bad, good and skip refs', () => {
  const out = [`refs/bisect/bad\x1f${A}`, `refs/bisect/good-${B}\x1f${B}`, `refs/bisect/skip-${C}\x1f${C}`, 'junk'].join('\n');
  assert.deepEqual(parseBisectRefs(out), { bad: A, good: [B], skipped: [C] });
});

test('parseBisectRefs honours custom terms', () => {
  const out = [`refs/bisect/new\x1f${A}`, `refs/bisect/old-${B}\x1f${B}`].join('\n');
  assert.deepEqual(parseBisectRefs(out, { bad: 'new', good: 'old' }), { bad: A, good: [B], skipped: [] });
});

test('parseBisectTerms defaults and reads two lines', () => {
  assert.deepEqual(parseBisectTerms(''), { bad: 'bad', good: 'good' });
  assert.deepEqual(parseBisectTerms('new\nold\n'), { bad: 'new', good: 'old' });
});

test('parseBisectVars reads shell assignments', () => {
  const v = parseBisectVars(`bisect_rev='${A}'\nbisect_nr=3\nbisect_good=1\nbisect_bad=2\nbisect_all=8\nbisect_steps=2\n`);
  assert.equal(v.bisect_rev, A);
  assert.equal(v.bisect_nr, '3');
  assert.equal(v.bisect_steps, '2');
});

test('parseFirstBad finds the culprit line', () => {
  assert.equal(parseFirstBad(`${A} is the first bad commit\ncommit ${A}\n`), A);
  assert.equal(parseFirstBad('Bisecting: 3 revisions left to test after this\n'), undefined);
});

test('bisect on a real repo finds the culprit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-bisect-'));
  try {
    const env = { ...process.env, GIT_EDITOR: ':', GIT_CONFIG_NOSYSTEM: '1' };
    const g = (...args: string[]) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 'Tester');
    const shas: string[] = [];
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(dir, 'f.txt'), `${i}\n`);
      g('add', '.');
      g('commit', '-q', '-m', `c${i}`);
      shas.push(g('rev-parse', 'HEAD').trim());
    }
    const culprit = shas[5]; // c5 introduced the bug
    const isBad = () => Number(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')) >= 5;
    const git = new GitCli('git', dir);

    {
      assert.equal((await readBisect(git)).active, false);
      g('bisect', 'start', shas[7], shas[0]);
      let st = await readBisect(git);
      assert.equal(st.active, true);
      assert.equal(st.start, 'main');
      assert.equal(st.bad, shas[7]);
      assert.deepEqual(st.good, [shas[0]]);
      assert.ok(st.remaining !== undefined && st.remaining > 0);
      assert.ok(st.steps !== undefined && st.steps >= 1);
      assert.equal(st.culprit, undefined);

      let out = '';
      for (let n = 0; n < 10 && !st.culprit; n++) {
        out = g('bisect', isBad() ? 'bad' : 'good');
        st = await readBisect(git);
      }
      assert.equal(st.culprit, culprit);
      assert.equal(parseFirstBad(out), culprit);

      g('bisect', 'reset');
      assert.equal((await readBisect(git)).active, false);
      assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
