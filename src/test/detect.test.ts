import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseRemoteUrl, repoLabel } from '../providers/detect';

const azure = (org: string, project: string, repo: string) => ({ provider: 'azure', owner: org, project, repo });
const github = (owner: string, repo: string, host = 'github.com') => ({ provider: 'github', owner, repo, host });

const cases: [string, object | null][] = [
  // Azure DevOps
  ['https://dev.azure.com/contoso/Fabric%20BI/_git/meta-factory', azure('contoso', 'Fabric BI', 'meta-factory')],
  ['https://contoso@dev.azure.com/contoso/Proj/_git/Repo', azure('contoso', 'Proj', 'Repo')],
  ['https://dev.azure.com/contoso/Proj/_git/Repo.git', azure('contoso', 'Proj', 'Repo')],
  ['https://contoso.visualstudio.com/Proj/_git/Repo', azure('contoso', 'Proj', 'Repo')],
  ['https://contoso.visualstudio.com/DefaultCollection/Proj/_git/Repo', azure('contoso', 'Proj', 'Repo')],
  ['git@ssh.dev.azure.com:v3/contoso/Proj/Repo', azure('contoso', 'Proj', 'Repo')],
  ['ssh://git@ssh.dev.azure.com/v3/contoso/Proj/Repo', azure('contoso', 'Proj', 'Repo')],
  ['contoso@vs-ssh.visualstudio.com:v3/contoso/Proj/Repo', azure('contoso', 'Proj', 'Repo')],
  // GitHub
  ['https://github.com/octo/hello-world.git', github('octo', 'hello-world')],
  ['https://github.com/octo/hello-world', github('octo', 'hello-world')],
  ['https://user@github.com/octo/hello-world/', github('octo', 'hello-world')],
  ['git@github.com:octo/hello-world.git', github('octo', 'hello-world')],
  ['ssh://git@github.com:22/octo/hello-world.git', github('octo', 'hello-world')],
  // Not supported
  ['https://gitlab.com/octo/hello-world.git', null],
  ['C:\\repos\\remote.git', null],
  ['/srv/git/repo.git', null],
];

for (const [url, expected] of cases) {
  test(`parseRemoteUrl ${url}`, () => {
    const r = parseRemoteUrl(url);
    if (expected === null) return assert.equal(r, null);
    assert.ok(r, 'expected a match');
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map(k => [k, (r as unknown as Record<string, unknown>)[k]])),
      expected
    );
  });
}

test('GitHub Enterprise host only when configured', () => {
  assert.equal(parseRemoteUrl('https://git.corp.example/team/app.git'), null);
  const r = parseRemoteUrl('https://git.corp.example/team/app.git', ['git.corp.example']);
  assert.equal(r?.host, 'git.corp.example');
  assert.equal(r?.webUrl, 'https://git.corp.example/team/app');
});

test('web URLs and labels', () => {
  const a = parseRemoteUrl('https://dev.azure.com/contoso/Fabric%20BI/_git/meta-factory')!;
  assert.equal(a.webUrl, 'https://dev.azure.com/contoso/Fabric%20BI/_git/meta-factory');
  assert.equal(repoLabel(a), 'contoso/Fabric BI/meta-factory');
  const g = parseRemoteUrl('git@github.com:octo/hello-world.git')!;
  assert.equal(g.webUrl, 'https://github.com/octo/hello-world');
  assert.equal(repoLabel(g), 'octo/hello-world');
});
