import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../git';

// format-patch -> am roundtrip and am state detection, against real throwaway repositories.
const env = { ...process.env, GIT_EDITOR: ':', GIT_CONFIG_NOSYSTEM: '1' };
const mk = (root: string, name: string) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const g = (...args: string[]) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'Tester');
  g('config', 'core.autocrlf', 'false');
  const commit = (file: string, text: string, msg: string) => {
    fs.writeFileSync(path.join(dir, file), text);
    g('add', '.');
    g('commit', '-q', '-m', msg);
  };
  return { dir, g, commit, git: new GitCli('git', dir) };
};

test('format-patch -> am roundtrip keeps messages, and numbered files are written oldest first', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-patch-'));
  try {
    const a = mk(tmp, 'a');
    a.commit('f.txt', 'base\n', 'base');
    a.g('branch', 'target');
    a.commit('g.txt', 'one\n', 'add g');
    a.commit('h.txt', 'two\n', 'add h');
    const shas = a.g('log', '--reverse', '--format=%H', 'target..main').trim().split('\n');

    const single = await a.git.formatPatch(shas[0]);
    assert.match(single, /^From [0-9a-f]{40}/);
    assert.match(single, /Subject: \[PATCH\] add g/);

    const out = path.join(tmp, 'out');
    const files = await a.git.formatPatches(out, shas);
    assert.equal(files.length, 2);
    assert.match(path.basename(files[0]), /^0001-.*add-g\.patch$/);
    assert.match(path.basename(files[1]), /^0002-.*add-h\.patch$/);
    assert.match(fs.readFileSync(files[1], 'utf8'), /Subject: \[PATCH 2\/2\] add h/);

    a.g('checkout', '-q', 'target');
    for (const f of files) await a.git.run(['am', '--3way', '--', f]);
    assert.deepEqual(a.g('log', '--format=%s', 'target~2..target').trim().split('\n'), ['add h', 'add g']);
    assert.equal(await a.git.opState(), null);
    assert.equal(await a.git.onRemote('HEAD'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('opState reports a conflicting git am as "am", and abort clears it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-patch-'));
  try {
    const a = mk(tmp, 'a');
    a.commit('f.txt', 'base\n', 'base');
    a.g('branch', 'other');
    a.commit('f.txt', 'from main\n', 'main change');
    const patch = path.join(tmp, 'x.patch');
    fs.writeFileSync(patch, await a.git.formatPatch('HEAD'));
    a.g('checkout', '-q', 'other');
    a.commit('f.txt', 'different\n', 'other change');

    await assert.rejects(a.git.run(['am', '--3way', '--', patch]));
    const op = await a.git.opState();
    assert.equal(op?.kind, 'am');
    assert.equal(op?.step, 1);
    assert.equal(op?.total, 1);
    assert.deepEqual(op?.conflicts, ['f.txt']);

    await a.git.run(['am', '--abort']);
    assert.equal(await a.git.opState(), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
