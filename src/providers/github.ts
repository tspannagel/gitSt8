import { toStatus } from './ci';
import { requestJson } from './http';
import { AuthHeader, CiCheck, CiState, CiStatus, ProviderClient, PullRequest, RepoRef, ReviewState } from './types';

const BATCH = 40;

const CONTEXTS = `contexts(first: 50) {
  nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl }
  }
}`;

interface GqlCheckRun {
  __typename: 'CheckRun';
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}
interface GqlStatusContext {
  __typename: 'StatusContext';
  context: string;
  state: string;
  targetUrl: string | null;
}
type GqlContext = GqlCheckRun | GqlStatusContext;
interface GqlRollup {
  state: string;
  contexts: { nodes: GqlContext[] };
}
interface GqlPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  reviewDecision: string | null;
  author: { login: string } | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export function apiUrl(host: string): string {
  return host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
}

export function checkRunState(status: string, conclusion: string | null): CiState {
  if (status !== 'COMPLETED') return 'pending';
  switch (conclusion) {
    case 'SUCCESS':
      return 'success';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'NEUTRAL':
    case 'STALE':
      return 'neutral';
    default:
      return 'failure'; // FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE
  }
}

export function statusContextState(state: string): CiState {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'failure'; // FAILURE, ERROR
  }
}

export function rollupState(state: string | undefined): CiState | undefined {
  if (!state) return undefined;
  return state === 'SUCCESS' ? 'success' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'failure';
}

export function mapRollup(r: GqlRollup | null | undefined): CiStatus | undefined {
  if (!r) return undefined;
  const checks: CiCheck[] = r.contexts.nodes.map(n =>
    n.__typename === 'CheckRun'
      ? { name: n.name, state: checkRunState(n.status, n.conclusion), url: n.detailsUrl || undefined }
      : { name: n.context, state: statusContextState(n.state), url: n.targetUrl || undefined }
  );
  return checks.length ? toStatus(checks) : { state: rollupState(r.state) || 'neutral', checks };
}

function review(decision: string | null): ReviewState {
  return decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes' : decision === 'REVIEW_REQUIRED' ? 'required' : 'none';
}

export function mapPullRequest(p: GqlPr): PullRequest {
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    isDraft: p.isDraft,
    sourceBranch: p.headRefName,
    targetBranch: p.baseRefName,
    author: p.author?.login || '',
    headSha: p.headRefOid,
    review: review(p.reviewDecision),
    ci: rollupState(p.commits.nodes[0]?.commit.statusCheckRollup?.state),
    fromFork: p.isCrossRepository,
  };
}

export class GitHubClient implements ProviderClient {
  constructor(private readonly auth: (host: string) => Promise<AuthHeader>) {}

  private async graphql<T>(host: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await requestJson<{ data?: T; errors?: { message: string }[] }>(apiUrl(host), await this.auth(host), {
      method: 'POST',
      body: { query, variables },
    });
    if (!res.data) throw new Error(res.errors?.map(e => e.message).join('; ') || 'GitHub returned no data');
    return res.data;
  }

  async pullRequests(repo: RepoRef): Promise<PullRequest[]> {
    const q = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            number title url isDraft headRefName baseRefName headRefOid isCrossRepository reviewDecision
            author { login }
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          }
        }
      }
    }`;
    const data = await this.graphql<{ repository: { pullRequests: { nodes: GqlPr[] } } | null }>(repo.host, q, { owner: repo.owner, name: repo.repo });
    return (data.repository?.pullRequests.nodes || []).map(mapPullRequest);
  }

  async statuses(repo: RepoRef, shas: string[]): Promise<Record<string, CiStatus>> {
    const result: Record<string, CiStatus> = {};
    // SHAs are interpolated into the query, so only accept full hex object ids.
    shas = shas.filter(s => /^[0-9a-f]{40}$/.test(s));
    const batches: string[][] = [];
    for (let i = 0; i < shas.length; i += BATCH) batches.push(shas.slice(i, i + BATCH));
    await Promise.all(
      batches.map(async batch => {
        const fields = batch.map((sha, j) => `c${j}: object(oid: "${sha}") { ... on Commit { statusCheckRollup { state ${CONTEXTS} } } }`).join('\n');
        const q = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
        const data = await this.graphql<{ repository: Record<string, { statusCheckRollup: GqlRollup | null } | null> | null }>(repo.host, q, {
          owner: repo.owner,
          name: repo.repo,
        });
        batch.forEach((sha, j) => {
          const s = mapRollup(data.repository?.[`c${j}`]?.statusCheckRollup);
          if (s) result[sha] = s;
        });
      })
    );
    return result;
  }
}
