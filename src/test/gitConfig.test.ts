import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../git';
import { CONFIG_SETTINGS, configKeyId, effectiveValue, globalConfigPath, isValidConfigKey, parseConfigList } from '../gitConfig';

test('parseConfigList: key/value pairs, bare keys and multi-line values', () => {
  assert.deepEqual(parseConfigList('user.name\nTim S\0core.bare\0alias.lg\nlog\n--graph\0'), [
    { key: 'user.name', value: 'Tim S' },
    { key: 'core.bare', value: null },
    { key: 'alias.lg', value: 'log\n--graph' },
  ]);
  assert.deepEqual(parseConfigList(''), []);
});

test('parseConfigList: with --show-scope', () => {
  assert.deepEqual(parseConfigList('system\0core.autocrlf\ntrue\0local\0core.autocrlf\nfalse\0', true), [
    { scope: 'system', key: 'core.autocrlf', value: 'true' },
    { scope: 'local', key: 'core.autocrlf', value: 'false' },
  ]);
});

test('isValidConfigKey', () => {
  for (const k of ['user.name', 'core.autocrlf', 'remote.origin.url', 'branch.feature/x y.remote', 'url.https://github.com/.insteadOf', 'a-b.c-d'])
    assert.ok(isValidConfigKey(k), k);
  for (const k of ['', 'user', '--global', '-c.x', 'user.', '.name', 'user.1name', 'user name.x', 'a.b\nc.d', 'sec.sub.na_me'])
    assert.ok(!isValidConfigKey(k), k);
});

test('configKeyId / effectiveValue: case-insensitive section and name, last entry wins', () => {
  assert.equal(configKeyId('Remote.Origin.URL'), 'remote.Origin.url');
  assert.equal(configKeyId('Pull.Rebase'), 'pull.rebase');
  const entries = parseConfigList('system\0pull.rebase\nfalse\0global\0pull.rebase\ntrue\0global\0remote.Origin.url\nx\0', true);
  assert.deepEqual(effectiveValue(entries, 'pull.rebase'), { scope: 'global', key: 'pull.rebase', value: 'true' });
  assert.equal(effectiveValue(entries, 'remote.origin.url'), undefined);
  assert.equal(effectiveValue(entries, 'remote.Origin.URL')?.value, 'x');
});

test('CONFIG_SETTINGS: valid keys, unique, options for selectors', () => {
  const ids = CONFIG_SETTINGS.map(s => configKeyId(s.key));
  assert.equal(new Set(ids).size, ids.length);
  for (const s of CONFIG_SETTINGS) {
    assert.ok(isValidConfigKey(s.key), s.key);
    assert.equal(s.type === 'text', !s.options, s.key);
  }
});

test('globalConfigPath: GIT_CONFIG_GLOBAL, else ~/.gitconfig unless only the XDG file exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-home-'));
  try {
    assert.equal(globalConfigPath({ GIT_CONFIG_GLOBAL: '/x/cfg' }, home), '/x/cfg');
    assert.equal(globalConfigPath({}, home), path.join(home, '.gitconfig'));
    fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'git', 'config'), '');
    assert.equal(globalConfigPath({}, home), path.join(home, '.config', 'git', 'config'));
    fs.writeFileSync(path.join(home, '.gitconfig'), '');
    assert.equal(globalConfigPath({}, home), path.join(home, '.gitconfig'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- real git: a throwaway repo and a throwaway global config file

let tmp: string;
let git: GitCli;
let globalFile: string;
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitst8-config-'));
  globalFile = path.join(tmp, 'global.gitconfig');
  process.env.GIT_CONFIG_GLOBAL = globalFile;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir);
  cp.execFileSync('git', ['init', '-q', dir]);
  git = new GitCli('git', dir);
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows sometimes keeps a handle open for a moment; the OS cleans temp eventually.
  }
});

test('configList: a missing global file is empty', async () => {
  assert.deepEqual(await git.configList('global'), []);
});

test('configSet / configUnset per scope, effective list shows the override', async () => {
  await git.configSet('global', 'pull.rebase', 'true');
  await git.configSet('local', 'pull.rebase', 'false');
  assert.deepEqual(await git.configList('global'), [{ key: 'pull.rebase', value: 'true' }]);
  assert.ok((await git.configList('local')).some(e => e.key === 'pull.rebase' && e.value === 'false'));
  assert.deepEqual(effectiveValue(await git.configList(), 'pull.rebase'), { scope: 'local', key: 'pull.rebase', value: 'false' });

  await git.configUnset('local', 'pull.rebase');
  assert.deepEqual(effectiveValue(await git.configList(), 'pull.rebase'), { scope: 'global', key: 'pull.rebase', value: 'true' });
  await git.configUnset('local', 'pull.rebase'); // already gone: no error
  await git.configUnset('global', 'nothing.here');
});

test('configSet: values that look like options are stored literally', async () => {
  await git.configSet('global', 'alias.lg', '--global');
  await git.configSet('global', 'test.dash', '-x');
  const g = await git.configList('global');
  assert.equal(effectiveValue(g, 'alias.lg')?.value, '--global');
  assert.equal(effectiveValue(g, 'test.dash')?.value, '-x');
  await assert.rejects(git.configSet('global', '--add', 'x'), /Not a valid config key/);
  await assert.rejects(git.configUnset('global', '-x.y'), /Not a valid config key/);
});

test('multi-valued keys: add, replace one value, remove one value, replace all', async () => {
  const values = async () => (await git.configList('local')).filter(e => e.key === 'test.multi').map(e => e.value);
  await git.configSet('local', 'test.multi', 'a');
  await git.configSet('local', 'test.multi', 'b [x]', { add: true });
  await git.configSet('local', 'test.multi', 'c', { add: true });
  assert.deepEqual(await values(), ['a', 'b [x]', 'c']);
  // The old value is matched literally, not as a regex.
  await git.configSet('local', 'test.multi', 'B', { old: 'b [x]' });
  assert.deepEqual(await values(), ['a', 'B', 'c']);
  await git.configUnset('local', 'test.multi', 'a');
  assert.deepEqual(await values(), ['B', 'c']);
  await git.configSet('local', 'test.multi', 'only');
  assert.deepEqual(await values(), ['only']);
});

test('configFile: local is the repository config, global the test file', async () => {
  assert.equal(path.resolve(await git.configFile('local')), path.resolve(tmp, 'repo', '.git', 'config'));
  assert.equal(await git.configFile('global'), globalFile);
});
