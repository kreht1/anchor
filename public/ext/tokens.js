'use strict';
/* Tokens: where the tokens of the last days went (read from Claude Code's own transcripts on this computer) and what to
   change, biggest saving first; plus the token saver switch. Nothing is sent anywhere. */

const tkFmt = n => (n == null ? '–' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));
const tkBase = p => String(p || '').split(/[\\/]/).pop();

views.tokens = {
  days: 7,
  mount(el) {
    el.innerHTML = `
      <div class="x-hero x-panel"><div><div class="x-eyebrow">Token saver</div><h1>Tokens</h1>
        <p class="sub" style="max-width:62ch">Where your tokens went, from Claude Code's own transcripts on this computer, and what to change, biggest saving first.</p></div>
        <div style="display:grid;gap:10px;justify-items:end">
          <div style="display:flex;gap:10px;align-items:center"><span class="sub">Token saver</span><button class="x-switch" id="tk-saver" type="button" role="switch" aria-checked="true" title="Lean session note, working habits for Claude, stricter skill hints"><i></i></button></div>
          <div id="tk-days" style="display:flex;gap:6px">${[1, 7, 30].map(d => `<button type="button" class="btn" data-days="${d}" aria-pressed="${d === this.days}">${d === 1 ? 'Today' : `${d} days`}</button>`).join('')}</div>
        </div></div>
      <div id="tk-body"><div class="x-thinking"><i></i><i></i><i></i> Reading your transcripts…</div></div>
      <div id="tk-gov"></div>`;
    const sw = $('#tk-saver');
    api('/api/settings').then(st => sw.setAttribute('aria-checked', st.tokenSaver)).catch(() => {});
    sw.onclick = async () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      try { const st = await api('/api/settings', { method: 'POST', body: { tokenSaver: on } }); sw.setAttribute('aria-checked', st.tokenSaver);
        toast(st.tokenSaver ? 'Token saver on: new sessions work lean and get only clear skill hints' : 'Token saver off'); } catch (e) { toast(e.message); }
    };
    $('#tk-days').onclick = e => { const b = e.target.closest('[data-days]'); if (!b) return; this.days = Number(b.dataset.days);
      $$('#tk-days [data-days]').forEach(x => x.setAttribute('aria-pressed', x === b)); this.load(); };
    this.load();
    this.loadGov();
  },
  unmount() { clearTimeout(this.poll); },
  update() {},
  // the governor, lean start and the ranked token tools (Anchor 3)
  async loadGov() {
    const box = $('#tk-gov'); if (!box) return;
    let st = {}, lean = null, cat = [];
    try { [st, lean, cat] = await Promise.all([api('/api/settings'), api('/api/lean').catch(() => null), api('/api/catalog').catch(() => [])]); } catch { return; }
    if (!$('#tk-gov')) return;
    const act = t => t.installable
      ? (t.job ? `<span class="sub">${esc(t.job.status)}: ${esc((t.job.log || []).slice(-1)[0] || '')}</span>` : `<button class="btn" type="button" data-install="${esc(t.id)}">Install</button> <span class="sub">from github.com/${esc(t.repo)}</span>`)
      : `<span class="sub">Set up by hand: ${esc(t.guide)}</span>`;
    const tool = t => `<div class="x-row" style="cursor:default;white-space:normal"><b style="white-space:normal">${esc(t.name)} <span class="chip${t.verdict === 'worth it' ? ' ok' : ''}">${esc(t.verdict)}</span> <span class="sub">${esc(t.kind)} · ${esc(t.licence)}</span></b>
        <span class="sub" style="white-space:normal">${esc(t.what)} Acts on ${tkFmt(t.exposure)} of your tool output (${(t.share * 100).toFixed(2)}% of your usage); saves about ${tkFmt(t.saves)}, costs about ${tkFmt(t.costs)} at session start. ${esc(t.note)}</span>
        <span>${act(t)}</span></div>`;
    const leanRow = lean && lean.idle ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span>Lean start: ${lean.idle} skills never used are described to every session.</span>
        ${lean.movable.length || lean.plugins.length ? `<button class="btn" type="button" id="tk-lean">Switch off ${lean.movable.length + lean.plugins.length} here</button>` : ''}
        ${lean.elsewhere.length ? `<span class="sub">${lean.elsewhere.length} come from claude.ai: turn them off there (Settings > Capabilities > Skills).</span>` : ''}</div>` : '';
    const guard = st.cacheGuard || 'block';
    setHTML(box, `
      <section><div class="section-head"><h2>Token governor</h2><span class="sub">long sessions and cache rebuilds are most of a heavy user's limit</span></div>
        <div class="x-panel x-pad" style="display:grid;gap:12px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span>Governor</span><button class="x-switch" id="tk-gov-sw" type="button" role="switch" aria-checked="${st.governor !== false}" title="/compact and /clear prompts as a session grows"><i></i></button>
            <span class="sub" style="margin-left:12px">Returning to a big session after its cache expired:</span>
            <span id="tk-guard" style="display:flex;gap:6px">${[['block', 'Stop once'], ['warn', 'Warn'], ['off', 'Off']].map(([v, l]) => `<button type="button" class="btn" data-guard="${v}" aria-pressed="${guard === v}">${l}</button>`).join('')}</span></div>
          <span class="sub">Status line with context size and cache time: run <code>anchor statusline install --apply</code> once.</span>
          ${leanRow}
        </div></section>
      <section><div class="section-head"><h2>Token tools from the web</h2><span class="sub">vetted, ranked for your last 7 days · nothing installs until you click</span></div>
        <div class="x-list" id="tk-cat">${cat.map(tool).join('')}</div></section>`);
    $('#tk-gov-sw').onclick = async e => {
      const b = e.currentTarget, on = b.getAttribute('aria-checked') !== 'true';
      try { const r = await api('/api/settings', { method: 'POST', body: { governor: on } }); b.setAttribute('aria-checked', r.governor); toast(r.governor ? 'Governor on' : 'Governor off'); } catch (x) { toast(x.message); }
    };
    $('#tk-guard').onclick = async e => {
      const b = e.target.closest('[data-guard]'); if (!b) return;
      try { const r = await api('/api/settings', { method: 'POST', body: { cacheGuard: b.dataset.guard } }); $$('#tk-guard [data-guard]').forEach(x => x.setAttribute('aria-pressed', x.dataset.guard === r.cacheGuard)); toast(`Cache guard: ${r.cacheGuard}`); } catch (x) { toast(x.message); }
    };
    const lb = $('#tk-lean');
    if (lb) lb.onclick = async () => { try { const r = await api('/api/lean/apply', { method: 'POST', body: {} }); toast(r.message.split('\n').pop()); this.loadGov(); } catch (x) { toast(x.message); } };
    $('#tk-cat').onclick = async e => {
      const b = e.target.closest('[data-install]'); if (!b) return;
      b.disabled = true;
      try { const r = await api('/api/catalog/install', { method: 'POST', body: { id: b.dataset.install } }); toast(r.message); } catch (x) { toast(x.message); }
      clearTimeout(this.poll); this.poll = setTimeout(() => this.loadGov(), 4000);
    };
    if (cat.some(t => t.job && t.job.status === 'running')) { clearTimeout(this.poll); this.poll = setTimeout(() => this.loadGov(), 4000); }
  },
  async load() {
    const body = $('#tk-body'); if (!body) return;
    setHTML(body, '<div class="x-thinking"><i></i><i></i><i></i> Reading your transcripts…</div>');
    let a;
    try { a = await api(`/api/tokens?days=${this.days}`); } catch (e) { setHTML(body, `<div class="empty">${esc(e.message)}</div>`); return; }
    if (!$('#tk-body')) return;
    const t = a.totals;
    const saves = a.tips.reduce((n, x) => n + (x.saves || 0), 0);
    const up = a.upfront;
    setHTML(body, `
      <div class="x-stats">
        <div class="x-stat claude"><b>${tkFmt(t.weighted)}</b><span>counted toward limits</span></div>
        <div class="x-stat"><b>${a.sessions}</b><span>sessions · ${a.subagents} subagent runs</span></div>
        <div class="x-stat"><b>${tkFmt(t.cr)}</b><span>cached tokens re-read</span></div>
        <div class="x-stat"><b>${tkFmt(up.total)}</b><span>read by each session before any work</span></div>
        <div class="x-stat ok"><b>${tkFmt(saves)}</b><span>the fixes below would have saved</span></div>
      </div>
      <section><div class="section-head"><h2>What to change</h2><span class="sub">biggest saving first · estimates</span></div>
        ${a.tips.length ? `<div class="x-list">${a.tips.map((x, i) => `<div class="x-row" style="cursor:default;white-space:normal"><b style="white-space:normal">${i + 1}. ${esc(x.title)}${x.saves ? ` <span class="chip ok">saves ~${tkFmt(x.saves)}</span>` : ''}</b>
          <span class="sub" style="white-space:normal">${esc(x.detail)}</span>${x.id === 'idle-skills' ? '<span><a href="#/skills">Open Skills to switch them off →</a></span>' : ''}</div>`).join('')}</div>` : '<div class="empty">Nothing stands out. Lean work.</div>'}</section>
      <div class="grid-2"><div>
        <section><div class="section-head"><h2>Before any work</h2><span class="sub">what each session in ${esc(up.folder ? tkBase(up.folder) : 'your busiest folder')} reads first</span></div>
          <div class="x-panel x-pad">${bars(up.items.map(x => [x.what, x.tokens]), { fmt: tkFmt })}</div></section>
        <section><div class="section-head"><h2>Skills loaded</h2><span class="sub">instructions that stay for the rest of the session</span></div>
          ${a.skills.length ? `<div class="x-panel x-pad">${bars(a.skills.slice(0, 10).map(s => [`${s.name} ×${s.loads}`, s.tokens]), { fmt: tkFmt, color: 'var(--dia)' })}</div>` : '<div class="empty">No skills loaded in this period.</div>'}</section>
        <section><div class="section-head"><h2>Notes added by hooks</h2></div>
          ${a.hooks.length ? `<div class="x-panel x-pad">${bars(a.hooks.map(h => [`${h.hook} (${h.notes})`, h.tokens]), { fmt: tkFmt, color: 'var(--club)' })}</div>` : '<div class="empty">None.</div>'}</section>
      </div><div>
        <section><div class="section-head"><h2>Largest tool results</h2><span class="sub">stay in context for every later reply</span></div>
          ${a.outputs.length ? `<table class="list"><tr><th>Tokens</th><th>Tool</th><th>What</th></tr>${a.outputs.slice(0, 12).map(o => `<tr><td class="num">${tkFmt(o.tokens)}</td><td>${esc(o.tool.replace(/^mcp__[^_]+__/, ''))}</td><td title="${esc(o.what)}">${esc(tkBase(o.what) || o.what)} <span class="sub">${esc(o.project)}${o.sub ? ' · subagent' : ''}</span></td></tr>`).join('')}</table>` : '<div class="empty">No tool result over 4k tokens.</div>'}</section>
        <section><div class="section-head"><h2>Files read again and again</h2><span class="sub">same file, same session</span></div>
          ${a.rereads.length ? `<table class="list"><tr><th>Times</th><th>Repeated</th><th>File</th></tr>${a.rereads.slice(0, 10).map(x => `<tr><td class="num">×${x.times}</td><td class="num">${tkFmt(x.wasted)}</td><td title="${esc(x.path)}">${esc(tkBase(x.path))} <span class="sub">${esc(x.project)}</span></td></tr>`).join('')}</table>` : '<div class="empty">No file was read three times in one session.</div>'}</section>
        <section><div class="section-head"><h2>Prompt cache</h2></div>
          <div class="x-panel x-pad x-tk"><div class="x-kv"><div><b>Rebuilt</b><span>${a.rebuilds.count} times · ${tkFmt(a.rebuilds.tokens)} written</span></div>
            <div><b>After an hour or more away</b><span>${a.rebuilds.idle} times · ${tkFmt(a.rebuilds.idleTokens)}</span></div>
            <div><b>Long sessions (150k+ context)</b><span>${a.longSessions.length}${a.longSessions[0] ? ` · largest: ${esc(a.longSessions[0].title || a.longSessions[0].project)} (${tkFmt(a.longSessions[0].maxCtx)} context)` : ''}</span></div></div></div></section>
      </div></div>
      <section><div class="section-head"><h2>Use these skills in claude.ai too</h2></div>
        <div class="x-panel x-pad"><p class="sub">Anchor gives every Claude Code session the <b>token-saver</b> and <b>token-audit</b> skills. To use the token saver in the Claude app as well, run <code>anchor export-skills</code> and upload <code>token-saver.zip</code> under Settings › Capabilities › Skills.</p></div></section>
      <p class="sub">Token counts are estimates from the transcripts (about 3.6 characters per token). Cache reads count at 10% toward limits. Ask Claude “audit my tokens” to go through the fixes together.</p>`);
  },
};
