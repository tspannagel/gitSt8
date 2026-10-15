import * as vscode from 'vscode';
import * as path from 'path';
import { Integrations } from './integration';
import { AuthError, HostedRepo } from './providers/types';
import type { API } from './types/git';

// Init / clone / pick a remote repository. Network work goes through the vscode.git API (init, clone),
// so credentials, progress and the "open the clone?" prompt behave like VS Code's own commands.

interface Item extends vscode.QuickPickItem {
  id?: string;
  value?: string;
}

const samePath = (a: string, b: string) => path.relative(a, b) === '';

/**
 * Asks where a repository lives: the signed-in GitHub / Azure DevOps account, or a typed URL.
 * Returns the clone URL, or undefined when cancelled.
 */
export async function pickRepositoryUrl(integrations: Integrations, title: string): Promise<string | undefined> {
  const sources: Item[] = [
    { label: '$(github) GitHub', description: 'github.com · your repositories', id: 'github', value: 'github.com' },
    ...integrations.githubHosts().map(h => ({ label: '$(github) GitHub Enterprise', description: `${h} · your repositories`, id: 'github', value: h })),
    { label: '$(azure-devops) Azure DevOps', description: 'repositories of your organizations', id: 'azure' },
    { label: '$(link) Enter a URL…', description: 'HTTPS or SSH', id: 'url' },
  ];
  const source = await vscode.window.showQuickPick(sources, { title, placeHolder: 'Where is the repository?' });
  if (!source) return undefined;
  if (source.id === 'url') return enterUrl(title);
  if (source.id === 'github') return pickHosted(title, `Loading repositories from ${source.value}…`, () => integrations.githubRepos(source.value!));
  const org = await pickAzureOrg(integrations, title);
  return org ? pickHosted(`${title} · ${org}`, `Loading repositories of ${org}…`, () => integrations.azureRepos(org)) : undefined;
}

async function enterUrl(title: string): Promise<string | undefined> {
  const url = await vscode.window.showInputBox({
    title,
    prompt: 'Repository URL',
    placeHolder: 'https://github.com/owner/repo.git  or  git@github.com:owner/repo.git',
    ignoreFocusOut: true,
    validateInput: v => (!v.trim() ? undefined : /\s/.test(v.trim()) ? 'A URL cannot contain spaces.' : v.trim().startsWith('-') ? 'Not a URL.' : undefined),
  });
  return url?.trim() || undefined;
}

/** A quick pick that shows a spinner while `load` runs, then lets the user search the result. */
async function pickHosted(title: string, loading: string, load: () => Promise<HostedRepo[]>): Promise<string | undefined> {
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = title;
  qp.placeholder = loading;
  qp.busy = true;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  qp.show();
  const picked = new Promise<string | undefined>(resolve => {
    qp.onDidAccept(() => {
      const it = qp.selectedItems[0];
      if (it?.value) resolve(it.value);
    });
    qp.onDidHide(() => resolve(undefined));
  });
  load().then(
    repos => {
      qp.busy = false;
      qp.placeholder = repos.length ? 'Search repositories' : 'No repositories found for this account';
      qp.items = repos.map(r => ({
        label: `${r.isPrivate ? '$(lock) ' : '$(repo) '}${r.label}`,
        description: [r.isArchived && 'archived', r.isFork && 'fork'].filter(Boolean).join(' · '),
        detail: r.description,
        value: r.cloneUrl,
      }));
    },
    e => {
      qp.hide();
      vscode.window.showErrorMessage(`gitSt8: could not list repositories. ${loadError(e)}`);
    }
  );
  const url = await picked;
  qp.dispose();
  return url;
}

async function pickAzureOrg(integrations: Integrations, title: string): Promise<string | undefined> {
  const enter = () => vscode.window.showInputBox({ title, prompt: 'Azure DevOps organization (as in dev.azure.com/<organization>)', ignoreFocusOut: true }).then(v => v?.trim() || undefined);
  let orgs: string[];
  try {
    orgs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Loading Azure DevOps organizations…' }, () =>
      integrations.azureOrganizations()
    );
  } catch (e) {
    // Personal access tokens without the profile scope, or organizations of another tenant: let the user type it.
    vscode.window.showWarningMessage(`gitSt8: could not list your Azure DevOps organizations, enter one instead. ${loadError(e)}`);
    return enter();
  }
  if (orgs.length === 1) return orgs[0];
  const pick = await vscode.window.showQuickPick<Item>(
    [
      ...orgs.map(o => ({ label: `$(organization) ${o}`, value: o })),
      { label: '$(edit) Enter an organization…', description: orgs.length ? 'e.g. one in another Entra tenant' : 'none found for this account', id: 'other' },
    ],
    { title, placeHolder: 'Organization' }
  );
  if (!pick) return undefined;
  return pick.id === 'other' ? enter() : pick.value;
}

function loadError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return e instanceof AuthError ? `${msg} Sign in again or, for Azure DevOps, use a personal access token (gitSt8: Set Azure DevOps Personal Access Token).` : msg;
}

/**
 * Asks which folder to turn into a repository: `preset` (Explorer), a workspace folder that is not a repository yet,
 * or any folder via the file dialog. Returns undefined when cancelled or when the folder already is a repository.
 */
export async function chooseInitFolder(api: API, preset?: vscode.Uri): Promise<vscode.Uri | undefined> {
  let folder = preset;
  if (!folder) {
    const candidates: Item[] = (vscode.workspace.workspaceFolders || [])
      .filter(f => f.uri.scheme === 'file' && !isRepoRoot(api, f.uri))
      .map(f => {
        const parent = api.getRepository(f.uri);
        return { label: `$(folder) ${f.name}`, description: parent ? `inside ${path.basename(parent.rootUri.fsPath)}` : '', detail: f.uri.fsPath, value: f.uri.fsPath };
      });
    const pick = await vscode.window.showQuickPick<Item>([...candidates, { label: '$(folder-opened) Choose a folder…', id: 'browse' }], {
      title: 'Initialize repository',
      placeHolder: 'Folder to initialize',
    });
    if (!pick) return undefined;
    if (pick.id === 'browse') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Initialize Repository',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      folder = picked?.[0];
    } else {
      folder = vscode.Uri.file(pick.value!);
    }
  }
  if (!folder) return undefined;
  if (isRepoRoot(api, folder)) {
    vscode.window.showInformationMessage(`gitSt8: ${path.basename(folder.fsPath)} already is a git repository.`);
    return undefined;
  }
  const parent = api.getRepository(folder);
  if (parent) {
    const ok = await vscode.window.showWarningMessage(
      `${path.basename(folder.fsPath)} is inside the repository ${path.basename(parent.rootUri.fsPath)}.`,
      { modal: true, detail: 'A nested repository is ignored by the outer one except as an untracked folder. Usually you want a submodule or a separate folder instead.' },
      'Initialize Anyway'
    );
    if (ok !== 'Initialize Anyway') return undefined;
  }
  return folder;
}

function isRepoRoot(api: API, uri: vscode.Uri): boolean {
  const r = api.getRepository(uri);
  return !!r && samePath(r.rootUri.fsPath, uri.fsPath);
}

/** `git.defaultBranchName`, the same default VS Code's own "Initialize Repository" uses. */
export function defaultBranch(folder: vscode.Uri): string {
  const cfg = vscode.workspace.getConfiguration('git', folder);
  return cfg.get<string>('defaultBranchName', 'main').trim().replace(/\s+/g, cfg.get<string>('branchWhitespaceChar', '-'));
}

/**
 * Clones `url`. The git extension asks for the parent folder, shows progress and then offers
 * Open / Open in New Window / Add to Workspace (honoring `git.openAfterClone`).
 * With `addToWorkspace`, that prompt is skipped and the clone becomes a folder of the current workspace.
 * Returns the clone's folder, or undefined when cancelled or when it cannot tell (scp-style SSH URLs).
 */
export async function cloneRepository(api: API, url: string, addToWorkspace = false): Promise<vscode.Uri | undefined> {
  let uri: vscode.Uri | undefined;
  try {
    uri = vscode.Uri.parse(url, true);
  } catch {
    uri = undefined;
  }
  // `git@host:owner/repo` is not a URI, and the API takes one. The command takes the plain string.
  if (!uri || !/^(https?|ssh|git|file)$/i.test(uri.scheme)) {
    await vscode.commands.executeCommand('git.clone', url);
    return undefined;
  }
  const dir = (await api.clone(uri, addToWorkspace ? { postCloneAction: 'none' } : undefined)) || undefined;
  if (dir && addToWorkspace && !vscode.workspace.getWorkspaceFolder(dir)) {
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri: dir });
  }
  return dir;
}
