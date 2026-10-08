import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const FS = '\x1f';
const RS = '\x1e';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZERO_SHA = '0000000000000000000000000000000000000000';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly exitCode?: number) {
    super(message);
  }
}

export type QueryKind = 'any' | 'path' | 'message' | 'author' | 'pickaxe' | 'regex';

export interface Query {
  kind: QueryKind;
  value: string;
  exact?: boolean;
  isDir?: boolean;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email?: string;
  date: number;
  subject: string;
  graphParents?: string[];
  wip?: boolean;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  message: string;
}

export interface Head {
  branch: string | null;
  sha: string | null;
  detached: boolean;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface LocalBranch {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  isHead: boolean;
  date: number;
  worktree: string | null;
}

export interface RemoteBranch {
  name: string;
  remote: string;
  branch: string;
  sha: string;
  date: number;
}

export interface Tag {
  name: string;
  sha: string;
  annotated: boolean;
  date: number;
  message: string;
}

export interface Refs {
  local: LocalBranch[];
  remote: RemoteBranch[];
  tags: Tag[];
  remotes: string[];
  remoteInfo: RemoteInfo[];
}

export interface Stash {
  ref: string;
  hash: string;
  parents: string[];
  date: number;
  message: string;
}

export interface StatusEntry {
  status: string;
  x: string;
  y: string;
  path: string;
  oldPath?: string;
}

export interface FileChange {
  status: string;
  path: string;
  oldPath?: string;
}

export type OpKind = 'rebase' | 'merge' | 'cherry-pick' | 'revert';

export interface OpState {
  kind: OpKind;
  step?: number;
  total?: number;
  branch?: string;
  onto?: string;
  head?: string;
  conflicts: string[];
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean | string;
  prunable: boolean | string;
}

export interface ReflogEntry {
  hash: string;
  selector: string;
  action: string;
  subject: string;
  date: number;
}

export interface StackEntry {
  name: string;
  count: number;
}

/** Thin wrapper around the git CLI for one repository. */
export class GitCli {
  private gitDirCache?: string;
  private baseCache?: { configured: string; value: string | null };

  constructor(readonly gitPath: string, readonly root: string) {}

  run(args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) };
      const child = cp.execFile(
        this.gitPath || 'git',
        ['--no-optional-locks', ...args],
        { cwd: this.root, env, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || stdout || err.message).trim();
            reject(new GitError(msg, stderr, typeof err.code === 'number' ? err.code : undefined));
          } else {
            resolve(stdout);
          }
        }
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  async tryRun(args: string[], fallback = ''): Promise<string> {
    try {
      return await this.run(args);
    } catch {
      return fallback;
    }
  }

  async ok(args: string[]): Promise<boolean> {
    try {
      await this.run(args);
      return true;
    } catch {
      return false;
    }
  }

  async log({ limit, all, query }: { limit: number; all: boolean; query?: Query | null }): Promise<{ commits: Commit[]; hasMore: boolean }> {
    if (query?.kind === 'any') {
      // Union of message, author and file-name matches, newest first.
      const kinds: QueryKind[] = ['message', 'author', 'path'];
      const parts = await Promise.all(kinds.map(kind => this.log({ limit, all, query: { kind, value: query.value } })));
      const byHash = new Map<string, Commit>();
      for (const p of parts) for (const c of p.commits) byHash.set(c.hash, c);
      const commits = [...byHash.values()].sort((a, b) => b.date - a.date);
      const hasMore = parts.some(p => p.hasMore) || commits.length > limit;
      if (commits.length > limit) commits.length = limit;
      return { commits, hasMore };
    }
    const args = ['log', '--topo-order', `--max-count=${limit + 1}`, '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e'];
    let pathspec: string[] | null = null;
    if (query) {
      switch (query.kind) {
        case 'path':
          if (query.exact) {
            if (!query.isDir) args.push('--follow');
            pathspec = [query.value];
          } else {
            // Any file or folder whose name contains the text, at any depth.
            const v = query.value.replace(/[\\*?[\]]/g, '\\$&');
            pathspec = [`:(glob,icase)**/*${v}*`, `:(glob,icase)**/*${v}*/**`];
          }
          break;
        case 'message':
          args.push(`--grep=${query.value}`, '--regexp-ignore-case');
          break;
        case 'author':
          args.push(`--author=${query.value}`, '--regexp-ignore-case');
          break;
        case 'pickaxe':
          args.push(`-S${query.value}`);
          break;
        case 'regex':
          args.push(`-G${query.value}`);
          break;
      }
    }
    if (all) args.push('--exclude=refs/stash', '--all');
    else args.push('HEAD');
    if (pathspec) args.push('--', ...pathspec);
    const out = await this.tryRun(args);
    const commits: Commit[] = parseRecords(out).map(f => ({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      email: f[3],
      date: Number(f[4]),
      subject: f[5] || '',
    }));
    const hasMore = commits.length > limit;
    if (hasMore) commits.length = limit;
    return { commits, hasMore };
  }

  async head(): Promise<Head> {
    const branch = (await this.tryRun(['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
    const sha = (await this.tryRun(['rev-parse', '-q', '--verify', 'HEAD'])).trim() || null;
    return { branch, sha, detached: !branch };
  }

  async remotes(): Promise<RemoteInfo[]> {
    const out = await this.tryRun(['remote', '-v']);
    const map = new Map<string, RemoteInfo>();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line.trim());
      if (!m) continue;
      const r = map.get(m[1]) || { name: m[1], fetchUrl: '', pushUrl: '' };
      if (m[3] === 'fetch') r.fetchUrl = m[2];
      else r.pushUrl = m[2];
      map.set(m[1], r);
    }
    // Remotes without a URL still show up in `git remote`.
    for (const name of (await this.tryRun(['remote'])).split('\n').map(s => s.trim()).filter(Boolean)) {
      if (!map.has(name)) map.set(name, { name, fetchUrl: '', pushUrl: '' });
    }
    return [...map.values()];
  }

  async refs(): Promise<Refs> {
    const remoteInfo = await this.remotes();
    const remotes = remoteInfo.map(r => r.name);
    const fmt = [
      '%(refname)',
      '%(objectname)',
      '%(*objectname)',
      '%(upstream:short)',
      '%(upstream:track,nobracket)',
      '%(HEAD)',
      '%(objecttype)',
      '%(creatordate:unix)',
      '%(worktreepath)',
      '%(contents:subject)',
    ].join('%1f');
    const out = await this.tryRun(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
    const local: LocalBranch[] = [];
    const remote: RemoteBranch[] = [];
    const tags: Tag[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [ref, obj, deref, upstream, track, headMark, type, date, worktree, subject] = line.split(FS);
      const sha = deref || obj;
      if (ref.startsWith('refs/heads/')) {
        local.push({
          name: ref.slice(11),
          sha,
          upstream: upstream || null,
          ...parseTrack(track),
          isHead: headMark === '*',
          date: Number(date) || 0,
          worktree: worktree || null,
        });
      } else if (ref.startsWith('refs/remotes/')) {
        const full = ref.slice(13);
        if (full.endsWith('/HEAD')) continue;
        const split = splitRemoteRef(full, remotes) || { remote: full.split('/')[0], branch: full.slice(full.indexOf('/') + 1) };
        remote.push({ name: full, ...split, sha, date: Number(date) || 0 });
      } else if (ref.startsWith('refs/tags/')) {
        tags.push({ name: ref.slice(10), sha, annotated: type === 'tag', date: Number(date) || 0, message: type === 'tag' ? subject : '' });
      }
    }
    return { local, remote, tags, remotes, remoteInfo };
  }

  async stashes(): Promise<Stash[]> {
    const out = await this.tryRun(['stash', 'list', '--format=%gd%x1f%H%x1f%P%x1f%at%x1f%gs%x1e']);
    return parseRecords(out).map(f => ({
      ref: f[0],
      hash: f[1],
      parents: f[2] ? f[2].split(' ') : [],
      date: Number(f[3]),
      message: f[4] || '',
    }));
  }

  /** Working tree status (porcelain v1). */
  async status(): Promise<StatusEntry[]> {
    const out = await this.tryRun(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const tokens = out.split('\0');
    const files: StatusEntry[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const e = tokens[i];
      if (!e) continue;
      const x = e[0], y = e[1], p = e.slice(3);
      let orig: string | undefined;
      if (x === 'R' || x === 'C') orig = tokens[++i];
      files.push({ status: statusLetter(x, y), x, y, path: p, oldPath: orig });
    }
    return files;
  }

  async gitDir(): Promise<string> {
    if (!this.gitDirCache) this.gitDirCache = (await this.run(['rev-parse', '--absolute-git-dir'])).trim();
    return this.gitDirCache;
  }

  /** Detects an in-progress rebase / merge / cherry-pick / revert. */
  async opState(): Promise<OpState | null> {
    const dir = await this.gitDir().catch(() => null);
    if (!dir) return null;
    const exists = (p: string) => fs.existsSync(path.join(dir, p));
    const read = (p: string) => {
      try {
        return fs.readFileSync(path.join(dir, p), 'utf8').trim();
      } catch {
        return '';
      }
    };

    let state: Omit<OpState, 'conflicts'> | null = null;
    if (exists('rebase-merge')) {
      state = {
        kind: 'rebase',
        step: Number(read('rebase-merge/msgnum')) || 0,
        total: Number(read('rebase-merge/end')) || 0,
        branch: read('rebase-merge/head-name').replace(/^refs\/heads\//, ''),
        onto: read('rebase-merge/onto'),
      };
    } else if (exists('rebase-apply')) {
      state = {
        kind: 'rebase',
        step: Number(read('rebase-apply/next')) || 0,
        total: Number(read('rebase-apply/last')) || 0,
        branch: read('rebase-apply/head-name').replace(/^refs\/heads\//, ''),
        onto: read('rebase-apply/onto'),
      };
    } else if (exists('MERGE_HEAD')) {
      state = { kind: 'merge', head: read('MERGE_HEAD').split('\n')[0] };
    } else if (exists('CHERRY_PICK_HEAD') || exists('sequencer/todo')) {
      const head = read('CHERRY_PICK_HEAD');
      state = { kind: !head && read('sequencer/todo').startsWith('revert') ? 'revert' : 'cherry-pick', head };
    } else if (exists('REVERT_HEAD')) {
      state = { kind: 'revert', head: read('REVERT_HEAD') };
    }
    if (!state) return null;

    const conflicts = (await this.tryRun(['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
    return { ...state, conflicts };
  }

  async commit(sha: string): Promise<CommitDetails> {
    const out = await this.run(['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', sha]);
    const f = out.split(FS);
    return {
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      email: f[3],
      date: Number(f[4]),
      committer: f[5],
      committerEmail: f[6],
      commitDate: Number(f[7]),
      message: (f[8] || '').trim(),
    };
  }

  /** Files changed between two refs; `right` undefined means the working tree. */
  async diffFiles(left: string, right?: string): Promise<FileChange[]> {
    const args = ['diff', '--name-status', '-M', '-z', left];
    if (right) args.push(right);
    const tokens = (await this.run(args)).split('\0');
    const files: FileChange[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const s = tokens[i];
      if (!s) continue;
      const letter = s[0];
      if (letter === 'R' || letter === 'C') {
        files.push({ status: letter, oldPath: tokens[i + 1], path: tokens[i + 2] });
        i += 2;
      } else {
        files.push({ status: letter, path: tokens[i + 1] });
        i += 1;
      }
    }
    return files;
  }

  async aheadBehind(a: string, b: string): Promise<{ onlyLeft: number; onlyRight: number }> {
    const out = (await this.tryRun(['rev-list', '--left-right', '--count', `${a}...${b}`])).trim();
    const [left, right] = out.split(/\s+/).map(Number);
    return { onlyLeft: left || 0, onlyRight: right || 0 };
  }

  isAncestor(a: string, b: string): Promise<boolean> {
    return this.ok(['merge-base', '--is-ancestor', a, b]);
  }

  async hasStagedChanges(): Promise<boolean> {
    return !(await this.ok(['diff', '--cached', '--quiet']));
  }

  /** Commit that last touched `line` (1-based) of `relPath`; `contents` blames unsaved editor text. */
  async blameLine(relPath: string, line: number, contents?: string): Promise<string | null> {
    const args = ['blame', '--porcelain', '-L', `${line},${line}`];
    if (contents !== undefined) args.push('--contents', '-');
    args.push('--', relPath);
    const out = await this.run(args, contents !== undefined ? { input: contents } : {});
    const sha = out.split(' ')[0];
    return sha === ZERO_SHA ? null : sha;
  }

  async worktrees(): Promise<Worktree[]> {
    const out = await this.tryRun(['worktree', 'list', '--porcelain']);
    const list: Worktree[] = [];
    let cur: Worktree | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        cur = { path: path.normalize(line.slice(9)), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
        list.push(cur);
      } else if (!cur) {
        continue;
      } else if (line.startsWith('HEAD ')) {
        cur.head = line.slice(5);
      } else if (line.startsWith('branch ')) {
        cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        cur.detached = true;
      } else if (line === 'bare') {
        cur.bare = true;
      } else if (line.startsWith('locked')) {
        cur.locked = line.slice(7) || true;
      } else if (line.startsWith('prunable')) {
        cur.prunable = line.slice(9) || true;
      }
    }
    return list;
  }

  /** HEAD reflog, newest first. */
  async reflog(limit = 200): Promise<ReflogEntry[]> {
    // With --date=unix, %gd is HEAD@{<time>}; the index selector HEAD@{n} is simply the position.
    const out = await this.tryRun(['reflog', `-n${limit}`, '--date=unix', '--format=%H%x1f%gd%x1f%gs%x1f%s%x1e']);
    return parseRecords(out).map((f, i) => ({
      hash: f[0],
      selector: `HEAD@{${i}}`,
      action: f[2],
      subject: f[3],
      date: Number((/@\{(\d+)\}/.exec(f[1]) || [])[1]) || 0,
    }));
  }

  /**
   * Base branch for stacks and hygiene: configured, else origin/HEAD, else a common default name.
   * Needed on every refresh, so the answer is cached and only re-verified with one rev-parse.
   */
  async defaultBase(configured = ''): Promise<string | null> {
    const cached = this.baseCache;
    if (cached?.configured === configured && cached.value && (await this.isCommit(cached.value))) return cached.value;
    const value = await this.findBase(configured);
    this.baseCache = { configured, value };
    return value;
  }

  private isCommit(ref: string): Promise<boolean> {
    return this.ok(['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
  }

  private async findBase(configured: string): Promise<string | null> {
    const candidates: string[] = [];
    if (configured) candidates.push(configured);
    const originHead = (await this.tryRun(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (originHead) candidates.push(originHead);
    candidates.push('origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop', 'trunk');
    for (const c of candidates) {
      if (await this.isCommit(c)) return c;
    }
    return null;
  }

  /** Non-merge commits in `range`, oldest first (what an interactive rebase todo lists). */
  async rangeCommits(range: string): Promise<{ hash: string; subject: string; author: string }[]> {
    const out = await this.run(['log', '--reverse', '--topo-order', '--no-merges', '--format=%H%x1f%s%x1f%an%x1e', range]);
    return parseRecords(out).map(([hash, subject, author]) => ({ hash, subject, author }));
  }

  async mergeCount(range: string): Promise<number> {
    return Number((await this.run(['rev-list', '--merges', '--count', range])).trim()) || 0;
  }

  /** Local branches stacked with HEAD on top of `base`, ordered bottom to top. */
  async stack(base: string): Promise<StackEntry[]> {
    const list = async (args: string[]) =>
      (await this.tryRun(['branch', '--format=%(refname:short)', ...args])).split('\n').map(s => s.trim()).filter(Boolean);
    const [below, above] = await Promise.all([list(['--merged', 'HEAD', '--no-merged', base]), list(['--contains', 'HEAD', '--no-merged', base])]);
    const names = [...new Set([...below, ...above])];
    const counts = await Promise.all(names.map(async n => Number((await this.tryRun(['rev-list', '--count', `${base}..${n}`], '0')).trim()) || 0));
    return names.map((name, i) => ({ name, count: counts[i] })).sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
  }

  async mergedInto(base: string): Promise<string[]> {
    return (await this.tryRun(['branch', '--format=%(refname:short)', '--merged', base])).split('\n').map(s => s.trim()).filter(Boolean);
  }

  /** Tags on a remote as name -> peeled commit sha. */
  async remoteTags(remote: string): Promise<Record<string, string>> {
    const out = await this.run(['ls-remote', '--tags', remote]);
    const tags: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (!ref || !ref.startsWith('refs/tags/')) continue;
      const peeled = ref.endsWith('^{}');
      const name = ref.slice(10, peeled ? -3 : undefined);
      if (peeled || !tags[name]) tags[name] = sha;
    }
    return tags;
  }
}

/** Splits `origin/feature/x` into remote and branch, preferring the longest matching remote name. */
export function splitRemoteRef(ref: string, remotes: string[]): { remote: string; branch: string } | null {
  const remote = remotes.filter(n => ref.startsWith(n + '/')).sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: ref.slice(remote.length + 1) } : null;
}

function parseRecords(out: string): string[][] {
  return out
    .split(RS)
    .map(r => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map(r => r.split(FS));
}

function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (!track) return { ahead: 0, behind: 0, gone: false };
  if (track === 'gone') return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: false };
}

function statusLetter(x: string, y: string): string {
  if (x === '?' && y === '?') return 'U';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return '!';
  if (x === 'R' || x === 'C') return x;
  if (x === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  return 'M';
}
