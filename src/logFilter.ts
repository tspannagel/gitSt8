// Combinable history filters for `git log`. Pure: no vscode, no git execution.

export interface LogFilter {
  author?: string;
  since?: string;
  until?: string;
  paths?: string[];
  message?: string;
  /** Show only these branches/refs instead of All/HEAD. */
  refs?: string[];
  noMerges?: boolean;
  firstParent?: boolean;
  /** Only commits by the configured `user.email`. */
  mine?: boolean;
}

export interface FilterArgs {
  /** Options to add before the revision list. */
  args: string[];
  /** Pathspecs to add after `--`. */
  pathspec: string[];
  /** Author patterns (regex) and exact emails that must ALL match; see `authorArgs`. */
  authors: string[];
  emails: string[];
  /** Revisions to log instead of `--all`/`HEAD`; empty means the caller's default. */
  refs: string[];
}

function str(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  if (s.startsWith('-')) throw new Error(`Filter ${what} must not start with '-'.`);
  return s;
}

function strList(v: unknown, what: string): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(x => str(x, what)).filter((x): x is string => !!x);
  return out.length ? out : undefined;
}

/** Cleans a filter from the webview; throws on values git could mistake for options. Returns null if nothing is set. */
export function normalizeFilter(raw: unknown): LogFilter | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const f: LogFilter = {};
  const author = str(r.author, 'author');
  if (author) f.author = author;
  const since = str(r.since, 'since');
  if (since) f.since = since;
  const until = str(r.until, 'until');
  if (until) f.until = until;
  const message = str(r.message, 'message');
  if (message) f.message = message;
  // Paths go after `--`, so a leading '-' is harmless there.
  const paths = Array.isArray(r.paths) ? r.paths.map(p => String(p).trim()).filter(Boolean) : [];
  if (paths.length) f.paths = paths;
  const refs = strList(r.refs, 'branch');
  if (refs) f.refs = refs;
  if (r.noMerges) f.noMerges = true;
  if (r.firstParent) f.firstParent = true;
  if (r.mine) f.mine = true;
  return Object.keys(f).length ? f : null;
}


/** Builds git arguments for a filter. `email` is the resolved `user.email` for `mine`. */
export function buildFilterArgs(f: LogFilter | null | undefined, email?: string): FilterArgs {
  const out: FilterArgs = { args: [], pathspec: [], refs: [], authors: [], emails: [] };
  if (!f) return out;
  const author = str(f.author, 'author');
  const since = str(f.since, 'since');
  const until = str(f.until, 'until');
  const message = str(f.message, 'message');
  if (author) out.authors.push(author);
  if (f.mine && email) out.emails.push(email);
  if (since) out.args.push(`--since=${since}`);
  if (until) out.args.push(`--until=${until}`);
  if (message) out.args.push(`--grep=${message}`, '--regexp-ignore-case');
  if (f.noMerges) out.args.push('--no-merges');
  if (f.firstParent) out.args.push('--first-parent');
  out.pathspec = (f.paths || []).map(p => p.trim()).filter(Boolean);
  out.refs = strList(f.refs, 'branch') || [];
  return out;
}

/** True when the filter keeps history connected (only changes which branches or parents are walked). */
export function keepsGraph(f: LogFilter | null | undefined): boolean {
  if (!f) return true;
  return !(f.author || f.since || f.until || f.message || f.mine || (f.paths && f.paths.length));
}

// --author is a basic regex; several --author options are OR-ed, but filters must AND.
const escapeBre = (s: string) => s.replace(/[\\^$.*[\]]/g, '\\$&');
const escapePcre = (s: string) => s.replace(/[^A-Za-z0-9_\s]/g, '\\$&');

/** `--author` arguments requiring every pattern and email to match (several need PCRE lookaheads). */
export function authorArgs(authors: string[], emails: string[]): string[] {
  const n = authors.length + emails.length;
  if (n === 0) return [];
  if (n === 1) return [`--author=${authors.length ? authors[0] : `<${escapeBre(emails[0])}>`}`];
  const parts = [...authors, ...emails.map(e => `<${escapePcre(e)}>`)];
  return ['--perl-regexp', `--author=^${parts.map(p => `(?=.*${p})`).join('')}`];
}
