import * as vscode from 'vscode';
import * as path from 'path';
import { RepoPanel } from './panel';
import { GitCli } from './git';
import { Integrations } from './integration';
import type { API, GitExtension } from './types/git';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExt) {
    vscode.window.showErrorMessage('gitSt8 needs the built-in Git extension, which is disabled.');
    return;
  }
  const exports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
  const api: API = exports.getAPI(1);
  const integrations = new Integrations(context.secrets);
  const show = (root?: string) => RepoPanel.show(context, api, integrations, root);

  const repoFromArg = (arg: unknown): string | undefined => {
    // Invoked from the SCM title bar: arg is a SourceControl with rootUri.
    const uri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
    return uri ? api.getRepository(uri)?.rootUri.fsPath : undefined;
  };

  /** Resolves a file URI (from a menu arg or the active editor) to its repository. */
  const fileTarget = (arg: unknown): { uri: vscode.Uri; root: string; rel: string } | null => {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('gitSt8: open a file from a git repository first.');
      return null;
    }
    const repo = api.getRepository(uri);
    if (!repo) {
      vscode.window.showWarningMessage(`gitSt8: ${path.basename(uri.fsPath)} is not inside an open git repository.`);
      return null;
    }
    const root = repo.rootUri.fsPath;
    return { uri, root, rel: path.relative(root, uri.fsPath).replace(/\\/g, '/') };
  };

  context.subscriptions.push(
    integrations,
    RepoPanel.register(context, api, integrations),
    vscode.commands.registerCommand('gitst8.open', (arg: unknown) => show(repoFromArg(arg))),

    vscode.commands.registerCommand('gitst8.fetchPrune', async () => {
      const repos = api.repositories;
      if (!repos.length) return vscode.window.showInformationMessage('gitSt8: no git repositories open.');
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fetch & prune ${repos.length} repo(s)` },
        () => Promise.allSettled(repos.map(r => r.fetch({ all: true, prune: true })))
      );
      const failed = repos.filter((_, i) => results[i].status === 'rejected').map(r => path.basename(r.rootUri.fsPath));
      if (failed.length) vscode.window.showWarningMessage(`gitSt8: fetch failed for ${failed.join(', ')}.`);
    }),

    vscode.commands.registerCommand('gitst8.revealLineCommit', async () => {
      const editor = vscode.window.activeTextEditor;
      const t = editor && fileTarget(editor.document.uri);
      if (!editor || !t) return;
      const line = editor.selection.active.line + 1;
      const git = new GitCli(api.git.path, t.root);
      let sha: string | null;
      try {
        sha = await git.blameLine(t.rel, line, editor.document.isDirty ? editor.document.getText() : undefined);
      } catch (e) {
        return vscode.window.showWarningMessage(`gitSt8: cannot blame ${t.rel}:${line}. ${e instanceof Error ? e.message : e}`);
      }
      const panel = await show(t.root);
      await panel.revealCommit(sha, t.rel);
      if (!sha) vscode.window.setStatusBarMessage('gitSt8: that line is not committed yet', 3000);
    }),

    vscode.commands.registerCommand('gitst8.fileHistory', async (arg: unknown) => {
      const t = fileTarget(arg);
      if (!t) return;
      const panel = await show(t.root);
      await panel.ready;
      await panel.on_search({ kind: 'path', value: t.rel });
    }),

    vscode.commands.registerCommand('gitst8.signInGitHub', () => integrations.signIn('github')),
    vscode.commands.registerCommand('gitst8.signInAzure', () => integrations.signIn('azure')),
    vscode.commands.registerCommand('gitst8.setAzurePat', async () => {
      const scope = await vscode.window.showQuickPick(
        [
          { label: 'All organizations', id: '' },
          { label: 'One organization…', id: 'org' },
        ],
        { placeHolder: 'Use this token for' }
      );
      if (!scope) return;
      const org = scope.id ? await vscode.window.showInputBox({ prompt: 'Organization name (as in dev.azure.com/<org>)' }) : undefined;
      if (scope.id && !org) return;
      if (await integrations.setAzurePat(org)) vscode.window.showInformationMessage('gitSt8: Azure DevOps token saved in VS Code secret storage.');
    }),
    vscode.commands.registerCommand('gitst8.clearAzurePat', async () => {
      const org = await vscode.window.showInputBox({ prompt: 'Organization to remove the token for (leave empty for the all-organizations token)' });
      if (org === undefined) return;
      await integrations.clearAzurePat(org || undefined);
      vscode.window.showInformationMessage('gitSt8: Azure DevOps token removed.');
    })
  );

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = '$(git-merge) gitSt8';
  item.tooltip = 'Open gitSt8 repository view';
  item.command = 'gitst8.open';
  item.show();
  context.subscriptions.push(item);
}

export function deactivate(): void {}
