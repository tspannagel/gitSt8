import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SessionOptions } from '../accounts';
import { RepoRef } from '../providers/types';
import type { Integrations } from '../integration';

// Integration host seam: providers remain ordinary Node modules, no VS Code runtime needed.
const calls: { provider: string; scopes: string[]; options: SessionOptions }[] = [];
let account = 'a';
const fakeVscode = {
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  authentication: {
    onDidChangeSessions: () => ({ dispose() {} }),
    getAccounts: async () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    getSession: async (provider: string, scopes: string[], options: SessionOptions) => {
      calls.push({ provider, scopes, options });
      return { account: { id: options.account?.id || account, label: options.account?.label || account }, accessToken: `fixture-${options.account?.id || account}` };
    },
  },
};
const loader = require('node:module') as { _load: (id: string, ...args: unknown[]) => unknown };
const original = loader._load;
let IntegrationClass: typeof Integrations;
try {
  loader._load = function(id, ...args) { return id === 'vscode' ? fakeVscode : original.call(this, id, ...args); };
  IntegrationClass = require('../integration').Integrations;
} finally { loader._load = original; }

function instance(pats = new Map<string, string>()) {
  calls.length = 0;
  account = 'a';
  const saved = new Map<string, unknown>();
  const state = { keys: () => [...saved.keys()], get: <T>(key: string) => saved.get(key) as T | undefined, update: async (key: string, value: unknown) => { saved.set(key, value); } };
  const secrets = { get: async (key: string) => pats.get(key), store: async (key: string, value: string) => { pats.set(key, value); }, delete: async (key: string) => { pats.delete(key); }, onDidChange: () => ({ dispose() {} }) };
  return new IntegrationClass(secrets, state);
}
const gh: RepoRef = { provider: 'github', host: 'github.com', owner: 'o', repo: 'r', webUrl: 'https://github.com/o/r' };
const ado: RepoRef = { provider: 'azure', host: 'dev.azure.com', owner: 'org', project: 'p', repo: 'r', webUrl: 'https://dev.azure.com/org/p/_git/r' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('background operation resolves once, remains silent, and permission failures retain identity', async t => {
  const integrations = instance();
  let forbidden = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (forbidden) return json({}, 403);
    const query = JSON.parse(String(init.body)).query as string;
    return json({ data: { repository: query.includes('pullRequests') ? { pullRequests: { nodes: [] } } : {} } });
  });
  await integrations.signIn(gh, 'root', 'change');
  calls.length = 0;
  const loaded = await integrations.load('origin', gh, ['a'.repeat(40)], true, 'root');
  assert.equal(loaded.signedIn, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.silent, true);
  assert.equal(calls[0].options.account?.id, 'a');
  forbidden = true;
  const denied = await integrations.load('origin', gh, [], true, 'root');
  assert.equal(denied.signedIn, true);
  assert.match(denied.error!, /403|permissions/);
  integrations.dispose();
});

test('explicit PR authenticates once and reuses the same credentials for lookup and mutation', async t => {
  const integrations = instance();
  const headers: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    headers.push((init.headers as Record<string, string>).Authorization);
    const query = JSON.parse(String(init.body)).query as string;
    return query.includes('mutation') ? json({ data: { createPullRequest: { pullRequest: {
      number: 1, title: 'T', url: '', isDraft: false, headRefName: 'feat', baseRefName: 'main', headRefOid: '', isCrossRepository: false, reviewDecision: null, author: null, commits: { nodes: [] },
    } } } }) : json({ data: { repository: { id: 'R1' } } });
  });
  await integrations.createPullRequest(gh, { source: 'feat', target: 'main', title: 'T', body: '', draft: false }, 'root');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.createIfNone, true);
  assert.equal(headers.length, 2);
  assert.equal(headers[0], headers[1]);
  integrations.dispose();
});

test('Azure organization PAT precedes global PAT and OAuth; failures remain actionable without fallback', async t => {
  const pats = new Map([['gitst8.azurePat:org', 'fixture-org'], ['gitst8.azurePat', 'fixture-global']]);
  const integrations = instance(pats);
  const headers: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    headers.push((init.headers as Record<string, string>).Authorization);
    return json({}, 401);
  });
  const failed = await integrations.load('origin', ado, [], true, 'root');
  assert.equal(failed.signedIn, false);
  assert.match(failed.error!, /PAT takes precedence/);
  assert.match(failed.error!, /replace\/remove/);
  assert.equal(headers[0], `Basic ${Buffer.from(':fixture-org').toString('base64')}`);
  await integrations.clearAzurePat('org');
  await integrations.load('origin', ado, [], true, 'root');
  assert.equal(headers[1], `Basic ${Buffer.from(':fixture-global').toString('base64')}`);
  await assert.rejects(integrations.signIn(ado, 'root', 'change'), /PAT takes precedence/);
  assert.equal(calls.length, 0);
  integrations.dispose();
});

test('Azure tenant resolution is deduplicated and supplied to silent account resolution; lookup failures do not fall back', async t => {
  const integrations = instance();
  let heads = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method === 'HEAD') { heads++; return new Response(null, { headers: { 'x-vss-resourcetenant': '27444538-cf50-4827-91c3-1261e1728f12' } }); }
    return json({}, 403);
  });
  await Promise.all([integrations.load('origin', ado, [], true, 'a'), integrations.load('origin', ado, [], true, 'b')]);
  assert.equal(heads, 1);
  assert.ok(calls.every(c => c.options.silent && c.scopes.includes('VSCODE_TENANT:27444538-cf50-4827-91c3-1261e1728f12')));
  const failed = instance();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const result = await failed.load('origin', ado, [], true, 'root');
  assert.match(result.error!, /resolve the Entra tenant/);
  assert.equal(calls.length, 0);
  integrations.dispose();
  failed.dispose();
});
