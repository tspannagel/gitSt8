// git bisect state. No `vscode` import, so it stays unit-testable.
import * as fs from 'fs';
import * as path from 'path';
import type { GitCli } from './git';

export interface BisectState {
  active: boolean;
  /** Branch (or detached sha) to return to on reset, from BISECT_START. */
  start?: string;
  terms: { bad: string; good: string };
  bad?: string;
  good: string[];
  skipped: string[];
  /** Candidate revisions left to test after the current one (git's "N revisions left to test after this"). */
  remaining?: number;
  /** Estimated number of steps left. */
  steps?: number;
  /** Commit git wants tested next (the checked out one). */
  current?: string;
  /** First bad commit, once found. */
  culprit?: string;
}

const HEX = /^[0-9a-f]{40}$/;

/** Parses `git for-each-ref refs/bisect --format='%(refname)%x1f%(objectname)'` output. */
export function parseBisectRefs(out: string, terms = { bad: 'bad', good: 'good' }): { bad?: string; good: string[]; skipped: string[] } {
  const res: { bad?: string; good: string[]; skipped: string[] } = { good: [], skipped: [] };
  for (const line of out.split('\n')) {
    const [ref, sha] = line.trim().split('\x1f');
    if (!ref || !HEX.test(sha || '')) continue;
    const name = ref.replace(/^refs\/bisect\//, '');
    if (name === terms.bad) res.bad = sha;
    else if (name.startsWith(`${terms.good}-`)) res.good.push(sha);
    else if (name.startsWith('skip-')) res.skipped.push(sha);
  }
  return res;
}

/** BISECT_TERMS holds the "bad" term on line 1 and the "good" term on line 2. */
export function parseBisectTerms(text: string): { bad: string; good: string } {
  const [bad, good] = text.split('\n').map(s => s.trim());
  return { bad: bad || 'bad', good: good || 'good' };
}

/** Parses `git rev-list --bisect-vars` output (shell assignments). */
export function parseBisectVars(out: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const m of out.matchAll(/^(\w+)='?([^'\n]*)'?$/gm)) vars[m[1]] = m[2];
  return vars;
}

/** Finds the culprit in the output of `git bisect good|bad|skip` ("<sha> is the first bad commit"). */
export function parseFirstBad(out: string): string | undefined {
  return /^([0-9a-f]{40}) is the first bad commit/m.exec(out)?.[1];
}

/**
 * Reads the bisect state. Costs one file check when no bisect is running.
 * Remaining revisions/steps come from `git rev-list --bisect-vars <bad> --not <good...>` (skips are not
 * excluded, so with skips the numbers are an upper bound). The culprit is derived: when the only candidate
 * left is the bad commit itself, it is the first bad commit.
 */
export async function readBisect(git: GitCli): Promise<BisectState> {
  const none: BisectState = { active: false, terms: { bad: 'bad', good: 'good' }, good: [], skipped: [] };
  const dir = await git.gitDir().catch(() => null);
  if (!dir || !fs.existsSync(path.join(dir, 'BISECT_START'))) return none;
  const read = (p: string) => {
    try {
      return fs.readFileSync(path.join(dir, p), 'utf8');
    } catch {
      return '';
    }
  };
  const terms = parseBisectTerms(read('BISECT_TERMS'));
  const state: BisectState = { ...none, active: true, terms, start: read('BISECT_START').trim() };
  const refs = parseBisectRefs(await git.tryRun(['for-each-ref', 'refs/bisect', '--format=%(refname)%1f%(objectname)']), terms);
  Object.assign(state, refs);
  state.current = (await git.tryRun(['rev-parse', '--verify', '-q', 'HEAD'])).trim() || undefined;
  if (state.bad && state.good.length) {
    const vars = parseBisectVars(await git.tryRun(['rev-list', '--bisect-vars', state.bad, '--not', ...state.good]));
    if (vars.bisect_nr !== undefined) {
      state.remaining = Number(vars.bisect_nr);
      state.steps = Number(vars.bisect_steps);
      if (vars.bisect_rev === state.bad && state.remaining === 0) state.culprit = state.bad;
    }
  }
  return state;
}
