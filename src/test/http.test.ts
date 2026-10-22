import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { requestJson, HttpError } from '../providers/http';
import { AuthError, RepoRef } from '../providers/types';
import { GitHubClient } from '../providers/github';
import * as gh from '../providers/github';
import * as azure from '../providers/azure';

const repo: RepoRef = { provider: 'github', host: 'github.com', owner: 'o', repo: 'r', webUrl: '' };

test('HTTP credentials, permission, rate-limit and sign-in-page failures remain distinct', async t => {
  let response: Response;
  t.mock.method(globalThis, 'fetch', async () => response);
  response = new Response('sensitive service response', { status: 401 });
  await assert.rejects(requestJson('https://example.com', 'test-auth'), e => e instanceof AuthError && /401/.test(e.message) && !/sensitive/.test(e.message));
  response = new Response('denied', { status: 403 });
  await assert.rejects(requestJson('https://example.com', 'test-auth'), e => e instanceof HttpError && e.status === 403 && !(e instanceof AuthError));
  response = new Response('rate limit', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  await assert.rejects(requestJson('https://example.com', 'test-auth'), e => e instanceof HttpError && e.status === 429);
  response = new Response('<html>login</html>', { status: 203, headers: { 'content-type': 'text/html' } });
  await assert.rejects(requestJson('https://example.com', 'test-auth'), AuthError);
  response = new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(requestJson('https://example.com', 'test-auth'), AuthError);
});

test('GitHub partial GraphQL permission errors and invisible repositories are not successful empty lists', async t => {
  let payload: unknown = { data: { repository: null } };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }));
  const client = new GitHubClient(async () => 'test-auth');
  await assert.rejects(client.pullRequests(repo), e => e instanceof HttpError && e.status === 403);
  payload = { data: { repository: { pullRequests: { nodes: [] } } }, errors: [{ type: 'FORBIDDEN', message: 'denied' }] };
  await assert.rejects(client.pullRequests(repo), e => e instanceof HttpError && e.status === 403);
  payload = { errors: [{ type: 'UNAUTHORIZED', message: 'invalid' }] };
  await assert.rejects(client.pullRequests(repo), AuthError);
});

test('PR error mapping preserves credentials vs permissions for integration diagnostics', () => {
  for (const mapper of [gh.friendlyCreateError, azure.friendlyCreateError]) {
    assert.ok(mapper(new AuthError('401')) instanceof AuthError);
    const error = mapper(new HttpError('403', 403));
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 403);
    assert.match(error.message, /permissions|access/);
  }
});
