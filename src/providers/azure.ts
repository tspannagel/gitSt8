import { toStatus } from './ci';
import { requestJson } from './http';
import { AuthHeader, CiCheck, CiState, CiStatus, ProviderClient, PullRequest, RepoRef, ReviewState } from './types';

/** Azure DevOps resource id, used as the OAuth scope for Microsoft sign-in. */
export const AZURE_DEVOPS_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const API_VERSION = '7.1';

interface AdoRepository {
  id: string;
}
interface AdoReviewer {
  vote: number;
  isRequired?: boolean;
}
interface AdoPr {
  pullRequestId: number;
  title: string;
  isDraft?: boolean;
  sourceRefName: string;
  targetRefName: string;
  createdBy?: { displayName?: string };
  lastMergeSourceCommit?: { commitId: string };
  reviewers?: AdoReviewer[];
  forkSource?: unknown;
}
export interface AdoBuild {
  id: number;
  status: string; // notStarted | inProgress | cancelling | completed | postponed
  result?: string; // succeeded | partiallySucceeded | failed | canceled | none
  sourceVersion: string;
  sourceBranch: string;
  queueTime?: string;
  definition: { id: number; name: string };
  triggerInfo?: Record<string, string>;
  _links?: { web?: { href: string } };
}

const base = (r: RepoRef) => `https://dev.azure.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.project || '')}`;
const stripRef = (ref: string) => ref.replace(/^refs\/heads\//, '');

export function buildState(b: AdoBuild): CiState {
  if (b.status === 'cancelling') return 'cancelled';
  if (b.status !== 'completed') return 'pending';
  switch (b.result) {
    case 'succeeded':
      return 'success';
    case 'partiallySucceeded':
      return 'neutral';
    case 'canceled':
      return 'cancelled';
    default:
      return 'failure';
  }
}

/** Commit a build ran for: PR builds run on a merge commit, but report the PR's source commit in triggerInfo. */
export function buildCommit(b: AdoBuild): string {
  return b.triggerInfo?.['pr.sourceSha'] || b.sourceVersion;
}

/** Groups builds by commit, keeping only the newest run per pipeline. Builds must be newest first. */
export function mapBuilds(builds: AdoBuild[], wanted: Set<string>): Record<string, CiStatus> {
  const perCommit = new Map<string, Map<number, CiCheck>>();
  for (const b of builds) {
    const sha = buildCommit(b);
    if (!wanted.has(sha)) continue;
    const byDef = perCommit.get(sha) || new Map<number, CiCheck>();
    if (!byDef.has(b.definition.id)) byDef.set(b.definition.id, { name: b.definition.name, state: buildState(b), url: b._links?.web?.href });
    perCommit.set(sha, byDef);
  }
  const result: Record<string, CiStatus> = {};
  for (const [sha, byDef] of perCommit) result[sha] = toStatus([...byDef.values()]);
  return result;
}

export function reviewState(reviewers: AdoReviewer[] = []): ReviewState {
  if (reviewers.some(r => r.vote <= -10)) return 'changes';
  if (reviewers.some(r => r.isRequired && r.vote < 5)) return 'required';
  if (reviewers.some(r => r.vote >= 5)) return 'approved';
  return reviewers.length ? 'required' : 'none';
}

export function mapPullRequest(repo: RepoRef, p: AdoPr): PullRequest {
  return {
    number: p.pullRequestId,
    title: p.title,
    url: `${repo.webUrl}/pullrequest/${p.pullRequestId}`,
    isDraft: !!p.isDraft,
    sourceBranch: stripRef(p.sourceRefName),
    targetBranch: stripRef(p.targetRefName),
    author: p.createdBy?.displayName || '',
    headSha: p.lastMergeSourceCommit?.commitId,
    review: reviewState(p.reviewers),
    fromFork: !!p.forkSource,
  };
}

export class AzureDevOpsClient implements ProviderClient {
  private repoIds = new Map<string, string>();

  constructor(private readonly auth: (repo: RepoRef) => Promise<AuthHeader>) {}

  private async get<T>(repo: RepoRef, path: string): Promise<T> {
    const sep = path.includes('?') ? '&' : '?';
    return requestJson<T>(`${base(repo)}/_apis/${path}${sep}api-version=${API_VERSION}`, await this.auth(repo));
  }

  private async repoId(repo: RepoRef): Promise<string> {
    const key = `${repo.owner}/${repo.project}/${repo.repo}`.toLowerCase();
    let id = this.repoIds.get(key);
    if (!id) {
      id = (await this.get<AdoRepository>(repo, `git/repositories/${encodeURIComponent(repo.repo)}`)).id;
      this.repoIds.set(key, id);
    }
    return id;
  }

  async pullRequests(repo: RepoRef): Promise<PullRequest[]> {
    const id = await this.repoId(repo);
    const res = await this.get<{ value: AdoPr[] }>(repo, `git/repositories/${id}/pullrequests?searchCriteria.status=active&$top=100`);
    return res.value.map(p => mapPullRequest(repo, p));
  }

  async statuses(repo: RepoRef, shas: string[]): Promise<Record<string, CiStatus>> {
    if (!shas.length) return {};
    const id = await this.repoId(repo);
    // One call for the most recent runs of every pipeline in this repository.
    const res = await this.get<{ value: AdoBuild[] }>(
      repo,
      `build/builds?repositoryId=${id}&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=200`
    );
    return mapBuilds(res.value, new Set(shas));
  }
}
