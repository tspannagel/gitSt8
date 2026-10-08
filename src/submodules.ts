// Submodule parsing. Pure functions, no `vscode` import.

export type SubmoduleState = 'ok' | 'uninitialized' | 'modified' | 'conflict';

export interface Submodule {
  name: string;
  path: string;
  url: string;
  branch?: string;
  /** Commit recorded in the superproject's index. */
  recorded: string;
  /** Commit checked out in the submodule; absent when it is not initialized. */
  checkedOut?: string;
  state: SubmoduleState;
}

export interface SubmoduleStatusEntry {
  state: SubmoduleState;
  sha: string;
  path: string;
  describe?: string;
}

/** `git submodule status --recursive`: `<prefix><sha> <path> (<describe>)`; prefix ' ' ok, '-' not initialized, '+' differs, 'U' conflict. */
export function parseSubmoduleStatus(out: string): SubmoduleStatusEntry[] {
  const list: SubmoduleStatusEntry[] = [];
  for (const line of out.split('\n')) {
    const m = /^([ +\-U])([0-9a-f]{40,64}) (.*?)(?: \(([^()]*)\))?$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const state: SubmoduleState = m[1] === '-' ? 'uninitialized' : m[1] === '+' ? 'modified' : m[1] === 'U' ? 'conflict' : 'ok';
    list.push({ state, sha: m[2], path: m[3], describe: m[4] });
  }
  return list;
}

export interface GitmodulesEntry {
  name: string;
  path?: string;
  url?: string;
  branch?: string;
}

/** `git config -f .gitmodules -z --get-regexp ^submodule\.`: records `key\nvalue\0`. Names may contain dots. */
export function parseGitmodules(out: string): GitmodulesEntry[] {
  const byName = new Map<string, GitmodulesEntry>();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    const value = nl < 0 ? '' : rec.slice(nl + 1);
    const m = /^submodule\.(.+)\.(path|url|branch)$/i.exec(key);
    if (!m) continue;
    const e = byName.get(m[1]) || { name: m[1] };
    (e as unknown as Record<string, string>)[m[2].toLowerCase()] = value;
    byName.set(m[1], e);
  }
  return [...byName.values()];
}

/** `git ls-files -s -z` filtered to gitlinks (mode 160000): path -> commit recorded in the index. */
export function parseGitlinks(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rec of out.split('\0')) {
    const m = /^160000 ([0-9a-f]{40,64}) (\d)\t(.*)$/s.exec(rec);
    if (m && (m[2] === '0' || !map.has(m[3]))) map.set(m[3], m[1]);
  }
  return map;
}

export function mergeSubmodules(status: SubmoduleStatusEntry[], modules: GitmodulesEntry[], links: Map<string, string>): Submodule[] {
  const byPath = new Map(modules.filter(m => m.path).map(m => [m.path as string, m]));
  return status.map(s => {
    const mod = byPath.get(s.path);
    // Status shows the checked-out commit for ' ' and '+', the recorded one for '-' and 'U'.
    const checkedOut = s.state === 'uninitialized' || s.state === 'conflict' ? undefined : s.sha;
    const sub: Submodule = {
      name: mod?.name || s.path,
      path: s.path,
      url: mod?.url || '',
      recorded: links.get(s.path) || s.sha,
      state: s.state,
    };
    if (mod?.branch) sub.branch = mod.branch;
    if (checkedOut) sub.checkedOut = checkedOut;
    return sub;
  });
}
