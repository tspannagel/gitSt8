import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// git config: scopes, `--list -z` parsing, key validation and the catalog of common settings shown as selectors. Pure: no vscode.

/** Scopes the UI can edit. `system` and `worktree` are only shown as the origin of an effective value. */
export type ConfigScope = 'local' | 'global';
export const CONFIG_SCOPES: ConfigScope[] = ['local', 'global'];

export interface ConfigEntry {
  /** Only set when listed with `--show-scope`. */
  scope?: string;
  /** As git prints it: section and name lowercased, subsection kept. */
  key: string;
  /** null for a bare `name` line (implicit true). */
  value: string | null;
}

export type SettingType = 'bool' | 'enum' | 'text';

export interface ConfigSetting {
  key: string;
  group: string;
  type: SettingType;
  options?: string[];
  hint: string;
}

const BOOL = ['true', 'false'];

/** Common settings the dialog shows as selectors / inputs. Everything else is reachable as a free-text entry. */
export const CONFIG_SETTINGS: ConfigSetting[] = [
  { key: 'user.name', group: 'Identity', type: 'text', hint: 'Author and committer name' },
  { key: 'user.email', group: 'Identity', type: 'text', hint: 'Author and committer email' },
  { key: 'commit.gpgSign', group: 'Signing', type: 'bool', options: BOOL, hint: 'Sign every commit' },
  { key: 'tag.gpgSign', group: 'Signing', type: 'bool', options: BOOL, hint: 'Sign every annotated tag' },
  { key: 'gpg.format', group: 'Signing', type: 'enum', options: ['openpgp', 'x509', 'ssh'], hint: 'Kind of signing key' },
  { key: 'user.signingKey', group: 'Signing', type: 'text', hint: 'Key ID, or the public key file for ssh' },
  { key: 'pull.rebase', group: 'Pull, push, fetch', type: 'enum', options: ['false', 'true', 'merges', 'interactive'], hint: 'Rebase instead of merge on pull' },
  { key: 'pull.ff', group: 'Pull, push, fetch', type: 'enum', options: ['true', 'false', 'only'], hint: 'Fast-forward behavior of pull' },
  { key: 'push.default', group: 'Pull, push, fetch', type: 'enum', options: ['simple', 'current', 'upstream', 'matching', 'nothing'], hint: 'What a plain push pushes' },
  { key: 'push.autoSetupRemote', group: 'Pull, push, fetch', type: 'bool', options: BOOL, hint: 'First push of a new branch sets its upstream' },
  { key: 'push.followTags', group: 'Pull, push, fetch', type: 'bool', options: BOOL, hint: 'Push annotated tags reachable from pushed commits' },
  { key: 'fetch.prune', group: 'Pull, push, fetch', type: 'bool', options: BOOL, hint: 'Delete remote-tracking branches that are gone' },
  { key: 'fetch.pruneTags', group: 'Pull, push, fetch', type: 'bool', options: BOOL, hint: 'Also delete local tags that are gone on the remote' },
  { key: 'init.defaultBranch', group: 'Branches, merge, rebase', type: 'text', hint: 'Branch name of a new repository' },
  { key: 'branch.autoSetupRebase', group: 'Branches, merge, rebase', type: 'enum', options: ['never', 'local', 'remote', 'always'], hint: 'New tracking branches pull with rebase' },
  { key: 'merge.ff', group: 'Branches, merge, rebase', type: 'enum', options: ['true', 'false', 'only'], hint: 'Fast-forward behavior of merge' },
  { key: 'merge.conflictStyle', group: 'Branches, merge, rebase', type: 'enum', options: ['merge', 'diff3', 'zdiff3'], hint: 'Conflict markers; diff3 / zdiff3 also show the base' },
  { key: 'rebase.autoStash', group: 'Branches, merge, rebase', type: 'bool', options: BOOL, hint: 'Stash local changes around a rebase' },
  { key: 'rebase.autoSquash', group: 'Branches, merge, rebase', type: 'bool', options: BOOL, hint: 'Apply fixup! / squash! commits in interactive rebase' },
  { key: 'rebase.updateRefs', group: 'Branches, merge, rebase', type: 'bool', options: BOOL, hint: 'Move stacked branches along with a rebase' },
  { key: 'rerere.enabled', group: 'Branches, merge, rebase', type: 'bool', options: BOOL, hint: 'Remember and reuse conflict resolutions' },
  { key: 'core.autocrlf', group: 'Working tree', type: 'enum', options: ['true', 'false', 'input'], hint: 'Line ending conversion on checkout / commit' },
  { key: 'core.eol', group: 'Working tree', type: 'enum', options: ['native', 'lf', 'crlf'], hint: 'Line endings for text files in the working tree' },
  { key: 'core.ignoreCase', group: 'Working tree', type: 'bool', options: BOOL, hint: 'File system is case-insensitive' },
  { key: 'core.fileMode', group: 'Working tree', type: 'bool', options: BOOL, hint: 'Track the executable bit' },
  { key: 'core.longpaths', group: 'Working tree', type: 'bool', options: BOOL, hint: 'Allow paths over 260 characters (Git for Windows)' },
  { key: 'diff.algorithm', group: 'Diff', type: 'enum', options: ['myers', 'minimal', 'patience', 'histogram'], hint: 'Diff algorithm' },
  { key: 'diff.colorMoved', group: 'Diff', type: 'enum', options: ['no', 'default', 'plain', 'blocks', 'zebra', 'dimmed-zebra'], hint: 'Highlight moved lines in diffs' },
  { key: 'core.editor', group: 'Tools', type: 'text', hint: 'Editor for messages, e.g. code --wait' },
  { key: 'credential.helper', group: 'Tools', type: 'text', hint: 'Credential store, e.g. manager' },
  { key: 'core.hooksPath', group: 'Tools', type: 'text', hint: 'Folder with hooks instead of .git/hooks' },
];

/**
 * `section.name` or `section.subsection.name`. Section and name: letters, digits and `-`, starting with a letter
 * (so a key can never look like an option); the subsection may contain anything but a newline.
 */
export function isValidConfigKey(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]*(\.[^\n\0]*)?\.[A-Za-z][A-Za-z0-9-]*$/.test(key);
}

/** Parses `git config --list -z`, with `--show-scope` when `withScope`. */
export function parseConfigList(out: string, withScope = false): ConfigEntry[] {
  const parts = out.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  const entries: ConfigEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const scope = withScope ? parts[i++] : undefined;
    const kv = parts[i];
    if (kv === undefined) break;
    const nl = kv.indexOf('\n');
    const entry: ConfigEntry = nl < 0 ? { key: kv, value: null } : { key: kv.slice(0, nl), value: kv.slice(nl + 1) };
    if (scope !== undefined) entry.scope = scope;
    entries.push(entry);
  }
  return entries;
}

/** git compares section and name case-insensitively, the subsection case-sensitively. */
export function configKeyId(key: string): string {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first < 0) return key.toLowerCase();
  return first === last ? key.toLowerCase() : `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

/** The value git uses for `key` (the last one wins) and the scope it comes from. */
export function effectiveValue(entries: ConfigEntry[], key: string): ConfigEntry | undefined {
  const id = configKeyId(key);
  for (let i = entries.length - 1; i >= 0; i--) if (configKeyId(entries[i].key) === id) return entries[i];
  return undefined;
}

/** The file `git config --global` writes to: $GIT_CONFIG_GLOBAL, else ~/.gitconfig unless only the XDG file exists. */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.GIT_CONFIG_GLOBAL) return env.GIT_CONFIG_GLOBAL;
  const dot = path.join(home, '.gitconfig');
  const xdg = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'config');
  return !fs.existsSync(dot) && fs.existsSync(xdg) ? xdg : dot;
}
