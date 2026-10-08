import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Commit, FileChange, GitCli, Head, LocalBranch, OpState, Query, QueryKind, Refs, StackEntry, StatusEntry, Worktree, EMPTY_TREE, appendIgnore, ignorePattern, splitRemoteRef } from './git';
import { layout } from './graph';
import { Integrations, IntegrationState } from './integration';
import { ProviderId } from './providers/types';
import type { API, Repository } from './types/git';

const PAGE = 400;
/** How far "reveal" loads history to find a commit; older commits are shown in the details pane only. */
const REVEAL_LIMIT = 5000;
/** Scratch folder (inside the git dir) for rebase todo and reword message files. */
const REBASE_DIR = 'gitst8-rebase';
const REBASE_ACTIONS = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);
/**
 * Message fields that end up as git arguments. They must never look like an option (e.g. `--upload-pack=…`),
 * so a webview bug cannot turn into arbitrary git options. File paths are always passed after `--` instead.
 */
const ARG_FIELDS = ['sha', 'shas', 'ref', 'onto', 'name', 'remote', 'branch', 'newBranch', 'a', 'b', 'left', 'right', 'from', 'base', 'hash', 'parents'];
const looksLikeOption = (v: unknown) => (Array.isArray(v) ? v : [v]).some(x => typeof x === 'string' && x.startsWith('-'));
const short = (s: string | null | undefined) => (s && /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : s || '');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const shQuote = (p: string) => `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
const samePath = (a: string, b: string) => {
  const n = (p: string) => path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const config = () => vscode.workspace.getConfiguration('gitst8');
// VS Code ships its icon font; reusing it keeps the icons identical to the rest of the workbench.
const CODICON_DIR = path.join(vscode.env.appRoot, 'out', 'media');

const VIEW_ID = 'gitst8.view';
const resourceRoots = (context: vscode.ExtensionContext) => [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.file(CODICON_DIR)];

/** A message from the webview: `{type: 'x', ...}` is handled by `on_x`. Payloads are loosely typed on purpose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;

/** Quick pick entry carrying the data an action needs. */
type PickItem = vscode.QuickPickItem & { id?: string; args?: string[]; mode?: string; value?: string };
/** Force-push strength: 'safe' = lease + if-includes, 'lease' = lease only, 'force' = unconditional. */
type ForceMode = 'safe' | 'lease' | 'force';
const FORCE_FLAGS: Record<ForceMode, string[]> = {
  safe: ['--force-with-lease', '--force-if-includes'],
  lease: ['--force-with-lease'],
  force: ['--force'],
};
const PULL_MODES: PickItem[] = [
  { label: 'Pull', description: 'repository default (pull.rebase / pull.ff config)', id: 'default' },
  { label: 'Pull --rebase', description: 'replay your commits on top of upstream', id: 'rebase', args: ['--rebase'] },
  { label: 'Pull --rebase --autostash', description: 'same, stashing local changes around it', id: 'autostash', args: ['--rebase', '--autostash'] },
  { label: 'Pull --ff-only', description: 'only fast-forward, never merge or rebase', id: 'ff', args: ['--ff-only'] },
  { label: 'Pull --no-rebase', description: 'merge upstream into your branch', id: 'merge', args: ['--no-rebase', '--no-edit'] },
];

/**
 * The UI can live in the bottom panel (a WebviewView, default) or in an editor tab (a WebviewPanel).
 * Both are wrapped in a small host object so RepoPanel does not care which one it runs in.
 */
interface Host {
  webview: vscode.Webview;
  reveal(): void;
  readonly visible: boolean;
  onDidDispose: vscode.Event<void>;
  onDidChangeVisibility: vscode.Event<unknown>;
}

export class RepoPanel {
  static current: RepoPanel | undefined;
  static pendingRoot: string | undefined;
  static waiters: ((p: RepoPanel) => void)[] = [];

  static async show(context: vscode.ExtensionContext, api: API, integrations: Integrations, root?: string): Promise<RepoPanel> {
    const cur = RepoPanel.current;
    if (cur) {
      cur.host.reveal();
      if (root && !samePath(root, cur.root || '')) cur.setRoot(root);
      return cur;
    }
    if (config().get('location') === 'editor') {
      const panel = vscode.window.createWebviewPanel('gitst8', 'gitSt8', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots(context),
      });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
      const host: Host = {
        webview: panel.webview,
        reveal: () => panel.reveal(),
        get visible() {
          return panel.visible;
        },
        onDidDispose: panel.onDidDispose,
        onDidChangeVisibility: panel.onDidChangeViewState,
      };
      return RepoPanel.adopt(new RepoPanel(host, context, api, integrations, root));
    }
    // Focusing the panel view makes VS Code resolve it, which creates the RepoPanel (see register()).
    RepoPanel.pendingRoot = root;
    const created = new Promise<RepoPanel>(resolve => RepoPanel.waiters.push(resolve));
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    return RepoPanel.current || created;
  }

  static adopt(p: RepoPanel): RepoPanel {
    if (RepoPanel.current && RepoPanel.current !== p) RepoPanel.current.dispose();
    RepoPanel.current = p;
    RepoPanel.waiters.splice(0).forEach(resolve => resolve(p));
    return p;
  }

  /** Registers the bottom-panel view. */
  static register(context: vscode.ExtensionContext, api: API, integrations: Integrations): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      {
        resolveWebviewView(view) {
          view.webview.options = { enableScripts: true, localResourceRoots: resourceRoots(context) };
          const host: Host = {
            webview: view.webview,
            reveal: () => view.show(false),
            get visible() {
              return view.visible;
            },
            onDidDispose: view.onDidDispose,
            onDidChangeVisibility: view.onDidChangeVisibility,
          };
          const root = RepoPanel.pendingRoot;
          RepoPanel.pendingRoot = undefined;
          RepoPanel.adopt(new RepoPanel(host, context, api, integrations, root));
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    );
  }

  root: string | undefined;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private limit = PAGE;
  private showAll = true;
  private query: Query | null = null;
  private tagSync: { remote: string; tags: Record<string, string> } | null = null;
  private splitting: { sha: string; subject: string } | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly gits = new Map<string, GitCli>();
  private repoSubs?: vscode.Disposable[];
  private refreshTimer?: NodeJS.Timeout;
  private pickerTimer?: NodeJS.Timeout;
  private ciTimer?: NodeJS.Timeout;
  private refreshing: Promise<void> | null = null;
  private pending = false;
  /** A refresh was skipped while the view was hidden. */
  private stale = false;
  private preparingRebase = false;
  private lastMessage?: { sha: string; message: string };
  private lastHead?: Head;
  private lastRefs?: Refs;
  private lastBase: string | null = null;
  private lastCommits?: Commit[];
  private lastWorktrees?: Worktree[];
  private lastStack?: StackEntry[];
  private lastIntegration: IntegrationState | null = null;
  private integrationSeq = 0;

  constructor(
    readonly host: Host,
    private readonly context: vscode.ExtensionContext,
    private readonly api: API,
    private readonly integrations: Integrations,
    root?: string
  ) {
    this.root = root || this.defaultRoot();
    this.ready = new Promise(resolve => (this.resolveReady = resolve));

    host.webview.html = this.html();
    host.onDidDispose(() => this.dispose(), null, this.disposables);
    host.webview.onDidReceiveMessage((m: Msg) => this.onMessage(m), null, this.disposables);
    host.onDidChangeVisibility(() => {
      if (!host.visible) return;
      if (this.stale) this.scheduleRefresh(0);
      else this.scheduleIntegration(0);
    }, null, this.disposables);
    integrations.onDidChange(() => this.scheduleIntegration(0, true), null, this.disposables);
    api.onDidOpenRepository(() => {
      this.watchRepo();
      if (!this.root) this.setRoot(this.defaultRoot());
      else this.scheduleRefresh();
    }, null, this.disposables);
    api.onDidCloseRepository(() => {
      this.watchRepo();
      if (!this.repo) this.setRoot(this.defaultRoot());
      else this.scheduleRefresh();
    }, null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('gitst8') && this.scheduleRefresh(), null, this.disposables);
    this.watchRepo();
  }

  dispose(): void {
    if (RepoPanel.current === this) RepoPanel.current = undefined;
    this.repoSubs?.forEach(d => d.dispose());
    clearTimeout(this.refreshTimer);
    clearTimeout(this.pickerTimer);
    clearTimeout(this.ciTimer);
    this.disposables.forEach(d => d.dispose());
  }

  // ---------------------------------------------------------------- hosting service integration

  /** Loads PRs and CI status in the background, after the graph is already shown. */
  scheduleIntegration(delay = 0, force = false): void {
    clearTimeout(this.ciTimer);
    this.ciTimer = setTimeout(() => this.loadIntegration(force), delay);
  }

  private async loadIntegration(force = false): Promise<void> {
    if (!this.root || !this.lastRefs || !config().get('integrations.enabled', true)) {
      if (this.lastIntegration) this.post({ type: 'integration', state: (this.lastIntegration = null) });
      return;
    }
    const target = this.integrations.detect(this.refs().remoteInfo);
    if (!target) {
      this.lastIntegration = null;
      return this.post({ type: 'integration', state: null });
    }
    const n = config().get<number>('integrations.commitsToCheck', 60);
    const tips = [...this.refs().local.map(b => b.sha), ...this.refs().remote.filter(r => r.remote === target.remote).map(r => r.sha)];
    const shas = [...new Set([...(this.lastCommits || []).filter(c => !c.wip).slice(0, n).map(c => c.hash), ...tips])];
    const seq = ++this.integrationSeq;
    const state = await this.integrations.load(target.remote, target.repo, shas, force);
    if (seq !== this.integrationSeq) return; // a newer load started meanwhile
    this.lastIntegration = state;
    this.post({ type: 'integration', state });
    // Keep polling while something is running and the view is visible.
    const running = Object.values(state.statuses).some(s => s.state === 'pending');
    if (running && this.host.visible) this.scheduleIntegration(30_000);
  }

  async on_signIn(m: Msg): Promise<void> {
    if (m.provider === 'github' || m.provider === 'azure') await this.integrations.signIn(m.provider as ProviderId);
  }

  async on_setAzurePat(m: Msg): Promise<void> {
    await this.integrations.setAzurePat(m.org);
  }

  on_refreshIntegration(): void {
    this.scheduleIntegration(0, true);
  }

  async on_openExternal(m: Msg): Promise<void> {
    const url = String(m.url || '');
    if (/^https:\/\//i.test(url)) await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // ---------------------------------------------------------------- repo plumbing

  defaultRoot(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const repo = (uri && this.api.getRepository(uri)) || this.api.repositories[0];
    return repo?.rootUri.fsPath;
  }

  get repo(): Repository | undefined {
    const root = this.root;
    return root ? this.api.repositories.find(r => samePath(r.rootUri.fsPath, root)) : undefined;
  }

  /** The shown repository; actions are only reachable when one is open. */
  requireRepo(): Repository {
    const r = this.repo;
    if (!r) throw new Error('No repository is open.');
    return r;
  }

  requireRoot(): string {
    if (!this.root) throw new Error('No repository is open.');
    return this.root;
  }

  git(): GitCli {
    const root = this.requireRoot();
    let g = this.gits.get(root);
    if (!g) this.gits.set(root, (g = new GitCli(this.api.git.path, root)));
    return g;
  }

  refs(): Refs {
    if (!this.lastRefs) throw new Error('Repository not loaded yet.');
    return this.lastRefs;
  }

  setRoot(root: string | undefined): void {
    this.root = root;
    this.limit = PAGE;
    this.query = null;
    this.tagSync = null;
    this.splitting = null;
    this.lastIntegration = null;
    this.watchRepo();
    this.post({ type: 'reset' });
    this.scheduleRefresh(0);
  }

  /** Full refresh for the shown repo; other repos only update their entry in the picker. */
  watchRepo(): void {
    this.repoSubs?.forEach(d => d.dispose());
    this.repoSubs = this.api.repositories.map(r =>
      r.state.onDidChange(() => (this.root && samePath(r.rootUri.fsPath, this.root) ? this.scheduleRefresh() : this.schedulePickerUpdate()))
    );
  }

  schedulePickerUpdate(): void {
    clearTimeout(this.pickerTimer);
    this.pickerTimer = setTimeout(() => this.post({ type: 'repos', repos: this.repoList(), root: this.root }), 500);
  }

  post(msg: object): void {
    this.host.webview.postMessage(msg);
  }

  scheduleRefresh(delay = 400): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delay);
  }

  refresh(): Promise<void> {
    // Nothing to show while hidden: catch up once the view becomes visible again.
    if (!this.host.visible) {
      this.stale = true;
      return Promise.resolve();
    }
    this.stale = false;
    if (this.refreshing) {
      this.pending = true;
      return this.refreshing;
    }
    this.refreshing = this.collect()
      .catch(e => this.post({ type: 'error', text: errText(e) }))
      .finally(() => {
        this.refreshing = null;
        if (this.pending) {
          this.pending = false;
          this.scheduleRefresh(0);
        }
      });
    return this.refreshing;
  }

  /** Open repositories for the picker, with branch and pending-change counts. */
  repoList(): { root: string; name: string; rel: string; branch: string; changes: number }[] {
    const repos = this.api.repositories.map(r => {
      const s = r.state;
      const changes = s.workingTreeChanges.length + s.indexChanges.length + s.mergeChanges.length + (s.untrackedChanges?.length || 0);
      return {
        root: r.rootUri.fsPath,
        name: path.basename(r.rootUri.fsPath),
        rel: vscode.workspace.asRelativePath(r.rootUri, true),
        branch: s.HEAD?.name || (s.HEAD?.commit ? s.HEAD.commit.slice(0, 7) : ''),
        changes,
      };
    });
    // Disambiguate repos with the same folder name (e.g. nested repos in a multi-root workspace).
    for (const r of repos) if (repos.filter(o => o.name === r.name).length > 1) r.name = r.rel;
    return repos.sort((a, b) => a.name.localeCompare(b.name));
  }

  async collect(): Promise<void> {
    const repos = this.repoList();
    const root = this.root;
    if (!root || !repos.some(r => samePath(r.root, root))) {
      if (repos.length && !root) this.setRoot(repos[0].root);
      this.post({ type: 'data', data: { repos, root, empty: true } });
      return;
    }
    const git = this.git();
    const base = await git.defaultBase(config().get<string>('stackBase'));
    const [log, refs, stashes, status, op, head, worktrees, stack] = await Promise.all([
      git.log({ limit: this.limit, all: this.showAll, query: this.query }),
      git.refs(),
      git.stashes(),
      git.status(),
      git.opState(),
      git.head(),
      git.worktrees(),
      base ? git.stack(base) : Promise.resolve([] as StackEntry[]),
    ]);
    if (!op) this.splitting = null;
    // Remove rebase scratch files once no rebase uses them. Checked synchronously right before deleting,
    // because a rebase may have started (or stopped) while the queries above ran.
    const gitDir = await git.gitDir().catch(() => null);
    if (gitDir && !this.preparingRebase && !fs.existsSync(path.join(gitDir, 'rebase-merge'))) {
      fs.rmSync(path.join(gitDir, REBASE_DIR), { recursive: true, force: true });
    }
    // Sent with every refresh, so an open commit box updates without another round trip.
    const wip = await this.wipDetails(status, head);

    const commits = log.commits;
    if (this.query) {
      // Search results are not a connected history: draw them as one line.
      commits.forEach((c, i) => (c.graphParents = commits[i + 1] ? [commits[i + 1].hash] : []));
    } else if (status.length) {
      const staged = status.filter(f => f.x !== ' ' && f.x !== '?').length;
      const unstaged = status.filter(f => f.y !== ' ').length;
      commits.unshift({
        hash: 'WIP',
        parents: head.sha ? [head.sha] : [],
        author: '',
        date: Math.floor(Date.now() / 1000),
        subject: `Uncommitted changes · ${staged} staged · ${unstaged} unstaged`,
        wip: true,
      });
    }
    const g = layout(commits);
    this.lastHead = head;
    this.lastRefs = refs;
    this.lastBase = base;
    this.lastCommits = commits;
    this.lastWorktrees = worktrees;
    this.lastStack = stack;
    this.post({
      type: 'data',
      data: {
        repos,
        root,
        head,
        commits,
        rows: g.rows,
        maxLanes: g.maxLanes,
        refs,
        stashes,
        op: op && { ...op, splitting: this.splitting },
        hasMore: log.hasMore,
        showAll: this.showAll,
        query: this.query,
        tagSync: this.tagSync,
        worktrees,
        stack,
        base,
        staleDays: config().get('staleBranchDays', 60),
        integration: this.lastIntegration,
        wip,
      },
    });
    this.scheduleIntegration(0);
  }

  /**
   * Runs a mutating operation with progress, turning conflicts into a hint instead of an error.
   * @param notify show a notification progress instead of the status bar one
   * @returns whether the operation succeeded
   */
  async runOp(label: string, fn: () => Promise<unknown>, notify = false): Promise<boolean> {
    this.post({ type: 'busy', busy: true, label });
    try {
      await vscode.window.withProgress(
        { location: notify ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title: label },
        fn
      );
      return true;
    } catch (e) {
      const op: OpState | null = await this.git().opState().catch(() => null);
      if (op && op.conflicts.length) {
        vscode.window.showWarningMessage(`${label}: stopped with ${op.conflicts.length} conflict(s). Resolve them, then use Continue or Abort in the gitSt8 banner.`);
      } else {
        vscode.window.showErrorMessage(`${label} failed: ${errText(e)}`);
      }
      return false;
    } finally {
      this.post({ type: 'busy', busy: false });
      this.scheduleRefresh(0);
    }
  }

  async confirm(message: string, detail: string | undefined, ...buttons: string[]): Promise<string | undefined> {
    return vscode.window.showWarningMessage(message, { modal: true, detail }, ...(buttons.length ? buttons : ['OK']));
  }

  localBranch(name: string) {
    return this.lastRefs?.local.find(b => b.name === name);
  }

  splitUpstream(upstream: string): { remote: string; branch: string } | null {
    return splitRemoteRef(upstream, this.lastRefs?.remotes || []);
  }

  /** Absolute path for a repository-relative path from the webview; refuses anything outside the repository. */
  inRepo(rel: string): string {
    const root = this.requireRoot();
    const abs = path.resolve(root, String(rel));
    const r = path.relative(root, abs);
    if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) throw new Error(`Not inside the repository: ${rel}`);
    return abs;
  }

  /** Worktree paths from the webview must be ones git listed. */
  requireWorktree(p: string): string {
    if (!this.lastWorktrees?.some(w => samePath(w.path, String(p)))) throw new Error(`Unknown worktree: ${p}`);
    return p;
  }

  async pickRemote(placeHolder = 'Select remote'): Promise<string | undefined> {
    const remotes = this.lastRefs?.remotes || [];
    if (!remotes.length) {
      vscode.window.showWarningMessage('This repository has no remotes.');
      return undefined;
    }
    if (remotes.length === 1) return remotes[0];
    return vscode.window.showQuickPick(remotes, { placeHolder });
  }

  currentName(): string {
    return this.lastHead?.branch || `detached ${short(this.lastHead?.sha) || 'HEAD'}`;
  }

  async requireCleanTree(what: string): Promise<boolean> {
    const dirty = (await this.git().status()).filter(f => f.status !== 'U');
    if (!dirty.length) return true;
    vscode.window.showWarningMessage(`${what} needs a clean working tree: commit or stash your ${dirty.length} changed file(s) first.`);
    return false;
  }

  /** Loads enough history to contain `sha` (if reachable), then selects it in the webview. */
  async revealCommit(sha: string | null, highlightPath?: string): Promise<void> {
    await this.ready;
    const git = this.git();
    if (sha && !this.lastCommits?.some(c => c.hash === sha)) {
      this.query = null;
      let limit = this.limit;
      for (;;) {
        const { commits, hasMore } = await git.log({ limit, all: this.showAll, query: null });
        if (commits.some(c => c.hash === sha) || !hasMore || limit >= REVEAL_LIMIT) break;
        limit *= 2;
      }
      this.limit = limit;
    }
    await this.collect();
    this.post({ type: 'reveal', sha: sha || 'WIP', path: highlightPath });
  }

  async setQuery(query: Query | null): Promise<void> {
    await this.ready;
    this.query = query && query.value ? query : null;
    this.limit = PAGE;
    await this.collect();
    const hl = query && (query.kind === 'path' || query.kind === 'any') ? query.value : null;
    this.post({ type: 'queryApplied', path: hl });
  }

  // ---------------------------------------------------------------- messages

  async onMessage(m: Msg): Promise<void> {
    const handler = (this as unknown as Record<string, unknown>)[`on_${m.type}`];
    if (typeof handler !== 'function') return;
    const bad = ARG_FIELDS.find(f => looksLikeOption(m[f]));
    if (bad) {
      vscode.window.showErrorMessage(`gitSt8: refused '${m.type}': ${bad} looks like a git option.`);
      return;
    }
    try {
      await handler.call(this, m);
    } catch (e) {
      vscode.window.showErrorMessage(`gitSt8: ${errText(e)}`);
    }
  }

  on_ready() {
    this.resolveReady();
    this.scheduleRefresh(0);
  }
  on_refresh() {
    this.scheduleRefresh(0);
  }
  on_selectRepo(m: Msg) {
    this.setRoot(m.root);
  }
  on_loadMore() {
    this.limit += PAGE;
    this.scheduleRefresh(0);
  }
  on_setShowAll(m: Msg) {
    this.showAll = !!m.value;
    this.scheduleRefresh(0);
  }
  async on_search(m: Msg) {
    if (!m.kind) return this.setQuery(null);
    const query: Query = { kind: m.kind as QueryKind, value: String(m.value) };
    if (m.kind === 'path') {
      // An existing path gets exact history (with rename following); anything else is a name search.
      const rel = query.value.replace(/\\/g, '/').replace(/^\.?\//, '');
      try {
        const st = fs.statSync(this.inRepo(rel));
        Object.assign(query, { value: rel, exact: true, isDir: st.isDirectory() });
      } catch {
        query.exact = (await this.git().tryRun(['log', '-1', '--format=%H', '--all', '--', rel])).trim() !== '';
        if (query.exact) query.value = rel;
      }
    }
    await this.setQuery(query);
  }
  async on_reveal(m: Msg) {
    await this.revealCommit(m.sha, m.path);
  }
  async on_copy(m: Msg) {
    await vscode.env.clipboard.writeText(m.text);
    vscode.window.setStatusBarMessage('gitSt8: copied to clipboard', 2000);
  }

  // ---- details & diffs

  async on_commitDetails(m: Msg) {
    const git = this.git();
    const c = await git.commit(m.sha);
    const left = c.parents[0] || EMPTY_TREE;
    const files = await git.diffFiles(left, c.hash);
    this.post({ type: 'details', details: { kind: 'commit', commit: c, files, left, right: c.hash } });
  }

  async on_wipDetails() {
    const git = this.git();
    const [files, head] = await Promise.all([git.status(), git.head()]);
    this.post({ type: 'details', details: await this.wipDetails(files, head) });
  }

  /** Staged / unstaged / conflicted files for the commit box, plus the last message for amending. */
  async wipDetails(files: StatusEntry[], head: Head) {
    const staged: FileChange[] = [], unstaged: FileChange[] = [], conflicts: FileChange[] = [];
    for (const f of files) {
      if (f.status === '!') {
        conflicts.push({ path: f.path, status: '!' });
        continue;
      }
      if (f.x !== ' ' && f.x !== '?') staged.push({ path: f.path, oldPath: f.oldPath, status: f.x });
      if (f.y !== ' ') unstaged.push({ path: f.path, status: f.y === '?' ? 'U' : f.y });
    }
    if (head.sha && this.lastMessage?.sha !== head.sha) this.lastMessage = { sha: head.sha, message: (await this.git().commit(head.sha)).message };
    const lastMessage = head.sha ? this.lastMessage?.message || '' : '';
    return { kind: 'wip', staged, unstaged, conflicts, lastMessage, headRef: head.sha ? 'HEAD' : EMPTY_TREE, branch: head.branch };
  }

  // ---- staging & committing

  async on_stage(m: Msg) {
    await this.runOp('Stage', () => this.git().run(['add', '-A', '--', ...m.paths]));
  }

  async on_unstage(m: Msg) {
    const args = this.lastHead?.sha ? ['restore', '--staged', '--', ...m.paths] : ['rm', '--cached', '-r', '-q', '--', ...m.paths];
    await this.runOp('Unstage', () => this.git().run(args));
  }

  async on_stageAll() {
    await this.runOp('Stage all', () => this.git().run(['add', '-A']));
  }

  async on_unstageAll() {
    const args = this.lastHead?.sha ? ['reset', '-q'] : ['rm', '--cached', '-r', '-q', '.'];
    await this.runOp('Unstage all', () => this.git().run(args));
  }

  async on_discard(m: Msg) {
    const what = m.paths.length === 1 ? m.paths[0] : `${m.paths.length} files`;
    const ok = await this.confirm(
      `Discard changes in ${what}?`,
      m.untracked ? 'Untracked files are deleted permanently.' : 'Unstaged changes are lost permanently. Staged changes are kept.',
      m.untracked ? 'Delete' : 'Discard'
    );
    if (!ok) return;
    const args = m.untracked ? ['clean', '-f', '-q', '--', ...m.paths] : ['restore', '--', ...m.paths];
    await this.runOp('Discard', () => this.git().run(args));
  }

  /**
   * Adds an ignore rule for a changed file. m.kind: file | dir | ext (see ignorePattern); m.local: write to
   * .git/info/exclude (this clone only) instead of .gitignore. Afterwards, offers to untrack files that are
   * tracked but now ignored, since ignore rules don't apply to them.
   */
  async on_ignore(m: Msg) {
    const pattern = ignorePattern(String(m.path), m.kind);
    if (!pattern) return;
    const root = this.requireRoot();
    const git = this.git();
    const file = m.local ? path.resolve(root, (await git.run(['rev-parse', '--git-path', 'info/exclude'])).trim()) : path.join(root, '.gitignore');
    const trackedIgnored = async () => (await git.tryRun(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'])).split('\0').filter(Boolean);
    const before = new Set(await trackedIgnored());
    const done = await this.runOp(`Ignore ${pattern}`, async () => {
      const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const next = appendIgnore(content, [pattern]);
      if (next === null) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next);
    });
    if (!done) return;
    const tracked = (await trackedIgnored()).filter(f => !before.has(f));
    if (!tracked.length) return;
    const list = tracked.slice(0, 15).join('\n') + (tracked.length > 15 ? `\n… and ${tracked.length - 15} more` : '');
    const ok = await this.confirm(
      `${tracked.length} tracked file(s) match the new rule. Stop tracking them?`,
      `Ignore rules don't apply to files git already tracks. "git rm --cached" removes them from the index (the next commit deletes them from the repository) but keeps them on disk.\n\n${list}`,
      'Stop Tracking'
    );
    if (ok) await this.runOp('Stop tracking ignored files', () => git.run(['rm', '--cached', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: tracked.join('\0') }));
  }

  async on_commit(m: Msg) {
    let message = (m.message || '').trim();
    if (!message && m.amend) message = (await this.git().commit('HEAD')).message;
    if (!message) return vscode.window.showWarningMessage('Enter a commit message.');
    const git = this.git();
    if (m.stageAll) await git.run(['add', '-A']);
    if (!m.amend && !(await git.hasStagedChanges())) return vscode.window.showWarningMessage('Nothing staged to commit.');
    const label = m.amend ? 'Amend commit' : 'Commit';
    // Through the git extension so commit signing, hooks and git.* settings behave like the SCM view.
    const ok = await this.runOp(label, () => this.requireRepo().commit(message, { amend: !!m.amend, noVerify: !!m.noVerify }));
    if (ok) this.post({ type: 'committed' });
  }

  async on_stashDetails(m: Msg) {
    const left = m.parents[0];
    const files = await this.git().diffFiles(left, m.hash);
    this.post({ type: 'details', details: { kind: 'stash', stash: m, files, left, right: m.hash } });
  }

  async on_compare(m: Msg) {
    const git = this.git();
    const files = await git.diffFiles(m.a, m.b || undefined);
    const counts = m.b ? await git.aheadBehind(m.a, m.b) : null;
    this.post({ type: 'details', details: { kind: 'compare', a: m.a, b: m.b, aLabel: m.aLabel, bLabel: m.bLabel, counts, files, left: m.a, right: m.b } });
  }

  async on_reflog() {
    const entries = await this.git().reflog(300);
    this.post({ type: 'details', details: { kind: 'reflog', entries } });
  }

  async on_openDiff(m: Msg) {
    const fileUri = vscode.Uri.file(this.inRepo(m.path));
    const oldUri = vscode.Uri.file(this.inRepo(m.oldPath || m.path));
    // 'INDEX' is the staging area; the git extension serves it for ref '~'.
    const ref = (r: string) => (r === 'INDEX' ? '~' : r);
    const name = (r: string) => (r === 'INDEX' ? 'index' : r === EMPTY_TREE ? 'empty' : short(r));
    const leftUri = this.api.toGitUri(oldUri, ref(m.left));
    const rightUri = m.right ? this.api.toGitUri(fileUri, ref(m.right)) : fileUri;
    const title = `${path.basename(m.path)} (${name(m.left)} ↔ ${m.right ? name(m.right) : 'working tree'})`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
  }

  async on_openFile(m: Msg) {
    await vscode.window.showTextDocument(vscode.Uri.file(this.inRepo(m.path)), { preview: true });
  }

  async on_fileHistory(m: Msg) {
    await this.on_search({ kind: 'path', value: m.path });
  }

  // ---- remote ops (fetch/pull/push of the current branch go through the git extension so credentials work)

  /** m.mode (from the toolbar right-click menu): 'noprune' fetches all remotes without pruning. */
  async on_fetch(m: Msg = {}) {
    if (m.mode === 'noprune') return this.runOp('Fetch all', () => this.requireRepo().fetch({ all: true }), true);
    await this.runOp('Fetch all & prune', () => this.requireRepo().fetch({ all: true, prune: true }), true);
  }

  /** m.mode (from the toolbar right-click menu) skips the quick pick: one of the PULL_MODES ids. */
  async on_pull(m: Msg = {}) {
    const head = this.lastHead;
    const b = head?.branch ? this.localBranch(head.branch) : undefined;
    if (!b?.upstream) return vscode.window.showWarningMessage(`${this.currentName()} has no upstream. Use "Set upstream…" on the branch first.`);
    const pick = PULL_MODES.find(p => p.id === m.mode) || (await vscode.window.showQuickPick<PickItem>(PULL_MODES, { placeHolder: `Pull ${b.upstream} into ${b.name}` }));
    if (!pick) return;
    if (pick.id === 'default') return this.runOp('Pull', () => this.requireRepo().pull(), true);
    const args = pick.args || [];
    await this.runOp(`Pull ${args.join(' ')}`, () => this.git().run(['pull', ...args], { env: { GIT_EDITOR: ':' } }), true);
  }

  /** m.mode (from the toolbar right-click menu) skips the quick pick: branch, follow, all, tags, safe, lease or force. */
  async on_push(m: Msg = {}) {
    const head = this.lastHead;
    const branch = head?.branch;
    const pick = m.mode ? { id: String(m.mode) } : await vscode.window.showQuickPick<PickItem>([
        ...(branch
          ? [
              { label: `Push ${branch}`, description: 'current branch only', id: 'branch' },
              { label: `Push ${branch} --follow-tags`, description: 'plus annotated tags on the pushed commits', id: 'follow' },
              { label: `Push ${branch} and all tags`, description: 'plus every local tag (git push --tags)', id: 'all' },
              { label: 'Force push', kind: vscode.QuickPickItemKind.Separator },
              { label: `$(shield) Force push ${branch} (lease + if-includes)`, description: '--force-with-lease --force-if-includes · safest', id: 'safe' },
              { label: `$(warning) Force push ${branch} (lease)`, description: '--force-with-lease · refuses if the remote moved since your last fetch', id: 'lease' },
              { label: `$(error) Force push ${branch} (unconditional)`, description: '--force · overwrites whatever is on the remote', id: 'force' },
            ]
          : []),
        { label: 'Tags', kind: vscode.QuickPickItemKind.Separator },
        { label: 'Push all tags', description: 'tags only, no branch', id: 'tags' },
      ],
      { placeHolder: branch ? `Push ${branch}` : 'Detached HEAD: only tags can be pushed' }
    );
    if (!pick) return;
    if (pick.id === 'tags') return this.on_pushAllTags();
    if (!branch) return vscode.window.showWarningMessage('Detached HEAD: check out a branch to push it.');
    if (pick.id === 'safe' || pick.id === 'lease' || pick.id === 'force') return this.pushBranch(branch, pick.id);
    await this.pushBranch(branch, false, pick.id === 'follow' ? 'follow' : pick.id === 'all' ? 'all' : undefined);
  }

  /** m.force: true/'lease' = --force-with-lease, 'safe' = plus --force-if-includes, 'force' = plain --force. */
  async on_pushBranch(m: Msg) {
    const force: ForceMode | false = m.force === true ? 'lease' : m.force === 'safe' || m.force === 'lease' || m.force === 'force' ? m.force : false;
    await this.pushBranch(m.name, force);
  }

  /** tags: 'follow' = --follow-tags (annotated tags reachable from the pushed commits), 'all' = also push every tag. */
  async pushBranch(name: string, force: ForceMode | false, tags?: 'follow' | 'all') {
    const b = this.localBranch(name);
    const upstream = b?.upstream && !b.gone ? this.splitUpstream(b.upstream) : null;
    const setUpstream = !upstream;
    const remote = upstream ? upstream.remote : await this.pickRemote();
    if (!remote) return;
    const target = upstream || { remote, branch: name };
    if (force) {
      const flags = FORCE_FLAGS[force];
      const detail = {
        safe: 'Uses --force-with-lease --force-if-includes: refuses if the remote moved since your last fetch, or if it has commits you never had locally (protects against background auto-fetch).',
        lease: 'Uses --force-with-lease: refuses if the remote moved since your last fetch. Note: a background fetch (git.autofetch) updates that reference, so the lease may not protect you.',
        force: 'Uses --force: overwrites the remote branch unconditionally. Commits pushed by others since will be lost from the branch.',
      }[force];
      const ok = await this.confirm(`Force-push '${name}' to ${target.remote}/${target.branch}?`, detail, force === 'force' ? 'Force Push (Unconditional)' : 'Force Push');
      if (!ok) return;
      const args = ['push', ...flags];
      if (setUpstream) args.push('-u');
      return this.runOp(`Force push ${name} ${flags.join(' ')}`, () => this.git().run([...args, target.remote, `${name}:${target.branch}`]), true);
    }
    const refspec = target.branch === name ? name : `${name}:${target.branch}`;
    if (tags === 'follow') {
      // The vscode.git API has no --follow-tags option, so this one goes through the CLI.
      const args = ['push', '--follow-tags'];
      if (setUpstream) args.push('-u');
      return this.runOp(`Push ${name} --follow-tags`, () => this.git().run([...args, target.remote, `${name}:${target.branch}`]), true);
    }
    if (tags === 'all') {
      return this.runOp(`Push ${name} and all tags`, async () => {
        await this.requireRepo().push(target.remote, refspec, setUpstream);
        await this.git().run(['push', target.remote, '--tags']);
      }, true);
    }
    await this.runOp(`Push ${name}`, () => this.requireRepo().push(target.remote, refspec, setUpstream), true);
  }

  // ---- upstream tools

  async on_setUpstream(m: Msg) {
    const remotes = (this.lastRefs?.remote || []).map(r => ({ label: r.name, description: r.branch === m.name ? 'same name' : '' }));
    remotes.sort((a, b) => (b.description ? 1 : 0) - (a.description ? 1 : 0));
    const pick = await vscode.window.showQuickPick<PickItem>([...remotes, { label: '$(edit) Enter a remote branch…', id: 'other' }], {
      placeHolder: `Upstream for '${m.name}'`,
    });
    if (!pick) return;
    let upstream: string | undefined = pick.label;
    if (pick.id === 'other') {
      upstream = await vscode.window.showInputBox({ prompt: 'Remote branch, e.g. origin/feature', value: `origin/${m.name}` });
      if (!upstream) return;
    }
    await this.runOp(`Set upstream of ${m.name}`, () => this.git().run(['branch', `--set-upstream-to=${upstream}`, m.name]));
  }

  async on_unsetUpstream(m: Msg) {
    await this.runOp(`Unset upstream of ${m.name}`, () => this.git().run(['branch', '--unset-upstream', m.name]));
  }

  /** Fast-forwards a branch to its upstream without checking it out. */
  async on_updateBranch(m: Msg) {
    const b = this.localBranch(m.name);
    if (!b?.upstream || b.gone) return vscode.window.showWarningMessage(`'${m.name}' has no (existing) upstream.`);
    if (b.isHead) return this.runOp(`Fast-forward ${m.name}`, () => this.git().run(['pull', '--ff-only']), true);
    const up = this.splitUpstream(b.upstream);
    if (!up) return;
    await this.runOp(`Fast-forward ${m.name} to ${b.upstream}`, () => this.git().run(['fetch', up.remote, `${up.branch}:${m.name}`]), true);
  }

  // ---- remotes

  async on_addRemote() {
    const name = await vscode.window.showInputBox({ prompt: 'Remote name', value: this.lastRefs?.remotes.length ? 'upstream' : 'origin' });
    if (!name) return;
    const url = await vscode.window.showInputBox({ prompt: `URL for '${name}'` });
    if (!url) return;
    const ok = await this.runOp(`Add remote ${name}`, () => this.git().run(['remote', 'add', name, url]));
    if (ok) await this.runOp(`Fetch ${name}`, () => this.requireRepo().fetch({ remote: name }), true);
  }

  async on_fetchRemote(m: Msg) {
    await this.runOp(`Fetch ${m.remote} & prune`, () => this.requireRepo().fetch({ remote: m.remote, prune: true }), true);
  }

  async on_pruneRemote(m: Msg) {
    await this.runOp(`Prune ${m.remote}`, () => this.git().run(['remote', 'prune', m.remote]), true);
  }

  async on_renameRemote(m: Msg) {
    const name = await vscode.window.showInputBox({ prompt: `Rename remote '${m.remote}'`, value: m.remote });
    if (name && name !== m.remote) await this.runOp(`Rename ${m.remote}`, () => this.git().run(['remote', 'rename', m.remote, name]));
  }

  async on_setRemoteUrl(m: Msg) {
    const info = this.lastRefs?.remoteInfo.find(r => r.name === m.remote);
    const url = await vscode.window.showInputBox({ prompt: `URL for '${m.remote}'`, value: info?.fetchUrl || '' });
    if (url) await this.runOp(`Set URL of ${m.remote}`, () => this.git().run(['remote', 'set-url', m.remote, url]));
  }

  async on_removeRemote(m: Msg) {
    const ok = await this.confirm(`Remove remote '${m.remote}'?`, 'Its remote-tracking branches are deleted locally. Nothing changes on the server.', 'Remove');
    if (ok) await this.runOp(`Remove ${m.remote}`, () => this.git().run(['remote', 'remove', m.remote]));
  }

  // ---- branches

  async on_checkout(m: Msg) {
    const git = this.git();
    if (m.kind === 'remote') {
      const existing = this.localBranch(m.branch);
      if (existing) {
        const pick = await vscode.window.showQuickPick<PickItem>([
            { label: `Checkout local '${m.branch}'`, id: 'local' },
            { label: `Checkout local '${m.branch}' and reset it to ${m.name}`, id: 'reset', description: 'discards local commits on that branch' },
          ],
          { placeHolder: `A local branch '${m.branch}' already exists` }
        );
        if (!pick) return;
        if (pick.id === 'local') return this.runOp(`Checkout ${m.branch}`, () => git.run(['checkout', m.branch]));
        return this.runOp(`Checkout ${m.branch}`, () => git.run(['checkout', '-B', m.branch, '--track', m.name]));
      }
      return this.runOp(`Checkout ${m.name}`, () => git.run(['checkout', '--track', m.name]));
    }
    if (m.kind === 'local') {
      const b = this.localBranch(m.name);
      if (b?.worktree && !samePath(b.worktree, this.requireRoot())) {
        const open = await vscode.window.showWarningMessage(`'${m.name}' is checked out in another worktree (${b.worktree}).`, 'Open That Worktree');
        if (open) await this.on_openWorktree({ path: b.worktree, newWindow: true });
        return;
      }
      return this.runOp(`Checkout ${m.name}`, () => git.run(['checkout', m.name]));
    }
    // commit / tag → detached HEAD
    const ok = await this.confirm(`Checkout ${short(m.name)} as detached HEAD?`, 'Commits made here will not belong to any branch until you create one.', 'Checkout');
    if (ok) await this.runOp(`Checkout ${short(m.name)}`, () => git.run(['checkout', '--detach', m.name]));
  }

  async on_createBranch(m: Msg) {
    const from = m.from || 'HEAD';
    const name = await vscode.window.showInputBox({
      prompt: `New branch from ${short(from)}`,
      value: m.suggest || '',
      validateInput: v => (/^\S+$/.test(v) && !v.startsWith('-') ? null : 'Enter a valid branch name'),
    });
    if (!name) return;
    // m.mode (from the toolbar right-click menu) skips the pick: co, create or wt.
    const pick = ['co', 'create', 'wt'].includes(m.mode) ? { id: m.mode as string } : await vscode.window.showQuickPick<PickItem>([
        { label: 'Create and checkout', id: 'co' },
        { label: 'Create only', id: 'create' },
        { label: 'Create in a new worktree', id: 'wt', description: 'check it out in a separate folder' },
      ],
      { placeHolder: `Branch '${name}' from ${short(from)}` }
    );
    if (!pick) return;
    if (pick.id === 'wt') return this.addWorktree({ newBranch: name, ref: from });
    const args = pick.id === 'co' ? ['checkout', '-b', name, from] : ['branch', name, from];
    await this.runOp(`Create branch ${name}`, () => this.git().run(args));
  }

  async on_renameBranch(m: Msg) {
    const name = await vscode.window.showInputBox({ prompt: `Rename branch '${m.name}'`, value: m.name });
    if (!name || name === m.name) return;
    await this.runOp(`Rename ${m.name}`, () => this.git().run(['branch', '-m', m.name, name]));
  }

  async on_deleteBranch(m: Msg) {
    const git = this.git();
    if (m.kind === 'remote') {
      const ok = await this.confirm(`Delete remote branch '${m.name}'?`, `Runs: git push ${m.remote} --delete ${m.branch}`, 'Delete');
      if (ok) await this.runOp(`Delete ${m.name}`, () => git.run(['push', m.remote, '--delete', m.branch]), true);
      return;
    }
    const b = this.localBranch(m.name);
    const choices = ['Delete'];
    const up = b?.upstream && !b.gone ? this.splitUpstream(b.upstream) : null;
    if (up) choices.push('Delete Local and Remote');
    const choice = await this.confirm(`Delete local branch '${m.name}'?`, up ? `Its upstream is ${b?.upstream}.` : undefined, ...choices);
    if (!choice) return;
    // Same rule as `git branch -d`: merged into its upstream, or into HEAD when it has none.
    let flag = '-d';
    if (!(await git.isAncestor(m.name, up && b?.upstream ? b.upstream : 'HEAD'))) {
      const force = await this.confirm(`'${m.name}' is not fully merged.`, 'Force-deleting will lose commits that are only on this branch.', 'Force Delete');
      if (!force) return;
      flag = '-D';
    }
    const deleted = await this.runOp(`Delete ${m.name}`, () => git.run(['branch', flag, m.name]));
    if (deleted && choice === 'Delete Local and Remote' && up) {
      await this.runOp(`Delete ${up.remote}/${up.branch}`, () => git.run(['push', up.remote, '--delete', up.branch]), true);
    }
  }

  /** Branch hygiene: gone upstreams, merged into base, stale. */
  async on_cleanupBranches() {
    const git = this.git();
    const refs = this.refs();
    const root = this.requireRoot();
    const base = this.lastBase;
    const staleDays = config().get('staleBranchDays', 60);
    const cutoff = Date.now() / 1000 - staleDays * 86400;
    const baseNames = new Set(base ? [base, base.replace(/^[^/]+\//, '')] : []);
    const merged = new Set(base ? await git.mergedInto(base) : []);
    const protectedBranch = (b: LocalBranch) => b.isHead || baseNames.has(b.name) || (!!b.worktree && !samePath(b.worktree, root));

    const groups: { title: string; test: (b: LocalBranch) => boolean; picked: boolean }[] = [
      { title: 'Upstream deleted ("gone")', test: b => b.gone, picked: true },
      { title: base ? `Merged into ${base}` : 'Merged', test: b => merged.has(b.name), picked: true },
      { title: `No commits for ${staleDays}+ days`, test: b => !!b.date && b.date < cutoff, picked: false },
    ];
    const seen = new Set<string>();
    const items: vscode.QuickPickItem[] = [];
    for (const g of groups) {
      const hits = refs.local.filter(b => !protectedBranch(b) && !seen.has(b.name) && g.test(b));
      if (!hits.length) continue;
      items.push({ label: g.title, kind: vscode.QuickPickItemKind.Separator });
      for (const b of hits) {
        seen.add(b.name);
        const age = b.date ? `${Math.round((Date.now() / 1000 - b.date) / 86400)}d old` : '';
        items.push({ label: b.name, description: [b.upstream, age].filter(Boolean).join(' · '), picked: g.picked });
      }
    }
    if (!items.length) {
      return vscode.window.showInformationMessage(`No branches to clean up${base ? ` (base: ${base})` : ''}. Tip: Fetch & Prune first to detect gone upstreams.`);
    }
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Delete these local branches? (current, base and worktree branches are excluded)' });
    const names = (picks || []).map(p => p.label);
    if (!names.length) return;
    await this.runOp(`Delete ${names.length} branch(es)`, () => git.run(['branch', '-D', ...names]));
  }

  // ---- merge / rebase / history rewriting

  async on_merge(m: Msg) {
    const cur = this.currentName();
    const pick = await vscode.window.showQuickPick<PickItem>([
        { label: 'Merge', description: 'fast-forward when possible', args: ['--no-edit'] },
        { label: 'Merge --no-ff', description: 'always create a merge commit', args: ['--no-ff', '--no-edit'] },
        { label: 'Merge --ff-only', description: 'fail unless fast-forward', args: ['--ff-only'] },
        { label: 'Squash merge', description: 'stage the changes as one commit, commit yourself', args: ['--squash'] },
      ],
      { placeHolder: `Merge ${short(m.ref)} into ${cur}` }
    );
    if (!pick) return;
    await this.runOp(`Merge ${short(m.ref)} into ${cur}`, () => this.git().run(['merge', ...(pick.args || []), m.ref]));
  }

  async on_rebase(m: Msg) {
    const cur = this.currentName();
    const pick = await vscode.window.showQuickPick<PickItem>([
        { label: 'Rebase', args: [] },
        { label: 'Rebase with --autostash', description: 'stash local changes around the rebase', args: ['--autostash'] },
        { label: 'Rebase with --update-refs', description: 'also move branches stacked on the rebased commits', args: ['--update-refs'] },
      ],
      { placeHolder: `Rebase ${cur} onto ${short(m.onto)}` }
    );
    if (!pick) return;
    await this.runOp(`Rebase ${cur} onto ${short(m.onto)}`, () => this.git().run(['rebase', ...(pick.args || []), m.onto], { env: { GIT_EDITOR: ':' } }));
  }

  async on_cherryPick(m: Msg) {
    const args = ['cherry-pick'];
    if (m.parents?.length > 1) args.push('-m', '1');
    await this.runOp(`Cherry-pick ${short(m.sha)}`, () => this.git().run([...args, m.sha]));
  }

  /** @param {{shas: string[]}} m commits oldest first */
  async on_cherryPickMany(m: Msg) {
    const merges = (this.lastCommits || []).filter(c => m.shas.includes(c.hash) && c.parents.length > 1);
    if (merges.length) return vscode.window.showWarningMessage(`The selection contains merge commit(s) (${merges.map(c => short(c.hash)).join(', ')}). Cherry-pick them one by one.`);
    const ok = await this.confirm(`Cherry-pick ${m.shas.length} commits onto ${this.currentName()}?`, 'Applied oldest first.', 'Cherry-pick');
    if (ok) await this.runOp(`Cherry-pick ${m.shas.length} commits`, () => this.git().run(['cherry-pick', ...m.shas]));
  }

  async on_revert(m: Msg) {
    const args = ['revert', '--no-edit'];
    if (m.parents?.length > 1) args.push('-m', '1');
    await this.runOp(`Revert ${short(m.sha)}`, () => this.git().run([...args, m.sha]));
  }

  /** @param {{shas: string[]}} m commits oldest first */
  async on_revertMany(m: Msg) {
    const merges = (this.lastCommits || []).filter(c => m.shas.includes(c.hash) && c.parents.length > 1);
    if (merges.length) return vscode.window.showWarningMessage('The selection contains merge commits. Revert them one by one.');
    const ok = await this.confirm(`Revert ${m.shas.length} commits on ${this.currentName()}?`, 'Creates one revert commit per selected commit, newest first.', 'Revert');
    if (ok) await this.runOp(`Revert ${m.shas.length} commits`, () => this.git().run(['revert', '--no-edit', ...m.shas.slice().reverse()]));
  }

  async on_reset(m: Msg) {
    const cur = this.currentName();
    const pick = await vscode.window.showQuickPick<PickItem>([
        { label: 'Keep', description: 'move the branch, keep local changes (refuses if they conflict)', mode: '--keep' },
        { label: 'Soft', description: 'keep changes staged', mode: '--soft' },
        { label: 'Mixed', description: 'keep changes unstaged', mode: '--mixed' },
        { label: 'Hard', description: 'DISCARD all changes', mode: '--hard' },
      ],
      { placeHolder: `Reset ${cur} to ${short(m.sha)}` }
    );
    if (!pick) return;
    if (pick.mode === '--hard') {
      const ok = await this.confirm(`Hard reset ${cur} to ${short(m.sha)}?`, 'All uncommitted changes will be lost.', 'Reset');
      if (!ok) return;
    }
    await this.runOp(`Reset ${cur}`, () => this.git().run(['reset', pick.mode, m.sha]));
  }

  // ---- interactive rebase & friends

  /** Commits git would put in a rebase todo from `sha` (inclusive) up to HEAD, oldest first. */
  async rebaseRange(sha: string) {
    const git = this.git();
    const c = await git.commit(sha);
    if (!(await git.isAncestor(c.hash, 'HEAD'))) {
      vscode.window.showWarningMessage(`${short(c.hash)} is not an ancestor of HEAD, so it cannot be rebased from here.`);
      return null;
    }
    const root = c.parents.length === 0;
    const base = root ? null : c.parents[0];
    const range = root ? 'HEAD' : `${base}..HEAD`;
    const [commits, merges] = await Promise.all([git.rangeCommits(range), git.mergeCount(range)]);
    if (merges > 0) {
      const ok = await this.confirm(`The range contains ${merges} merge commit(s).`, 'Rebasing linearizes history: merge commits are dropped and the merged commits are replayed in order.', 'Continue');
      if (!ok) return null;
    }
    return { commit: c, base, root, commits };
  }

  /**
   * A fresh scratch folder for todo and message files. It lives in the git dir, not in the OS temp dir,
   * because `exec` steps still read from it when a rebase stops (edit, conflict) and is continued later.
   * collect() removes it once no operation is in progress.
   */
  async rebaseDir(): Promise<string> {
    this.preparingRebase = true; // cleared by runTodo; keeps collect() from removing the folder before git starts
    const dir = path.join(await this.git().gitDir(), REBASE_DIR);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Runs `git rebase -i` with a prepared todo list instead of opening an editor. */
  async runTodo(
    label: string,
    lines: string[] | null,
    o: { base: string | null; root: boolean; autostash?: boolean; updateRefs?: boolean; autosquash?: boolean; dir?: string }
  ): Promise<boolean> {
    const args = ['rebase', '-i'];
    if (o.autostash) args.push('--autostash');
    if (o.updateRefs) args.push('--update-refs');
    if (o.autosquash) args.push('--autosquash');
    if (o.root) args.push('--root');
    else if (o.base) args.push(o.base);
    else throw new Error('No base commit for the rebase.');
    let editor = ':';
    if (lines) {
      const todo = path.join(o.dir || (await this.rebaseDir()), 'todo');
      fs.writeFileSync(todo, lines.join('\n') + '\n');
      editor = `cp ${shQuote(todo)}`;
    }
    try {
      return await this.runOp(label, () => this.git().run(args, { env: { GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: ':' } }));
    } finally {
      this.preparingRebase = false;
    }
  }

  async on_irebasePrepare(m: Msg) {
    const r = await this.rebaseRange(m.sha);
    if (!r) return;
    if (!r.commits.length) return vscode.window.showInformationMessage('Nothing to rebase.');
    this.post({ type: 'irebase', base: r.base, root: r.root, branch: this.currentName(), commits: r.commits });
  }

  async on_irebaseRun(m: Msg) {
    const items = m.items as { action: string; hash: string; subject: string; message: string }[];
    // The todo is executed by git, so only plain steps on real commits are accepted (no exec, break, …).
    if (!items.every(it => REBASE_ACTIONS.has(it.action) && /^[0-9a-f]{40}$/.test(it.hash))) throw new Error('Invalid rebase step.');
    const dir = await this.rebaseDir();
    const lines: string[] = [];
    items.forEach((it, i) => {
      const subject = String(it.subject || '').replace(/[\r\n]+/g, ' ');
      if (it.action === 'reword') {
        const msgFile = path.join(dir, `msg-${i}.txt`);
        fs.writeFileSync(msgFile, String(it.message));
        lines.push(`pick ${it.hash} ${subject}`);
        lines.push(`exec git commit --amend --only --allow-empty --no-verify -F ${shQuote(msgFile)}`);
      } else {
        lines.push(`${it.action} ${it.hash} ${subject}`);
      }
    });
    await this.runTodo(`Interactive rebase of ${items.length} commit(s)`, lines, {
      base: m.base,
      root: !!m.root,
      autostash: !!m.autostash,
      updateRefs: !!m.updateRefs,
      dir,
    });
  }

  /** Stops a rebase at `sha` and un-commits it so its changes can be committed in pieces. */
  async on_splitCommit(m: Msg) {
    if (!(await this.requireCleanTree('Splitting a commit'))) return;
    const git = this.git();
    const c = await git.commit(m.sha);
    if (c.parents.length !== 1) return vscode.window.showWarningMessage('Only non-merge, non-root commits can be split.');
    const ok = await this.confirm(
      `Split ${short(c.hash)} "${c.message.split('\n')[0]}"?`,
      'The commit is undone and its changes left unstaged. Stage and commit them in pieces from Source Control, then press Continue in the gitSt8 banner.',
      'Split'
    );
    if (!ok) return;
    const headSha = this.lastHead?.sha;
    if (headSha === c.hash) {
      const done = await this.runOp(`Split ${short(c.hash)}`, () => git.run(['reset', 'HEAD~1']));
      if (done) vscode.window.showInformationMessage(`Changes of ${short(c.hash)} are unstaged. Commit them in pieces from Source Control.`);
      return;
    }
    const r = await this.rebaseRange(c.hash);
    if (!r) return;
    const lines = r.commits.map(x => `${x.hash === c.hash ? 'edit' : 'pick'} ${x.hash} ${x.subject}`);
    const stopped = await this.runTodo(`Split ${short(c.hash)}`, lines, { base: r.base, root: false });
    if (!stopped) return;
    await git.run(['reset', 'HEAD~1']);
    this.splitting = { sha: c.hash, subject: c.message.split('\n')[0] };
    this.scheduleRefresh(0);
    vscode.commands.executeCommand('workbench.view.scm');
  }

  /** Commits the staged changes as a fixup of `sha` and autosquashes it in. */
  async on_fixupInto(m: Msg) {
    const git = this.git();
    if (!(await git.hasStagedChanges())) {
      const stage = await this.confirm('No staged changes.', 'Stage all changes to tracked files (git add -u) and use them as the fixup?', 'Stage Tracked Changes');
      if (!stage) return;
      await git.run(['add', '-u']);
      if (!(await git.hasStagedChanges())) return vscode.window.showInformationMessage('There are no changes to tracked files.');
    }
    const c = await git.commit(m.sha);
    if (!(await git.isAncestor(c.hash, 'HEAD'))) return vscode.window.showWarningMessage(`${short(c.hash)} is not an ancestor of HEAD.`);
    const committed = await this.runOp(`Fixup commit for ${short(c.hash)}`, () => git.run(['commit', '--no-verify', `--fixup=${c.hash}`]));
    if (!committed) return;
    await this.runTodo(`Squash fixup into ${short(c.hash)}`, null, { base: c.parents[0], root: c.parents.length === 0, autosquash: true, autostash: true });
  }

  // ---- in-progress operations

  async on_opContinue() {
    const git = this.git();
    const env = { GIT_EDITOR: ':' };
    const op = await git.opState();
    if (!op) return;
    if (op.conflicts.length) {
      return vscode.window.showWarningMessage(`Still ${op.conflicts.length} unresolved file(s). Resolve and mark them resolved first.`);
    }
    const cmd = {
      rebase: ['rebase', '--continue'],
      merge: ['commit', '--no-edit'],
      'cherry-pick': ['cherry-pick', '--continue'],
      revert: ['revert', '--continue'],
    }[op.kind];
    await this.runOp(`Continue ${op.kind}`, () => git.run(cmd, { env }));
  }

  async on_opAbort() {
    const git = this.git();
    const op = await git.opState();
    if (!op) return;
    const ok = await this.confirm(`Abort ${op.kind}?`, 'Your branch goes back to where it was before the operation started.', 'Abort');
    if (ok) await this.runOp(`Abort ${op.kind}`, () => git.run([op.kind, '--abort']));
  }

  async on_opSkip() {
    const git = this.git();
    const op = await git.opState();
    if (!op || op.kind === 'merge') return;
    await this.runOp(`Skip commit`, () => git.run([op.kind, '--skip'], { env: { GIT_EDITOR: ':' } }));
  }

  async on_markResolved(m: Msg) {
    await this.runOp(`Mark ${m.path} resolved`, () => this.git().run(['add', '--', m.path]));
  }

  async on_takeSide(m: Msg) {
    if (m.side !== 'ours' && m.side !== 'theirs') return;
    await this.runOp(`Take ${m.side} for ${m.path}`, async () => {
      await this.git().run(['checkout', `--${m.side}`, '--', m.path]);
      await this.git().run(['add', '--', m.path]);
    });
  }

  // ---- stacks

  async on_changeBase() {
    const refs = this.refs();
    const items = [
      { label: '$(sync) Automatic', description: 'origin/HEAD, then main/master/develop', value: '' },
      ...refs.remote.map(r => ({ label: r.name, value: r.name })),
      ...refs.local.map(b => ({ label: b.name, value: b.name })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Base branch for stacks and cleanup (now: ${this.lastBase || 'none'})` });
    if (!pick) return;
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config().update('stackBase', pick.value || undefined, target);
  }

  /** Rebases the whole stack onto the base, moving every branch in it (--update-refs). */
  async on_restack() {
    const stack = this.lastStack || [];
    const base = this.lastBase;
    if (!stack.length || !base) return;
    if (!(await this.requireCleanTree('Restacking'))) return;
    const git = this.git();
    const top = stack[stack.length - 1].name;
    const offLine = [];
    for (const s of stack.slice(0, -1)) if (!(await git.isAncestor(s.name, top))) offLine.push(s.name);
    const ok = await this.confirm(
      `Rebase the stack onto ${base}?`,
      `Rebases ${top} with --update-refs, moving: ${stack.map(s => s.name).join(', ')}.` + (offLine.length ? `\n\nNot in line with ${top}, left alone: ${offLine.join(', ')}.` : ''),
      'Restack'
    );
    if (!ok) return;
    const back = this.lastHead?.branch;
    await this.runOp(`Restack onto ${base}`, async () => {
      if (back !== top) await git.run(['checkout', top]);
      await git.run(['rebase', '--update-refs', base], { env: { GIT_EDITOR: ':' } });
      if (back && back !== top) await git.run(['checkout', back]);
    });
  }

  async on_pushStack() {
    const stack = this.lastStack || [];
    if (!stack.length) return;
    const remote = await this.pickRemote('Push the stack to which remote?');
    if (!remote) return;
    const names = stack.map(s => s.name);
    const ok = await this.confirm(`Force-push ${names.length} branch(es) to ${remote}?`, `${names.join(', ')}\n\nUses --force-with-lease and sets upstreams.`, 'Push Stack');
    if (ok) await this.runOp('Push stack', () => this.git().run(['push', '--force-with-lease', '-u', remote, ...names.map(n => `${n}:${n}`)]), true);
  }

  // ---- tags

  async on_tag(m: Msg) {
    const name = await vscode.window.showInputBox({ prompt: `Tag ${short(m.sha)}`, validateInput: v => (/^\S+$/.test(v) ? null : 'Enter a valid tag name') });
    if (!name) return;
    const message = await vscode.window.showInputBox({ prompt: 'Annotation message (leave empty for a lightweight tag)' });
    if (message === undefined) return;
    const args = message ? ['tag', '-a', name, '-m', message, m.sha] : ['tag', name, m.sha];
    const ok = await this.runOp(`Tag ${name}`, () => this.git().run(args));
    if (ok && this.lastRefs?.remotes.length) {
      const push = await vscode.window.showInformationMessage(`Created tag ${name}.`, 'Push Tag');
      if (push) await this.on_pushTag({ name });
    }
  }

  async on_pushTag(m: Msg) {
    const remote = await this.pickRemote(`Push tag ${m.name} to`);
    if (remote) await this.runOp(`Push tag ${m.name}`, () => this.git().run(['push', remote, `refs/tags/${m.name}`]), true);
  }

  async on_pushAllTags() {
    const remote = await this.pickRemote('Push all tags to');
    if (remote) await this.runOp(`Push all tags to ${remote}`, () => this.git().run(['push', remote, '--tags']), true);
  }

  async on_fetchTags() {
    const remote = await this.pickRemote('Fetch tags from');
    if (remote) await this.runOp(`Fetch tags from ${remote}`, () => this.git().run(['fetch', remote, '--tags']), true);
  }

  async on_fetchTag(m: Msg) {
    const remote = this.tagSync?.remote || (await this.pickRemote());
    if (remote) await this.runOp(`Fetch tag ${m.name}`, () => this.git().run(['fetch', remote, `refs/tags/${m.name}:refs/tags/${m.name}`]), true);
  }

  async on_pruneTags() {
    const remote = await this.pickRemote('Prune tags against');
    if (!remote) return;
    const ok = await this.confirm(
      `Fetch ${remote} with --prune-tags?`,
      `Deletes every local tag that does not exist on ${remote}, including tags you created but never pushed. Use "Compare with remote" first to see which ones.`,
      'Prune Tags'
    );
    if (!ok) return;
    await this.runOp(`Prune tags against ${remote}`, () => this.git().run(['fetch', remote, '--prune', '--prune-tags', '--tags']), true);
    if (this.tagSync) await this.on_tagSync({ remote });
  }

  async on_tagSync(m: Msg) {
    const remote = m?.remote || (await this.pickRemote('Compare tags with'));
    if (!remote) return;
    let tags;
    await this.runOp(`Compare tags with ${remote}`, async () => (tags = await this.git().remoteTags(remote)), true);
    if (tags) this.tagSync = { remote, tags };
    this.scheduleRefresh(0);
  }

  on_clearTagSync() {
    this.tagSync = null;
    this.scheduleRefresh(0);
  }

  async on_deleteTag(m: Msg) {
    const remotes = this.lastRefs?.remotes || [];
    const onRemote = this.tagSync ? m.name in this.tagSync.tags : null;
    const choices = ['Delete Local'];
    if (remotes.length && onRemote !== false) choices.push('Delete Local and Remote', 'Delete Remote Only');
    const choice = await this.confirm(`Delete tag '${m.name}'?`, onRemote === false ? `The tag does not exist on ${this.tagSync?.remote}.` : undefined, ...choices);
    if (!choice) return;
    const git = this.git();
    let remote: string | undefined;
    if (choice !== 'Delete Local') {
      remote = this.tagSync?.remote || (await this.pickRemote(`Delete tag ${m.name} on`));
      if (!remote) return;
    }
    await this.runOp(`Delete tag ${m.name}`, async () => {
      if (choice !== 'Delete Remote Only') await git.run(['tag', '-d', m.name]);
      if (remote) {
        await git.run(['push', remote, '--delete', `refs/tags/${m.name}`]);
        if (this.tagSync && this.tagSync.remote === remote) delete this.tagSync.tags[m.name];
      }
    }, !!remote);
  }

  // ---- worktrees

  on_addWorktree(m: Msg) {
    return this.addWorktree(m || {});
  }

  /** @param {{branch?: string, newBranch?: string, ref?: string}} m */
  async addWorktree(m: Msg) {
    const git = this.git();
    let { branch, newBranch, ref } = m;
    if (!branch && !newBranch && ref) {
      newBranch = await vscode.window.showInputBox({ prompt: `New branch at ${short(ref)} for the worktree` });
      if (!newBranch) return;
    } else if (!branch && !newBranch) {
      const free = this.refs().local.filter(b => !b.worktree);
      const pick = await vscode.window.showQuickPick<PickItem>([{ label: '$(add) New branch…', id: 'new' }, ...free.map(b => ({ label: b.name, description: b.upstream || '' }))],
        { placeHolder: 'Branch to check out in the new worktree' }
      );
      if (!pick) return;
      if (pick.id === 'new') {
        newBranch = await vscode.window.showInputBox({ prompt: 'New branch name' });
        if (!newBranch) return;
        ref = await vscode.window.showInputBox({ prompt: 'Start point', value: this.lastBase || 'HEAD' });
        if (!ref) return;
      } else {
        branch = pick.label;
      }
    }
    const label = (newBranch || branch).replace(/[\\/:*?"<>|]+/g, '-');
    const root = this.requireRoot();
    const suggested = path.join(path.dirname(root), `${path.basename(root)}-${label}`);
    const target = await vscode.window.showInputBox({ prompt: 'Folder for the new worktree', value: suggested });
    if (!target) return;
    const args = newBranch ? ['worktree', 'add', '-b', newBranch, target, ref || 'HEAD'] : ['worktree', 'add', target, branch];
    const ok = await this.runOp(`Add worktree ${label}`, () => git.run(args));
    if (!ok) return;
    const open = await vscode.window.showInformationMessage(`Worktree created at ${target}.`, 'Open in New Window', 'Open Here');
    if (open) await this.on_openWorktree({ path: target, newWindow: open === 'Open in New Window' });
  }

  async on_openWorktree(m: Msg) {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.path), { forceNewWindow: !!m.newWindow });
  }

  async on_revealWorktree(m: Msg) {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
  }

  async on_removeWorktree(m: Msg) {
    const wt = this.requireWorktree(m.path);
    const ok = await this.confirm(`Remove worktree ${wt}?`, 'Deletes the folder. The branch itself is kept.', 'Remove');
    if (!ok) return;
    const git = this.git();
    try {
      await git.run(['worktree', 'remove', wt]);
      this.scheduleRefresh(0);
    } catch (e) {
      const force = await this.confirm('The worktree has local changes or is locked.', `${errText(e)}\n\nForce removal discards them.`, 'Force Remove');
      if (force) await this.runOp('Remove worktree', () => git.run(['worktree', 'remove', '--force', '--force', wt]));
    }
  }

  async on_lockWorktree(m: Msg) {
    const wt = this.requireWorktree(m.path);
    const args = m.locked ? ['worktree', 'unlock', wt] : ['worktree', 'lock', wt];
    await this.runOp(m.locked ? 'Unlock worktree' : 'Lock worktree', () => this.git().run(args));
  }

  async on_pruneWorktrees() {
    await this.runOp('Prune worktrees', () => this.git().run(['worktree', 'prune', '-v']));
  }

  // ---- stashes

  /** m.mode (from the toolbar right-click menu) skips the "what to stash" pick: tracked, untracked, staged or keepIndex. */
  async on_stashSave(m: Msg = {}) {
    const modes: PickItem[] = [
      { label: 'Tracked changes', id: 'tracked', args: [] },
      { label: 'Include untracked files', id: 'untracked', args: ['--include-untracked'] },
      { label: 'Staged changes only', id: 'staged', args: ['--staged'] },
      { label: 'Keep staged changes in the index', id: 'keepIndex', args: ['--keep-index'] },
    ];
    const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
    if (message === undefined) return;
    const pick = modes.find(p => p.id === m.mode) || (await vscode.window.showQuickPick<PickItem>(modes, { placeHolder: 'What to stash' }));
    if (!pick) return;
    const args = ['stash', 'push', ...(pick.args || [])];
    if (message) args.push('-m', message);
    await this.runOp('Stash', () => this.git().run(args));
  }

  async on_stashApply(m: Msg) {
    await this.runOp(`Apply ${m.ref}`, () => this.git().run(['stash', 'apply', m.ref]));
  }
  async on_stashPop(m: Msg) {
    await this.runOp(`Pop ${m.ref}`, () => this.git().run(['stash', 'pop', m.ref]));
  }
  async on_stashDrop(m: Msg) {
    const ok = await this.confirm(`Drop ${m.ref}?`, m.message, 'Drop');
    if (ok) await this.runOp(`Drop ${m.ref}`, () => this.git().run(['stash', 'drop', m.ref]));
  }
  async on_stashBranch(m: Msg) {
    const name = await vscode.window.showInputBox({ prompt: `New branch from ${m.ref} (applies and drops the stash)` });
    if (name) await this.runOp(`Branch from ${m.ref}`, () => this.git().run(['stash', 'branch', name, m.ref]));
  }

  // ---------------------------------------------------------------- html

  html() {
    const w = this.host.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('base64');
    const fontFile = path.join(CODICON_DIR, 'codicon.ttf');
    const font = fs.existsSync(fontFile) ? w.asWebviewUri(vscode.Uri.file(fontFile)) : null;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'nonce-${nonce}'; font-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('main.css')}">
${font ? `<style nonce="${nonce}">@font-face { font-family: "codicon"; font-display: block; src: url("${font}") format("truetype"); }</style>` : ''}
<title>gitSt8</title>
</head>
<body class="${font ? 'has-codicons' : ''}">
<div id="toolbar">
  <label class="repo-pick" title="Repository shown in this view">
    <i class="ci" data-icon="repo"></i>
    <select id="repo"></select>
  </label>
  <span id="head" class="head-chip"></span>
  <span id="integration" hidden></span>
  <span class="tgroup">
    <button class="tb primary-tb" data-cmd="openCommit" title="Staged/unstaged changes and commit"><i class="ci" data-icon="check"></i><span class="lbl">Commit</span></button>
    <button class="tb" data-cmd="fetch" title="Fetch all remotes and prune deleted branches (right-click: more options)"><i class="ci" data-icon="sync"></i><span class="lbl">Fetch</span></button>
    <button class="tb" data-cmd="pull" title="Pull current branch: rebase / ff-only / merge (right-click: pick directly)"><i class="ci" data-icon="repo-pull"></i><span class="lbl">Pull</span></button>
    <button class="tb" data-cmd="push" title="Push current branch, with tags or force push (right-click: pick directly)"><i class="ci" data-icon="repo-push"></i><span class="lbl">Push</span></button>
  </span>
  <span class="tgroup">
    <button class="tb" data-cmd="createBranch" title="New branch from HEAD (right-click: checkout / create only / worktree)"><i class="ci" data-icon="git-branch"></i><span class="lbl">Branch</span></button>
    <button class="tb" data-cmd="stashSave" title="Stash changes (right-click: untracked / staged only / keep index)"><i class="ci" data-icon="archive"></i><span class="lbl">Stash</span></button>
    <button class="tb" data-cmd="cleanupBranches" title="Delete gone, merged or stale local branches"><i class="ci" data-icon="clear-all"></i><span class="lbl">Clean up</span></button>
    <button class="tb" data-cmd="reflog" title="HEAD reflog: undo resets, rebases and other history changes"><i class="ci" data-icon="history"></i><span class="lbl">Reflog</span></button>
  </span>
  <span class="spacer"></span>
  <label class="check" title="Show all branches, or only the history of HEAD"><input type="checkbox" id="showAll" checked><i class="ci" data-icon="git-merge"></i><span class="lbl">All branches</span></label>
  <span class="search">
  <i class="ci" data-icon="search"></i>
  <select id="searchKind" title="Search mode">
    <option value="">Filter loaded</option>
    <option value="any">Message, author or file name</option>
    <option value="message">Message</option>
    <option value="author">Author</option>
    <option value="pickaxe">Code added/removed (-S)</option>
    <option value="regex">Diff matches regex (-G)</option>
    <option value="path">File / folder name or path</option>
  </select>
  <input id="filter" type="search" placeholder="Filter loaded commits…">
  </span>
  <button class="tb" data-cmd="refresh" title="Refresh (F5)"><i class="ci" data-icon="refresh"></i></button>
</div>
<div id="querybar" hidden></div>
<div id="banner" hidden></div>
<div id="main">
  <aside id="sidebar">
    <div class="side-filter"><i class="ci" data-icon="filter"></i><input id="sideFilter" type="search" placeholder="Filter branches, tags…"></div>
    <div id="sideContent"></div>
  </aside>
  <section id="center">
    <div id="graphWrap">
      <table id="graph"><colgroup><col class="c-graph"><col><col class="c-author"><col class="c-date"><col class="c-sha"></colgroup><tbody></tbody></table>
      <div id="more"></div>
    </div>
  </section>
  <div id="splitter" title="Drag to resize"></div>
  <section id="detailsPane">
    <div id="details"><div class="empty">Select a commit. ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+click to multi-select (2 = compare), Shift+click for a range.</div></div>
  </section>
</div>
<div id="menu" hidden></div>
<div id="modal" hidden></div>
<div id="busy" hidden></div>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}

