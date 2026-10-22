import * as vscode from 'vscode';
import { Accounts, AccountAuth, accountScope, Session } from './accounts';
import { HttpError } from './providers/http';
import { RemoteInfo } from './git';
import { AZURE_DEVOPS_SCOPE, AzureDevOpsClient, listOrganizations, listRepositories, resourceTenant } from './providers/azure';
import { parseRemoteUrl, repoLabel } from './providers/detect';
import { GitHubClient } from './providers/github';
import { AuthError, CiStatus, HostedRepo, NewPullRequest, ProviderClient, ProviderId, PullRequest, RepoRef } from './providers/types';

/** What the webview needs to show hosting-service information. */
export interface IntegrationState {
  provider: ProviderId;
  remote: string;
  label: string;
  webUrl: string;
  /** Where pipelines / Actions live in the browser. */
  ciUrl: string;
  prsUrl: string;
  signedIn: boolean;
  error?: string;
  account?: string;
  statuses: Record<string, CiStatus>;
  prs: PullRequest[];
}

const PAT_KEY = 'gitst8.azurePat';
const STATUS_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 30_000;
const PR_TTL_MS = 60_000;

interface Cached<T> {
  value: T;
  at: number;
}

const providerName = (p: ProviderId) => (p === 'github' ? 'GitHub' : 'Azure DevOps');

/**
 * Talks to GitHub / Azure DevOps for the repository behind a git remote.
 * Sign-in uses VS Code's built-in accounts (GitHub, Microsoft); Azure DevOps can also use a PAT.
 */
export class Integrations {
  private readonly accounts: Accounts;
  private generation = 0;
  private readonly statusCache = new Map<string, Cached<CiStatus | null>>();
  private readonly prCache = new Map<string, Cached<PullRequest[]>>();
  /** Entra tenant per Azure DevOps organization (undefined: Microsoft-account org or unknown). */
  private readonly tenants = new Map<string, string | undefined>();
  private readonly tenantRequests = new Map<string, Promise<string | undefined>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly secrets: vscode.SecretStorage, workspaceState: vscode.Memento) {
    // Newer stable VS Code supports getAccounts/account. Keep the 1.90 typings and fail closed
    // on older hosts rather than silently replacing a repository's associated identity.
    this.accounts = new Accounts(workspaceState, vscode.authentication as unknown as AccountAuth);
    this.disposables.push(
      vscode.authentication.onDidChangeSessions(e => {
        if (['github', 'github-enterprise', 'microsoft'].includes(e.provider.id)) this.invalidate();
      })
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  // ---------------------------------------------------------------- detection

  githubHosts(): string[] {
    const ghe = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
    try {
      return ghe ? [new URL(ghe).host] : [];
    } catch {
      return [];
    }
  }

  /** Picks the remote to integrate with: configured, else origin, else the first supported one. */
  detect(remotes: RemoteInfo[]): { remote: string; repo: RepoRef } | null {
    const configured = vscode.workspace.getConfiguration('gitst8').get<string>('integrations.remote');
    const hosts = this.githubHosts();
    const parse = (r: RemoteInfo) => parseRemoteUrl(r.fetchUrl || r.pushUrl, hosts);
    const ordered = [
      ...remotes.filter(r => r.name === configured),
      ...remotes.filter(r => r.name === 'origin'),
      ...remotes,
    ];
    for (const r of ordered) {
      const repo = parse(r);
      if (repo) return { remote: r.name, repo };
    }
    return null;
  }

  // ---------------------------------------------------------------- auth

  private async azurePat(org: string): Promise<string | undefined> {
    return (org && await this.secrets.get(`${PAT_KEY}:${org.toLowerCase()}`)) || await this.secrets.get(PAT_KEY);
  }

  /** Tenant discovery is unauthenticated, deduplicated, and failures never select the home tenant. */
  private azureTenant(org: string): Promise<string | undefined> {
    const key = org.toLowerCase();
    if (this.tenants.has(key)) return Promise.resolve(this.tenants.get(key));
    const hit = this.tenantRequests.get(key);
    if (hit) return hit;
    const request = resourceTenant(org).then(tenant => {
      this.tenants.set(key, tenant);
      return tenant;
    }, () => { throw new Error(`Could not resolve the Entra tenant for '${org}'. Retry or use an organization PAT.`); });
    this.tenantRequests.set(key, request);
    void request.finally(() => this.tenantRequests.delete(key)).catch(() => undefined);
    return request;
  }

  private async credentials(repo: RepoRef, root?: string, action: 'silent' | 'signin' | 'change' | 'default' = 'silent'): Promise<{ header: string; label: string; pat: boolean }> {
    if (repo.provider === 'azure') {
      const pat = await this.azurePat(repo.owner);
      if (pat) {
        if (action === 'change' || action === 'default') throw new Error('An Azure DevOps PAT takes precedence over accounts. Remove the organization PAT and/or all-organizations PAT using gitSt8: Remove Azure DevOps Personal Access Token, then choose an account.');
        return { header: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, label: 'Azure DevOps PAT', pat: true };
      }
    }
    const tenant = repo.provider === 'azure' && repo.owner ? await this.azureTenant(repo.owner) : undefined;
    const provider = repo.provider === 'azure' ? 'microsoft' : repo.host === 'github.com' ? 'github' : 'github-enterprise';
    const scopes = repo.provider === 'azure' ? [AZURE_DEVOPS_SCOPE, ...(tenant ? [`VSCODE_TENANT:${tenant}`] : [])] : ['repo'];
    const session: Session = await this.accounts.session(provider, scopes, accountScope(repo, tenant), root, action);
    return { header: `Bearer ${session.accessToken}`, label: session.account.label, pat: false };
  }

  async signIn(repo: RepoRef, root?: string, action: 'signin' | 'change' | 'default' = 'signin'): Promise<void> {
    await this.credentials(repo, root, action);
    this.invalidate();
  }

  async setAzurePat(org?: string): Promise<boolean> {
    const pat = await vscode.window.showInputBox({
      prompt: org
        ? `Azure DevOps personal access token for '${org}' (scopes: Code read, Build read; Code read & write to create pull requests)`
        : 'Azure DevOps personal access token (scopes: Code read, Build read). Used for every organization without its own token.',
      password: true,
      ignoreFocusOut: true,
    });
    if (!pat) return false;
    await this.secrets.store(org ? `${PAT_KEY}:${org.toLowerCase()}` : PAT_KEY, pat.trim());
    this.invalidate();
    return true;
  }

  async clearAzurePat(org?: string): Promise<void> {
    await this.secrets.delete(org ? `${PAT_KEY}:${org.toLowerCase()}` : PAT_KEY);
    this.invalidate();
  }

  invalidate(): void {
    this.generation++;
    this.statusCache.clear();
    this.prCache.clear();
    this.changed.fire();
  }

  // ---------------------------------------------------------------- clone sources (explicit user action, may prompt to sign in)

  /** GitHub repositories of the signed-in account on `host` (github.com or a GitHub Enterprise host). */
  async githubRepos(host: string): Promise<HostedRepo[]> {
    const repo: RepoRef = { provider: 'github', host, owner: '', repo: '', webUrl: `https://${host}` };
    const auth = await this.credentials(repo, undefined, 'signin');
    return new GitHubClient(async () => auth.header).repositories(host);
  }

  async azureOrganizations(): Promise<string[]> {
    return listOrganizations((await this.credentials({ provider: 'azure', host: 'dev.azure.com', owner: '', repo: '', webUrl: '' }, undefined, 'signin')).header);
  }

  async azureRepos(org: string): Promise<HostedRepo[]> {
    const repo: RepoRef = { provider: 'azure', host: 'dev.azure.com', owner: org, repo: '', webUrl: '' };
    return listRepositories(org, (await this.credentials(repo, undefined, 'signin')).header);
  }

  // ---------------------------------------------------------------- writes

  /** One explicit authentication, reused across all requests in this operation. */
  async createPullRequest(repo: RepoRef, input: NewPullRequest, root?: string): Promise<PullRequest> {
    const auth = await this.credentials(repo, root, 'signin');
    try {
      const pr = await this.client(repo.provider, auth.header).createPullRequest(repo, input);
      this.invalidate();
      return pr;
    } catch (e) {
      throw new Error(this.failure(e, repo, auth));
    }
  }

  // ---------------------------------------------------------------- data

  private client(p: ProviderId, header: string): ProviderClient {
    return p === 'github' ? new GitHubClient(async () => header) : new AzureDevOpsClient(async () => header);
  }

  private failure(e: unknown, repo: RepoRef, auth?: { label: string; pat: boolean }): string {
    const message = e instanceof Error ? e.message : String(e);
    if (auth?.pat && (e instanceof AuthError || e instanceof HttpError && e.status === 403)) {
      return `${message} Azure DevOps PAT takes precedence over Microsoft accounts. Check expiry, organization access and Code read / Build read scopes (Code Read & write for PR creation), or replace/remove the organization or all-organizations PAT.`;
    }
    if (e instanceof AuthError || e instanceof HttpError && e.status === 403) {
      return `${message}${auth ? ` Using ${auth.label} for ${providerName(repo.provider)} '${repoLabel(repo)}'.` : ''} ${e instanceof AuthError ? 'Sign in or change account for this repository.' : 'Check repository/project permissions and token scopes, organization membership and SSO authorization, or change account for this repository.'}`;
    }
    return message;
  }

  /**
   * Loads PRs and CI status for `shas`. Cached results are reused; only stale or unknown commits are requested.
   * Never throws: problems are reported in `error` / `signedIn`.
   */
  async load(remote: string, repo: RepoRef, shas: string[], force = false, root?: string): Promise<IntegrationState> {
    const key = JSON.stringify([root, repo.provider, repo.host.toLowerCase(), repoLabel(repo).toLowerCase(), this.generation]);
    const state: IntegrationState = {
      provider: repo.provider,
      remote,
      label: repoLabel(repo),
      webUrl: repo.webUrl,
      ciUrl: repo.provider === 'github' ? `${repo.webUrl}/actions` : repo.webUrl.replace(/\/_git\/.*$/, '/_build'),
      prsUrl: repo.provider === 'github' ? `${repo.webUrl}/pulls` : `${repo.webUrl}/pullrequests`,
      signedIn: true,
      statuses: {},
      prs: [],
    };
    let auth: { header: string; label: string; pat: boolean } | undefined;
    const now = Date.now();
    // Drop entries no TTL would accept any more, so the cache does not grow with every commit ever shown.
    for (const [k, v] of this.statusCache) if (now - v.at > STATUS_TTL_MS) this.statusCache.delete(k);
    try {
      auth = await this.credentials(repo, root);
      state.account = auth.label;
      const client = this.client(repo.provider, auth.header);
      const prHit = this.prCache.get(key);
      if (!force && prHit && now - prHit.at < PR_TTL_MS) state.prs = prHit.value;
      else {
        state.prs = await client.pullRequests(repo);
        this.prCache.set(key, { value: state.prs, at: now });
      }

      const wanted = [...new Set([...shas, ...state.prs.map(p => p.headSha).filter((s): s is string => !!s)])];
      const stale = wanted.filter(sha => {
        const hit = this.statusCache.get(`${key}:${sha}`);
        if (!hit || force) return true;
        const ttl = hit.value?.state === 'pending' ? PENDING_TTL_MS : STATUS_TTL_MS;
        return now - hit.at > ttl;
      });
      if (stale.length) {
        const fresh = await client.statuses(repo, stale);
        for (const sha of stale) this.statusCache.set(`${key}:${sha}`, { value: fresh[sha] || null, at: now });
      }
      for (const sha of wanted) {
        const s = this.statusCache.get(`${key}:${sha}`)?.value;
        if (s) state.statuses[sha] = s;
      }
      for (const pr of state.prs) if (!pr.ci && pr.headSha && state.statuses[pr.headSha]) pr.ci = state.statuses[pr.headSha].state;
    } catch (e) {
      state.signedIn = !(e instanceof AuthError);
      state.error = this.failure(e, repo, auth);
    }
    return state;
  }
}
