'use strict';
/* Projects: every folder Claude Code has worked in, and one detailed page per project: activity, sessions, tools,
   skills, files Claude changed, tasks, board, memory, CLAUDE.md, git, studies and its graphify graph. */

function heatmap(days, weeks = 26) {
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(end.getDate() - (weeks * 7 - 1) - end.getDay());
  const max = Math.max(1, ...Object.values(days || {}));
  let cells = '';
  for (let d = new Date(start), i = 0; d <= end; d.setDate(d.getDate() + 1), i++) {
    const k = d.toISOString().slice(0, 10), v = (days || {})[k] || 0;
    const lvl = v ? Math.min(4, 1 + Math.floor((v / max) * 3.999)) : 0;
    cells += `<i class="hm l${lvl}" style="grid-column:${Math.floor(i / 7) + 1};grid-row:${(i % 7) + 1}" title="${k}: ${v} message${v === 1 ? '' : 's'}"></i>`;
  }
  return `<div class="x-heat">${cells}</div>`;
}

function bars(rows, { max, fmt = v => v, color = 'var(--spade)' } = {}) {
  const top = max || Math.max(1, ...rows.map(r => r[1]));
  return `<div class="x-bars">${rows.map(([k, v]) => `<div class="x-bar"><span class="k" title="${esc(k)}">${esc(k)}</span><span class="t"><i style="width:${((v / top) * 100).toFixed(1)}%;background:${color}"></i></span><span class="v num">${esc(fmt(v))}</span></div>`).join('')}</div>`;
}

views.projects = {
  mount(el) {
    el.innerHTML = `<div class="view-head"><h1>Projects</h1><span class="sub" id="pj-sub"></span></div><div class="x-grid x-projects" id="pj-grid"><div class="empty">Loading…</div></div>`;
    this.load();
    this.timer = setInterval(() => this.load(), 15000);
  },
  unmount() { clearInterval(this.timer); },
  update() {},
  async load() {
    let list;
    try { list = await api('/api/projects'); } catch (e) { return; }
    if (!$('#pj-grid')) return;
    $('#pj-sub').textContent = `${list.length} folders Claude Code has worked in · $${list.reduce((a, p) => a + p.cost, 0).toFixed(2)} in equivalent API cost`;
    setHTML($('#pj-grid'), list.map(p => `<a class="x-card x-project tilt ${p.live ? 'is-live' : ''}" href="${projHref(p.key)}" style="--accent:${p.busy ? 'var(--dia)' : p.live ? 'var(--spade)' : 'var(--ink-3)'}">
        <div class="x-skill-top"><span class="x-glyph">${esc((p.name[0] || '?').toUpperCase())}</span><div class="x-skill-name"><b>${esc(p.name)}</b><span class="x-mono">${esc(shortPath(p.cwd || p.key))}</span></div>
          ${p.busy ? '<span class="chip run"><span class="pulse"></span>Working</span>' : p.live ? '<span class="chip claude">Open</span>' : ''}</div>
        ${heatmap(p.days, 18)}
        <div class="x-kpis"><div><b class="num">${p.prompts}</b><span>messages</span></div><div><b class="num">${p.toolCalls}</b><span>tool calls</span></div><div><b class="num">$${p.cost.toFixed(0)}</b><span>cost</span></div><div><b class="num">${p.sessions}</b><span>session${p.sessions > 1 ? 's' : ''}</span></div></div>
        <div class="x-skill-foot"><span class="sub">last active ${esc(ago(p.last))}</span>${p.graph ? '<span class="chip ok">graph</span>' : ''}${p.exists ? '' : '<span class="chip bad">folder gone</span>'}</div></a>`).join('') || '<div class="empty">No projects yet.</div>');
  },
};

const PTABS = [['overview', 'Overview'], ['sessions', 'Sessions'], ['files', 'Files changed'], ['graph', 'Graph'], ['code', 'Code'], ['memory', 'Memory & notes'], ['study', 'Study']];
views.project = {
  key: () => 'project',
  mount(el, args, query) {
    this.key = query.get('key');
    this.tab = query.get('tab') || 'overview';
    el.innerHTML = `<div id="pd"><div class="empty">Loading project…</div></div>`;
    this.load();
    this.timer = setInterval(() => { if (this.tab === 'overview' || this.tab === 'sessions') this.load(); }, 15000);
  },
  route(args, query) { this.key = query.get('key'); this.tab = query.get('tab') || 'overview'; this.load(); },
  unmount() { clearInterval(this.timer); if (this.graph) this.graph.destroy(); this.graph = null; },
  update() {},
  async load() {
    try { this.d = await api('/api/project?key=' + encodeURIComponent(this.key)); } catch (e) { $('#pd').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    this.render();
  },
  render() {
    const d = this.d, el = $('#pd'); if (!el || !d) return;
    if (!el.dataset.k || el.dataset.k !== d.key) {
      el.dataset.k = d.key;
      el.innerHTML = `<div class="x-hero x-panel"><div class="x-hero-main"><div class="x-eyebrow">Project</div><h1>${esc(d.name)}</h1><div class="x-mono sub">${esc(d.cwd || '')}</div>
          <div class="tools" style="margin-top:12px" id="pd-tools"></div></div><div class="x-hero-kpis" id="pd-kpis"></div></div>
        <nav class="x-tabs" id="pd-tabs">${PTABS.map(([k, l]) => `<a href="${projHref(d.key)}&tab=${k}" data-tab="${k}">${l}</a>`).join('')}</nav><div id="pd-body"></div>`;
    }
    $$('#pd-tabs a').forEach(a => a.setAttribute('aria-current', a.dataset.tab === this.tab ? 'page' : 'false'));
    setHTML($('#pd-tools'), `${d.busy ? '<span class="chip run"><span class="pulse"></span>Claude is working</span>' : d.live ? '<span class="chip claude">Session open</span>' : `<span class="chip">Last active ${esc(ago(d.last))}</span>`}
      ${d.git ? `<span class="chip">⎇ ${esc(d.git.branch)}${d.git.changed ? ` · ${d.git.changed} changed` : ''}</span>` : ''}
      ${Object.keys(d.models).map(m => `<span class="chip claude">${esc(m)}</span>`).join('')}
      ${d.cwd ? '<button class="btn" type="button" data-pa="vscode">Open in VS Code</button>' : ''}
      <button class="btn" type="button" data-pa="chat">New chat here</button>`);
    setHTML($('#pd-kpis'), [['messages', d.prompts], ['tool calls', d.toolCalls], ['cost', '$' + d.cost.toFixed(2)], ['sessions', d.sessions], ['files changed', d.files.length], ['transcripts', d.sizeMB + ' MB']]
      .map(([k, v]) => `<div><b class="num">${esc(v)}</b><span>${k}</span></div>`).join(''));
    $('#pd-tools').onclick = e => {
      const b = e.target.closest('[data-pa]'); if (!b) return;
      if (b.dataset.pa === 'vscode') api('/api/open', { method: 'POST', body: { path: d.cwd } }).then(() => toast('Opening in VS Code')).catch(err => toast(err.message));
      if (b.dataset.pa === 'chat') newChat(d.cwd);
    };
    const body = $('#pd-body');
    if (this.graph && this.tab !== 'graph') { this.graph.destroy(); this.graph = null; }
    if (this.tab === 'overview') setHTML(body, this.overview(d));
    else if (this.tab === 'sessions') setHTML(body, `<div class="sessions">${d.sessionsList.map(sessionRow).join('')}</div>`);
    else if (this.tab === 'files') setHTML(body, this.files(d));
    else if (this.tab === 'memory') setHTML(body, this.memory(d));
    else if (this.tab === 'graph') this.graphTab(body, d);
    else if (this.tab === 'code') { if (body.dataset.t !== 'code') { body.dataset.t = 'code'; body._html = null; body.innerHTML = '<div id="pd-code"></div>'; codeBrowser($('#pd-code'), d.cwd); } return; }
    else if (this.tab === 'study') { if (body.dataset.t !== 'study') { body.dataset.t = 'study'; body._html = null; body.innerHTML = '<div id="pd-study"></div>'; studyPanel($('#pd-study'), d.cwd); } return; }
    body.dataset.t = this.tab;
  },
  overview(d) {
    const tt = d.taskTotals;
    return `<div class="grid-2"><div>
        <section><div class="section-head"><h2>Activity</h2><span class="sub">messages you sent, by day</span></div><div class="x-panel x-pad">${heatmap(d.days, 40)}</div></section>
        <section><div class="section-head"><h2>Tools Claude used</h2></div><div class="x-panel x-pad">${bars(d.tools.slice(0, 14))}</div></section>
        <section><div class="section-head"><h2>Recently changed files</h2><a href="${projHref(d.key)}&tab=files">All</a></div>${this.fileRows(d.files.slice(0, 8), d)}</section>
      </div><div>
        <section><div class="section-head"><h2>Skills used here</h2></div>${d.skills.length ? `<div class="x-panel x-pad">${bars(d.skills.map(([k, v]) => [k, v.uses]), { color: 'var(--you)' })}</div>` : '<div class="empty">No skills used in this project yet.</div>'}</section>
        <section><div class="section-head"><h2>Tasks</h2></div><div class="tools">${Object.entries(tt).map(([k, v]) => `${statusChip(k)}<span class="num">${v}</span>`).join(' ') || '<span class="sub">none</span>'}</div>
          <div class="strips" style="margin-top:10px">${d.tasks.slice(0, 5).map(t => `<div class="x-row"><b>${esc(t.description || t.id)}</b><span class="sub">${esc(kindLabel(t))} · ${esc(STATUS_LABEL[t.status] || t.status)} · ${esc(ago(t.startedAt))}</span></div>`).join('')}</div></section>
        <section><div class="section-head"><h2>Board</h2><a href="#/board">Board</a></div>${d.board.length ? d.board.filter(i => i.status !== 'done').slice(0, 8).map(i => `<div class="x-row"><b>${esc(i.title)}</b><span class="sub">${esc(i.status)} · ${esc(ago(i.updatedAt))}</span></div>`).join('') || '<div class="sub">Everything on the board is done.</div>' : '<div class="empty">No board items for this project.</div>'}</section>
        ${d.git ? `<section><div class="section-head"><h2>Git</h2><span class="sub">${esc(d.git.branch)}</span></div>${d.git.log.map(c => `<div class="x-row"><b class="x-mono">${esc(c.h)}</b><span>${esc(c.s)}</span><span class="sub">${esc(ago(c.d))}</span></div>`).join('')}</section>` : ''}
        ${d.artifacts.length ? `<section><div class="section-head"><h2>Artifacts</h2></div>${d.artifacts.slice(0, 8).map(a => `<div class="art"><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a><span class="sub">${esc(ago(a.ts))}</span></div>`).join('')}</section>` : ''}
      </div></div>`;
  },
  fileRows(files, d) {
    return files.length ? `<div class="x-list">${files.map(f => `<a class="x-row" href="#/code?path=${encodeURIComponent(f.file)}"><b class="x-mono">${esc(d.cwd && f.inside ? f.file.slice(d.cwd.length + 1) : shortPath(f.file))}</b>
      <span class="sub">${f.edits ? `${f.edits} edit${f.edits > 1 ? 's' : ''}` : ''}${f.edits && f.writes ? ' · ' : ''}${f.writes ? `${f.writes} write${f.writes > 1 ? 's' : ''}` : ''} · ${esc(ago(f.last))}</span></a>`).join('')}</div>` : '<div class="empty">Claude has not changed files here yet.</div>';
  },
  files(d) { return `<section><div class="section-head"><h2>Files Claude changed</h2><span class="sub">${d.files.length} files, newest first · click to open in the code view</span></div>${this.fileRows(d.files, d)}</section>`; },
  memory(d) {
    return `<div class="grid-2"><div><section><div class="section-head"><h2>Claude's memory for this project</h2><span class="sub">${d.memory.length} notes</span></div>
        ${d.memory.length ? d.memory.map(m => `<details class="plan x-panel" ${m.name === 'MEMORY.md' ? 'open' : ''}><summary>${esc(m.name)}</summary><div class="bubble" style="margin-top:8px">${md(m.text || '')}</div></details>`).join('') : '<div class="empty">No memory files.</div>'}</section></div>
      <div><section><div class="section-head"><h2>CLAUDE.md</h2></div>${d.claudeMd ? `<div class="bubble x-panel x-pad">${md(d.claudeMd)}</div>` : '<div class="empty">No CLAUDE.md in this folder.</div>'}</section>
        <section><div class="section-head"><h2>README</h2></div>${d.readme ? `<div class="bubble x-panel x-pad" style="max-height:520px;overflow:auto">${md(d.readme)}</div>` : '<div class="empty">No README.md.</div>'}</section></div></div>`;
  },
  async graphTab(body, d) {
    if (body.dataset.t === 'graph') return;
    body.dataset.t = 'graph'; body._html = null;
    if (!d.graph) {
      body.innerHTML = `<div class="empty x-pad"><h2>No graphify graph yet</h2><p>graphify turns this folder into a knowledge graph (code, docs, papers) with communities of related parts.
        Build it here: Claude runs the graphify skill in this folder with permission to run commands, and writes only to <code>graphify-out/</code>.</p>
        <div class="tools"><button class="btn primary" type="button" id="g-build">Build the graph with Claude</button><button class="btn" type="button" id="g-copy">Copy the command instead</button></div><div id="g-run" style="margin-top:14px"></div></div>`;
      $('#g-copy').onclick = () => copy(`cd "${d.cwd}" && claude "/graphify ."`, 'Command copied');
      $('#g-build').onclick = async () => {
        if (!confirm('Claude will run graphify in this folder and may install its Python package. Continue?')) return;
        try { const r = await api('/api/runs', { method: 'POST', body: { kind: 'graph', cwd: d.cwd, model: 'sonnet' } }); runView($('#g-run'), r.id, { onDone: () => { body.dataset.t = ''; this.load(); } }); } catch (e) { toast(e.message); }
      };
      return;
    }
    body.innerHTML = `<div class="x-graph-wrap"><div class="x-graph x-panel"><canvas id="g-canvas"></canvas>
        <div class="x-graph-hud"><div class="x-eyebrow" id="g-crumb">Communities</div><div id="g-hover" class="sub"></div></div>
        <div class="x-graph-tools tools"><button class="btn" type="button" id="g-back" hidden>← All communities</button><button class="btn" type="button" id="g-fit">Fit</button></div></div>
      <aside class="x-graph-side x-panel" id="g-side"><div class="x-thinking"><i></i><i></i><i></i> Loading graph…</div></aside></div>`;
    let ov;
    try { ov = await api('/api/graph?root=' + encodeURIComponent(d.graph.root)); } catch (e) { $('#g-side').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const pal = ['--spade', '--you', '--dia', '--club', '--heart'].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
    const colorOf = id => pal[Math.abs(Number(id)) % pal.length];
    const side = $('#g-side');
    const showOverview = () => {
      if (this.graph) this.graph.destroy();
      $('#g-back').hidden = true; $('#g-crumb').textContent = `${ov.communities} communities · ${ov.nodes} nodes · ${ov.links} links`;
      this.graph = forceGraph($('#g-canvas'), { nodes: ov.map.map(c => ({ ...c })), links: ov.edges, keepPerNode: 3, labels: 20, color: n => colorOf(n.id), size: n => 4 + Math.sqrt(n.size) * 1.6, label: n => n.name,
        onHover: n => { $('#g-hover').textContent = n ? `${n.name} · ${n.size} nodes · ${n.hubs.slice(0, 3).join(', ')}` : 'Hover a community; click to open it.'; },
        onPick: n => openCommunity(n.id) });
      side.innerHTML = `<div class="x-eyebrow">graphify · built ${esc(ago(ov.mtime))}</div><h2>Biggest communities</h2>
        <div class="x-list">${ov.map.slice(0, 24).map(c => `<button type="button" class="x-row" data-c="${c.id}"><b><i class="x-sw" style="background:${colorOf(c.id)}"></i>${esc(c.name)}</b><span class="sub">${c.size} nodes · ${esc(c.hubs.slice(0, 2).join(', '))}</span></button>`).join('')}</div>
        ${ov.hyperedges.length ? `<h3>Pipelines</h3>${ov.hyperedges.map(h => `<div class="x-row"><b>${esc(h.label)}</b><span class="sub">${h.n} parts</span></div>`).join('')}` : ''}
        ${ov.report ? `<details class="plan" style="margin-top:12px"><summary>GRAPH_REPORT.md</summary><div class="bubble">${md(ov.report.slice(0, 20000))}</div></details>` : ''}`;
    };
    const openCommunity = async id => {
      let c;
      try { c = await api(`/api/graph?root=${encodeURIComponent(d.graph.root)}&c=${encodeURIComponent(id)}`); } catch (e) { toast(e.message); return; }
      if (this.graph) this.graph.destroy();
      $('#g-back').hidden = false; $('#g-crumb').textContent = `${c.name} · ${c.size} nodes${c.nodes.length < c.size ? ` (top ${c.nodes.length} shown)` : ''}`;
      const types = [...new Set(c.nodes.map(n => n.type))];
      this.graph = forceGraph($('#g-canvas'), { nodes: c.nodes, links: c.links, keepPerNode: 4, labels: 30, color: n => pal[types.indexOf(n.type) % pal.length], size: n => 3 + Math.sqrt(n.deg) * 1.4, label: n => n.label,
        onHover: n => { $('#g-hover').textContent = n ? `${n.label} · ${n.type} · ${n.file}${n.loc ? ':' + n.loc : ''}` : ''; },
        onPick: n => { if (n.file) location.hash = `#/code?path=${encodeURIComponent((d.graph.root + '\\' + n.file).replace(/\//g, '\\'))}`; } });
      side.innerHTML = `<div class="x-eyebrow">Community</div><h2>${esc(c.name)}</h2><p class="sub">Click a node to open its file. Types: ${types.map((t, i) => `<i class="x-sw" style="background:${pal[i % pal.length]}"></i>${esc(t || 'other')}`).join(' ')}</p>
        <h3>Most connected</h3><div class="x-list">${c.nodes.slice(0, 18).map(n => `<a class="x-row" href="#/code?path=${encodeURIComponent((d.graph.root + '\\' + n.file).replace(/\//g, '\\'))}"><b>${esc(n.label)}</b><span class="sub x-mono">${esc(n.file)}${n.loc ? ':' + esc(n.loc) : ''} · ${n.deg} links</span></a>`).join('')}</div>
        <h3>Talks most to</h3><div class="x-list">${c.neighbours.map(x => `<button type="button" class="x-row" data-c="${x.id}"><b><i class="x-sw" style="background:${colorOf(x.id)}"></i>${esc(x.name)}</b><span class="sub">${x.w} links</span></button>`).join('')}</div>`;
    };
    side.onclick = e => { const b = e.target.closest('[data-c]'); if (b) openCommunity(b.dataset.c); };
    $('#g-back').onclick = showOverview;
    $('#g-fit').onclick = () => this.graph && this.graph.fit();
    showOverview();
  },
};

function newChat(cwd) {
  const m = modal(`<div class="x-eyebrow">New conversation</div><h2 class="x-title">Ask Claude in ${esc(shortPath(cwd))}</h2>
    <form id="nc" class="x-form"><textarea class="field" name="text" rows="4" required placeholder="What should Claude do?"></textarea>
      <div class="tools"><label class="x-check"><input type="checkbox" name="edits"> Let Claude edit files (no commands)</label>
        <select class="field" name="model"><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select><button class="btn primary" type="submit">Start</button></div></form><div id="nc-run"></div>`, { wide: true });
  m.el.querySelector('#nc').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/api/runs', { method: 'POST', body: { kind: 'new-chat', cwd, text: f.text, allowEdits: !!f.edits, model: f.model } });
      e.target.hidden = true;
      runView(m.el.querySelector('#nc-run'), r.id, { onDone: x => { if (x.sessionId) m.el.querySelector('#nc-run').insertAdjacentHTML('beforeend', `<p><a class="btn" href="#/chats/${encodeURIComponent(x.sessionId)}">Open the conversation</a></p>`); } });
    } catch (err) { toast(err.message); }
  });
}
