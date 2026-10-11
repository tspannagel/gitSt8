// Git LFS helpers. Pure functions, no `vscode` import.

export interface LfsFile {
  oid: string;
  path: string;
  /** false: only the pointer file is in the working tree. */
  downloaded: boolean;
}

export interface LfsSummary {
  total: number;
  missing: number;
}

/** `git lfs ls-files`: `<oid> * <path>` (content present) or `<oid> - <path>` (pointer only). */
export function parseLfsFiles(out: string): LfsFile[] {
  const list: LfsFile[] = [];
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{8,64}) ([*-]) (.+?)\r?$/.exec(line);
    if (m) list.push({ oid: m[1], path: m[3], downloaded: m[2] === '*' });
  }
  return list;
}

export function summarizeLfs(files: LfsFile[]): LfsSummary {
  return { total: files.length, missing: files.filter(f => !f.downloaded).length };
}

/** True when a .gitattributes file routes anything through the lfs filter. */
export function usesLfs(gitattributes: string): boolean {
  return gitattributes.split('\n').some(l => !l.trim().startsWith('#') && /\bfilter=lfs\b/.test(l));
}
