export type ProviderId = 'github' | 'azure';

/** A repository on a hosting service, derived from a git remote URL. */
export interface RepoRef {
  provider: ProviderId;
  /** API host, e.g. github.com, a GitHub Enterprise host, or dev.azure.com. */
  host: string;
  /** GitHub owner, or Azure DevOps organization. */
  owner: string;
  /** Azure DevOps project. */
  project?: string;
  repo: string;
  /** Browser URL of the repository. */
  webUrl: string;
}

export type CiState = 'success' | 'failure' | 'pending' | 'cancelled' | 'neutral' | 'skipped';

export interface CiCheck {
  name: string;
  state: CiState;
  url?: string;
}

export interface CiStatus {
  state: CiState;
  checks: CiCheck[];
}

export type ReviewState = 'approved' | 'changes' | 'required' | 'none';

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  /** Head commit of the source branch, when the provider reports it. */
  headSha?: string;
  review: ReviewState;
  ci?: CiState;
  fromFork: boolean;
}

/** Authorization header value, e.g. "Bearer …" or "Basic …". */
export type AuthHeader = string;

export interface ProviderClient {
  pullRequests(repo: RepoRef): Promise<PullRequest[]>;
  /** CI status per commit; commits without any CI are left out. */
  statuses(repo: RepoRef, shas: string[]): Promise<Record<string, CiStatus>>;
}

export class AuthError extends Error {}
