import { AuthError, RepoRef } from './providers/types';

export interface Account { id: string; label: string }
export interface Session { account: Account; accessToken: string }
export interface AccountState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}
export interface SessionOptions {
  silent?: boolean;
  createIfNone?: boolean;
  clearSessionPreference?: boolean;
  account?: Account;
}
export interface AccountAuth {
  getSession(provider: string, scopes: string[], options: SessionOptions): PromiseLike<Session | undefined>;
  getAccounts?(provider: string): PromiseLike<readonly Account[]>;
}

/** Identity boundary for preferences: Enterprise hosts and Azure tenants never share defaults. */
export function accountScope(repo: RepoRef, tenant?: string): string {
  return JSON.stringify([repo.provider, repo.host.toLowerCase(), repo.provider === 'azure' ? tenant || repo.owner.toLowerCase() : '']);
}

/** Stores only account IDs. Interactive requests are deduplicated by target and serialized per auth provider. */
export class Accounts {
  private readonly pending = new Map<string, Promise<Session>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly state: AccountState, private readonly auth: AccountAuth) {}

  private key(scope: string, root?: string): string {
    return `gitst8.account:${JSON.stringify([scope, root || 'workspace-default'])}`;
  }

  accountId(scope: string, root?: string): string | undefined {
    return (root && this.state.get<string>(this.key(scope, root))) || this.state.get<string>(this.key(scope));
  }

  session(provider: string, scopes: string[], scope: string, root?: string, action: 'silent' | 'signin' | 'change' | 'default' = 'silent'): Promise<Session> {
    const id = this.accountId(scope, root);
    const key = JSON.stringify([provider, scopes, scope, root, action, id]);
    const hit = this.pending.get(key);
    if (hit) return hit;
    const run = async (): Promise<Session> => {
      const id = this.accountId(scope, root); // earlier queued selections may have changed the default
      const interactive = action !== 'silent';
      const picking = action === 'change' || action === 'default';
      let account: Account | undefined;
      if (id && !picking) {
        const accounts = await this.auth.getAccounts?.(provider);
        account = accounts?.find(a => a.id === id) || { id, label: id };
        if (!interactive && accounts && !accounts.some(a => a.id === id)) throw new AuthError('The associated account is no longer signed in. Change account for this repository or sign in to that account in VS Code Accounts.');
      }
      const session = await this.auth.getSession(provider, scopes, interactive
        ? { createIfNone: true, ...(picking ? { clearSessionPreference: true } : {}), ...(account ? { account } : {}) }
        : { silent: true, ...(account ? { account } : {}) });
      if (!session) throw new AuthError('No credentials available. Sign in to see pull requests and pipeline status.');
      // Older VS Code versions can ignore the account option: never silently use a different identity.
      if (id && !picking && session.account.id !== id) throw new AuthError('VS Code returned a different account. Change account for this repository (account-specific sign-in requires a recent VS Code version).');
      if (interactive && (picking || !id)) await this.state.update(this.key(scope, action === 'default' ? undefined : root), session.account.id);
      return session;
    };
    const previous = action === 'silent' ? Promise.resolve() : this.queues.get(provider) || Promise.resolve();
    const promise = previous.catch(() => undefined).then(run);
    if (action !== 'silent') {
      this.queues.set(provider, promise);
      void promise.finally(() => { if (this.queues.get(provider) === promise) this.queues.delete(provider); }).catch(() => undefined);
    }
    this.pending.set(key, promise);
    void promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); }).catch(() => undefined);
    return promise;
  }
}
