'use strict';
/* Codex: Anchor in OpenAI's coding agent. Setup state, Codex's own usage and limit windows, and the skill bridge: every
   Claude skill with an honest verdict (works as-is, adapted, Claude-only), one click to send it to Codex, and a finder
   for well-known skills (caveman, superpowers, Anthropic's...) that installs to Claude, Codex or both after a scan. */

const VERDICT = {
  works: { label: 'Works as-is', cls: 'ok' },
  adapted: { label: 'Adapted', cls: '' },
  'claude-only': { label: 'Claude-only', cls: 'bad' },
};
const fmtK = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0);

views.codex = {
  filter: 'all',
  mount(el) {
    el.innerHTML = `<div class="x-panel x-trash-hero"><div><div class="x-eyebrow">Codex</div><h1 id="cx-title">Anchor in Codex</h1>
        <p class="sub" id="cx-sub">The same token saver, Guard, skill hints and board in OpenAI's Codex, and your Claude skills brought along.</p>
        <div class="x-cx-steps" id="cx-steps"></div>
        <div class="tools" style="margin-top:12px"><button class="btn primary" type="button" id="cx-setup">Set up Codex</button>
          <button class="btn" type="button" id="cx-refresh">Refresh</button></div>
        <pre class="x-fileview" id="cx-out" hidden></pre></div>
        <div class="x-hero-kpis" id="cx-kpis"></div></div>
      <section><div class="section-head"><h2>Skill bridge</h2><span class="sub">Claude skills, checked for Codex. Sending one copies it to ~/.agents/skills with Claude's tools mapped to Codex's; the original stays as it is.</span></div>
        <div class="tools" style="margin-bottom:10px"><div class="seg" id="cx-filter" role="group" aria-label="Filter">
          ${[['all', 'All'], ['works', 'Works as-is'], ['adapted', 'Adapted'], ['claude-only', 'Claude-only'], ['in', 'In Codex']].map(([k, v]) => `<button type="button" class="btn" data-f="${k}" aria-pressed="${k === 'all'}">${v}</button>`).join('')}</div>
          <input class="field" id="cx-q" placeholder="Filter skills" style="flex:1;min-width:160px">
          <button class="btn primary" type="button" id="cx-send" disabled>Send selected to Codex</button>
          <button class="btn" type="button" id="cx-sync" title="Re-port skills whose Claude source changed">Sync</button></div>
        <div id="cx-list" class="x-list"></div></section>
      <section><div class="section-head"><h2>Find skills</h2><span class="sub">Well-known collections and a GitHub search. Each one is downloaded into quarantine and scanned before you choose Claude, Codex or both.</span></div>
        <div class="tools"><input class="field" id="cx-find" placeholder="caveman, pdf, playwright, science…" style="flex:1"><button class="btn" type="button" id="cx-go">Search</button></div>
        <div id="cx-found" class="x-cx-found"></div></section>
      <section><div class="section-head"><h2>Recent Codex sessions</h2><span class="sub">From ~/.codex/sessions; nothing leaves this computer.</span></div>
        <div id="cx-sessions" class="x-list"></div></section>`;
    $('#cx-refresh').onclick = () => this.load();
    $('#cx-setup').onclick = async e => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Setting up…';
      try { const r = await api('/api/codex/setup', { method: 'POST', body: {} }); const o = $('#cx-out'); o.hidden = false; o.textContent = r.out; toast(r.ok ? 'Codex is set up' : 'Setup stopped; see the output'); }
      catch (err) { toast(err.message); }
      b.disabled = false; b.textContent = 'Set up Codex'; this.load();
    };
    $('#cx-filter').onclick = e => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      this.filter = b.dataset.f;
      for (const x of $('#cx-filter').children) x.setAttribute('aria-pressed', x === b);
      this.render();
    };
    $('#cx-q').addEventListener('input', () => this.render());
    $('#cx-list').addEventListener('change', () => { $('#cx-send').disabled = !$('#cx-list').querySelector('input[data-pick]:checked'); });
    $('#cx-list').addEventListener('click', async e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const { act, id, name } = b.dataset;
      if (act === 'force' && !b.classList.contains('armed')) { b.classList.add('armed', 'danger'); b.textContent = 'It may not work. Send anyway?'; return; }
      b.disabled = true;
      try {
        if (act === 'send' || act === 'force' || act === 'update') await this.send([id], act === 'force');
        if (act === 'remove') { await api('/api/codex/unport', { method: 'POST', body: { name } }); toast(`Removed $${name} from Codex`); }
        if (act === 'view') { const s = (SKD && SKD.skills || []).find(x => x.id === id); if (s) skillDetail(s); b.disabled = false; return; }
      } catch (err) { toast(err.message); }
      this.load();
    });
    $('#cx-send').onclick = async () => {
      const ids = [...$('#cx-list').querySelectorAll('input[data-pick]:checked')].map(x => x.dataset.pick);
      if (ids.length) { await this.send(ids, false); this.load(); }
    };
    $('#cx-sync').onclick = async () => {
      try { const r = await api('/api/codex/sync', { method: 'POST', body: {} }); toast(`${r.updated.length} updated, ${r.same.length} unchanged${r.missing.length ? `, ${r.missing.length} without a source` : ''}`); } catch (err) { toast(err.message); }
      this.load();
    };
    const find = () => this.find($('#cx-find').value.trim());
    $('#cx-go').onclick = find; $('#cx-find').addEventListener('keydown', e => { if (e.key === 'Enter') find(); });
    $('#cx-found').addEventListener('click', e => { const b = e.target.closest('[data-repo]'); if (b) inspectRepo(b.dataset.repo, '', 'both'); });
    this.load(); this.find('');
    if (!SKD) loadSkills().catch(() => {});
  },
  update() {},
  async send(ids, force) {
    try {
      const r = await api('/api/codex/port', { method: 'POST', body: { ids, force } });
      const ok = r.done.map(d => d.call).join(' ');
      toast(r.failed.length ? `${r.done.length ? `In Codex: ${ok}. ` : ''}Not sent: ${r.failed[0].id}: ${r.failed[0].error}` : `In Codex: ${ok}`);
    } catch (err) { toast(err.message); }
  },
  async load() {
    try { this.d = await api('/api/codex'); } catch (err) { toast(err.message); return; }
    this.render();
  },
  async find(q) {
    const el = $('#cx-found');
    if (q) el.innerHTML = '<div class="x-thinking"><i></i><i></i><i></i> Searching GitHub…</div>';
    let r;
    try { r = await api('/api/skilldir?q=' + encodeURIComponent(q)); } catch (err) { setHTML(el, `<div class="empty">${esc(err.message)}</div>`); return; }
    const card = (x, known) => `<div class="x-panel x-cx-card"><div class="x-eyebrow">${known ? 'Well known' : `★ ${fmtK(x.stars || 0)}`}${x.licence ? ` · ${esc(x.licence)}` : ''}</div>
        <b class="x-mono">${esc(x.repo)}</b><p class="sub">${esc(x.what || 'No description')}</p>
        <div class="tools"><button class="btn primary" type="button" data-repo="${esc(x.url)}">Inspect and install</button></div></div>`;
    setHTML(el, [...r.known.map(x => card(x, true)), ...r.found.map(x => card(x, false))].join('') || '<div class="empty">Nothing found. Try another word, or paste a GitHub URL on the Skills page.</div>');
  },
  render() {
    const d = this.d; if (!d) return;
    const s = d.status, u = d.usage;
    const step = (ok, text, hint) => `<div class="x-cx-step ${ok ? 'ok' : ''}"><i>${ok ? '✓' : '·'}</i><span>${text}${!ok && hint ? ` <span class="sub">${hint}</span>` : ''}</span></div>`;
    setHTML($('#cx-steps'), [
      step(s.installed, s.installed ? `Codex ${esc(s.version)}` : 'Codex is not installed', '<code>npm i -g @openai/codex</code>'),
      step(s.loggedIn, 'Signed in', '<code>codex login</code> in a terminal'),
      step(s.pluginEnabled, 'Anchor plugin in Codex: hooks, skills', 'Set up Codex below'),
      step(s.hooksFeature, 'Hooks on. Approve Anchor\'s hooks once with <code>/hooks</code> inside Codex'),
      step(s.agentsNote, 'Board note in ~/.codex/AGENTS.md', 'Set up Codex below'),
    ].join(''));
    const ready = s.installed && s.pluginEnabled && s.agentsNote;
    $('#cx-title').textContent = !s.installed ? 'Codex is not installed' : ready ? 'Anchor is running in Codex' : 'Anchor is almost ready in Codex';
    $('#cx-setup').textContent = ready ? 'Update Codex setup' : 'Set up Codex';
    $('#cx-setup').disabled = !s.installed;
    const p = u.limits && u.limits.primary, w = u.limits && u.limits.secondary;
    setHTML($('#cx-kpis'), [[fmtK(u.tokens), `tokens · ${u.days} days`], [p && p.pct != null ? `${p.pct}%` : '–', `short window${p && p.resetAt ? ` · resets ${ago(p.resetAt).replace(' ago', '')}` : ''}`],
      [w && w.pct != null ? `${w.pct}%` : '–', 'week'], [d.ported.length, 'skills ported']]
      .map(([v, k]) => `<div><b class="num">${v}</b><span>${k}</span></div>`).join(''));
    // the bridge list
    const q = ($('#cx-q').value || '').toLowerCase();
    const list = d.bridge.filter(x => (this.filter === 'all' || (this.filter === 'in' ? x.inCodex : x.verdict === this.filter))
      && (!q || `${x.id} ${x.description}`.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.inCodex) - Number(a.inCodex) || ['works', 'adapted', 'claude-only'].indexOf(a.verdict) - ['works', 'adapted', 'claude-only'].indexOf(b.verdict) || a.id.localeCompare(b.id));
    setHTML($('#cx-list'), list.length ? list.map(x => {
      const v = VERDICT[x.verdict];
      const native = x.inCodex && !x.ported;
      const act = x.ported
        ? `${x.ported.stale ? `<button class="btn primary" type="button" data-act="update" data-id="${esc(x.id)}">Update</button>` : ''}<button class="btn" type="button" data-act="remove" data-name="${esc(x.ported.name)}">Remove from Codex</button>`
        : native ? '<span class="chip ok">In Codex natively</span>'
          : x.verdict === 'claude-only' ? `<button class="btn" type="button" data-act="force" data-id="${esc(x.id)}">Send anyway</button>`
            : `<button class="btn primary" type="button" data-act="send" data-id="${esc(x.id)}">Send to Codex</button>`;
      return `<div class="x-row x-cx-row">
        ${!x.ported && !native && x.verdict !== 'claude-only' ? `<input type="checkbox" data-pick="${esc(x.id)}" aria-label="Select ${esc(x.id)}">` : '<span class="x-cx-pad"></span>'}
        <div class="x-trash-main"><b><button class="linklike" type="button" data-act="view" data-id="${esc(x.id)}">${esc(x.id)}</button></b>
          <span class="sub">${esc(String(x.description || '').slice(0, 160))}</span>
          <span class="sub"><span class="chip ${v.cls}">${v.label}</span> ${esc(x.why)}${x.ported ? ` · in Codex as <code>$${esc(x.ported.name)}</code>${x.ported.stale ? ' · <b>source changed</b>' : ''}` : ''}</span></div>
        <div class="tools">${act}</div></div>`;
    }).join('') : '<div class="empty">No skills match.</div>');
    $('#cx-send').disabled = !$('#cx-list').querySelector('input[data-pick]:checked');
    setHTML($('#cx-sessions'), u.recent.length ? u.recent.map(r => `<div class="x-row"><div class="x-trash-main"><b>${esc(r.project || 'Codex session')}</b>
        <span class="sub">${esc((r.firstPrompt || '').replace(/\s+/g, ' ').slice(0, 140) || 'No prompt yet')}</span>
        <span class="sub">${fmtK(r.total)} tokens · context ${fmtK(r.context)}${r.window ? ` of ${fmtK(r.window)}` : ''} · ${r.model ? esc(r.model) + ' · ' : ''}${esc(ago(r.last))}</span></div></div>`).join('')
      : '<div class="empty">No Codex sessions in the last week yet.</div>');
  },
};
