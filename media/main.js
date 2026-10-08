// @ts-nocheck
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = sel => document.querySelector(sel);
  const ROW = 24;
  const LANE = 14;
  const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39c5cf', '#db61a2', '#e3b341', '#56d364', '#ff7b72'];
  // macOS has Cmd/Option instead of Ctrl/Alt, and Ctrl+click there opens the context menu.
  const MOD = /Mac/i.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl';
  const HELP = `Click a commit to see its details. ${MOD}+click to multi-select (2 = compare), Shift+click for a range.`;

  // Code points of VS Code's bundled codicon font (loaded by the extension).
  const ICONS = {
    add: 0xea60, archive: 0xea98, 'arrow-down': 0xea9a, 'arrow-up': 0xeaa1, check: 0xeab2, 'chevron-down': 0xeab4,
    'circle-filled': 0xea71, 'circle-outline': 0xeabc, 'circle-slash': 0xeabd, 'clear-all': 0xeabf, close: 0xea76,
    cloud: 0xebaa, 'cloud-download': 0xeac2, 'cloud-upload': 0xeac3, copy: 0xebcc, discard: 0xeae2, edit: 0xea73,
    ellipsis: 0xea7c, filter: 0xeaf1, folder: 0xea83, 'folder-opened': 0xeaf7, 'git-branch': 0xec6f,
    'git-commit': 0xeafc, 'git-compare': 0xeafd, 'git-merge': 0xeafe, globe: 0xeb01, history: 0xea82,
    'go-to-file': 0xea94, layers: 0xebd2, 'link-external': 0xeb14, lock: 0xea75, 'multiple-windows': 0xeb23,
    remove: 0xeb3b, repo: 0xea62, 'repo-pull': 0xeb40, 'repo-push': 0xeb41, refresh: 0xeb37, 'root-folder': 0xeb46,
    search: 0xea6d, sync: 0xea77, tag: 0xea66, trash: 0xea81, warning: 0xea6c, 'git-stash': 0xec26,
    'debug-disconnect': 0xead0, milestone: 0xeb20, server: 0xeb50,
    github: 0xea84, 'azure-devops': 0xebe8, 'git-pull-request': 0xea64, 'git-pull-request-draft': 0xebdb,
    'pass-filled': 0xebb3, error: 0xea87, 'circle-large-outline': 0xebb5, skip: 0xec6a, 'sign-in': 0xea6f,
    'debug-rerun': 0xebc0, rocket: 0xeb44,
  };
  const ic = (name, cls = '') => `<i class="ci ${cls}" aria-hidden="true">${ICONS[name] ? String.fromCharCode(ICONS[name]) : ''}</i>`;
  const fillIcons = (root = document) =>
    root.querySelectorAll('[data-icon]').forEach(el => (el.textContent = ICONS[el.dataset.icon] ? String.fromCharCode(ICONS[el.dataset.icon]) : ''));

  const saved = vscode.getState() || {};
  const S = {
    data: null,
    selected: null, // last clicked commit (keyboard anchor)
    multi: [], // selected commits
    anchor: null, // shift-click anchor
    details: null, // details pane: the commit box by default, or stash / compare / reflog / multi
    inline: null, // commit details shown in the graph, under the selected row
    filter: '',
    sideFilter: '',
    highlight: null, // file name/path to highlight in file lists
    collapsed: saved.collapsed || { tags: true, worktrees: false },
    detailsHeight: saved.detailsHeight || 280,
    rawBody: !!saved.rawBody, // show commit bodies as plain text instead of Markdown
    bodyExpanded: false,
  };

  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const persist = () => vscode.setState({ collapsed: S.collapsed, detailsHeight: S.detailsHeight, detailsWidth: S.detailsWidth, rawBody: S.rawBody });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = s => (s && /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : s);
  const normPath = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  function relDate(ts) {
    const s = Date.now() / 1000 - ts;
    if (s < 60) return 'just now';
    for (const [n, u] of [[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']]) {
      if (s >= n) return `${Math.floor(s / n)}${u} ago`;
    }
    return '';
  }
  const absDate = ts => new Date(ts * 1000).toLocaleString();

  // ------------------------------------------------------------------ messages

  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'data':
        S.data = m.data;
        S.index = new Map((m.data.commits || []).map((c, i) => [c.hash, i]));
        if (m.data.integration !== undefined) S.integration = m.data.integration;
        renderAll();
        renderIntegration();
        // The refresh already carries the working tree state, so the commit box (the default pane) updates in place.
        if ((!S.details || S.details.kind === 'wip') && m.data.wip) {
          S.details = m.data.wip;
          renderDetails();
        }
        break;
      case 'reset':
        S.selected = S.anchor = S.details = S.inline = S.highlight = null;
        S.multi = [];
        renderDetails();
        break;
      case 'details':
        // A commit in the graph opens inline under its row, so the commit box stays in the pane.
        if (m.details.kind === 'commit' && commitBySha(m.details.commit.hash)) {
          if (m.details.commit.hash !== S.selected) break; // stale: another row was clicked meanwhile
          S.inline = m.details;
          renderInline();
          revealInline();
          break;
        }
        S.details = m.details;
        renderDetails();
        break;
      case 'reveal':
        if (m.path !== undefined) S.highlight = m.path || null;
        if (commitBySha(m.sha)) select(m.sha, true);
        else if (m.sha !== 'WIP') post('commitDetails', { sha: m.sha });
        break;
      case 'queryApplied':
        S.highlight = m.path || null;
        if (S.data?.commits?.length) select(S.data.commits[0].hash, true);
        else {
          S.inline = null;
          renderInline();
        }
        break;
      case 'repos':
        renderRepoPicker(m.repos, m.root);
        break;
      case 'integration':
        S.integration = m.state;
        renderIntegration();
        if (S.data && !S.data.empty) {
          renderSidebar();
          renderGraph();
          if (S.details?.kind === 'commit') renderDetails();
        }
        break;
      case 'committed':
        S.commitMsg = '';
        S.amend = false;
        if (S.details?.kind === 'wip') post('wipDetails');
        break;
      case 'irebase':
        openRebaseEditor(m);
        break;
      case 'busy':
        $('#busy').hidden = !m.busy;
        $('#busy').innerHTML = m.label ? `${ic('sync')}${esc(m.label)}…` : '';
        break;
      case 'error':
        $('#details').innerHTML = `<div class="empty">Error: ${esc(m.text)}</div>`;
        break;
    }
  });

  // ------------------------------------------------------------------ rendering

  function renderAll() {
    renderToolbar();
    renderQueryBar();
    renderBanner();
    renderSidebar();
    renderGraph();
  }

  function renderRepoPicker(repos, root) {
    const sel = $('#repo');
    // Native <option>s cannot use the icon font, so keep this plain text.
    const label = r => `${r.name}${r.branch ? `  —  ${r.branch}` : ''}${r.changes ? `   (${r.changes} changed)` : ''}`;
    sel.innerHTML = repos.length
      ? repos.map(r => `<option value="${esc(r.root)}" title="${esc(r.root)}" ${normPath(r.root) === normPath(root) ? 'selected' : ''}>${esc(label(r))}</option>`).join('')
      : '<option>No repository</option>';
    sel.disabled = repos.length <= 1;
    sel.title = repos.length > 1 ? `${repos.length} repositories open. Switch the one shown here.` : root || '';
    $('.repo-pick').classList.toggle('multi', repos.length > 1);
  }

  function renderToolbar() {
    const d = S.data;
    renderRepoPicker(d.repos || [], d.root);
    $('#showAll').checked = d.showAll !== false;
    const head = $('#head');
    head.classList.toggle('detached', !!d.head?.detached);
    head.innerHTML = d.head
      ? d.head.branch
        ? `${ic('git-branch', 'sm')}${esc(d.head.branch)}`
        : `${ic('debug-disconnect', 'sm')}detached @ ${esc(short(d.head.sha) || '—')}`
      : '';
    head.title = d.head?.branch ? `Current branch: ${d.head.branch}` : 'HEAD is detached';
  }

  function renderQueryBar() {
    const q = S.data.query;
    const el = $('#querybar');
    if (!q) {
      el.hidden = true;
      return;
    }
    const v = esc(q.value);
    const what = {
      any: `Message, author or file name matches “${v}”`,
      message: `Message matches “${v}”`,
      author: `Author matches “${v}”`,
      pickaxe: `Changes that add or remove “${v}”`,
      regex: `Diffs matching /${v}/`,
      path: q.exact ? `History of <code>${v}</code>${q.isDir ? ' (folder)' : ''}` : `Files or folders named *${v}*`,
    }[q.kind];
    const n = S.data.commits.length;
    el.hidden = false;
    el.innerHTML = `${ic('search')}<span>${what}</span><span class="dir">${n}${S.data.hasMore ? '+' : ''} commit(s)${S.data.showAll ? ' · all branches' : ' · current branch'}</span>
      <span class="spacer"></span><button class="tb" data-clearquery="1">${ic('close', 'sm')}Clear search</button>`;
  }

  function renderBanner() {
    const op = S.data.op;
    const el = $('#banner');
    if (!op) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    const what = {
      rebase: `Rebase of ${esc(op.branch || 'HEAD')} in progress${op.total ? ` (step ${op.step}/${op.total})` : ''}`,
      merge: `Merge in progress (${esc(short(op.head))})`,
      'cherry-pick': `Cherry-pick ${op.head ? `of ${esc(short(op.head))} ` : ''}in progress`,
      revert: `Revert ${op.head ? `of ${esc(short(op.head))} ` : ''}in progress`,
    }[op.kind];
    const ours = op.kind === 'rebase' ? 'upstream' : 'ours';
    const theirs = op.kind === 'rebase' ? 'your commit' : 'theirs';
    const split = op.splitting
      ? `<div class="hint">Splitting <b>${esc(short(op.splitting.sha))}</b> “${esc(op.splitting.subject)}”: its changes are unstaged. Stage and commit them in pieces from Source Control, then press Continue.</div>`
      : '';
    el.innerHTML = `
      <span class="title">${what}</span>
      <span>${op.conflicts.length ? `${op.conflicts.length} conflicted file(s)` : 'No conflicts. Ready to continue.'}</span>
      <span class="actions">
        <button class="primary" data-cmd="opContinue">Continue</button>
        ${op.kind !== 'merge' ? '<button data-cmd="opSkip">Skip commit</button>' : ''}
        <button class="danger" data-cmd="opAbort">Abort</button>
      </span>
      ${split}
      ${op.conflicts.length ? `<ul>${op.conflicts.map(p => `
        <li>
          <span class="st st-!">!</span><span class="path">${esc(p)}</span>
          <button class="link" data-act="openFile" data-path="${esc(p)}">Open</button>
          <button class="link" data-act="takeSide" data-side="ours" data-path="${esc(p)}">Take ${ours}</button>
          <button class="link" data-act="takeSide" data-side="theirs" data-path="${esc(p)}">Take ${theirs}</button>
          <button class="link" data-act="markResolved" data-path="${esc(p)}">Mark resolved</button>
        </li>`).join('')}</ul>` : ''}`;
  }

  // ---- sidebar

  const SECTION_ICONS = { stack: 'layers', local: 'git-branch', remote: 'cloud', tags: 'tag', worktrees: 'folder-opened', stashes: 'archive' };

  function section(id, title, count, inner, hasMenu = true) {
    const collapsed = S.collapsed[id];
    return `<div class="section ${collapsed ? 'collapsed' : ''}" data-section="${id}">
      <div class="sec-head">${ic('chevron-down', 'chev sm')}${ic(SECTION_ICONS[id], 'sec-icon')}<span class="sec-title">${title}</span><span class="count">${count}</span>${
        hasMenu ? `<span class="hbtn" data-secmenu="${id}" title="More actions">${ic('ellipsis')}</span>` : ''
      }</div>
      <div class="items">${inner || '<div class="empty">none</div>'}</div></div>`;
  }

  const matchesSide = name => !S.sideFilter || name.toLowerCase().includes(S.sideFilter);

  function branchItem(b, extraMeta = '', cls = '') {
    const d = S.data;
    const meta = prsForBranch('local', b).map(prPill);
    if (b.ahead) meta.push(`<span class="ab" title="${b.ahead} commit(s) ahead of ${esc(b.upstream)}">${ic('arrow-up', 'xs')}${b.ahead}</span>`);
    if (b.behind) meta.push(`<span class="ab" title="${b.behind} commit(s) behind ${esc(b.upstream)}">${ic('arrow-down', 'xs')}${b.behind}</span>`);
    if (b.gone) meta.push(`<span class="pill gone" title="upstream ${esc(b.upstream)} was deleted on the remote">gone</span>`);
    else if (!b.upstream) meta.push(`<span title="no upstream (never pushed)">${ic('circle-slash', 'xs')}</span>`);
    if (b.worktree && normPath(b.worktree) !== normPath(d.root)) meta.push(`<span title="checked out in worktree ${esc(b.worktree)}">${ic('folder-opened', 'xs')}</span>`);
    const ageDays = b.date ? Math.floor((Date.now() / 1000 - b.date) / 86400) : 0;
    const stale = ageDays >= (d.staleDays || 60);
    if (stale) meta.push(`<span class="pill stale" title="last commit ${ageDays} days ago">${ageDays}d</span>`);
    return `<div class="item ${b.isHead ? 'current' : ''} ${stale ? 'stale' : ''} ${cls}" data-ref="local" data-name="${esc(b.name)}" data-sha="${b.sha}"
      title="${esc(b.name)}${b.upstream ? ` → ${esc(b.upstream)}` : ''}${b.isHead ? ' (checked out)' : ''}">
      ${b.isHead ? ic('check', 'sm') : ic('git-branch', 'sm')}<span class="name">${esc(b.name)}</span><span class="meta">${extraMeta}${meta.join('')}${ciIcon(b.sha)}</span></div>`;
  }

  function renderSidebar() {
    const d = S.data;
    const el = $('#sideContent');
    if (d.empty) {
      el.innerHTML = '<div class="empty">No git repository open.</div>';
      return;
    }
    const { local, remote, tags, remoteInfo } = d.refs;
    const byName = Object.fromEntries(local.map(b => [b.name, b]));

    // Stack: top of the stack first, like the graph.
    const stack = (d.stack || []).filter(s => byName[s.name] && matchesSide(s.name)).reverse();
    const stackHtml =
      stack.map(s => branchItem(byName[s.name], `<span title="${s.count} commit(s) on top of ${esc(d.base)}">+${s.count}</span>`)).join('') +
      (stack.length ? `<div class="item base" data-ref="stackbase" data-name="${esc(d.base)}" data-sha="${(remote.find(r => r.name === d.base) || byName[d.base] || {}).sha || ''}" title="Stack base (change via ⋯)"><span class="name dir">${esc(d.base)}</span><span class="meta">base</span></div>` : '');

    const localHtml = local.filter(b => matchesSide(b.name)).map(b => branchItem(b)).join('');

    const byRemote = {};
    for (const r of remoteInfo) byRemote[r.name] = [];
    for (const r of remote) (byRemote[r.remote] ||= []).push(r);
    const remoteHtml = Object.keys(byRemote)
      .map(name => {
        const info = remoteInfo.find(r => r.name === name);
        const items = byRemote[name].filter(r => matchesSide(r.name));
        return (
          `<div class="group-head" data-remotegroup="${esc(name)}" title="${esc(info?.fetchUrl || '')} (right-click for actions)">${ic('server', 'sm')}<span class="gname">${esc(name)}</span><span class="dir">${esc(info?.fetchUrl || '')}</span></div>` +
          items
            .map(r => `<div class="item nested" data-ref="remote" data-name="${esc(r.name)}" data-remote="${esc(r.remote)}" data-branch="${esc(r.branch)}" data-sha="${r.sha}" title="${esc(r.name)}">${ic('git-branch', 'sm')}<span class="name">${esc(r.branch)}</span><span class="meta">${prsForBranch('remote', r).map(prPill).join('')}${ciIcon(r.sha)}</span></div>`)
            .join('')
        );
      })
      .join('');

    const sync = d.tagSync;
    const tagItems = tags
      .filter(t => matchesSide(t.name))
      .sort((a, b) => natural(b.name, a.name))
      .map(t => {
        let pill = '';
        if (sync) {
          if (!(t.name in sync.tags)) pill = `<span class="pill local-only" title="not on ${esc(sync.remote)}">local only</span>`;
          else if (sync.tags[t.name] !== t.sha) pill = `<span class="pill gone" title="${esc(sync.remote)} has it on ${short(sync.tags[t.name])}">differs</span>`;
        }
        const title = `${t.name}${t.annotated ? ` (annotated)${t.message ? `: ${t.message}` : ''}` : ''}${t.date ? `\n${absDate(t.date)}` : ''}`;
        return `<div class="item" data-ref="tag" data-name="${esc(t.name)}" data-sha="${t.sha}" title="${esc(title)}">${ic('tag', t.annotated ? 'sm' : 'sm tag-light')}<span class="name">${esc(t.name)}</span><span class="meta">${pill}${t.date ? `<span>${relDate(t.date)}</span>` : ''}</span></div>`;
      });
    if (sync) {
      const localNames = new Set(tags.map(t => t.name));
      Object.keys(sync.tags)
        .filter(n => !localNames.has(n) && matchesSide(n))
        .sort((a, b) => natural(b, a))
        .forEach(n =>
          tagItems.push(`<div class="item remote-only" data-ref="rtag" data-name="${esc(n)}" data-sha="${sync.tags[n]}" title="only on ${esc(sync.remote)}">${ic('cloud', 'sm')}<span class="name">${esc(n)}</span><span class="meta"><span class="pill remote-only">remote only</span></span></div>`)
        );
    }
    const tagTitle = sync ? `Tags <span class="dir">vs ${esc(sync.remote)}</span>` : 'Tags';

    const wtHtml = (d.worktrees || [])
      .filter(w => !w.bare && matchesSide(w.path + ' ' + (w.branch || '')))
      .map(w => {
        const current = normPath(w.path) === normPath(d.root);
        const name = w.path.split(/[\\/]/).pop();
        const flags = [w.locked ? `<span title="locked">${ic('lock', 'xs')}</span>` : '', w.prunable ? '<span class="pill gone" title="folder missing">prunable</span>' : ''].join('');
        return `<div class="item ${current ? 'current' : ''}" data-ref="worktree" data-path="${esc(w.path)}" data-sha="${w.head || ''}" data-locked="${w.locked ? 1 : ''}" title="${esc(w.path)}${current ? ' (this window)' : ' (double-click to open)'}">
          ${current ? ic('root-folder', 'sm') : ic('folder', 'sm')}<span class="name">${esc(name)}</span><span class="meta">${esc(w.branch || (w.detached ? 'detached' : ''))} ${flags}</span></div>`;
      })
      .join('');

    const stashHtml = d.stashes
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => matchesSide(s.ref + ' ' + s.message))
      .map(({ s, i }) => `<div class="item" data-ref="stash" data-idx="${i}" title="${esc(s.message)}">${ic('archive', 'sm')}<span class="name">${esc(s.ref)}</span><span class="meta">${esc(s.message.replace(/^On [^:]+: /, ''))}</span></div>`)
      .join('');

    el.innerHTML =
      (d.stack?.length ? section('stack', `Stack on ${esc(d.base)}`, d.stack.length, stackHtml) : '') +
      section('local', 'Branches', local.length, localHtml) +
      section('remote', 'Remotes', remote.length, remoteHtml) +
      section('tags', tagTitle, tags.length, tagItems.join('')) +
      section('worktrees', 'Worktrees', (d.worktrees || []).length, wtHtml) +
      section('stashes', 'Stashes', d.stashes.length, stashHtml);
  }

  // ---- graph

  function badgeMap() {
    const map = {};
    const add = (sha, b) => (map[sha] ||= []).push(b);
    const { refs, head } = S.data;
    if (head?.detached && head.sha) add(head.sha, { cls: 'head', name: 'HEAD', ref: 'head' });
    for (const b of refs.local) add(b.sha, { cls: b.isHead ? 'head' : 'local', name: b.name, ref: 'local' });
    for (const r of refs.remote) add(r.sha, { cls: 'remote', name: r.name, ref: 'remote', remote: r.remote, branch: r.branch });
    for (const t of refs.tags) add(t.sha, { cls: 'tag', name: t.name, ref: 'tag' });
    S.data.stashes.forEach((s, i) => add(s.parents[0], { cls: 'stash', name: s.ref, ref: 'stash', idx: i }));
    return map;
  }

  const BADGE_ICONS = { head: 'check', local: 'git-branch', remote: 'cloud', tag: 'tag', stash: 'archive' };

  // ---- hosting service integration (GitHub / Azure DevOps)

  const CI_ICONS = { success: 'pass-filled', failure: 'error', pending: 'circle-large-outline', cancelled: 'circle-slash', neutral: 'circle-outline', skipped: 'skip' };
  const CI_WORDS = { success: 'passed', failure: 'failed', pending: 'running', cancelled: 'cancelled', neutral: 'neutral', skipped: 'skipped' };
  const PROVIDER = { github: { icon: 'github', name: 'GitHub', ci: 'Actions' }, azure: { icon: 'azure-devops', name: 'Azure DevOps', ci: 'Pipelines' } };

  const ciStatus = sha => S.integration?.statuses?.[sha];

  function ciIcon(sha) {
    const s = ciStatus(sha);
    if (!s) return '';
    const lines = s.checks.map(c => `${CI_WORDS[c.state]}: ${c.name}`).join('\n');
    return `<span class="cistat ci-${s.state}" data-ci="${sha}" title="${esc(`${PROVIDER[S.integration.provider].ci}: ${CI_WORDS[s.state]}\n${lines}\n(click for details)`)}">${ic(CI_ICONS[s.state], 'sm')}</span>`;
  }

  /** Open PRs whose source is this local or remote branch (on the integrated remote). */
  function prsForBranch(kind, b) {
    const st = S.integration;
    if (!st?.prs?.length) return [];
    let branch = null;
    if (kind === 'remote') branch = b.remote === st.remote ? b.branch : null;
    else if (b.upstream) branch = b.upstream.startsWith(st.remote + '/') ? b.upstream.slice(st.remote.length + 1) : null;
    else branch = b.name;
    return branch ? st.prs.filter(p => p.sourceBranch === branch && !p.fromFork) : [];
  }

  function prPill(p) {
    const review = { approved: 'approved', changes: 'changes requested', required: 'review required', none: '' }[p.review];
    const title = `#${p.number} ${p.title}\n${p.sourceBranch} → ${p.targetBranch} · ${p.author}${p.isDraft ? ' · draft' : ''}${review ? ` · ${review}` : ''}${p.ci ? ` · checks ${CI_WORDS[p.ci]}` : ''}\n(click to open, right-click for more)`;
    return `<span class="pill pr ${p.isDraft ? 'draft' : ''} review-${p.review}" data-pr="${esc(p.number)}" title="${esc(title)}">${ic(p.isDraft ? 'git-pull-request-draft' : 'git-pull-request', 'xs')}${esc(p.number)}${p.ci ? ic(CI_ICONS[p.ci], `xs ci-${p.ci}`) : ''}</span>`;
  }

  const prByNumber = n => S.integration?.prs?.find(p => p.number === Number(n));

  // ---- Markdown (commit and PR descriptions)

  /**
   * Small, safe Markdown renderer for commit messages. Everything is HTML-escaped first and
   * only a fixed set of tags is produced; links open in the browser via the extension.
   * Supports headings, paragraphs, emphasis, strikethrough, inline code, fenced code, lists
   * (nested by indent, task items), blockquotes, rules, tables and autolinks.
   */
  function renderMarkdown(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    };
    const isTableSep = l => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l);
    const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line))) {
        flushPara();
        const fence = m[1];
        const code = [];
        while (++i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i]);
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      } else if (!line.trim()) {
        flushPara();
      } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        flushPara();
        const level = Math.min(6, m[1].length + 2); // keep headings small inside the pane
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara();
        out.push('<hr>');
      } else if (/^\s{0,3}>/.test(line)) {
        flushPara();
        const quote = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i--;
        out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      } else if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara();
        const head = cells(line);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
        i--;
        out.push(`<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map(r => `<tr>${head.map((_, j) => `<td>${inline(r[j] || '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`);
      } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flushPara();
        const items = [];
        for (; i < lines.length; i++) {
          const l = lines[i];
          const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
          if (li) items.push({ indent: li[1].replace(/\t/g, '  ').length, ordered: /\d/.test(li[2]), text: li[3] });
          else if (l.trim() && /^\s{2,}\S/.test(l) && items.length) items[items.length - 1].text += ' ' + l.trim(); // wrapped item
          else break;
        }
        i--;
        out.push(renderList(items));
      } else {
        para.push(line.trim());
      }
    }
    flushPara();
    return out.join('');
  }

  function renderList(items) {
    // Nest by indentation: deeper items become a sub-list of the previous item.
    const build = (start, indent) => {
      const ordered = items[start].ordered;
      let html = '';
      let i = start;
      while (i < items.length && items[i].indent >= indent) {
        const it = items[i];
        const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
        const body = task ? `${ic(task[1] === ' ' ? 'circle-large-outline' : 'pass-filled', `xs task ${task[1] === ' ' ? '' : 'done'}`)}${inline(task[2])}` : inline(it.text);
        i++;
        let sub = '';
        if (i < items.length && items[i].indent > it.indent) {
          const r = build(i, items[i].indent);
          sub = r.html;
          i = r.next;
        }
        html += `<li class="${task ? 'task-item' : ''}">${body}${sub}</li>`;
      }
      const tag = ordered ? 'ol' : 'ul';
      return { html: `<${tag}>${html}</${tag}>`, next: i };
    };
    let html = '';
    for (let i = 0; i < items.length; ) {
      const r = build(i, items[i].indent);
      html += r.html;
      i = r.next;
    }
    return html;
  }

  /** Inline Markdown on one block of text. Escapes first, then adds a fixed set of tags. */
  function inline(text) {
    const slots = [];
    const keep = html => `\u0000${slots.push(html) - 1}\u0000`;
    let s = text
      // inline code first, so nothing inside it is formatted
      .replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`))
      // [text](url)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => keep(`<a data-url="${esc(u)}" title="${esc(u)}">${esc(t)}</a>`))
      // bare URLs
      .replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, u => keep(`<a data-url="${esc(u)}">${esc(u)}</a>`));
    s = esc(s)
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
      .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)|(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2 ?? ''}<em>${a ?? b}</em>`)
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[n]);
  }

  /** CI checks and PRs for a commit, shown in its details. */
  function checksBlock(sha) {
    const s = ciStatus(sha);
    const prs = (S.integration?.prs || []).filter(p => p.headSha === sha);
    if (!s && !prs.length) return '';
    const p = PROVIDER[S.integration.provider];
    return `<div class="checks">
      ${prs.map(pr => `<div class="check-row" data-url="${esc(pr.url)}">${ic(pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request', 'sm')}<span>#${pr.number} ${esc(pr.title)}</span><span class="dir">${esc(pr.sourceBranch)} → ${esc(pr.targetBranch)}</span></div>`).join('')}
      ${s ? `<div class="grp-head">${p.ci}: <span class="ci-${s.state}">${CI_WORDS[s.state]}</span></div>
        ${s.checks.map(c => `<div class="check-row" ${c.url ? `data-url="${esc(c.url)}"` : ''}>${ic(CI_ICONS[c.state], `sm ci-${c.state}`)}<span>${esc(c.name)}</span><span class="dir">${CI_WORDS[c.state]}</span></div>`).join('')}` : ''}
    </div>`;
  }

  function renderIntegration() {
    const el = $('#integration');
    const st = S.integration;
    if (!st) {
      el.hidden = true;
      return;
    }
    const p = PROVIDER[st.provider];
    el.hidden = false;
    el.className = `integ ${st.signedIn ? '' : 'signed-out'} ${st.error && st.signedIn ? 'has-error' : ''}`;
    if (!st.signedIn) {
      el.innerHTML = `${ic(p.icon)}<span class="lbl">${esc(st.label)}</span>
        <button class="tb" data-signin="${st.provider}" title="${esc(st.error || '')}">${ic('sign-in', 'sm')}Sign in</button>
        ${st.provider === 'azure' ? `<button class="tb" data-setpat="${esc(st.label.split('/')[0])}" title="Use a personal access token instead">Use token…</button>` : ''}`;
      return;
    }
    const open = st.prs.length;
    el.innerHTML = `${ic(p.icon)}<span class="lbl">${esc(st.label)}</span>${
      st.error ? `<span title="${esc(st.error)}">${ic('warning', 'sm')}</span>` : `<span class="prcount" title="${open} open pull request(s)">${ic('git-pull-request', 'sm')}${open}</span>`
    }<span class="hbtn" data-integmenu="1" title="More">${ic('ellipsis', 'sm')}</span>`;
    el.title = `${p.name}: ${st.label} (remote '${st.remote}')${st.error ? `\n${st.error}` : ''}`;
  }

  function integrationMenu() {
    const st = S.integration;
    const p = PROVIDER[st.provider];
    return [
      { header: `${p.name} · ${st.label}` },
      { label: 'Open repository in browser', icon: 'link-external', run: () => post('openExternal', { url: st.webUrl }) },
      { label: `Open pull requests (${st.prs.length} open)`, icon: 'git-pull-request', run: () => post('openExternal', { url: st.prsUrl }) },
      { label: `Open ${p.ci}`, icon: 'rocket', run: () => post('openExternal', { url: st.ciUrl }) },
      '-',
      ...st.prs.slice(0, 15).map(pr => ({ label: `#${pr.number} ${pr.title.slice(0, 60)}`, icon: pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request', run: () => post('openExternal', { url: pr.url }) })),
      ...(st.prs.length ? ['-'] : []),
      { label: 'Refresh status', icon: 'refresh', run: () => post('refreshIntegration') },
      ...(st.provider === 'azure' ? [{ label: 'Use a personal access token…', icon: 'sign-in', run: () => post('setAzurePat', { org: st.label.split('/')[0] }) }] : []),
    ];
  }

  function ciMenu(sha) {
    const s = ciStatus(sha);
    if (!s) return [];
    return [
      { header: `${PROVIDER[S.integration.provider].ci} for ${short(sha)}: ${CI_WORDS[s.state]}` },
      ...s.checks.map(c => ({ label: `${c.name} (${CI_WORDS[c.state]})`, icon: CI_ICONS[c.state], run: () => c.url && post('openExternal', { url: c.url }) })),
      '-',
      { label: 'Refresh status', icon: 'refresh', run: () => post('refreshIntegration') },
    ];
  }

  function prMenu(n) {
    const p = prByNumber(n);
    if (!p) return [];
    const st = S.integration;
    return [
      { header: `#${p.number} ${p.title}` },
      { label: 'Open in browser', icon: 'link-external', run: () => post('openExternal', { url: p.url }) },
      { label: `Compare with ${st.remote}/${p.targetBranch}`, icon: 'git-compare', run: () => compare(`${st.remote}/${p.targetBranch}`, p.headSha || `${st.remote}/${p.sourceBranch}`) },
      ...(p.headSha && commitBySha(p.headSha) ? [{ label: 'Show head commit', icon: 'go-to-file', run: () => select(p.headSha, true) }] : []),
      { label: 'Copy link', icon: 'copy', run: () => post('copy', { text: p.url }) },
    ];
  }

  function graphSvg(row, width) {
    let paths = '';
    for (const [x1, y1, x2, y2, c] of row.segs) {
      const ax = 8 + x1 * LANE, ay = y1 * ROW, bx = 8 + x2 * LANE, by = y2 * ROW;
      const color = COLORS[c % COLORS.length];
      const d = ax === bx ? `M${ax} ${ay}L${bx} ${by}` : `M${ax} ${ay}C${ax} ${(ay + by) / 2} ${bx} ${(ay + by) / 2} ${bx} ${by}`;
      paths += `<path d="${d}" stroke="${color}" stroke-width="2" fill="none"/>`;
    }
    const cx = 8 + row.col * LANE;
    const color = COLORS[row.col % COLORS.length];
    return `<svg width="${width}" height="${ROW}">${paths}<circle cx="${cx}" cy="${ROW / 2}" r="4" fill="${color}" stroke="var(--vscode-editor-background)" stroke-width="1.5"/></svg>`;
  }

  function renderGraph() {
    const d = S.data;
    const tbody = $('#graph tbody');
    if (d.empty || !d.commits) {
      tbody.innerHTML = '';
      $('#more').innerHTML = '';
      return;
    }
    const lanes = Math.min(d.maxLanes, 40);
    const width = 16 + lanes * LANE;
    $('#graph col.c-graph').style.width = `${width}px`;
    // Graph lines only change with new data, not with integration updates, so build them once per data message.
    if (S.svgFor !== d) {
      S.svg = d.commits.map((_, i) => graphSvg(d.rows[i], width));
      S.svgFor = d;
    }
    const badges = badgeMap();
    const prsByHead = {};
    for (const p of S.integration?.prs || []) if (p.headSha) prsByHead[p.headSha] = (prsByHead[p.headSha] || '') + prPill(p);
    const html = [];
    d.commits.forEach((c, i) => {
      const bs = (badges[c.hash] || [])
        .map(b => `<span class="badge ${b.cls}" data-badge="${b.ref}" data-name="${esc(b.name)}" ${b.remote ? `data-remote="${esc(b.remote)}" data-branch="${esc(b.branch)}"` : ''} ${b.idx !== undefined ? `data-idx="${b.idx}"` : ''} title="${esc(b.name)}">${ic(BADGE_ICONS[b.cls] || 'git-branch')}${esc(b.name)}</span>`)
        .join('');
      html.push(`<tr data-i="${i}" data-sha="${c.hash}" class="${c.wip ? 'wip' : ''}">
        <td class="g">${S.svg[i]}</td>
        <td class="msg" title="${esc(c.subject)}">${ciIcon(c.hash)}${bs}${prsByHead[c.hash] || ''}<span class="subject">${esc(c.subject)}</span></td>
        <td class="author" title="${esc(c.email || '')}">${esc(c.author)}</td>
        <td class="date" title="${c.wip ? '' : absDate(c.date)}">${c.wip ? '' : relDate(c.date)}</td>
        <td class="sha">${c.wip ? '' : c.hash.slice(0, 7)}</td></tr>`);
    });
    tbody.innerHTML = html.join('');
    $('#more').innerHTML = d.hasMore ? '<button data-cmd="loadMore">Load more commits</button>' : '';
    S.multi = S.multi.filter(sha => commitBySha(sha));
    if (S.selected && !commitBySha(S.selected)) S.selected = null;
    applyMarks();
    applyFilter();
    renderInline();
  }

  function applyMarks() {
    const sel = new Set(S.multi);
    for (const tr of document.querySelectorAll('#graph tr[data-sha]')) tr.classList.toggle('sel', sel.has(tr.dataset.sha));
  }

  function applyFilter() {
    const f = S.filter.trim().toLowerCase();
    if (!S.data?.commits) return;
    const searching = $('#searchKind').value !== '';
    for (const tr of document.querySelectorAll('#graph tr[data-sha]')) {
      const c = S.data.commits[tr.dataset.i];
      const hit = searching || !f || c.subject.toLowerCase().includes(f) || (c.author || '').toLowerCase().includes(f) || c.hash.startsWith(f);
      tr.classList.toggle('dim', !hit);
    }
  }

  // ---- details

  /**
   * @param {object[]} files
   * @param {string} left diff left ref
   * @param {string|null} right diff right ref, null = working tree
   * @param {{act: string, icon: string, title: string, when?: (f) => boolean}[]} [actions] per-file buttons
   */
  function fileList(files, left, right, actions = []) {
    if (!files.length) return '<div class="empty">No file changes.</div>';
    const hl = S.highlight ? S.highlight.toLowerCase() : null;
    const isHit = f => hl && (f.path.toLowerCase().includes(hl) || (f.oldPath || '').toLowerCase().includes(hl));
    const sorted = hl ? [...files.filter(isHit), ...files.filter(f => !isHit(f))] : files;
    return `<ul class="files">${sorted
      .map(f => {
        const i = f.path.lastIndexOf('/');
        const dir = i >= 0 ? f.path.slice(0, i + 1) : '';
        const base = f.path.slice(i + 1);
        const rename = f.oldPath && f.oldPath !== f.path ? ` <span class="dir">← ${esc(f.oldPath)}</span>` : '';
        return `<li class="${isHit(f) ? 'hl' : ''}" data-path="${esc(f.path)}" data-old="${esc(f.oldPath || '')}" data-left="${esc(left)}" data-right="${esc(right || '')}" data-status="${f.status}" title="Open diff (right-click for more)">
          <span class="st st-${f.status}">${f.status}</span><span class="fname">${esc(base)} <span class="dir">${esc(dir)}</span>${rename}</span>
          ${actions.length ? `<span class="factions">${actions.filter(a => !a.when || a.when(f)).map(a => `<button class="icon" data-fileact="${a.act}" title="${esc(a.title)}">${ic(a.icon)}</button>`).join('')}</span>` : ''}</li>`;
      })
      .join('')}</ul>`;
  }

  /** Staged / unstaged changes with a commit box. Keeps the draft message and caret across refreshes. */
  function renderWip(el, d) {
    const ta = document.activeElement?.id === 'commitMsg' ? document.activeElement : null;
    const caret = ta ? [ta.selectionStart, ta.selectionEnd] : null;
    const nStaged = d.staged.length;
    const nUnstaged = d.unstaged.length;
    const canAmend = d.headRef === 'HEAD';
    const label = S.amend ? (nStaged ? `Amend with ${nStaged} staged file(s)` : 'Amend last commit') : nStaged ? `Commit ${nStaged} staged file(s)` : nUnstaged ? `Stage all ${nUnstaged} & commit` : 'Nothing to commit';
    el.innerHTML = `<div class="wip">
      <div class="commitbox">
        <div class="d-subject">Commit to ${esc(d.branch || 'detached HEAD')}</div>
        <textarea id="commitMsg" placeholder="Message (${MOD}+Enter to commit)">${esc(S.commitMsg || '')}</textarea>
        <div class="opts">
          <label class="check" title="${canAmend ? 'Replace the last commit' : 'No commit yet'}"><input type="checkbox" id="amend" ${S.amend ? 'checked' : ''} ${canAmend ? '' : 'disabled'}> Amend last commit</label>
          <label class="check" title="git commit --no-verify"><input type="checkbox" id="noVerify" ${S.noVerify ? 'checked' : ''}> Skip hooks</label>
        </div>
        <button class="primary" data-commit="1" ${!nStaged && !nUnstaged && !S.amend ? 'disabled' : ''}>${ic('check')}${label}</button>
      </div>
      <div class="changes">
        ${d.conflicts.length ? `<div class="grp-head conflict">Merge conflicts (${d.conflicts.length})</div>
          ${fileList(d.conflicts, d.headRef, null, [{ act: 'open', icon: 'go-to-file', title: 'Open file' }, { act: 'resolved', icon: 'check', title: 'Mark resolved (stage)' }])}` : ''}
        <div class="grp-head">Staged changes (${nStaged}) ${nStaged ? '<button class="link" data-wip="unstageAll">unstage all</button>' : ''}</div>
        ${nStaged ? fileList(d.staged, d.headRef, 'INDEX', [{ act: 'unstage', icon: 'remove', title: 'Unstage' }]) : '<div class="empty">Nothing staged.</div>'}
        <div class="grp-head">Changes (${nUnstaged}) ${nUnstaged ? '<button class="link" data-wip="stageAll">stage all</button> <button class="link danger" data-wip="discardAll">discard all…</button>' : ''}</div>
        ${nUnstaged
          ? fileList(d.unstaged, 'INDEX', null, [
              { act: 'open', icon: 'go-to-file', title: 'Open file', when: f => f.status !== 'D' },
              { act: 'discard', icon: 'discard', title: 'Discard changes' },
              { act: 'stage', icon: 'add', title: 'Stage' },
            ])
          : '<div class="empty">Working tree clean.</div>'}
      </div></div>`;
    const box = $('#commitMsg');
    if (caret) {
      box.focus();
      box.setSelectionRange(caret[0], caret[1]);
    } else if (S.focusCommit) {
      box.focus();
      S.focusCommit = false;
    }
  }

  function commitNow() {
    const d = S.details;
    if (d?.kind !== 'wip') return;
    post('commit', { message: S.commitMsg || '', amend: !!S.amend, noVerify: !!S.noVerify, stageAll: !d.staged.length && !S.amend });
  }

  function openCommit() {
    S.focusCommit = true;
    if (commitBySha('WIP')) return select('WIP', true);
    S.multi = [];
    applyMarks();
    post('wipDetails');
  }

  /** Message, metadata, checks and files of one commit. Used inline in the graph and in the pane. */
  function commitHtml(d) {
    const c = d.commit;
    const [subject, ...rest] = c.message.split('\n');
    const body = rest.join('\n').trim();
    const long = body.split('\n').length > 14;
    return `
      <div class="d-head"><span class="d-subject">${esc(subject)}</span>
        ${body ? `<span class="spacer"></span><button class="link" data-rawtoggle="1" title="Show the message as plain text or rendered Markdown">${S.rawBody ? 'Markdown' : 'Raw'}</button>` : ''}</div>
      ${body ? `<div class="d-body ${S.rawBody ? 'raw' : 'md'} ${long && !S.bodyExpanded ? 'clamped' : ''}">${S.rawBody ? esc(body) : renderMarkdown(body)}</div>
        ${long ? `<button class="link more" data-bodytoggle="1">${S.bodyExpanded ? 'Show less' : 'Show more'}</button>` : ''}` : ''}
      <div class="d-meta">
        <span>${esc(c.author)} &lt;${esc(c.email)}&gt; · ${absDate(c.date)}</span>
        ${c.committer !== c.author ? `<span>committed by ${esc(c.committer)} · ${absDate(c.commitDate)}</span>` : ''}
        <span><code>${c.hash}</code> <button class="link" data-copy="${c.hash}">copy</button></span>
        <span>parents: ${c.parents.map(p => `<button class="link" data-goto="${p}">${p.slice(0, 7)}</button>`).join(' ') || 'none'}</span>
        <span>${d.files.length} file(s)${c.parents.length > 1 ? ' (vs first parent)' : ''}</span>
      </div>
      ${checksBlock(c.hash)}
      ${fileList(d.files, d.left, d.right)}`;
  }

  /** Lane lines that pass the inline details row, so the graph doesn't look cut. */
  function laneSvg(i, width) {
    const lines = S.data.rows[i].segs
      .filter(s => s[3] === 1)
      .map(([, , x, , c]) => `<path d="M${8 + x * LANE} 0V1" stroke="${COLORS[c % COLORS.length]}" stroke-width="2" vector-effect="non-scaling-stroke"/>`)
      .join('');
    return `<svg width="${width}" viewBox="0 0 ${width} 1" preserveAspectRatio="none">${lines}</svg>`;
  }

  function renderInline() {
    document.querySelector('#graph tr.inline')?.remove();
    const d = S.inline;
    if (!d) return;
    const tr = document.querySelector(`#graph tr[data-sha="${d.commit.hash}"]`);
    if (!tr) {
      S.inline = null;
      return;
    }
    const width = parseInt($('#graph col.c-graph').style.width, 10) || 16;
    tr.insertAdjacentHTML('afterend', `<tr class="inline"><td class="g">${laneSvg(+tr.dataset.i, width)}</td><td colspan="4"><div class="inline-details">${commitHtml(d)}</div></td></tr>`);
  }

  /** Scrolls so the opened details are visible, keeping their commit row on screen. */
  function revealInline() {
    const row = document.querySelector('#graph tr.inline');
    if (!row) return;
    if (row.offsetHeight < $('#graphWrap').clientHeight - ROW) row.scrollIntoView({ block: 'nearest' });
    else row.previousElementSibling.scrollIntoView({ block: 'start' });
  }

  /** Back to the default pane content: the commit box. */
  function showWip() {
    if (S.details?.kind === 'wip') return;
    if (S.data?.wip) {
      S.details = S.data.wip;
      renderDetails();
    }
    post('wipDetails');
  }

  const rerenderCommit = () => {
    if (S.details?.kind === 'commit') renderDetails();
    renderInline();
  };

  function renderDetails() {
    const el = $('#details');
    const d = S.details;
    if (!d) {
      el.innerHTML = `<div class="empty">${HELP}</div>`;
      return;
    }
    if (d.kind === 'commit') {
      el.innerHTML = commitHtml(d);
    } else if (d.kind === 'wip') {
      renderWip(el, d);
    } else if (d.kind === 'stash') {
      el.innerHTML = `<div class="d-head"><span class="d-subject">${esc(d.stash.ref)}</span><span>${esc(d.stash.message)}</span></div>
        <div class="d-meta"><span>${absDate(d.stash.date)}</span>
          <button class="link" data-stash="stashApply">apply</button>
          <button class="link" data-stash="stashPop">pop</button>
          <button class="link" data-stash="stashBranch">branch</button>
          <button class="link" data-stash="stashDrop">drop</button></div>
        ${fileList(d.files, d.left, d.right)}`;
    } else if (d.kind === 'compare') {
      const counts = d.counts ? `<span>${d.counts.onlyLeft} commit(s) only in ${esc(d.aLabel)}, ${d.counts.onlyRight} only in ${esc(d.bLabel)}</span>` : '';
      el.innerHTML = `<div class="d-head"><span class="d-subject">Compare ${esc(d.aLabel)} ↔ ${esc(d.bLabel)}</span>
          ${d.b ? '<button class="link" data-swap="1">swap</button>' : ''}</div>
        <div class="d-meta">${counts}<span>${d.files.length} file(s) differ</span></div>
        ${fileList(d.files, d.left, d.right)}`;
    } else if (d.kind === 'reflog') {
      el.innerHTML = `<div class="d-head"><span class="d-subject">HEAD reflog</span>
          <span class="dir">Every position HEAD has been at. To undo a rebase, reset or bad merge, reset to the entry before it.</span></div>
        <table class="reflog"><tbody>${d.entries
          .map(
            e => `<tr data-sha="${e.hash}">
            <td class="rsel">${esc(e.selector)}</td>
            <td class="when" title="${e.date ? absDate(e.date) : ''}">${e.date ? relDate(e.date) : ''}</td>
            <td class="act">${esc(e.action)}</td>
            <td class="sha">${e.hash.slice(0, 7)}</td>
            <td class="subj">${esc(e.subject)}</td>
            <td class="btns"><button class="link" data-rl="show">show</button><button class="link" data-rl="reset">reset here…</button><button class="link" data-rl="branch">branch…</button></td>
          </tr>`
          )
          .join('')}</tbody></table>`;
    } else if (d.kind === 'multi') {
      const cs = d.shas.map(commitBySha).filter(Boolean);
      const cur = headName();
      el.innerHTML = `<div class="d-head"><span class="d-subject">${cs.length} commits selected</span><span class="dir">oldest first</span></div>
        <div class="d-meta">
          <button class="link" data-multi="cherryPickMany">cherry-pick onto ${esc(cur)}</button>
          <button class="link" data-multi="revertMany">revert on ${esc(cur)}</button>
          <button class="link" data-multi="compareEnds">compare oldest ↔ newest</button>
          <button class="link" data-multi="copy">copy SHAs</button>
        </div>
        <ul class="files">${cs.map(c => `<li data-goto-row="${c.hash}"><span class="st">•</span><span><code>${c.hash.slice(0, 7)}</code> ${esc(c.subject)} <span class="dir">${esc(c.author)}</span></span></li>`).join('')}</ul>`;
    }
  }

  // ------------------------------------------------------------------ selection & compare

  const indexOf = sha => S.index?.get(sha) ?? -1;
  const commitBySha = sha => S.data?.commits?.[indexOf(sha)];
  const oldestFirst = shas => shas.slice().sort((a, b) => indexOf(b) - indexOf(a));
  const labelFor = sha => {
    const b = badgeMap()[sha];
    return b?.length ? b[0].name : short(sha);
  };
  const headName = () => S.data?.head?.branch || 'HEAD';

  function select(sha, scroll) {
    if (sha !== S.selected) S.bodyExpanded = false;
    S.selected = S.anchor = sha;
    S.multi = [sha];
    applyMarks();
    const c = commitBySha(sha);
    if (scroll) document.querySelector(`#graph tr[data-sha="${sha}"]`)?.scrollIntoView({ block: 'center' });
    if (!c) return;
    if (S.inline && S.inline.commit.hash !== sha) {
      S.inline = null;
      renderInline();
    }
    if (c.wip) {
      S.details = null;
      return showWip();
    }
    showWip();
    post('commitDetails', { sha });
  }

  function compare(a, b) {
    // a = base side, b = other side; b null => working tree
    post('compare', { a, b, aLabel: labelFor(a), bLabel: b ? labelFor(b) : 'working tree' });
  }

  /** Shows the right details for the current multi-selection. */
  function showMulti() {
    applyMarks();
    const m = S.multi;
    if (m.length !== 1 && S.inline) {
      S.inline = null;
      renderInline();
    }
    if (!m.length) return showWip();
    if (m.length === 1) return select(m[0]);
    if (m.length === 2) {
      if (m.includes('WIP')) return compare(m.find(x => x !== 'WIP'), null);
      const [older, newer] = oldestFirst(m);
      return compare(older, newer);
    }
    S.details = { kind: 'multi', shas: oldestFirst(m.filter(x => x !== 'WIP')) };
    renderDetails();
  }

  function reveal(sha) {
    if (commitBySha(sha)) select(sha, true);
    else post('reveal', { sha });
  }

  // ------------------------------------------------------------------ context menus

  function showMenu(x, y, items) {
    const el = $('#menu');
    el.innerHTML = items
      .map((it, i) => {
        if (it === '-') return '<div class="ms"></div>';
        if (it.header) return `<div class="mh">${esc(it.header)}</div>`;
        return `<div class="mi ${it.danger ? 'danger' : ''}" data-i="${i}">${ic(it.icon)}${esc(it.label)}</div>`;
      })
      .join('');
    el.hidden = false;
    el._items = items;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height - 4))}px`;
  }
  const hideMenu = () => ($('#menu').hidden = true);

  function multiMenu(shas) {
    const list = oldestFirst(shas.filter(x => x !== 'WIP'));
    const cur = headName();
    return [
      { header: `${list.length} commits selected` },
      { label: `Cherry-pick ${list.length} commits onto ${cur}`, icon: 'git-commit', run: () => post('cherryPickMany', { shas: list }) },
      { label: `Revert ${list.length} commits`, icon: 'discard', run: () => post('revertMany', { shas: list }) },
      { label: 'Compare oldest ↔ newest', icon: 'git-compare', run: () => compare(list[0], list[list.length - 1]) },
      '-',
      { label: 'Copy SHAs', icon: 'copy', run: () => post('copy', { text: list.join('\n') }) },
    ];
  }

  function commitMenu(c) {
    if (c.wip) {
      return [
        { header: 'Uncommitted changes' },
        { label: 'Stash changes…', icon: 'archive', run: () => post('stashSave') },
        { label: 'Create branch here…', icon: 'git-branch', run: () => post('createBranch', { from: 'HEAD' }) },
      ];
    }
    const cur = headName();
    const s = short(c.hash);
    const isMerge = c.parents.length > 1;
    return [
      { header: `${s} · ${c.subject.slice(0, 50)}` },
      { label: 'Create branch here…', icon: 'git-branch', run: () => post('createBranch', { from: c.hash }) },
      { label: 'Create worktree here…', icon: 'multiple-windows', run: () => post('addWorktree', { ref: c.hash }) },
      { label: 'Checkout (detached)', icon: 'check', run: () => post('checkout', { kind: 'commit', name: c.hash }) },
      { label: 'Tag…', icon: 'tag', run: () => post('tag', { sha: c.hash }) },
      '-',
      { label: `Merge into ${cur}…`, icon: 'git-merge', run: () => post('merge', { ref: c.hash }) },
      { label: `Rebase ${cur} onto here…`, icon: 'git-commit', run: () => post('rebase', { onto: c.hash }) },
      { label: 'Interactive rebase from here…', icon: 'git-commit', run: () => post('irebasePrepare', { sha: c.hash }) },
      { label: `Cherry-pick onto ${cur}`, icon: 'git-commit', run: () => post('cherryPick', { sha: c.hash, parents: c.parents }) },
      { label: 'Revert', icon: 'discard', run: () => post('revert', { sha: c.hash, parents: c.parents }) },
      ...(isMerge
        ? []
        : [
            { label: 'Split commit…', icon: 'edit', run: () => post('splitCommit', { sha: c.hash }) },
            { label: 'Fixup staged changes into this commit', icon: 'edit', run: () => post('fixupInto', { sha: c.hash }) },
          ]),
      { label: `Reset ${cur} to here…`, danger: true, icon: 'discard', run: () => post('reset', { sha: c.hash }) },
      '-',
      { label: 'Compare with HEAD', icon: 'git-compare', run: () => compare(c.hash, 'HEAD') },
      { label: 'Compare with working tree', icon: 'git-compare', run: () => compare(c.hash, null) },
      '-',
      { label: 'Copy SHA', icon: 'copy', run: () => post('copy', { text: c.hash }) },
      { label: 'Copy subject', icon: 'copy', run: () => post('copy', { text: c.subject }) },
    ];
  }

  function refMenu(kind, ds) {
    const cur = headName();
    const name = ds.name;
    if (kind === 'local') {
      const b = S.data.refs.local.find(x => x.name === name);
      const isHead = b?.isHead;
      return [
        { header: `branch ${name}${b?.upstream ? ` → ${b.upstream}` : ''}` },
        ...(isHead ? [] : [{ label: 'Checkout', icon: 'check', run: () => post('checkout', { kind: 'local', name }) }]),
        { label: 'Create branch from…', icon: 'git-branch', run: () => post('createBranch', { from: name }) },
        ...(isHead || b?.worktree ? [] : [{ label: 'Open in new worktree…', icon: 'multiple-windows', run: () => post('addWorktree', { branch: name }) }]),
        ...(isHead
          ? []
          : [
              '-',
              { label: `Merge into ${cur}…`, icon: 'git-merge', run: () => post('merge', { ref: name }) },
              { label: `Rebase ${cur} onto ${name}…`, icon: 'git-commit', run: () => post('rebase', { onto: name }) },
            ]),
        '-',
        { label: 'Push', icon: 'repo-push', run: () => post('pushBranch', { name }) },
        { label: 'Force push (with lease)…', danger: true, icon: 'repo-push', run: () => post('pushBranch', { name, force: true }) },
        ...(b?.upstream && !b.gone ? [{ label: `Fast-forward from ${b.upstream}`, icon: 'repo-pull', run: () => post('updateBranch', { name }) }] : []),
        { label: b?.upstream ? 'Change upstream…' : 'Set upstream…', icon: 'cloud', run: () => post('setUpstream', { name }) },
        ...(b?.upstream ? [{ label: 'Unset upstream', icon: 'cloud', run: () => post('unsetUpstream', { name }) }] : []),
        '-',
        ...(isHead ? [] : [{ label: `Compare with ${cur}`, icon: 'git-compare', run: () => compare(name, 'HEAD') }]),
        ...(b?.upstream && !b.gone ? [{ label: `Compare with ${b.upstream}`, icon: 'git-compare', run: () => compare(b.upstream, name) }] : []),
        { label: 'Compare with working tree', icon: 'git-compare', run: () => compare(name, null) },
        '-',
        { label: 'Rename…', icon: 'edit', run: () => post('renameBranch', { name }) },
        { label: 'Copy name', icon: 'copy', run: () => post('copy', { text: name }) },
        ...(isHead ? [] : [{ label: 'Delete…', danger: true, icon: 'trash', run: () => post('deleteBranch', { kind: 'local', name }) }]),
      ];
    }
    if (kind === 'remote') {
      return [
        { header: `remote branch ${name}` },
        { label: 'Checkout (track locally)', icon: 'check', run: () => post('checkout', { kind: 'remote', name, branch: ds.branch }) },
        { label: 'Create branch from…', icon: 'git-branch', run: () => post('createBranch', { from: name, suggest: ds.branch }) },
        '-',
        { label: `Merge into ${cur}…`, icon: 'git-merge', run: () => post('merge', { ref: name }) },
        { label: `Rebase ${cur} onto ${name}…`, icon: 'git-commit', run: () => post('rebase', { onto: name }) },
        '-',
        { label: `Compare with ${cur}`, icon: 'git-compare', run: () => compare(name, 'HEAD') },
        { label: 'Copy name', icon: 'copy', run: () => post('copy', { text: name }) },
        '-',
        { label: 'Delete on remote…', danger: true, icon: 'trash', run: () => post('deleteBranch', { kind: 'remote', name, remote: ds.remote, branch: ds.branch }) },
      ];
    }
    if (kind === 'tag') {
      return [
        { header: `tag ${name}` },
        { label: 'Checkout (detached)', icon: 'check', run: () => post('checkout', { kind: 'tag', name }) },
        { label: 'Create branch from…', icon: 'git-branch', run: () => post('createBranch', { from: name }) },
        { label: `Merge into ${cur}…`, icon: 'git-merge', run: () => post('merge', { ref: name }) },
        { label: `Compare with ${cur}`, icon: 'git-compare', run: () => compare(name, 'HEAD') },
        '-',
        { label: 'Push tag', icon: 'repo-push', run: () => post('pushTag', { name }) },
        { label: 'Copy name', icon: 'copy', run: () => post('copy', { text: name }) },
        '-',
        { label: 'Delete…', danger: true, icon: 'trash', run: () => post('deleteTag', { name }) },
      ];
    }
    if (kind === 'rtag') {
      return [
        { header: `tag ${name} (only on ${S.data.tagSync?.remote})` },
        { label: 'Fetch tag', icon: 'sync', run: () => post('fetchTag', { name }) },
        { label: 'Delete on remote…', danger: true, icon: 'trash', run: () => post('deleteTag', { name }) },
      ];
    }
    if (kind === 'stash') {
      const s = S.data.stashes[ds.idx];
      return [
        { header: s.ref },
        { label: 'Show changes', icon: 'go-to-file', run: () => post('stashDetails', s) },
        { label: 'Apply', icon: 'archive', run: () => post('stashApply', s) },
        { label: 'Pop', icon: 'archive', run: () => post('stashPop', s) },
        { label: 'Create branch from stash…', icon: 'git-branch', run: () => post('stashBranch', s) },
        '-',
        { label: 'Drop…', danger: true, icon: 'trash', run: () => post('stashDrop', s) },
      ];
    }
    if (kind === 'worktree') {
      const current = normPath(ds.path) === normPath(S.data.root);
      return [
        { header: ds.path },
        ...(current
          ? []
          : [
              { label: 'Open in new window', icon: 'multiple-windows', run: () => post('openWorktree', { path: ds.path, newWindow: true }) },
              { label: 'Open in this window', icon: 'multiple-windows', run: () => post('openWorktree', { path: ds.path }) },
            ]),
        { label: 'Reveal in file explorer', icon: 'go-to-file', run: () => post('revealWorktree', { path: ds.path }) },
        { label: 'Copy path', icon: 'copy', run: () => post('copy', { text: ds.path }) },
        ...(current
          ? []
          : [
              '-',
              { label: ds.locked ? 'Unlock' : 'Lock', icon: 'lock', run: () => post('lockWorktree', { path: ds.path, locked: !!ds.locked }) },
              { label: 'Remove…', danger: true, icon: 'trash', run: () => post('removeWorktree', { path: ds.path }) },
            ]),
      ];
    }
    return [];
  }

  function remoteMenu(name) {
    const info = S.data.refs.remoteInfo.find(r => r.name === name);
    return [
      { header: `remote ${name}` },
      { label: 'Fetch & prune', icon: 'sync', run: () => post('fetchRemote', { remote: name }) },
      { label: 'Prune stale remote branches', icon: 'sync', run: () => post('pruneRemote', { remote: name }) },
      '-',
      ...(info?.fetchUrl ? [{ label: 'Copy URL', icon: 'copy', run: () => post('copy', { text: info.fetchUrl }) }] : []),
      { label: 'Change URL…', icon: 'edit', run: () => post('setRemoteUrl', { remote: name }) },
      { label: 'Rename…', icon: 'edit', run: () => post('renameRemote', { remote: name }) },
      '-',
      { label: 'Remove…', danger: true, icon: 'trash', run: () => post('removeRemote', { remote: name }) },
    ];
  }

  function sectionMenu(id) {
    const d = S.data;
    switch (id) {
      case 'stack':
        return [
          { header: `Stack on ${d.base}` },
          { label: `Restack onto ${d.base} (rebase --update-refs)`, icon: 'git-commit', run: () => post('restack') },
          { label: 'Push stack (force with lease)…', icon: 'repo-push', run: () => post('pushStack') },
          '-',
          { label: 'Change base branch…', icon: 'edit', run: () => post('changeBase') },
        ];
      case 'local':
        return [
          { label: 'New branch from HEAD…', icon: 'git-branch', run: () => post('createBranch') },
          { label: 'Clean up branches…', icon: 'clear-all', run: () => post('cleanupBranches') },
          { label: `Change base branch (now ${d.base || 'none'})…`, icon: 'edit', run: () => post('changeBase') },
        ];
      case 'remote':
        return [
          { label: 'Add remote…', icon: 'add', run: () => post('addRemote') },
          { label: 'Fetch all & prune', icon: 'sync', run: () => post('fetch') },
        ];
      case 'tags':
        return [
          { label: d.tagSync ? `Re-compare with ${d.tagSync.remote}` : 'Compare with remote…', icon: 'sync', run: () => post('tagSync', d.tagSync ? { remote: d.tagSync.remote } : {}) },
          ...(d.tagSync ? [{ label: 'Hide comparison', icon: 'close', run: () => post('clearTagSync') }] : []),
          '-',
          { label: 'Fetch tags…', icon: 'sync', run: () => post('fetchTags') },
          { label: 'Push all tags…', icon: 'repo-push', run: () => post('pushAllTags') },
          '-',
          { label: 'Delete local tags missing on remote (prune)…', danger: true, icon: 'trash', run: () => post('pruneTags') },
        ];
      case 'worktrees':
        return [
          { label: 'Add worktree…', icon: 'multiple-windows', run: () => post('addWorktree') },
          { label: 'Prune stale worktrees', icon: 'sync', run: () => post('pruneWorktrees') },
        ];
      case 'stashes':
        return [{ label: 'Stash changes…', icon: 'archive', run: () => post('stashSave') }];
    }
    return [];
  }

  function fileMenu(ds) {
    return [
      { header: ds.path },
      { label: 'Open diff', icon: 'git-compare', run: () => post('openDiff', { path: ds.path, oldPath: ds.old || undefined, left: ds.left, right: ds.right || null }) },
      ...(ds.status !== 'D' ? [{ label: 'Open file', icon: 'go-to-file', run: () => post('openFile', { path: ds.path }) }] : []),
      { label: 'File history', icon: 'history', run: () => post('fileHistory', { path: ds.path }) },
      { label: 'Copy path', icon: 'copy', run: () => post('copy', { text: ds.path }) },
    ];
  }

  // ------------------------------------------------------------------ interactive rebase editor

  function openRebaseEditor(m) {
    // Commits arrive oldest-first, which is also git's todo order.
    let items = m.commits.map(c => ({ ...c, action: 'pick', message: c.subject }));
    const modal = $('#modal');

    const validate = () => {
      const firstKept = items.find(i => i.action !== 'drop');
      if (!firstKept) return 'Every commit is dropped. Use reset instead.';
      if (firstKept.action === 'squash' || firstKept.action === 'fixup') return `The first kept commit cannot be ${firstKept.action}: there is nothing before it to meld into.`;
      if (items.some(i => i.action === 'reword' && !i.message.trim())) return 'A reworded commit needs a message.';
      return '';
    };

    const draw = () => {
      const err = validate();
      modal.innerHTML = `<div class="dialog">
        <h2>Interactive rebase of ${esc(m.branch)} (${items.length} commit${items.length === 1 ? '' : 's'}) onto ${m.root ? 'root' : esc(short(m.base))}</h2>
        <div class="hint">Oldest at the top. Drag or use ▲▼ to reorder. squash/fixup meld into the commit above.</div>
        <div class="body">${items
          .map(
            (it, i) => `<div class="rb-row ${it.action}" draggable="true" data-i="${i}">
            <span class="rb-handle" title="Drag to reorder">⋮⋮</span>
            <span class="rb-move"><button data-up="${i}" ${i === 0 ? 'disabled' : ''}>▲</button><button data-down="${i}" ${i === items.length - 1 ? 'disabled' : ''}>▼</button></span>
            <select data-action="${i}">${['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'].map(a => `<option ${a === it.action ? 'selected' : ''}>${a}</option>`).join('')}</select>
            <span class="rb-sha" title="${it.hash}">${it.hash.slice(0, 7)}</span>
            <span class="rb-subject">${it.action === 'reword' ? `<textarea data-msg="${i}">${esc(it.message)}</textarea>` : esc(it.subject)}</span>
          </div>`
          )
          .join('')}</div>
        <div class="foot">
          <label class="check"><input type="checkbox" id="rbAutostash" checked> --autostash</label>
          <label class="check"><input type="checkbox" id="rbUpdateRefs"> --update-refs</label>
          <span class="error">${esc(err)}</span>
          <span class="spacer"></span>
          <button data-rb="cancel">Cancel</button>
          <button class="primary" data-rb="start" ${err ? 'disabled' : ''}>Start rebase</button>
        </div></div>`;
    };

    const move = (from, to) => {
      if (to < 0 || to >= items.length || from === to) return;
      const [it] = items.splice(from, 1);
      items.splice(to, 0, it);
      draw();
    };

    let dragFrom = -1;
    modal.onclick = e => {
      const t = e.target;
      if (t === modal || t.dataset.rb === 'cancel') return close();
      if (t.dataset.up !== undefined) move(+t.dataset.up, +t.dataset.up - 1);
      if (t.dataset.down !== undefined) move(+t.dataset.down, +t.dataset.down + 1);
      if (t.dataset.rb === 'start') {
        post('irebaseRun', {
          base: m.base,
          root: m.root,
          autostash: $('#rbAutostash').checked,
          updateRefs: $('#rbUpdateRefs').checked,
          items: items.map(i => ({ hash: i.hash, action: i.action, subject: i.subject, message: i.message })),
        });
        close();
      }
    };
    modal.onchange = e => {
      const t = e.target;
      if (t.dataset.action !== undefined) {
        items[+t.dataset.action].action = t.value;
        draw();
      }
    };
    modal.oninput = e => {
      const t = e.target;
      if (t.dataset.msg !== undefined) {
        items[+t.dataset.msg].message = t.value;
        const err = validate();
        modal.querySelector('.error').textContent = err;
        modal.querySelector('[data-rb=start]').disabled = !!err;
      }
    };
    modal.ondragstart = e => {
      const row = e.target.closest?.('.rb-row');
      if (!row) return;
      dragFrom = +row.dataset.i;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    };
    modal.ondragover = e => {
      const row = e.target.closest?.('.rb-row');
      if (!row) return;
      e.preventDefault();
      modal.querySelectorAll('.rb-row.over').forEach(r => r.classList.remove('over'));
      row.classList.add('over');
    };
    modal.ondrop = e => {
      const row = e.target.closest?.('.rb-row');
      if (!row || dragFrom < 0) return;
      e.preventDefault();
      move(dragFrom, +row.dataset.i);
      dragFrom = -1;
    };
    modal.ondragend = () => {
      dragFrom = -1;
      draw();
    };

    const close = () => {
      modal.hidden = true;
      modal.innerHTML = '';
    };
    draw();
    modal.hidden = false;
  }

  // ------------------------------------------------------------------ events

  document.addEventListener('click', e => {
    const t = e.target;
    const menu = $('#menu');
    if (!menu.hidden) {
      const mi = t.closest('.mi');
      hideMenu();
      if (mi) return menu._items[+mi.dataset.i].run();
      if (t.closest('#menu')) return;
    }

    // Hosting-service bits sit inside rows and sidebar items, so handle them first.
    const ciEl = t.closest('[data-ci]');
    if (ciEl) {
      const s = ciStatus(ciEl.dataset.ci);
      const withUrl = s?.checks.filter(c => c.url) || [];
      if (withUrl.length === 1 && s.checks.length === 1) return post('openExternal', { url: withUrl[0].url });
      const r = ciEl.getBoundingClientRect();
      return showMenu(r.left, r.bottom, ciMenu(ciEl.dataset.ci));
    }
    const prEl = t.closest('[data-pr]');
    if (prEl) {
      const p = prByNumber(prEl.dataset.pr);
      return p && post('openExternal', { url: p.url });
    }
    const urlEl = t.closest('[data-url]');
    if (urlEl) return post('openExternal', { url: urlEl.dataset.url });
    if (t.closest('[data-rawtoggle]')) {
      S.rawBody = !S.rawBody;
      persist();
      return rerenderCommit();
    }
    if (t.closest('[data-bodytoggle]')) {
      S.bodyExpanded = !S.bodyExpanded;
      return rerenderCommit();
    }
    const signIn = t.closest('[data-signin]');
    if (signIn) return post('signIn', { provider: signIn.dataset.signin });
    const setPat = t.closest('[data-setpat]');
    if (setPat) return post('setAzurePat', { org: setPat.dataset.setpat });
    const integ = t.closest('#integration');
    if (integ && S.integration?.signedIn) {
      const r = integ.getBoundingClientRect();
      return showMenu(r.left, r.bottom, integrationMenu());
    }

    const secMenu = t.closest('[data-secmenu]');
    if (secMenu) {
      const r = secMenu.getBoundingClientRect();
      return showMenu(r.left, r.bottom, sectionMenu(secMenu.dataset.secmenu));
    }

    const cmdBtn = t.closest('[data-cmd]');
    if (cmdBtn) return cmdBtn.dataset.cmd === 'openCommit' ? openCommit() : post(cmdBtn.dataset.cmd);

    if (t.closest('[data-commit]')) return commitNow();
    const wipBtn = t.closest('[data-wip]');
    if (wipBtn && S.details?.kind === 'wip') {
      const d = S.details;
      if (wipBtn.dataset.wip === 'discardAll') {
        const tracked = d.unstaged.filter(f => f.status !== 'U').map(f => f.path);
        const untracked = d.unstaged.filter(f => f.status === 'U').map(f => f.path);
        if (tracked.length) post('discard', { paths: tracked });
        if (untracked.length) post('discard', { paths: untracked, untracked: true });
        return;
      }
      return post(wipBtn.dataset.wip);
    }
    const fileAct = t.closest('[data-fileact]');
    if (fileAct) {
      const ds = fileAct.closest('li').dataset;
      const act = fileAct.dataset.fileact;
      if (act === 'open') return post('openFile', { path: ds.path });
      if (act === 'stage') return post('stage', { paths: [ds.path] });
      if (act === 'unstage') return post('unstage', { paths: [ds.path, ...(ds.old ? [ds.old] : [])] });
      if (act === 'discard') return post('discard', { paths: [ds.path], untracked: ds.status === 'U' });
      if (act === 'resolved') return post('markResolved', { path: ds.path });
    }

    if (t.closest('[data-clearquery]')) return post('search', {});

    const act = t.closest('[data-act]');
    if (act) return post(act.dataset.act, { path: act.dataset.path, side: act.dataset.side });

    if (t.dataset.copy) return post('copy', { text: t.dataset.copy });
    if (t.dataset.goto) return reveal(t.dataset.goto);
    if (t.dataset.stash && S.details?.stash) return post(t.dataset.stash, S.details.stash);
    if (t.dataset.swap && S.details?.kind === 'compare' && S.details.b) {
      const d = S.details;
      return post('compare', { a: d.b, b: d.a, aLabel: d.bLabel, bLabel: d.aLabel });
    }
    if (t.dataset.multi && S.details?.kind === 'multi') {
      const shas = S.details.shas;
      if (t.dataset.multi === 'compareEnds') return compare(shas[0], shas[shas.length - 1]);
      if (t.dataset.multi === 'copy') return post('copy', { text: shas.join('\n') });
      return post(t.dataset.multi, { shas });
    }
    if (t.dataset.rl) {
      const sha = t.closest('tr').dataset.sha;
      if (t.dataset.rl === 'show') return reveal(sha);
      if (t.dataset.rl === 'reset') return post('reset', { sha });
      if (t.dataset.rl === 'branch') return post('createBranch', { from: sha });
    }
    const gotoRow = t.closest('[data-goto-row]');
    if (gotoRow) return document.querySelector(`#graph tr[data-sha="${gotoRow.dataset.gotoRow}"]`)?.scrollIntoView({ block: 'center' });

    const file = t.closest('.files li[data-path]');
    if (file) {
      const ds = file.dataset;
      // Untracked and conflicted files have nothing meaningful to diff against.
      if (ds.status === 'U' || ds.status === '!') return post('openFile', { path: ds.path });
      return post('openDiff', { path: ds.path, oldPath: ds.old || undefined, left: ds.left, right: ds.right || null });
    }

    const secHead = t.closest('.sec-head');
    if (secHead) {
      const id = secHead.parentElement.dataset.section;
      S.collapsed[id] = !S.collapsed[id];
      secHead.parentElement.classList.toggle('collapsed', S.collapsed[id]);
      return persist();
    }

    const item = t.closest('.item');
    if (item) {
      if (item.dataset.ref === 'stash') return post('stashDetails', S.data.stashes[item.dataset.idx]);
      if (item.dataset.ref === 'rtag') return;
      if (item.dataset.sha) return reveal(item.dataset.sha);
      return;
    }

    const tr = t.closest('#graph tr[data-sha]');
    if (tr) {
      const sha = tr.dataset.sha;
      if (e.shiftKey && S.anchor && commitBySha(S.anchor)) {
        const [from, to] = [indexOf(S.anchor), +tr.dataset.i].sort((a, b) => a - b);
        S.multi = S.data.commits.slice(from, to + 1).map(c => c.hash).filter(h => h !== 'WIP' || from === to);
        S.selected = sha;
        return showMulti();
      }
      if (e.ctrlKey || e.metaKey) {
        S.multi = S.multi.includes(sha) ? S.multi.filter(x => x !== sha) : [...S.multi, sha];
        S.selected = sha;
        if (S.multi.length === 1) S.anchor = S.multi[0];
        return showMulti();
      }
      // Clicking the open commit again closes its details.
      if (S.inline?.commit.hash === sha && S.multi.length === 1 && S.selected === sha) {
        S.inline = null;
        return renderInline();
      }
      select(sha);
    }
  });

  document.addEventListener('dblclick', e => {
    const item = e.target.closest('.item');
    if (item?.dataset.ref === 'local') post('checkout', { kind: 'local', name: item.dataset.name });
    if (item?.dataset.ref === 'remote') post('checkout', { kind: 'remote', name: item.dataset.name, branch: item.dataset.branch });
    if (item?.dataset.ref === 'worktree' && normPath(item.dataset.path) !== normPath(S.data.root)) post('openWorktree', { path: item.dataset.path, newWindow: true });
    const badge = e.target.closest('.badge');
    if (badge?.dataset.badge === 'local') post('checkout', { kind: 'local', name: badge.dataset.name });
  });

  document.addEventListener('contextmenu', e => {
    const t = e.target;
    const badge = t.closest('.badge');
    const item = t.closest('.item');
    const group = t.closest('[data-remotegroup]');
    const secHead = t.closest('.sec-head');
    const file = t.closest('.files li[data-path]');
    const tr = t.closest('#graph tr[data-sha]');
    const prEl = t.closest('[data-pr]');
    const ciEl = t.closest('[data-ci]');
    let items = null;
    if (prEl) items = prMenu(prEl.dataset.pr);
    else if (ciEl) items = ciMenu(ciEl.dataset.ci);
    else if (t.closest('#integration') && S.integration?.signedIn) items = integrationMenu();
    else if (badge && badge.dataset.badge !== 'head') items = refMenu(badge.dataset.badge, badge.dataset);
    else if (item) items = refMenu(item.dataset.ref, item.dataset);
    else if (group) items = remoteMenu(group.dataset.remotegroup);
    else if (secHead) items = sectionMenu(secHead.parentElement.dataset.section);
    else if (file) items = fileMenu(file.dataset);
    else if (tr) {
      const sha = tr.dataset.sha;
      if (S.multi.length > 1 && S.multi.includes(sha)) items = multiMenu(S.multi);
      else {
        const c = commitBySha(sha);
        if (c) items = commitMenu(c);
      }
    }
    if (!items || !items.length) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, items);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      hideMenu();
      if (!$('#modal').hidden) {
        $('#modal').hidden = true;
        $('#modal').innerHTML = '';
      }
      return;
    }
    if (e.key === 'F5') {
      e.preventDefault();
      return post('refresh');
    }
    if (e.target.matches('input, textarea, select') || !S.data?.commits?.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = S.data.commits;
      let i = list.findIndex(c => c.hash === S.selected);
      i = e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
      const sha = list[i].hash;
      select(sha);
      document.querySelector(`#graph tr[data-sha="${sha}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  });

  window.addEventListener('blur', hideMenu);
  $('#graphWrap').addEventListener('scroll', hideMenu);

  $('#repo').addEventListener('change', e => post('selectRepo', { root: e.target.value }));
  $('#showAll').addEventListener('change', e => post('setShowAll', { value: e.target.checked }));

  // Search: "Filter loaded" dims rows live; any other mode (or Enter) searches the whole history.
  const searchKind = $('#searchKind');
  const filterInput = $('#filter');
  const placeholders = {
    '': 'Filter loaded commits… (Enter searches all history)',
    any: 'Message, author or file name… (Enter)',
    message: 'Commit message regex… (Enter)',
    author: 'Author name or email… (Enter)',
    pickaxe: 'Exact text added/removed… (Enter)',
    regex: 'Regex in changed lines… (Enter)',
    path: 'File/folder name or path… (Enter)',
  };
  const updatePlaceholder = () => (filterInput.placeholder = placeholders[searchKind.value]);
  updatePlaceholder();
  searchKind.addEventListener('change', () => {
    updatePlaceholder();
    applyFilter();
    filterInput.focus();
  });
  filterInput.addEventListener('input', e => {
    S.filter = e.target.value;
    applyFilter();
  });
  filterInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const value = filterInput.value.trim();
    if (!value) return post('search', {});
    const kind = searchKind.value || 'any';
    if (!searchKind.value) {
      searchKind.value = 'any';
      updatePlaceholder();
      S.filter = '';
      applyFilter();
    }
    post('search', { kind, value });
  });

  // Commit box (re-rendered with the details pane, so listen on the document).
  document.addEventListener('input', e => {
    if (e.target.id === 'commitMsg') S.commitMsg = e.target.value;
  });
  document.addEventListener('change', e => {
    const d = S.details;
    if (e.target.id === 'noVerify') S.noVerify = e.target.checked;
    if (e.target.id === 'amend' && d?.kind === 'wip') {
      S.amend = e.target.checked;
      if (S.amend && !(S.commitMsg || '').trim()) S.commitMsg = d.lastMessage;
      else if (!S.amend && S.commitMsg === d.lastMessage) S.commitMsg = '';
      renderDetails();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.target.id === 'commitMsg' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commitNow();
    }
  });

  $('#sideFilter').addEventListener('input', e => {
    S.sideFilter = e.target.value.trim().toLowerCase();
    if (S.data && !S.data.empty) renderSidebar();
  });

  // Layout: details beside the graph when the view is wide and short (bottom panel),
  // below it when tall (editor tab). The splitter resizes whichever applies.
  const rootStyle = document.documentElement.style;
  const applySizes = () => {
    rootStyle.setProperty('--details-w', `${S.detailsWidth}px`);
    rootStyle.setProperty('--details-h', `${S.detailsHeight}px`);
  };
  const updateLayout = () => {
    const stack = window.innerHeight > 520 && window.innerHeight > window.innerWidth * 0.55;
    document.body.classList.toggle('layout-stack', stack);
    S.detailsWidth = Math.min(S.detailsWidth, Math.max(240, window.innerWidth - 500));
    applySizes();
  };
  S.detailsWidth = saved.detailsWidth || 440;
  window.addEventListener('resize', updateLayout);
  updateLayout();

  $('#splitter').addEventListener('mousedown', e => {
    e.preventDefault();
    const vertical = document.body.classList.contains('layout-stack');
    const start = vertical ? e.clientY : e.clientX;
    const startSize = vertical ? S.detailsHeight : S.detailsWidth;
    const onMove = ev => {
      if (vertical) S.detailsHeight = Math.max(80, Math.min(window.innerHeight - 160, startSize - (ev.clientY - start)));
      else S.detailsWidth = Math.max(240, Math.min(window.innerWidth - 480, startSize - (ev.clientX - start)));
      applySizes();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persist();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  fillIcons();
  post('ready');
})();
