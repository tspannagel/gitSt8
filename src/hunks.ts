// Parsing of `git diff` output into hunks, and building minimal patches for partial staging.
// No `vscode` import, so it stays unit-testable.

export interface HunkLine {
  kind: ' ' | '+' | '-';
  /** Line content without the kind marker; a trailing `\r` (CRLF files) is kept. */
  text: string;
  /** The line has no terminating newline (`\ No newline at end of file`). */
  noEol?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The full `@@ -a,b +c,d @@ section` line. */
  header: string;
  lines: HunkLine[];
}

export interface FileDiff {
  /** Lines before the first hunk (`diff --git`, mode lines, `---`/`+++`, ...). */
  header: string[];
  hunks: Hunk[];
  binary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  /** Mode from `new file mode` / `deleted file mode`, used when a whole-file creation/deletion hunk is rebuilt. */
  mode?: string;
}

export interface HunkSelection {
  /** Index into `FileDiff.hunks`. */
  hunk: number;
  /** Indices into `Hunk.lines` (only `+`/`-` lines); omitted = the whole hunk. */
  lines?: number[];
  /** Optional `hunkSignature()` of the hunk the caller saw; a mismatch means the diff changed meanwhile. */
  sig?: string;
}

/** Thrown when the selection no longer matches the current diff. */
export class HunkSelectionError extends Error {}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function hunkSignature(h: Hunk): string {
  return `${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}`;
}

/** Parses the output of `git diff --no-color --no-ext-diff [--cached] -- <path>` for ONE file. */
export function parseDiff(text: string): FileDiff {
  const rows = text.split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  const out: FileDiff = { header: [], hunks: [], binary: false, isNew: false, isDeleted: false };
  let i = 0;
  for (; i < rows.length && !HUNK_RE.test(rows[i]); i++) {
    const r = rows[i];
    out.header.push(r);
    if (/^Binary files .* differ$/.test(r) || r === 'GIT binary patch') out.binary = true;
    let m: RegExpMatchArray | null;
    if ((m = r.match(/^new file mode (\d+)/))) {
      out.isNew = true;
      out.mode = m[1];
    } else if ((m = r.match(/^deleted file mode (\d+)/))) {
      out.isDeleted = true;
      out.mode = m[1];
    }
  }
  while (i < rows.length) {
    const m = rows[i].match(HUNK_RE);
    if (!m) {
      i++; // stray line after a hunk (should not happen); skip rather than misparse
      continue;
    }
    const h: Hunk = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], header: rows[i], lines: [] };
    i++;
    let o = 0;
    let n = 0;
    // Counts decide where the hunk ends, so content lines that look like headers can't confuse us.
    while (i < rows.length && (o < h.oldLines || n < h.newLines)) {
      const r = rows[i];
      const k = r[0];
      if (k === '\\') {
        const last = h.lines[h.lines.length - 1];
        if (last) last.noEol = true;
        i++;
        continue;
      }
      if (k !== ' ' && k !== '+' && k !== '-') break;
      h.lines.push({ kind: k, text: r.slice(1) });
      if (k !== '+') o++;
      if (k !== '-') n++;
      i++;
    }
    while (i < rows.length && rows[i][0] === '\\') {
      const last = h.lines[h.lines.length - 1];
      if (last) last.noEol = true;
      i++;
    }
    out.hunks.push(h);
  }
  return out;
}

const quotePath = (p: string) =>
  /["\\\x00-\x1f]/.test(p)
    ? '"' + p.replace(/[\\"]/g, '\\$&').replace(/[\x00-\x1f]/g, c => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))) + '"'
    : p;

/**
 * Builds a patch for one hunk, or for selected lines of it.
 *
 * Forward (`reverse: false`): the patch applies to the OLD side of the diff (`git apply --cached` of an unstaged diff
 * stages it). Unselected `-` lines stay as context, unselected `+` lines are dropped.
 * Reverse (`reverse: true`): the patch is applied with `--reverse`, so it must match the NEW side of the diff
 * (`git apply --cached --reverse` of a staged diff unstages, `git apply --reverse` of an unstaged diff discards).
 * The rule mirrors: unselected `+` lines stay as context (they exist in the target), unselected `-` lines are dropped.
 *
 * Hunk headers are recomputed against that base side, so the result does not depend on `--recount` or on other hunks.
 * Throws HunkSelectionError if the selection does not fit `file`.
 */
export function buildPatch(file: FileDiff, sel: HunkSelection, opts: { reverse: boolean; path: string }): string {
  if (file.binary) throw new HunkSelectionError('Binary files can only be staged as a whole.');
  const h = file.hunks[sel.hunk];
  if (!h) throw new HunkSelectionError('The hunk no longer exists.');
  if (sel.sig !== undefined && sel.sig !== hunkSignature(h)) throw new HunkSelectionError('The file changed since the diff was shown.');
  const changeIdx = h.lines.map((l, i) => (l.kind === ' ' ? -1 : i)).filter(i => i >= 0);
  let chosen: Set<number>;
  if (sel.lines === undefined) chosen = new Set(changeIdx);
  else {
    chosen = new Set(sel.lines);
    for (const i of chosen) if (!changeIdx.includes(i)) throw new HunkSelectionError('The selected lines no longer match the diff.');
  }
  if (!chosen.size) throw new HunkSelectionError('No lines selected.');
  const full = chosen.size === changeIdx.length;

  const keepUnselected = opts.reverse ? '+' : '-'; // becomes context
  const body: string[] = [];
  let baseCount = 0;
  let otherCount = 0;
  for (let i = 0; i < h.lines.length; i++) {
    const l = h.lines[i];
    let kind: string = l.kind;
    if (l.kind !== ' ' && !chosen.has(i)) {
      if (l.kind === keepUnselected) kind = ' ';
      else continue; // dropped; its "no newline" marker goes with it
    }
    body.push(kind + l.text);
    if (l.noEol) body.push('\\ No newline at end of file');
    // base side = what the patch is matched against
    if (opts.reverse ? kind !== '-' : kind !== '+') baseCount++;
    if (opts.reverse ? kind !== '+' : kind !== '-') otherCount++;
  }
  const baseStart = opts.reverse ? h.newStart : h.oldStart;
  const otherStart = baseCount === 0 ? baseStart + 1 : otherCount === 0 ? baseStart - 1 : baseStart;
  const [oldStart, oldCount, newStart, newCount] = opts.reverse ? [otherStart, otherCount, baseStart, baseCount] : [baseStart, baseCount, otherStart, otherCount];
  const range = (s: number, c: number) => (c === 1 ? `${s}` : `${s},${c}`);
  const section = h.header.replace(/^@@ [^@]*@@ ?/, '');

  const a = quotePath('a/' + opts.path);
  const b = quotePath('b/' + opts.path);
  const head = [`diff --git ${a} ${b}`];
  if (full && file.isNew) head.push(`new file mode ${file.mode || '100644'}`, '--- /dev/null', `+++ ${b}`);
  else if (full && file.isDeleted) head.push(`deleted file mode ${file.mode || '100644'}`, `--- ${a}`, '+++ /dev/null');
  else head.push(`--- ${a}`, `+++ ${b}`);
  return [...head, `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${section ? ' ' + section : ''}`, ...body].join('\n') + '\n';
}
