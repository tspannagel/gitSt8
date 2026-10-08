// Subset of the built-in vscode.git extension API (extensions/git/src/api/git.d.ts) used by gitSt8.
import { Event, Uri } from 'vscode';

export interface GitExtension {
  getAPI(version: 1): API;
}

export interface Change {
  readonly uri: Uri;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly remotes: Remote[];
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly untrackedChanges?: Change[];
  readonly onDidChange: Event<void>;
}

export interface FetchOptions {
  remote?: string;
  ref?: string;
  all?: boolean;
  prune?: boolean;
  depth?: number;
}

export interface CommitOptions {
  all?: boolean | 'tracked';
  amend?: boolean;
  noVerify?: boolean;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  fetch(options?: FetchOptions): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  commit(message: string, opts?: CommitOptions): Promise<void>;
}

export interface API {
  readonly state: 'uninitialized' | 'initialized';
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  toGitUri(uri: Uri, ref: string): Uri;
  getRepository(uri: Uri): Repository | null;
}
