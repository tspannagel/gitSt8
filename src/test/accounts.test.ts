import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Accounts, AccountState, accountScope, Session, SessionOptions } from '../accounts';
import { AuthError, RepoRef } from '../providers/types';

const repo: RepoRef = { provider: 'github', host: 'github.com', owner: 'o', repo: 'r', webUrl: '' };
const scope = accountScope(repo);
const session = (id: string): Session => ({ account: { id, label: `Account ${id}` }, accessToken: `test-token-${id}` });
function state() {
  const values = new Map<string, unknown>();
  const storage: AccountState = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } };
  return { values, storage };
}

test('account IDs only: workspace fallback, repository override, host/tenant isolation and reload', async () => {
  const { values, storage } = state();
  let selected = 'default';
  const calls: SessionOptions[] = [];
  const auth = { getSession: async (_p: string, _s: string[], opts: SessionOptions) => { calls.push(opts); return session(opts.account?.id || selected); } };
  const accounts = new Accounts(storage, auth);
  await accounts.session('github', ['repo'], scope, 'repo-a', 'default');
  assert.equal(accounts.accountId(scope, 'repo-a'), 'default');
  selected = 'override';
  await accounts.session('github', ['repo'], scope, 'repo-a', 'change');
  assert.equal(accounts.accountId(scope, 'repo-b'), 'default');
  assert.equal(accounts.accountId(scope, 'repo-a'), 'override');
  assert.equal(accounts.accountId(accountScope({ ...repo, host: 'enterprise.example' }), 'repo-a'), undefined);
  const azure = { ...repo, provider: 'azure' as const, host: 'dev.azure.com' };
  assert.notEqual(accountScope(azure, 'tenant-a'), accountScope(azure, 'tenant-b'));
  assert.notEqual(accountScope({ ...azure, owner: 'org-a' }), accountScope({ ...azure, owner: 'org-b' }));
  const reloaded = new Accounts(storage, auth);
  await reloaded.session('github', ['repo'], scope, 'repo-a');
  assert.deepEqual(calls.at(-1), { silent: true, account: { id: 'override', label: 'override' } });
  assert.deepEqual([...values.values()].sort(), ['default', 'override']);
  assert.ok(!JSON.stringify([...values]).includes('test-token'));
  // A sign-in using the default must not accidentally pin a repository override.
  await reloaded.session('github', ['repo'], scope, 'repo-b', 'signin');
  selected = 'new-default';
  await reloaded.session('github', ['repo'], scope, 'repo-a', 'default');
  assert.equal(reloaded.accountId(scope, 'repo-b'), 'new-default');
  assert.equal(reloaded.accountId(scope, 'repo-a'), 'override');
});

test('deduplicate same action, serialize provider interactions, background never becomes interactive', async () => {
  const { storage } = state();
  let release!: (s: Session) => void;
  const calls: { provider: string; opts: SessionOptions }[] = [];
  const accounts = new Accounts(storage, { getSession: async (provider, _scopes, opts) => {
    calls.push({ provider, opts });
    if (calls.length === 1) return new Promise<Session>(resolve => { release = resolve; });
    return session(provider);
  } });
  const a = accounts.session('github', ['repo'], scope, 'repo-a', 'change');
  assert.equal(a, accounts.session('github', ['repo'], scope, 'repo-a', 'change'));
  const b = accounts.session('github', ['repo'], scope, 'repo-b', 'change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  await accounts.session('github', ['repo'], scope, 'background');
  assert.deepEqual(calls[1].opts, { silent: true });
  await accounts.session('microsoft', ['azure'], 'azure-scope', 'repo-c', 'change');
  assert.equal(calls[2].provider, 'microsoft');
  release(session('a'));
  await Promise.all([a, b]);
  assert.deepEqual(calls[3].opts, { createIfNone: true, clearSessionPreference: true });
});

test('cancelled selection preserves preference and does not poison queue', async () => {
  const { storage, values } = state();
  let cancel = false;
  const accounts = new Accounts(storage, { getSession: async () => cancel ? undefined : session('a') });
  await accounts.session('github', ['repo'], scope, 'repo-a', 'change');
  cancel = true;
  await assert.rejects(accounts.session('github', ['repo'], scope, 'repo-a', 'change'), AuthError);
  await assert.rejects(accounts.session('github', ['repo'], scope, 'repo-b', 'default'), AuthError);
  assert.deepEqual([...values.values()], ['a']);
  cancel = false;
  await accounts.session('github', ['repo'], scope, 'repo-b', 'change');
});

test('removed/mismatched account fails closed; explicit action can sign the saved account back in', async () => {
  const { storage } = state();
  let returned = 'a';
  let available = true;
  const calls: SessionOptions[] = [];
  const accounts = new Accounts(storage, {
    getAccounts: async () => available ? [session('a').account] : [],
    getSession: async (_p, _s, opts) => { calls.push(opts); return session(returned); },
  });
  await accounts.session('github', ['repo'], scope, 'repo-a', 'change');
  returned = 'wrong';
  await assert.rejects(accounts.session('github', ['repo'], scope, 'repo-a'), /different account/);
  available = false;
  await assert.rejects(accounts.session('github', ['repo'], scope, 'repo-a'), /no longer signed in/);
  returned = 'a';
  await accounts.session('github', ['repo'], scope, 'repo-a', 'signin');
  assert.equal(calls.at(-1)?.account?.id, 'a');
  assert.equal(calls.at(-1)?.createIfNone, true);
});
