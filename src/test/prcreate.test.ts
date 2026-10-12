import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as gh from '../providers/github';
import * as ado from '../providers/azure';
import { HttpError } from '../providers/http';
import { AuthError, RepoRef } from '../providers/types';
import { defaultBody, defaultTitle, humanizeBranch, prHeadRefspec } from '../prdraft';

test('GitHub: create pull request variables and response', () => {
  const v = gh.createPullRequestVariables('R_1', { source: 'feat/x', target: 'main', title: 'T "q"', body: '- a\n- b', draft: true });
  assert.deepEqual(v, { repositoryId: 'R_1', base: 'main', head: 'feat/x', title: 'T "q"', body: '- a\n- b', draft: true });
  assert.ok(!gh.CREATE_PR_MUTATION.includes('feat/x'));
  const pr = gh.mapPullRequest({
    number: 7, title: 'T', url: 'https://github.com/o/r/pull/7', isDraft: true, headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'a'.repeat(40),
    isCrossRepository: false, reviewDecision: null, author: { login: 'me' }, commits: { nodes: [] },
  });
  assert.equal(pr.number, 7);
  assert.equal(pr.isDraft, true);
});

test('GitHub: create pull request errors are friendly', () => {
  assert.match(gh.friendlyCreateError(new Error('A pull request already exists for o:feat/x.')).message, /already exists/);
  assert.match(gh.friendlyCreateError(new AuthError('Not authorized (403).')).message, /"repo" scope/);
  assert.match(gh.friendlyCreateError(new HttpError('500 oops', 500)).message, /500/);
});

test('Azure DevOps: create pull request body, response and errors', () => {
  const body = ado.createPullRequestBody({ source: 'feat/x', target: 'main', title: 'T', body: 'D', draft: false });
  assert.deepEqual(body, { sourceRefName: 'refs/heads/feat/x', targetRefName: 'refs/heads/main', title: 'T', description: 'D', isDraft: false });
  const repo: RepoRef = { provider: 'azure', host: 'dev.azure.com', owner: 'org', project: 'proj', repo: 'r', webUrl: 'https://dev.azure.com/org/proj/_git/r' };
  const pr = ado.mapPullRequest(repo, { pullRequestId: 12, title: 'T', isDraft: false, sourceRefName: 'refs/heads/feat/x', targetRefName: 'refs/heads/main' });
  assert.equal(pr.url, 'https://dev.azure.com/org/proj/_git/r/pullrequest/12');
  assert.match(ado.friendlyCreateError(new HttpError('409 Conflict: TF401179: An active pull request ...', 409)).message, /already exists/);
  assert.match(ado.friendlyCreateError(new AuthError('Not authorized (401).')).message, /Code \(Read & write\)/);
});

test('pull request defaults', () => {
  assert.equal(humanizeBranch('feature/add-login_page'), 'Add login page');
  assert.equal(defaultTitle('fix/x-y', ['Only commit']), 'Only commit');
  assert.equal(defaultTitle('fix/x-y', ['a', 'b']), 'X y');
  assert.equal(defaultBody(['a', 'b']), '- a\n- b');
  assert.equal(prHeadRefspec('github', 5), 'pull/5/head:pr/5');
  assert.equal(prHeadRefspec('azure', 5), null);
});
