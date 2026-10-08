# gitSt8

**One view for the git workflows the built-in Source Control view makes awkward.**

[Install from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tisp.gitst8) · [Source on GitHub](https://github.com/tspannagel/gitSt8) · [Report an issue](https://github.com/tspannagel/gitSt8/issues)

gitSt8 puts history, branches, remotes, tags, worktrees, stashes, staging and every common history-rewriting operation into a single panel next to your terminal. Instead of switching between the SCM view, the command palette and a shell, you right-click the thing you want to change.

- [Getting started](#getting-started)
- [The view at a glance](#the-view-at-a-glance)
- [Everyday workflows](#everyday-workflows)
- [Advanced workflows](#advanced-workflows)
- [Reference](#reference)
- [Safety and undo](#safety-and-undo)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Getting started

### Requirements

- VS Code 1.90 or newer
- Git 2.38 or newer on your `PATH` (needed for `--update-refs`; most other features work with 2.23+)
- The built-in **Git** extension enabled (gitSt8 uses it for credentials and repository discovery)

### Install

Install **gitSt8** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tisp.gitst8):

- In VS Code, open the Extensions view (`Ctrl+Shift+X`, `Cmd+Shift+X` on macOS), search for `gitSt8` and select **Install**, or
- run `code --install-extension tisp.gitst8` in a terminal, or
- press `Ctrl+P` (`Cmd+P` on macOS) and enter `ext install tisp.gitst8`.

Updates arrive automatically through VS Code. To try a specific build, download the `.vsix` from [GitHub Releases](https://github.com/tspannagel/gitSt8/releases) and use **Extensions → … → Install from VSIX…**. To run it from source, see [Development](#development).

### Open it

Any of these opens the gitSt8 tab in the bottom panel:

- `Ctrl+Alt+Shift+G` (`Cmd+Option+Shift+G` / `⌘⌥⇧G` on macOS)
- the **gitSt8** item in the status bar
- the gitSt8 icon in the Source Control view's title bar
- **gitSt8: Open Repository View** in the command palette

Prefer an editor tab? Set `"gitst8.location": "editor"`. You can also drag the panel tab into the sidebar like any other panel.

---

## The view at a glance

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [repo ▾] (branch)  ✓Commit ⟳Fetch ⤓Pull ⤒Push │ ⑂Branch ▣Stash ⌫Clean up ↶Reflog  🔍 │  toolbar
├────────────────┬──────────────────────────────────────────┬──────────────────────────┤
│ Filter…        │ ● Uncommitted changes · 1 staged · 2 …   │ Commit to main           │
│ ▾ STACK        │ ●─ fix parser       [main] [origin/main] │  [message…]   ✓ Commit   │
│ ▾ BRANCHES     │ │ ┃ message, author, SHA, files → diff   │  Staged changes          │
│ ▸ REMOTES      │ │ ● add tests        [feature/x]         │  Changes                 │
│ ▸ TAGS         │ ●─┘ initial                    [v1.0]    │                          │
│ ▸ WORKTREES    │                                          │  (or: compare, stash,    │
│ ▸ STASHES      │                                          │   reflog, multi-select)  │
└────────────────┴──────────────────────────────────────────┴──────────────────────────┘
   sidebar                    commit graph                        details pane
```

**Toolbar.** The repository picker comes first (see [multiple repositories](#multiple-repositories)), then the current branch (shown in red when HEAD is detached). Next come the main actions, the **All branches** toggle, search, and refresh. When space is tight, buttons shrink to icons; hover to see what they do.

**Sidebar.** Collapsible sections with a color per kind of ref. Click an entry to jump to its commit in the graph, double-click to check it out (or to open a worktree), and right-click for everything else. Each section header has a **⋯** menu with section-wide actions. The filter box at the top filters every section by name.

| Section | Shows | Markers |
| --- | --- | --- |
| **Stack** | Branches stacked with HEAD on top of the base branch, as a chain down to the base | `+N` commits on top of the base |
| **Branches** | Local branches | ✓ checked out · ↑ahead ↓behind upstream · ⊘ never pushed · `gone` upstream deleted · folder icon: checked out in another worktree · `90d` stale |
| **Remotes** | Remote-tracking branches grouped by remote, with the remote URL | |
| **Tags** | Tags, newest version first (`v1.10` sorts above `v1.9`) | Solid: annotated · faded: lightweight · `local only` / `remote only` / `differs` after comparing with a remote |
| **Worktrees** | All worktrees of the repository | Root icon: this window · lock: locked · `prunable`: folder is gone |
| **Stashes** | Stash entries with their messages | |

**Commit graph.** Every branch is drawn with its own lane. Labels on a commit show the local branches (green), remote branches (blue), tags (amber) and stashes (pink) that point at it. When your working tree has changes, an **Uncommitted changes** row sits on top. History loads in pages of 400 commits; use **Load more** at the bottom.

**Commit details** open inline, right under the commit you click, so the commit box stays where it is. Click the commit again to close them. Signed commits show a badge next to the author (verified, unverified, bad, expired or revoked, or "can't verify" when git cannot check the signature, e.g. gpg is missing or `gpg.ssh.allowedSignersFile` is not set); hover it for the signer and key. Unsigned commits show nothing.

**Details pane.** Shows the commit box (staged and unstaged changes) by default. A comparison, a stash, the reflog or a multi-selection temporarily take its place; clicking a single commit (or clearing the selection) brings the commit box back. Click any file to open VS Code's diff editor, and right-click it for *Open file*, *File history* and *Copy path*. Drag the divider to resize the pane. It sits to the right of the graph in the bottom panel and below it in a tall editor tab.

**Selecting commits.**

| Action | Result |
| --- | --- |
| Click | Show the commit's details under it; click again to close them |
| `Ctrl`/`Cmd`+click | Add or remove a commit from the selection. With exactly two selected, gitSt8 compares them |
| `Shift`+click | Select a range |
| `↑` / `↓` | Move the selection |
| Right-click | Context menu for that commit (or for the whole selection) |

---

## Everyday workflows

### Commit

1. Click **✓ Commit** in the toolbar, or click the *Uncommitted changes* row.
2. Hover a file for its buttons: **+** stages it, **−** unstages it, **↶** discards its changes, **↗** opens it. Use *stage all* / *unstage all* for everything at once.
3. Click a staged file to diff HEAD ↔ index, or an unstaged file to diff index ↔ working tree.
4. Type a message and press `Ctrl+Enter` (`Cmd+Enter` on macOS) or click the button.

**Stage parts of a file.** Click the chevron at the left of a file in *Staged changes* or *Changes* to expand its diff inline. Each hunk has its own buttons: **Stage hunk** / **Discard hunk** for unstaged files, **Unstage hunk** for staged ones. To work on single lines, click changed (`+` / `-`) lines to select them, or Shift+click to select a range within one hunk; then use **Stage selected lines**, **Unstage selected lines** or **Discard selected lines**. Unselected removed lines stay as they are and unselected added lines are left out, the same as edit mode in `add -p`. Discarding asks first. The diff is read again right before applying, so if the file changed in the meantime gitSt8 shows a warning instead of applying anything. Expanded files stay open across refreshes. Untracked, conflicted and binary files can only be staged as a whole, and a file's mode change always goes with the whole file.

Right-click a changed file to ignore it:

| Menu entry | Adds to | Pattern |
| --- | --- | --- |
| **Ignore ‹file›** | `.gitignore` at the repo root | `/path/to/file` (exact path, special characters escaped) |
| **Ignore folder ‹dir›/** | `.gitignore` | `/path/to/dir/` |
| **Ignore all \*.ext files** | `.gitignore` | `*.ext` (anywhere in the repo) |
| **Exclude ‹file› in this clone only** | `.git/info/exclude` (not committed, not shared) | `/path/to/file` |

Rules that are already in the file aren't added twice. Ignore rules don't apply to files git already tracks. If the new rule matches tracked files, gitSt8 lists them and offers **Stop tracking**: `git rm --cached` keeps the files on disk, and your next commit removes them from the repository.

Options:

- **Amend last commit** replaces the last commit and pre-fills its message.
- **Skip hooks** runs `--no-verify`.
- If nothing is staged, the button turns into **Stage all & commit**.

**Generate a message.** When a language model is available (VS Code's Language Model API, for example through GitHub Copilot), a sparkle button appears next to the message box. Click it to draft a message from your staged diff, or from all tracked changes if nothing is staged. The text streams into the box and the button turns into a stop button while it runs. The prompt includes the diff (long diffs are shortened per file), the file summary, the branch name and your last 15 commit subjects, so the message follows your repository's style, including Conventional Commits when you use them. An empty box is replaced; if you already typed a draft it stays, and the generated text is added below a `--- generated ---` line for you to pick from. Edit it before you commit. **Privacy:** your diff is sent to the model provider only when you click the button. Turn the feature off with `gitst8.ai.enabled`.

Commits go through VS Code's Git extension, so commit signing and `git.*` settings behave exactly as in the Source Control view. Your draft message survives refreshes.

### Fetch, pull, push

| Button | What it does |
| --- | --- |
| **Fetch** | `git fetch --all --prune`: updates every remote and removes remote branches that were deleted on the server |
| **Pull** | Asks how: repository default, `--rebase`, `--rebase --autostash`, `--ff-only`, or merge |
| **Push** | Asks what to push: the current branch only, the branch with `--follow-tags` (annotated tags on the pushed commits), the branch plus all tags, all tags only, or one of three force pushes (see below). Without an upstream, you pick a remote and the upstream is set. Tag pushes and force pushes use the git CLI |

**Right-click a toolbar button** to pick a variant directly instead of going through the quick pick:

| Button | Right-click menu |
| --- | --- |
| **Fetch** | Fetch all & prune · Fetch all without pruning · Fetch one remote & prune (with several remotes) |
| **Pull** | Default · `--rebase` · `--rebase --autostash` · `--ff-only` · `--no-rebase` (merge) |
| **Push** | Push · `--follow-tags` · and all tags · the three force pushes · Push all tags |
| **Branch** | Create and checkout · Create only · Create in a new worktree |
| **Stash** | Tracked changes · including untracked · staged only · `--keep-index` |

Force push comes in three strengths, from the toolbar **Push** menu (click or right-click) or by right-clicking a branch:

| Option | Flags | Refuses when |
| --- | --- | --- |
| **Lease + if-includes** (safest) | `--force-with-lease --force-if-includes` | the remote moved since your last fetch, or has commits that were never in your local branch. Protects you even when VS Code auto-fetched in the background. Needs git 2.30+ |
| **Lease only** | `--force-with-lease` | the remote moved since your last fetch. A background fetch (`git.autofetch`) silently renews the lease, so this can overwrite work you never saw |
| **Unconditional** | `--force` | never. Overwrites whatever is on the remote |

On a branch, right-click for **Push**, the three **Force push** options, and **Fast-forward from upstream**. The last one updates a branch you are *not* on, without checking it out. On a remote, right-click for **Fetch & prune**, which fetches just that remote.

### Branches

Right-click any commit, branch or tag and choose **Create branch here / from…**. You can then create it, create and check it out, or create it in a new [worktree](#worktrees).

Other branch actions: **Checkout** (or double-click), **Rename**, **Delete** (offers to delete the remote branch too, and falls back to a force delete if the branch isn't merged), **Set / change / unset upstream**, **Compare with current branch / upstream / working tree**.

Checking out a remote branch creates a local tracking branch. If a local branch with that name already exists, gitSt8 asks whether to switch to it or reset it to the remote.

### Merge and rebase

Right-click the commit or branch you want to bring in:

- **Merge into ‹current›**: plain merge, `--no-ff`, `--ff-only`, or squash merge.
- **Rebase ‹current› onto here**: plain, with `--autostash`, or with `--update-refs`.

If a conflict stops the operation, a yellow banner appears. See [resolving conflicts](#resolving-conflicts).

### Search history

The search box has several modes:

| Mode | Finds commits… |
| --- | --- |
| **Filter loaded** (default) | Dims non-matching rows among the commits already loaded, as you type. Press `Enter` to search all history instead |
| **Message, author or file name** | Matching any of the three |
| **Message** | Whose message matches (regex, case-insensitive) |
| **Author** | By author name or email |
| **Code added/removed** | That add or remove an exact string (`git log -S`) |
| **Diff matches regex** | Whose changed lines match a regex (`git log -G`) |
| **File / folder** | That touch a file or folder. Part of a name (`panel`) matches any file or folder containing it, at any depth. An exact path shows that file's history and follows renames |

The **Filter** button (funnel icon) in the toolbar opens a form above the graph. Filters combine with each other and with the search above (all of them must match):

| Filter | Shows commits… |
| --- | --- |
| **Author** | By that name or email. **Only my commits** uses your `user.email` |
| **Since / Until** | In a date range. Anything git accepts works: `2.weeks.ago`, `2026-01-01` |
| **Path** | That touch the given files or folders (comma-separated) |
| **Message** | Whose message matches a regex |
| **No merges** / **First parent only** | Hide merge commits, or follow only the first parent of merges |
| **Branches…** | Reachable from the branches you pick, instead of All branches / current branch |

Active filters show as removable chips above the graph, with **Clear all**. Branch, no-merges and first-parent filters keep the real graph; the others show a single line like search results.

Results show as a single line with a banner above. Files matching your search are highlighted and listed first in the details. Click **Clear search** to go back to the full graph. The **All branches** toggle decides whether search covers every branch or only HEAD.

### From the editor

| Command | Where | What it does |
| --- | --- | --- |
| **Show Line's Commit in gitSt8** | Editor right-click, `Ctrl+Alt+Shift+B` (`Cmd+Option+Shift+B` on macOS) | Finds the commit that last changed the line under the cursor (unsaved edits included), loads enough history to show it, and opens its details with the file highlighted |
| **File History in gitSt8** | Editor, editor tab and Explorer right-click | Shows only the commits that touched that file (following renames) or folder |
| **Add .gitkeep** | Explorer right-click on a folder (works on a multi-selection) | Creates an empty `.gitkeep` so git tracks the folder before it has real files. Folders that already have one are skipped |

For inline blame annotations, use VS Code's built-in setting `git.blame.editorDecoration.enabled`. gitSt8 does not duplicate it.

### Stashes

**Stash** in the toolbar asks for an optional message, then what to stash: tracked changes, tracked + untracked, or staged only. Click a stash to see its files. Right-click it to **Apply**, **Pop**, **Drop**, or **Create branch from stash**.

### Compare and diff

- `Ctrl`+click (`Cmd`+click on macOS) two commits to compare them. The older commit goes on the left. The header shows how many commits are on each side; **swap** reverses the comparison.
- Right-click → **Compare with HEAD** / **Compare with working tree** / **Compare with ‹upstream›**.
- Click any file in the list to open the side-by-side diff.

### Patches and links

**Patches.** Right-click a commit → **Copy as patch** or **Save as patch…** (`git format-patch`; hidden for merge commits). Select several commits and right-click → **Save as patch files…** to write one numbered file per commit (oldest first) into a folder you pick.

To apply one, right-click **Stash** in the toolbar (or the Stashes section menu, or run **gitSt8: Apply Patch…**) → **Apply patch…**, choose the file, then how to apply it:

- **As commits** (`git am --3way`): keeps author, date and message.
- **To the working tree** (`git apply --3way`): leaves the changes uncommitted.
- **To the index** (`git apply --cached`): stages them without touching files.

If `git am` stops on a conflict, the banner shows **Applying patches** with Continue, Skip and Abort.

**Copy helpers.** The commit menu also has **Copy short SHA** and **Copy full message**.

**Links to GitHub / Azure DevOps.** These only build URLs from the remote, so they work without signing in.

- Commit menu: **Open commit on GitHub / Azure DevOps** and **Copy link to commit**.
- File menu in the details pane: **Open file on …** and **Copy permalink** (pinned to that commit).
- Branch menu: **Create pull request in browser…** for pushed branches that have no open pull request. The target is the stack base. If the branch is ahead of its upstream, gitSt8 offers to push first.
- Editor right-click or command palette → **Copy Permalink to Line(s)** links the selection at the current HEAD commit. If HEAD is not on any remote-tracking branch, gitSt8 warns that the link may not work yet.

---

## Advanced workflows

### Interactive rebase

Right-click the oldest commit you want to change → **Interactive rebase from here**. A dialog lists every commit from that one up to HEAD, oldest at the top.

- Reorder by dragging or with ▲▼.
- Pick an action per commit: `pick`, `reword` (edit the message inline), `edit` (stop there), `squash`, `fixup`, `drop`.
- Optional: `--autostash`, and `--update-refs` to move branches that sit on top of the rewritten commits.

Click **Start rebase**. No editor ever opens: gitSt8 hands git the prepared plan and edits messages for you. If the range contains merge commits, gitSt8 warns you first, because they will be flattened into a straight line.

### Split a commit

Right-click a commit → **Split commit…**. gitSt8 rewinds to that commit and undoes it, leaving its changes unstaged. Commit them in pieces (from gitSt8's commit box or Source Control), then press **Continue** in the banner. For the latest commit this is just `git reset HEAD~1`. Requires a clean working tree.

### Fix up an older commit

Stage the fix, right-click the commit it belongs to → **Fixup staged changes into this commit**. gitSt8 creates a `fixup!` commit and immediately folds it into the target with an autosquash rebase. If nothing is staged, it offers to stage all changes to tracked files.

### Cherry-pick and revert several commits

Select commits with `Ctrl`+click (`Cmd`+click on macOS) or `Shift`+click, then right-click → **Cherry-pick N commits onto ‹current›** (applied oldest first) or **Revert N commits** (newest first). Merge commits must be handled one at a time.

### Find a bad commit with bisect

`git bisect` finds the commit that introduced a bug by binary search. Start it from the graph (requires a clean working tree):

- Right-click a commit that still worked → **Bisect: mark as good (HEAD is bad)**.
- Right-click a broken commit → **Bisect: mark as bad…** and enter a known good commit, branch or tag.
- Select exactly two commits → **Bisect between these**. The older one is good, the newer one is bad.

gitSt8 checks out a commit in the middle and shows a banner: *Bisecting: ~N revisions left (~K steps)*. Test your code, then press **Good**, **Bad** or **Skip** (for a commit you cannot test). You can also right-click any commit → **Bisect: mark good / mark bad / skip**. Graph rows get pills for good, bad, skipped and the commit to test next. The counts ignore skipped commits, so they are an upper bound if you skip.

When the search ends, the banner names the first bad commit: **Show commit** selects it in the graph. **Reset** ends the bisect and returns you to your original branch. Automated `git bisect run` scripts are not supported.

### Stacked branches

When several of your branches build on each other (`main ← feature-a ← feature-b`), the **Stack** section shows them as a chain down to the base branch, with the number of commits each adds. From the section's **⋯** menu:

- **Restack onto ‹base›**: rebases the top branch onto the base with `--update-refs`, so every branch in the stack moves along. Then returns you to the branch you were on.
- **Push stack**: force-pushes (with lease) every branch in the stack and sets upstreams.
- **Change base branch**: by default gitSt8 uses `origin/HEAD`, then `origin/main`, `origin/master`, `main`, `master`, `develop`. Saved in the `gitst8.stackBase` setting.

### Worktrees

A worktree is a second checkout of the same repository in another folder. It lets you review a PR or hotfix another branch without stashing your current work.

- **Create:** Worktrees **⋯** → *Add worktree*, or right-click a branch → *Open in new worktree*, or a commit → *Create worktree here*. The folder defaults to `../<repo>-<branch>`.
- **Open:** double-click (new window), or right-click → *Open in this window*.
- **Lock / Unlock**, **Remove** (asks before force-removing a worktree with changes), and **Prune stale worktrees**.

Trying to check out a branch that is already checked out in another worktree offers to open that worktree instead.

### Submodules and Git LFS

Two sidebar sections appear only when they apply, so repositories without them stay as fast and uncluttered as before.

**Submodules** (the repository has a `.gitmodules` file). Each entry shows the submodule path and a badge: *not initialized*, *modified* (the checked-out commit differs from the one the repository records) or *conflict*. Hover for the URL, branch and the short recorded / checked-out commits.

- **Open in gitSt8:** double-click, or right-click → *Open in gitSt8*, switches the view to the submodule's own repository. Also *Open in new window*, *Reveal in file explorer* and *Copy path*.
- **Initialize & update** / **Update to recorded commit:** runs `git submodule update --init --recursive` for that submodule, which also clears a *modified* badge by checking out the recorded commit (commits made inside the submodule are not lost, they just are no longer checked out).
- **Sync URL:** re-reads the URL from `.gitmodules` (`git submodule sync --recursive`).
- Submodules **⋯** → *Update all* and *Sync all URLs*.

**LFS** (`.gitattributes` contains `filter=lfs` and `git lfs` is installed). Shows how many files are tracked by LFS and how many are only pointer files (*not downloaded*). The **⋯** menu offers *Pull LFS files* (`git lfs pull`: download and check out) and *Fetch LFS files* (`git lfs fetch`: download only), with a progress notification. The file count is cached per HEAD commit, so it updates after the next commit or checkout, or after you use the LFS actions here (not after a `git lfs pull` in a terminal).

### Branch cleanup

**Clean up** in the toolbar opens one checklist with three groups:

1. **Upstream deleted ("gone")**: preselected. Run **Fetch** first so gitSt8 can see which ones are gone.
2. **Merged into ‹base›**: preselected.
3. **No commits for N days**: not preselected. N comes from `gitst8.staleBranchDays`, default 60.

The current branch, the base branch and branches checked out in other worktrees never appear in the list.

### Tags

| Action | Where |
| --- | --- |
| Create (lightweight or annotated), then optionally push | Right-click a commit → *Tag…* |
| Push one tag / all tags | Right-click a tag → *Push tag*; Tags **⋯** → *Push all tags*; or toolbar **Push** → *with tags* |
| Delete locally, on the remote, or both | Right-click a tag → *Delete…* |
| Compare local tags with a remote | Tags **⋯** → *Compare with remote*. Adds `local only` / `remote only` / `differs` markers and lists remote-only tags (right-click them to fetch or delete) |
| Fetch tags | Tags **⋯** → *Fetch tags* |
| Delete local tags missing on the remote | Tags **⋯** → *Delete local tags missing on remote (prune)*. **Also deletes tags you never pushed.** Compare first |

**Release tags and changelogs.** Right-click a commit → *Create release tag here…*, or Tags **⋯** → *Create release tag…* (tags `HEAD`):

- gitSt8 finds the highest semver tag (`1.2.3`, `v1.2.3`, `release-1.2.3`; prereleases rank below releases) reachable from the commit and reads the commits since then as [Conventional Commits](https://www.conventionalcommits.org). `feat` suggests a minor bump, `fix` and everything else a patch, and a `!` or a `BREAKING CHANGE:` footer a major bump (before 1.0 a breaking change only suggests a minor bump).
- A quick pick offers the next patch / minor / major version (the suggestion first) or *Custom…*. With no version tag yet it offers `v0.1.0`, `v1.0.0` or custom.
- The annotated tag's message is the generated changelog (Breaking changes, Features, Fixes, Performance, Other; each line with its short SHA) or just “Release <version>”. Afterwards you can push the tag.
- Tags **⋯** → *Generate changelog…* (pick a from-tag, then `HEAD` or another tag) and right-click a tag → *Changelog since this tag* open the changelog as an untitled Markdown document. Merge commits are skipped; commits that are not Conventional Commits go under *Other*.

### Remotes

Remotes **⋯** → **Add remote**. Right-click a remote's name for **Fetch & prune**, **Prune stale remote branches**, **Copy URL**, **Change URL**, **Rename**, **Remove**.

### GitHub and Azure DevOps

When a remote points at GitHub, GitHub Enterprise or Azure DevOps, gitSt8 shows hosting-service information next to your history. Status is read in the background; the only thing gitSt8 ever writes to the server is a pull request you explicitly create (below).

| Where | What you see |
| --- | --- |
| Toolbar chip | Provider and repository, the number of open pull requests. Click for *Open repository / pull requests / Actions or Pipelines*, a list of open PRs, and *Refresh status* |
| Graph | A pipeline/Actions status icon in front of each recent commit: ✓ passed, ✗ failed, ◯ running (pulses), ⊘ cancelled. Hover for each check; click to open the run (or pick one when there are several) |
| Graph labels | A PR pill on the PR's head commit |
| Sidebar | PR pills and tip status on local branches (matched through their upstream) and on remote branches. Pill colors show approved / changes requested / draft |
| Commit details | The commit's PRs and every check with its result; click to open in the browser |

**Sign-in.** gitSt8 uses the accounts VS Code already manages. Nothing is stored by gitSt8 itself.

- **GitHub**: the built-in GitHub account (scope `repo`). For GitHub Enterprise, set `github-enterprise.uri`.
- **Azure DevOps**: your Microsoft (Entra ID) account. If your organization blocks that, or you use an MSA-backed organization, use a personal access token with *Code (read)* and *Build (read)* scopes: **gitSt8: Set Azure DevOps Personal Access Token**. Tokens live in VS Code's secret storage, either for all organizations or for one.

**Create a pull request.** Right-click a local branch without an open PR and choose *Create pull request…*. If the branch is not on the integration remote yet, or is ahead of it, you are asked to push first. Then pick the target branch (default: the stack base), edit the title (the commit subject when there is exactly one commit, else the humanized branch name), and choose *Create* or *Create as draft*. The description is a bullet list of the commit subjects. Nothing is sent until you confirm the last step; afterwards a notification offers *Open in Browser*.

**Check out a PR branch.** Right-click a PR pill and choose *Check out PR branch*. A PR from the same repository fetches its branch and checks out a tracking branch. A GitHub fork PR is fetched from `pull/<n>/head` into a local `pr/<n>` branch (you are asked what to do if it already exists). Azure DevOps fork PRs cannot be fetched this way.

**Token scopes for writes.** GitHub needs the `repo` scope (the built-in sign-in has it). An Azure DevOps personal access token needs *Code (Read & write)* to create pull requests, in addition to the read scopes. If the service refuses, gitSt8 tells you which scope is missing.

Until you sign in, the chip shows a **Sign in** button. gitSt8 never opens a sign-in prompt on its own.

**Which remote.** `gitst8.integrations.remote`, else `origin`, else the first remote on a supported host.

**Load on the service.** Pull requests are cached for a minute and finished checks for five minutes. Running checks are re-checked every 30 seconds while the view is visible. Only the newest `gitst8.integrations.commitsToCheck` commits plus branch tips are queried: one GraphQL call per 40 commits on GitHub, one builds call on Azure DevOps.

### Multiple repositories

In a multi-root workspace, or a folder with nested repositories, the repository picker lists every repository VS Code's Git extension has found, as `name — branch (N changed)`. Repositories with the same folder name show their workspace-relative path. The picker updates live, including for repositories you are not currently viewing. *Show Line's Commit* and *File History* switch to the file's repository automatically.

---

## Reference

### Commands

| Command | Default key | Description |
| --- | --- | --- |
| `gitSt8: Open Repository View` | `Ctrl+Alt+Shift+G` / macOS `Cmd+Option+Shift+G` | Open or focus the view |
| `gitSt8: Show Line's Commit in gitSt8` | `Ctrl+Alt+Shift+B` / macOS `Cmd+Option+Shift+B` (editor focused) | Jump to the commit of the line under the cursor |
| `gitSt8: Copy Permalink to Line(s)` | | Copies a GitHub / Azure DevOps link to the selected lines at the current HEAD commit (also in the editor right-click menu) |
| `gitSt8: Apply Patch…` | | Apply a `.patch`, `.diff` or `.mbox` file |
| `gitSt8: File History in gitSt8` | | History of the active or right-clicked file or folder |
| `gitSt8: Fetch All & Prune` | | Fetch and prune every open repository |
| `gitSt8: Sign in to GitHub` / `Sign in to Azure DevOps` | | Sign in for pull requests and CI status |
| `gitSt8: Set / Remove Azure DevOps Personal Access Token` | | Token-based access for Azure DevOps |

Rebind these in **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`, on macOS `Cmd+K Cmd+S`; search "gitSt8"). On keyboard layouts where `Ctrl+Alt` acts as `AltGr` (German, for example), the defaults may not fire.

### Keys inside the view

| Key | Action |
| --- | --- |
| `↑` / `↓` | Previous / next commit |
| `Enter` in the search box | Search all history |
| `Ctrl+Enter` (`Cmd+Enter` on macOS) in the commit message | Commit |
| `F5` | Refresh |
| `Esc` | Close menu or dialog |

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitst8.location` | `panel` | `panel`: bottom panel next to the terminal. `editor`: an editor tab |
| `gitst8.stackBase` | `""` | Base branch for the Stack section and branch cleanup. Empty means auto-detect |
| `gitst8.staleBranchDays` | `60` | Days without commits before a branch is marked stale |
| `gitst8.ai.enabled` | `true` | Show the button that drafts a commit message with a language model. Hidden when no model is available |
| `gitst8.ai.modelFamily` | `""` | Model family for commit messages (for example `gpt-4o`). Empty: first available model, Copilot preferred |
| `gitst8.integrations.enabled` | `true` | Show pull requests and CI status from GitHub / Azure DevOps |
| `gitst8.integrations.remote` | `""` | Remote to integrate with. Empty: `origin`, else the first supported remote |
| `gitst8.integrations.commitsToCheck` | `60` | Newest commits that get a CI status (branch tips are always included) |

---

## Safety and undo

gitSt8 asks before anything destructive (hard reset, force push, deleting branches, tags, remotes or worktrees, discarding changes, pruning tags) and shows the exact effect in the dialog.

- **Reset** defaults to `--keep`: the branch moves, but git refuses rather than overwrite your local changes. `--hard` gets an extra confirmation.
- **Force push** offers `--force-with-lease --force-if-includes` first, then lease only, then plain `--force`. Each confirmation dialog says what the chosen flags protect against. **Push stack** always uses `--force-with-lease`.
- **Rebase, merge, cherry-pick or revert stopped?** The banner shows the operation, its progress and the conflicted files.

### Resolving conflicts

For each conflicted file in the banner:

- **Open**: resolve it in the editor (VS Code's merge editor works as usual)
- **Take upstream/ours** or **Take your commit/theirs**: take one side wholesale and stage it
- **Mark resolved**: stage the file once you're done

Then click **Continue**, or **Skip commit** (rebase / cherry-pick / revert), or **Abort** to return to where you started.

### Undo almost anything: the reflog

**↶ Reflog** lists every position HEAD has been at: commits, checkouts, resets, every rebase step. To undo a bad rebase, reset or merge, find the entry from just *before* it and choose **reset here…** (or **branch…** to keep both versions). Commits that are no longer on any branch can still be shown and recovered from here.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| **"Extension host did not start in 10 seconds"** on `F5` | The development window loads all your extensions and was too slow for the debugger. The included launch configuration starts it with an empty extensions folder (`--extensions-dir=.vscode-test/extensions`), so only built-in extensions such as Git load. Avoid `--disable-extensions`: on VS Code 1.141 it makes the development extension host crash right away (exit code 134) |
| Hotkey does nothing | Check that gitSt8 is installed and enabled in the Extensions view (see [Install](#install)), and look for conflicting bindings in Keyboard Shortcuts |
| View says "No git repository open" | Open a folder that contains a git repository. Check that the built-in Git extension is enabled and `git.enabled` is not `false` |
| Push / fetch asks for credentials repeatedly | Toolbar fetch/pull/push use VS Code's Git credentials. Force-push, remote branch/tag deletion and tag operations call `git` directly and rely on your credential helper (Git Credential Manager on Windows) |
| Icons are missing | gitSt8 uses the icon font that ships with VS Code (`out/media/codicon.ttf`). If a build lacks it, icons are hidden. Widen the view to see the button labels, or hover for tooltips |
| A commit from the editor isn't in the graph | It is not reachable from any branch shown. Enable **All branches**, or find it in the **Reflog**. Commits older than the newest 5,000 are not loaded into the graph; their details open in the details pane instead of inline |
| The view looks out of date after switching back to it | gitSt8 skips refreshes while its view is hidden and catches up when it becomes visible again. Press `F5` in the view to force a refresh |
| `DEP0169 url.parse()` warning in the Debug Console | Comes from VS Code itself, not gitSt8. Harmless |
| Integration chip says *Sign in* although you are signed in | The account may lack access to that organization or repository. On Azure DevOps, try a personal access token. Hover the chip for the exact error |
| No CI icons on Azure DevOps | Status comes from the newest 200 pipeline runs of the repository. Older commits show nothing |

---

## Development

The extension is TypeScript (strict mode) with no runtime dependencies. You need Node.js 20+.

```sh
npm install      # TypeScript, type definitions and vsce (all dev-only)
npm run watch    # compile on save (F5 starts this automatically)
npm test         # compile, then run unit + git integration tests (node:test)
npm run package  # build gitst8-<version>.vsix
```

Press `F5` (**Run gitSt8**) to start a development window with your other extensions disabled. Press `Ctrl+R` (`Cmd+R` on macOS) there to reload after a change. Changes to `package.json` need a full restart of the debug session.

| File | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation, commands, status bar item, editor integration (blame, file history), sign-in commands |
| `src/panel.ts` | The view controller: hosts the webview (bottom panel or editor tab), collects repository state, and handles every action, including confirmations and quick picks |
| `src/git.ts` | Git CLI wrapper and parsers: log and search, refs, status, in-progress operation state, worktrees, reflog, stacks, remote tags, blame |
| `src/graph.ts` | Lane layout for the commit graph |
| `src/integration.ts` | Hosting-service integration: remote detection, sign-in (VS Code accounts, Azure DevOps PAT), caching and throttling |
| `src/providers/` | VS Code-independent clients: `detect.ts` (remote URL → repository), `github.ts` (GraphQL), `azure.ts` (REST 7.1), `ci.ts` (status rollup), `http.ts` |
| `src/types/git.d.ts` | The part of the built-in Git extension API that gitSt8 uses |
| `src/test/` | Tests: remote URL parsing, provider response mapping (fixtures), and git operations against a throwaway repository |
| `media/main.js` | Webview UI: rendering, context menus, selection, interactive rebase dialog, commit box, CI and PR display |
| `media/main.css` | Webview styles, using VS Code theme variables, so light, dark and high-contrast themes work |

Design notes:

- **Credentials.** Fetch, pull (default mode), push and commit go through the built-in `vscode.git` extension API, so authentication, signing and settings match the Source Control view. Everything else uses the git CLI with `--no-optional-locks` and `GIT_TERMINAL_PROMPT=0`.
- **No editor pop-ups.** Interactive rebase, split and fixup set `GIT_SEQUENCE_EDITOR` to copy a prepared todo file (or to `:` to accept git's own), and `GIT_EDITOR=:`. Rewording adds an `exec git commit --amend -F <file>` line.
- **Messages.** The webview talks to the extension through `postMessage`. A message `{type: 'x', …}` is handled by `RepoPanel.on_x`.
- **Icons** come from VS Code's bundled `codicon.ttf`, loaded through the webview's resource roots. Code points live in `ICONS` in `media/main.js`.
- **Providers** implement `ProviderClient` (`pullRequests`, `statuses`) and never import `vscode`, so they can be tested with plain Node. The graph is posted first; PRs and CI status follow in a separate `integration` message, so a slow or unreachable service never delays the graph.

### Releasing

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) tests, packages and publishes the extension.

To release: bump `version` in package.json, commit, and push a matching tag (`git tag v0.0.3 && git push origin v0.0.3`). The workflow refuses to publish when the tag and the version differ or the metadata is incomplete. It publishes the `.vsix` it just tested, attaches it to a GitHub release and keeps it as a build artifact. To build a `.vsix` without publishing, run the workflow manually from the Actions tab and leave *publish* unticked.

Publishing authenticates with Microsoft Entra ID instead of a personal access token (global PATs are retired on December 1, 2026). GitHub's short-lived OIDC token is exchanged for a token of an Azure managed identity, and `vsce publish --azure-credential` uses it. No secret is stored anywhere. One-time setup:

1. **Azure: managed identity.** In the Azure portal, create a *user-assigned managed identity* (any resource group). Note its *Client ID*, *Tenant ID* and *Subscription ID*. No role assignment is needed.
2. **Azure: federated credential.** On the identity, open *Federated credentials → Add credential → GitHub Actions deploying Azure resources*: organization `tspannagel`, repository `gitSt8`, entity *Environment*, environment `marketplace`. This results in the subject `repo:tspannagel/gitSt8:environment:marketplace` and the issuer `https://token.actions.githubusercontent.com`.
3. **GitHub: environment.** In the repository settings, create the environment `marketplace`. Add the *variables* (not secrets) `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. Recommended: under *Deployment branches and tags*, allow only tags matching `v*`, and add yourself as a required reviewer.
4. **Marketplace: member ID.** Run the workflow manually with *publish* ticked. The *Show identity* step prints the identity's Marketplace ID; the publish step fails at this point because the identity is not a member yet.
5. **Marketplace: membership.** At [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage/publishers/tisp), open *Members*, add that ID and give it the *Contributor* role. Re-run the workflow.

---

## License

[MIT](LICENSE.md) © 2026 Tim Spannagel
