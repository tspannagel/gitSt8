/** Defaults for a new pull request. Pure helpers, no `vscode` import. */

/** "feature/add-login_page" -> "Add login page". */
export function humanizeBranch(name: string): string {
  const s = name.replace(/^(feature|feat|fix|bugfix|hotfix|chore)\//i, '').replace(/[-_/]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

/** Title: the commit subject when there is exactly one commit, else the humanized branch name. */
export function defaultTitle(branch: string, subjects: string[]): string {
  return subjects.length === 1 ? subjects[0] : humanizeBranch(branch);
}

/** Description: one bullet per commit subject (oldest first). */
export function defaultBody(subjects: string[]): string {
  return subjects.map(s => `- ${s}`).join('\n');
}

/** Refspec to fetch a pull request head into `pr/<n>` (GitHub), else null. */
export function prHeadRefspec(provider: 'github' | 'azure', n: number): string | null {
  return provider === 'github' && Number.isInteger(n) && n > 0 ? `pull/${n}/head:pr/${n}` : null;
}
