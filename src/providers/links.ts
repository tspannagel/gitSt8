import { RepoRef } from './types';

/** Encodes each path segment but keeps the `/` separators (branch names and file paths contain them). */
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export interface LineRange {
  start: number;
  end?: number;
}

const base = (repo: RepoRef) => repo.webUrl.replace(/\/+$/, '');

export function commitUrl(repo: RepoRef, sha: string): string {
  return `${base(repo)}/commit/${encodeURIComponent(sha)}`;
}

/** Link to a file at a fixed commit, optionally highlighting lines (1-based, inclusive). */
export function fileUrl(repo: RepoRef, sha: string, filePath: string, lines?: LineRange): string {
  const p = filePath.replace(/^\/+/, '');
  const start = lines && lines.start > 0 ? lines.start : 0;
  const end = lines && start ? Math.max(lines.end ?? start, start) : 0;
  if (repo.provider === 'github') {
    const hash = !start ? '' : end > start ? `#L${start}-L${end}` : `#L${start}`;
    return `${base(repo)}/blob/${encodeURIComponent(sha)}/${encPath(p)}${hash}`;
  }
  let url = `${base(repo)}?path=${encodeURIComponent('/' + p)}&version=GC${encodeURIComponent(sha)}`;
  // Azure DevOps' end position is exclusive: column 1 of the line after the range.
  if (start) url += `&line=${start}&lineEnd=${end + 1}&lineStartColumn=1&lineEndColumn=1&lineStyle=plain`;
  return `${url}&_a=contents`;
}

export function branchUrl(repo: RepoRef, branch: string): string {
  return repo.provider === 'github' ? `${base(repo)}/tree/${encPath(branch)}` : `${base(repo)}?version=GB${encodeURIComponent(branch)}`;
}

/** Opens the "new pull request" page with source and target preselected. Branch names without remote prefix. */
export function createPrUrl(repo: RepoRef, source: string, target: string): string {
  if (repo.provider === 'github') return `${base(repo)}/compare/${encPath(target)}...${encPath(source)}?expand=1`;
  return `${base(repo)}/pullrequestcreate?sourceRef=${encodeURIComponent(source)}&targetRef=${encodeURIComponent(target)}`;
}

export const providerName = (repo: RepoRef) => (repo.provider === 'github' ? 'GitHub' : 'Azure DevOps');
