// Prompt building and output cleanup for "generate a commit message". No vscode import, so it is unit-testable.

export interface CommitPromptInput {
  diff: string;
  stat: string;
  recentSubjects: string[];
  branch: string;
  /** Upper bound for the diff part of the prompt (characters). */
  maxChars: number;
}

const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?: \S/;

/** True when most recent subjects follow Conventional Commits. */
export function usesConventionalCommits(subjects: string[]): boolean {
  const s = subjects.filter(x => x.trim());
  return s.length >= 3 && s.filter(x => CONVENTIONAL.test(x)).length * 2 >= s.length;
}

/** Splits a unified diff into one chunk per file (`diff --git` header included). */
function splitByFile(diff: string): string[] {
  const parts = diff.split(/^(?=diff --git )/m).filter(p => p.length);
  return parts.length ? parts : diff ? [diff] : [];
}

function fileName(chunk: string): string {
  const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(chunk);
  return m ? m[2] : '(unknown file)';
}

/**
 * Fits the diff into `max` characters. Each file gets a fair share of the budget (small files leave
 * their unused part to the bigger ones). Truncated files are cut at a line boundary and marked.
 */
export function truncateDiff(diff: string, max: number): { text: string; truncated: string[] } {
  const chunks = splitByFile(diff);
  const order = chunks.map((c, i) => i).sort((a, b) => chunks[a].length - chunks[b].length);
  const budget: number[] = [];
  let remaining = Math.max(0, max);
  order.forEach((idx, n) => {
    const share = Math.floor(remaining / (order.length - n));
    const take = Math.min(chunks[idx].length, share);
    budget[idx] = take;
    remaining -= take;
  });
  const truncated: string[] = [];
  const out = chunks.map((c, i) => {
    if (c.length <= budget[i]) return c;
    truncated.push(fileName(c));
    let cut = c.slice(0, budget[i]);
    const nl = cut.lastIndexOf('\n');
    if (nl > 0) cut = cut.slice(0, nl + 1);
    return `${cut}[... diff of ${fileName(c)} truncated: ${c.length - cut.length} more characters ...]\n`;
  });
  return { text: out.join(''), truncated };
}

export function buildCommitPrompt(input: CommitPromptInput): string {
  const { text, truncated } = truncateDiff(input.diff, input.maxChars);
  const subjects = input.recentSubjects.filter(s => s.trim());
  const conventional = usesConventionalCommits(subjects);
  const lines: string[] = [
    'You write git commit messages. Write the commit message for the change below.',
    '',
    'Rules:',
    '- First line: a subject of at most 72 characters, imperative mood, no trailing period.',
    '- Then a blank line and an optional body that explains what changed and why. Skip the body for small changes. Wrap lines at about 72 characters.',
    conventional
      ? '- The repository uses Conventional Commits (type(scope): subject, e.g. feat, fix, docs, refactor, test, chore). Follow that format.'
      : '- Follow the style of the recent commit subjects below (capitalization, tense, prefixes).',
    '- Output only the commit message. No Markdown, no code fences, no quotes, no preamble.',
    '',
    `Branch: ${input.branch || '(detached HEAD)'}`,
  ];
  if (subjects.length) lines.push('', 'Recent commit subjects in this repository:', ...subjects.map(s => `- ${s}`));
  lines.push('', 'Changed files (git diff --stat):', input.stat.trim() || '(none)');
  lines.push('', 'Diff:', text.trim() ? text.replace(/\n+$/, '') : '(empty)');
  if (truncated.length) {
    lines.push('', `Note: the diff was shortened to fit. These files were truncated: ${truncated.join(', ')}. Use the stat above for the full list of changes.`);
  }
  return lines.join('\n');
}

/** Removes code fences, surrounding quotes and a leading "Commit message:" label from model output. */
export function cleanModelOutput(text: string): string {
  let t = text.replace(/\r\n/g, '\n').trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  else t = t.replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  t = t.replace(/^(?:here(?:'s| is) (?:the |a )?)?(?:suggested )?commit message\s*:?\s*\n?/i, '').trim();
  const q = /^(["'`])([\s\S]*)\1$/.exec(t);
  if (q) t = q[2].trim();
  return t;
}
