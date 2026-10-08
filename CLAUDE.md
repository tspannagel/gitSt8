# CLAUDE.md

gitSt8 is a VS Code extension: a single webview (bottom panel by default) for advanced git workflows: graph, branches, rebase/merge, stacks, worktrees, tags, reflog, commit/staging, plus read-only GitHub / Azure DevOps PR and CI status. `README.md` is the user guide; keep it in sync when features change.

## Commands

```sh
npm install        # dev deps only (typescript, @types/vscode, @types/node, @vscode/vsce); no runtime deps
npm run compile    # tsc -> out/
npm test           # compile + node:test on out/test/**/*.test.js (unit + real-git integration tests)
npm run package    # vsce package -> .vsix; release via .github/workflows/publish.yml (tag v<version>)
```

- Node is installed system-wide at `C:\Program Files\nodejs`. Shells started before the install may not have it on PATH: prefix with `$env:Path = "C:\Program Files\nodejs;$env:Path"`.
- F5 = "Run gitSt8": runs `npm: watch` first and starts the dev host with `--profile-temp` (fresh temporary profile, no user extensions; built-ins like vscode.git stay enabled). "Run gitSt8 (all extensions)" is the fallback: no isolation, slow, but known to work. On VS Code 1.141 both `--disable-extensions` and `--extensions-dir=<empty folder>` crash the dev extension host about 1 s after start (exit code 134, no exthost log), so don't use either. `--profile-temp` works (only built-ins + gitSt8 activate), but the same exit-134 crash also hits it intermittently (often 1–2 crashes, then a launch succeeds). It dies before `exthost.log` is created, so it happens before any extension code runs; the abort reason only shows in the main window's Debug Console or the js-debug trace (`"trace": true` in launch.json).
- `media/main.js` is not compiled. Check it with `node --check media/main.js`.
- After changes, run `npm test` and `node --check media/main.js` before reporting done. There is no way to drive the webview UI from here, so say clearly what was not verified visually.

## Architecture

| Path | Role |
| --- | --- |
| `src/extension.ts` | activation, commands, status bar, blame/file-history entry points, sign-in commands |
| `src/panel.ts` | `RepoPanel`: webview host (WebviewView in panel or WebviewPanel in editor, via a `Host` wrapper), state collection, every action handler |
| `src/git.ts` | `GitCli` wrapper + parsers. No `vscode` import |
| `src/graph.ts` | commit graph lane layout. No `vscode` import |
| `src/integration.ts` | GitHub/Azure DevOps: remote detection, auth (VS Code accounts + Azure PAT in SecretStorage), caching/TTL |
| `src/providers/*` | API clients and mappers (`github.ts` GraphQL, `azure.ts` REST 7.1, `detect.ts`, `ci.ts`, `http.ts`). **Must not import `vscode`**, so they stay unit-testable |
| `src/types/git.d.ts` | hand-written subset of the vscode.git API. Extend it when using more of the API |
| `media/main.js`, `media/main.css` | webview UI, plain JS (`// @ts-nocheck`), no framework |

### Conventions

- **Webview ↔ extension protocol:** the webview posts `{type: 'x', ...}` and `RepoPanel.on_x(m: Msg)` handles it (dispatched by name in `onMessage`). The extension posts `data`, `details`, `integration`, `busy`, `reveal`, `repos`, etc.; see the `message` switch in `main.js`.
- **Mutating git operations** go through `runOp(label, fn, notify?)`. It shows progress, turns conflicts into a hint (the banner handles continue/abort), and refreshes afterwards. Destructive actions ask first via `confirm()` (modal).
- **Network operations** (fetch, default pull, push, commit) use the vscode.git API (`requireRepo()`), so credentials, signing and settings match VS Code. Force-push, remote deletes and tag pushes use the CLI (`git()`).
- **Never open an editor from git:** set `GIT_EDITOR=':'`. Interactive rebase uses `GIT_SEQUENCE_EDITOR="cp '<todo>'"` (Git for Windows runs it through sh, so use forward slashes). `runTodo()` does this.
- **CLI calls** always add `--no-optional-locks` and `GIT_TERMINAL_PROMPT=0` (inside `GitCli.run`). Parse with `%x1f` / `%x1e` separators and `-z`, never by splitting on spaces.
- **Graph first, integration after:** `collect()` posts `data`, then `scheduleIntegration()` loads PRs/CI and posts `integration`. A slow service must never delay the graph. Integration only reads; it never writes to GitHub/Azure DevOps (create/checkout PR is a planned next phase).
- **GraphQL safety:** SHAs are interpolated into GitHub queries, so they are filtered to 40-char hex first. Keep that filter.

### Webview rules

- **Escape everything** with `esc()` before it goes into `innerHTML`. Commit messages are rendered by the built-in `renderMarkdown()`, which escapes first and emits only a fixed tag set. Do not add a Markdown library or allow raw HTML.
- **Links** never navigate the webview. Use `data-url` and let the click handler `post('openExternal')`; the extension only opens `https://` URLs.
- **CSP:** scripts and styles come only from `media/` or a nonce. External resources are not allowed.
- **Icons** are VS Code's own codicon font, loaded from `vscode.env.appRoot/out/media/codicon.ttf`. Use `ic('name', 'sm'|'xs')` or `<i class="ci" data-icon="name">` in static HTML. Code points live in `ICONS` in `main.js`. To add one, look up its code point in VS Code's registry (search `workbench.desktop.main.js` for `("name",<decimal>)`), don't guess. The `.ci` class is reserved for icon glyphs; don't reuse it for other elements (CI status uses `.cistat`).
- **Colors** come from theme variables (`--vscode-*`) and the ref-kind palette in `:root` (`--c-branch`, `--c-remote`, `--c-tag`, …), so light/dark/high-contrast work.
- **Layout** switches between side-by-side (wide/short panel) and stacked (tall editor tab) via `body.layout-stack`.

## Testing

- `src/test/git.test.ts` builds a throwaway repo plus a bare "origin" in the OS temp dir and exercises `GitCli` for real.
- Provider tests use recorded-shape fixtures. There are no live API calls; live GitHub/Azure behavior is only verifiable by the user (their repo: Azure DevOps `WashTec/Fabric_BI/FabricBI-Metafactory`).
- Add tests for any new parser or provider mapping. UI changes can't be tested here.

## User preferences (from working with Tim)

- Wants one consolidated view for advanced git workflows, docked in the bottom panel next to Terminal.
- Cares about clear visual differentiation and real icons (not text glyphs), at a comfortable size.
- Prefers recommendations with effort/risk estimates before larger features. Asks for docs (README) to stay complete.
- Don't commit unless asked (nothing has been committed yet).

## Windows / environment notes

- The PowerShell sandbox blocks `Remove-Item` commands that contain a `'\'` literal elsewhere in the same command. Split PATH edits and deletions into separate calls.
- Launching a second VS Code GUI from the sandbox does not work. Diagnose dev-host problems from `%APPDATA%\Code\logs\<session>\window*\{renderer.log,exthost\exthost.log}`.
