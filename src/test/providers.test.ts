import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { rollup } from '../providers/ci';
import * as gh from '../providers/github';
import * as ado from '../providers/azure';
import { RepoRef } from '../providers/types';

test('rollup: worst state wins', () => {
  assert.equal(rollup([]), 'neutral');
  assert.equal(rollup(['success', 'skipped']), 'success');
  assert.equal(rollup(['success', 'pending']), 'pending');
  assert.equal(rollup(['pending', 'failure', 'success']), 'failure');
  assert.equal(rollup(['success', 'cancelled']), 'cancelled');
  assert.equal(rollup(['skipped', 'skipped']), 'skipped');
});

test('GitHub: check runs and status contexts map to states', () => {
  assert.equal(gh.checkRunState('IN_PROGRESS', null), 'pending');
  assert.equal(gh.checkRunState('QUEUED', null), 'pending');
  assert.equal(gh.checkRunState('COMPLETED', 'SUCCESS'), 'success');
  assert.equal(gh.checkRunState('COMPLETED', 'TIMED_OUT'), 'failure');
  assert.equal(gh.checkRunState('COMPLETED', 'CANCELLED'), 'cancelled');
  assert.equal(gh.checkRunState('COMPLETED', 'SKIPPED'), 'skipped');
  assert.equal(gh.statusContextState('ERROR'), 'failure');
  assert.equal(gh.statusContextState('EXPECTED'), 'pending');
  assert.equal(gh.apiUrl('github.com'), 'https://api.github.com/graphql');
  assert.equal(gh.apiUrl('git.corp.example'), 'https://git.corp.example/api/graphql');
});

test('GitHub: statusCheckRollup fixture', () => {
  const s = gh.mapRollup({
    state: 'FAILURE',
    contexts: {
      nodes: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/1' },
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: null },
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', targetUrl: 'https://ci.example/1' },
      ],
    },
  });
  assert.equal(s?.state, 'failure');
  assert.deepEqual(
    s?.checks.map(c => [c.name, c.state, c.url]),
    [
      ['build', 'success', 'https://github.com/o/r/actions/runs/1'],
      ['test', 'failure', undefined],
      ['ci/legacy', 'success', 'https://ci.example/1'],
    ]
  );
  assert.equal(gh.mapRollup(null), undefined);
});

test('GitHub: pull request fixture', () => {
  const pr = gh.mapPullRequest({
    number: 42,
    title: 'Add feature',
    url: 'https://github.com/o/r/pull/42',
    isDraft: false,
    headRefName: 'feature/x',
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    isCrossRepository: false,
    reviewDecision: 'APPROVED',
    author: { login: 'octo' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
  });
  assert.deepEqual(pr, {
    number: 42,
    title: 'Add feature',
    url: 'https://github.com/o/r/pull/42',
    isDraft: false,
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    author: 'octo',
    headSha: 'a'.repeat(40),
    review: 'approved',
    ci: 'pending',
    fromFork: false,
  });
});

const repo: RepoRef = { provider: 'azure', host: 'dev.azure.com', owner: 'contoso', project: 'Proj', repo: 'Repo', webUrl: 'https://dev.azure.com/contoso/Proj/_git/Repo' };

test('Azure DevOps: builds group by commit, newest run per pipeline', () => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40), PRHEAD = 'c'.repeat(40);
  const build = (id: number, def: number, sha: string, status: string, result?: string, extra: Partial<ado.AdoBuild> = {}): ado.AdoBuild => ({
    id,
    status,
    result,
    sourceVersion: sha,
    sourceBranch: 'refs/heads/main',
    definition: { id: def, name: `pipe-${def}` },
    _links: { web: { href: `https://dev.azure.com/contoso/Proj/_build/results?buildId=${id}` } },
    ...extra,
  });
  // Newest first, as returned by the API.
  const builds = [
    build(5, 1, A, 'completed', 'succeeded'), // re-run of pipeline 1 on A: wins over build 3
    build(4, 2, A, 'inProgress'),
    build(3, 1, A, 'completed', 'failed'),
    build(2, 1, B, 'completed', 'partiallySucceeded'),
    build(1, 3, 'f'.repeat(40), 'completed', 'succeeded', { triggerInfo: { 'pr.sourceSha': PRHEAD } }),
    build(0, 1, 'e'.repeat(40), 'completed', 'succeeded'), // not wanted
  ];
  const s = ado.mapBuilds(builds, new Set([A, B, PRHEAD]));
  assert.deepEqual(Object.keys(s).sort(), [A, B, PRHEAD].sort());
  assert.equal(s[A].state, 'pending');
  assert.deepEqual(s[A].checks.map(c => [c.name, c.state]), [['pipe-1', 'success'], ['pipe-2', 'pending']]);
  assert.equal(s[B].state, 'neutral');
  assert.equal(s[PRHEAD].state, 'success', 'PR builds count for the PR source commit');
  assert.equal(s[A].checks[0].url, 'https://dev.azure.com/contoso/Proj/_build/results?buildId=5');
});

test('Azure DevOps: build states', () => {
  const b = (status: string, result?: string) => ado.buildState({ id: 1, status, result, sourceVersion: '', sourceBranch: '', definition: { id: 1, name: 'p' } });
  assert.equal(b('notStarted'), 'pending');
  assert.equal(b('cancelling'), 'cancelled');
  assert.equal(b('completed', 'canceled'), 'cancelled');
  assert.equal(b('completed', 'failed'), 'failure');
});

test('Azure DevOps: pull request fixture and review votes', () => {
  const pr = ado.mapPullRequest(repo, {
    pullRequestId: 17,
    title: 'Release artifacts',
    isDraft: true,
    sourceRefName: 'refs/heads/ts/releaseArtifacts',
    targetRefName: 'refs/heads/main',
    createdBy: { displayName: 'Tim' },
    lastMergeSourceCommit: { commitId: 'd'.repeat(40) },
    reviewers: [{ vote: 10 }],
  });
  assert.equal(pr.url, 'https://dev.azure.com/contoso/Proj/_git/Repo/pullrequest/17');
  assert.equal(pr.sourceBranch, 'ts/releaseArtifacts');
  assert.equal(pr.targetBranch, 'main');
  assert.equal(pr.isDraft, true);
  assert.equal(pr.review, 'approved');
  assert.equal(pr.headSha, 'd'.repeat(40));
  assert.equal(ado.reviewState([{ vote: 10 }, { vote: -10 }]), 'changes');
  assert.equal(ado.reviewState([{ vote: 10 }, { vote: 0, isRequired: true }]), 'required');
  assert.equal(ado.reviewState([]), 'none');
});
