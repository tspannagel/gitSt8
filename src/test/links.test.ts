import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchUrl, commitUrl, createPrUrl, fileUrl } from '../providers/links';
import { parseRemoteUrl } from '../providers/detect';
import { RepoRef } from '../providers/types';

const gh = parseRemoteUrl('git@github.com:acme/widgets.git') as RepoRef;
const ghe = parseRemoteUrl('https://git.corp.example/acme/widgets.git', ['git.corp.example']) as RepoRef;
const az = parseRemoteUrl('https://dev.azure.com/org/proj/_git/repo') as RepoRef;
const sha = 'a'.repeat(40);

test('github links', () => {
  assert.equal(commitUrl(gh, sha), `https://github.com/acme/widgets/commit/${sha}`);
  assert.equal(fileUrl(gh, sha, 'src/a b/c#.ts'), `https://github.com/acme/widgets/blob/${sha}/src/a%20b/c%23.ts`);
  assert.equal(fileUrl(gh, sha, 'x.ts', { start: 3 }), `https://github.com/acme/widgets/blob/${sha}/x.ts#L3`);
  assert.equal(fileUrl(gh, sha, 'x.ts', { start: 3, end: 9 }), `https://github.com/acme/widgets/blob/${sha}/x.ts#L3-L9`);
  assert.equal(branchUrl(gh, 'feat/new thing'), 'https://github.com/acme/widgets/tree/feat/new%20thing');
  assert.equal(createPrUrl(gh, 'feat/x', 'main'), 'https://github.com/acme/widgets/compare/main...feat/x?expand=1');
});

test('github enterprise host', () => {
  assert.equal(commitUrl(ghe, sha), `https://git.corp.example/acme/widgets/commit/${sha}`);
  assert.equal(createPrUrl(ghe, 'a', 'release/1.0'), 'https://git.corp.example/acme/widgets/compare/release/1.0...a?expand=1');
});

test('azure devops links', () => {
  const web = az.webUrl;
  assert.ok(web.startsWith('https://dev.azure.com/org/'));
  assert.equal(commitUrl(az, sha), `${web}/commit/${sha}`);
  assert.equal(fileUrl(az, sha, 'src/a.ts'), `${web}?path=%2Fsrc%2Fa.ts&version=GC${sha}&_a=contents`);
  assert.equal(
    fileUrl(az, sha, 'a.ts', { start: 2, end: 4 }),
    `${web}?path=%2Fa.ts&version=GC${sha}&line=2&lineEnd=5&lineStartColumn=1&lineEndColumn=1&lineStyle=plain&_a=contents`
  );
  assert.equal(branchUrl(az, 'feat/x'), `${web}?version=GBfeat%2Fx`);
  assert.equal(createPrUrl(az, 'feat/x', 'main'), `${web}/pullrequestcreate?sourceRef=feat%2Fx&targetRef=main`);
});
