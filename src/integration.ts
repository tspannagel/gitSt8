import * as vscode from 'vscode';
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
  private readonly github = new GitHubClient(host => this.githubAuth(host));
  private readonly azure = new AzureDevOpsClient(repo => this.azureAuth(repo.owner, false));
  private readonly statusCache = new Map<string, Cached<CiStatus | null>>();
  private readonly prCache = new Map<string, Cached<PullRequest[]>>();
  /** Providers the user explicitly asked to sign in to during this load. */
  private interactive = new Set<ProviderId>();
  /** Entra tenant per Azure DevOps organization (undefined: Microsoft-account org or unknown). */
  private readonly tenants = new Map<string, string | undefined>();
  /** Microsoft account used for the last Azure DevOps token, to name it when the service refuses it. */
  private azureAccount?: string;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly secrets: vscode.SecretStorage) {
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

  private async githubAuth(host: string, interactive = false): Promise<string> {
    const ask = interactive || this.interactive.has('github');
    const providerId = host === 'github.com' ? 'github' : 'github-enterprise';
    const session = await vscode.authentication.getSession(providerId, ['repo'], ask ? { createIfNone: true } : { silent: true });
    if (!session) throw new AuthError('Not signed in to GitHub.');
    return `Bearer ${session.accessToken}`;
  }

  /** `org` empty: any organization (the all-organizations PAT, or a token of the home tenant). */
  private async azureAuth(org: string, interactive: boolean, pickAccount = true): Promise<string> {
    const pat = (org && (await this.secrets.get(`${PAT_KEY}:${org.toLowerCase()}`))) || (await this.secrets.get(PAT_KEY));
    if (pat) {
      this.azureAccount = undefined;
      return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
    }
    const ask = interactive || this.interactive.has('azure');
    const tenant = org ? await this.azureTenant(org) : undefined;
    const scopes = [AZURE_DEVOPS_SCOPE, ...(tenant ? [`VSCODE_TENANT:${tenant}`] : [])];
    // On an explicit sign-in, let the user pick the account instead of silently reusing the remembered one,
    // which may be the wrong account and would make the button appear to do nothing.
    const session = await vscode.authentication.getSession('microsoft', scopes, ask ? { createIfNone: true, clearSessionPreference: pickAccount } : { silent: true });
    this.azureAccount = session?.account.label;
    if (!session) throw new AuthError('Not signed in to Azure DevOps.');
    return `Bearer ${session.accessToken}`;
  }

  /** Entra tenant of an Azure DevOps organization, looked up once. Lookup failures are retried on the next load. */
  private async azureTenant(org: string): Promise<string | undefined> {
    const key = org.toLowerCase();
    if (this.tenants.has(key)) return this.tenants.get(key);
    try {
      const tenant = await resourceTenant(org);
      this.tenants.set(key, tenant);
      return tenant;
    } catch {
      return undefined;
    }
  }

  async signIn(provider: ProviderId): Promise<void> {
    this.interactive.add(provider);
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
    this.statusCache.clear();
    this.prCache.clear();
    this.changed.fire();
  }

  // ---------------------------------------------------------------- clone sources (explicit user action, may prompt to sign in)

  /** GitHub repositories of the signed-in account on `host` (github.com or a GitHub Enterprise host). */
  async githubRepos(host: string): Promise<HostedRepo[]> {
    await this.githubAuth(host, true);
    return this.github.repositories(host);
  }

  /** Azure DevOps organizations of the signed-in account. Lets the user pick the Microsoft account. */
  async azureOrganizations(): Promise<string[]> {
    return listOrganizations(await this.azureAuth('', true));
  }

  async azureRepos(org: string): Promise<HostedRepo[]> {
    return listRepositories(org, await this.azureAuth(org, true, false));
  }

  // ---------------------------------------------------------------- writes

  /** Opens a pull request. Only call on explicit user action. Signs in interactively if needed. */
  async createPullRequest(repo: RepoRef, input: NewPullRequest): Promise<PullRequest> {
    this.interactive.add(repo.provider);
    try {
      const pr = await this.client(repo.provider).createPullRequest(repo, input);
      this.invalidate();
      return pr;
    } finally {
      this.interactive.delete(repo.provider);
    }
  }

  // ---------------------------------------------------------------- data

  private client(p: ProviderId): ProviderClient {
    return p === 'github' ? this.github : this.azure;
  }

  /**
   * Loads PRs and CI status for `shas`. Cached results are reused; only stale or unknown commits are requested.
   * Never throws: problems are reported in `error` / `signedIn`.
   */
  async load(remote: string, repo: RepoRef, shas: string[], force = false): Promise<IntegrationState> {
    const key = repoLabel(repo).toLowerCase();
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
    const client = this.client(repo.provider);
    const now = Date.now();
    // Drop entries no TTL would accept any more, so the cache does not grow with every commit ever shown.
    for (const [k, v] of this.statusCache) if (now - v.at > STATUS_TTL_MS) this.statusCache.delete(k);
    try {
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
      if (e instanceof AuthError) {
        state.signedIn = false;
        const account = repo.provider === 'azure' && this.azureAccount ? ` Signed in as ${this.azureAccount}; this account may have no access to '${repo.owner}'.` : '';
        state.error = this.interactive.has(repo.provider) ? e.message + account : `Sign in to ${providerName(repo.provider)} to see pull requests and pipeline status.`;
      } else {
        state.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.interactive.delete(repo.provider);
    }
    return state;
  }
}
