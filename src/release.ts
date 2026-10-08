// Release helpers: semver tags, Conventional Commits classification, version bump suggestion, changelog rendering.
// Pure logic, no `vscode` import, so it stays unit-testable.

export interface Version {
  prefix: string; // '' | 'v' | 'release-' ...
  major: number;
  minor: number;
  patch: number;
  prerelease: string[]; // dot-separated identifiers, [] for a release
  build: string;
  name: string; // the original tag name
}

export type Bump = 'major' | 'minor' | 'patch';
export type Section = 'breaking' | 'feat' | 'fix' | 'perf' | 'other';

export interface RawCommit {
  hash: string;
  subject: string;
  body: string;
}

export interface ReleaseCommit {
  hash: string;
  type: string; // conventional type, or '' when not conventional
  scope: string;
  description: string; // subject without the "type(scope)!: " prefix
  breaking: boolean;
  breakingNote: string; // text of the BREAKING CHANGE footer, if any
  section: Section;
}

// Prefix is "v", or a word ending in - _ / (e.g. "release-").
const VERSION_RE = /^((?:[A-Za-z][A-Za-z0-9_.]*[-_/])|[vV])?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parses `1.2.3`, `v1.2.3`, `release-1.2.3-rc.1+build5`. Returns null for anything that is not semver. */
export function parseVersionTag(name: string): Version | null {
  const m = VERSION_RE.exec(name);
  if (!m) return null;
  return {
    prefix: m[1] || '',
    major: Number(m[2]),
    minor: Number(m[3]),
    patch: Number(m[4]),
    prerelease: m[5] ? m[5].split('.') : [],
    build: m[6] || '',
    name,
  };
}

/** Semver precedence (build metadata ignored). Negative when a < b. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length; // release > prerelease
  const n = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1; // numeric identifiers sort below alphanumeric ones
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The highest version among the tag names (non-semver tags are ignored), or null. */
export function latestVersion(tags: string[]): Version | null {
  let best: Version | null = null;
  for (const t of tags) {
    const v = parseVersionTag(t);
    if (v && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

const SECTION_OF: Record<string, Section> = { feat: 'feat', fix: 'fix', perf: 'perf' };
/** Types that are recognised as Conventional Commits but listed under "Other". */
const OTHER_TYPES = new Set(['refactor', 'docs', 'chore', 'style', 'test', 'tests', 'build', 'ci', 'revert']);
const HEADER_RE = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:[ \t]+(.+)$/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:[ \t]*([\s\S]*?)(?=\n[A-Za-z-]+: |\n[A-Za-z-]+ #|(?![\s\S]))/m;

/** Classifies one commit. Non-conventional commits (and unknown types) get section 'other'. */
export function classifyCommit(c: RawCommit): ReleaseCommit {
  const footer = BREAKING_FOOTER_RE.exec(c.body || '');
  const breakingNote = footer ? footer[1].trim() : '';
  const h = HEADER_RE.exec(c.subject.trim());
  const type = h ? h[1].toLowerCase() : '';
  const known = !!h && (type in SECTION_OF || OTHER_TYPES.has(type));
  if (!known) {
    // A footer still marks a non-conventional commit as breaking.
    return { hash: c.hash, type: '', scope: '', description: c.subject.trim(), breaking: !!footer, breakingNote, section: footer ? 'breaking' : 'other' };
  }
  const breaking = !!h![3] || !!footer;
  return { hash: c.hash, type, scope: h![2] || '', description: h![4].trim(), breaking, breakingNote, section: breaking ? 'breaking' : SECTION_OF[type] || 'other' };
}

export function classifyCommits(commits: RawCommit[]): ReleaseCommit[] {
  return commits.map(classifyCommit);
}

/**
 * Suggested bump: breaking -> major, feat -> minor, anything else -> patch.
 * Pre-1.0 (`currentMajor === 0`) breaking changes only bump minor, following the common 0.x convention
 * that the public API is not yet stable. Leave `currentMajor` undefined to use the 1.0+ rules.
 */
export function suggestBump(commits: ReleaseCommit[], currentMajor?: number): Bump {
  if (commits.some(c => c.breaking)) return currentMajor === 0 ? 'minor' : 'major';
  if (commits.some(c => c.type === 'feat')) return 'minor';
  return 'patch';
}

/** Next version string. `current` null (no tags yet) starts from 0.0.0. A prerelease/build part is dropped. */
export function nextVersion(current: Version | null, bump: Bump, prefix = current?.prefix ?? 'v'): string {
  const { major, minor, patch } = current || { major: 0, minor: 0, patch: 0 };
  if (bump === 'major') return `${prefix}${major + 1}.0.0`;
  if (bump === 'minor') return `${prefix}${major}.${minor + 1}.0`;
  return `${prefix}${major}.${minor}.${patch + 1}`;
}

const HEADINGS: [Section, string][] = [['breaking', 'Breaking changes'], ['feat', 'Features'], ['fix', 'Fixes'], ['perf', 'Performance'], ['other', 'Other']];

export interface ChangelogInput {
  version: string;
  date: string; // YYYY-MM-DD
  commits: ReleaseCommit[];
  compareUrl?: string;
}

/** Markdown changelog grouped by section; empty sections are omitted. */
export function renderChangelog(i: ChangelogInput): string {
  const title = i.compareUrl ? `[${i.version}](${i.compareUrl})` : i.version;
  const out = [`## ${title} (${i.date})`];
  for (const [section, heading] of HEADINGS) {
    const items = i.commits.filter(c => c.section === section);
    if (!items.length) continue;
    out.push('', `### ${heading}`, '');
    for (const c of items) {
      const scope = c.scope ? `**${c.scope}:** ` : '';
      const note = section === 'breaking' && c.breakingNote ? ` - ${c.breakingNote.replace(/\s*\n\s*/g, ' ')}` : '';
      out.push(`- ${scope}${c.description}${note} (${c.hash.slice(0, 7)})`);
    }
  }
  return out.join('\n') + '\n';
}
