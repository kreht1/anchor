'use strict';
/* Account: who is signed in, the current 5-hour session window and the week, when each resets, usage by day and model,
   and every session. All from local files; nothing is sent anywhere. */

const fmtTok = n => (n == null ? '–' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const until = iso => { const s = (Date.parse(iso) - Date.now()) / 1000; return s <= 0 ? 'now' : s >= 172800 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : dur(s); };
const at = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

function limitCard(id, title, d, subHtml) {
  const pct = d.pct;
  const hot = d.limited ? 'bad' : pct >= 85 ? 'warn' : '';
  return `<div class="x-card x-limit ${hot}" id="${id}">
    <div class="x-limit-top"><div>${ring(id === 'lim-s' ? 'g-solar' : 'g-violet', (pct ?? 0) / 100, pct == null ? '–' : `${pct}%`)}</div>
      <div><div class="x-eyebrow">${title}</div><div class="x-limit-v num">${d.limited ? 'Limit reached' : pct == null ? fmtTok(d.used) : `${pct}%`}</div>
      <div class="sub">${subHtml}</div></div></div>
    <div class="x-kv"><div><b>Used</b><span>${fmtTok(d.used)} tokens · ${d.msgs} replies · ${fmtTok(d.output)} written</span></div>
      ${d.cap ? `<div><b>Your usual cap</b><span>about ${fmtTok(d.cap)} (from your past limit hits)</span></div>` : '<div><b>Your usual cap</b><span>not known yet: shown after you first hit this limit</span></div>'}</div></div>`;
}

views.account = {
  mount(el) {
    el.innerHTML = `<div id="acc"><div class="x-thinking"><i></i><i></i><i></i> Reading your usage…</div></div>`;
    this.load();
    this.timer = setInterval(() => this.load(), 30000);
    this.tick = setInterval(() => $$('[data-until]').forEach(n => { n.textContent = until(n.dataset.until); }), 1000);
  },
  unmount() { clearInterval(this.timer); clearInterval(this.tick); },
  update() { this.sessions(); },
  async load() {
    let u;
    try { u = await api('/api/usage'); } catch (e) { $('#acc').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (!$('#acc')) return;
    const a = u.account || {};
    const name = a.displayName || a.fullName || 'You';
    const s = u.session, w = u.weekly;
    const maxDay = Math.max(1, ...u.days.map(d => d.w));
    $('#acc').innerHTML = `
      <div class="x-hero x-panel"><div class="x-hero-main" style="display:flex;gap:20px;align-items:center">
          <span class="x-avatar">${esc(name[0].toUpperCase())}</span>
          <div><div class="x-eyebrow">Signed in to Claude Code</div><h1>${esc(name)}</h1>
          <div class="tools"><span class="chip claude">${esc(u.plan)}</span>${a.organizationName ? `<span class="chip">${esc(a.organizationName)}</span>` : ''}
            ${a.emailAddress ? `<button class="chip x-email" type="button" title="Show or hide">${esc(a.emailAddress.replace(/^(.).*(@.*)$/, '$1•••$2'))}</button>` : ''}
            ${a.organizationRole ? `<span class="chip">${esc(a.organizationRole)}</span>` : ''}${a.hasExtraUsageEnabled ? '<span class="chip ok">extra usage on</span>' : ''}</div></div></div>
        <div class="x-hero-kpis"><div><b class="num">${a.subscriptionCreatedAt ? esc(new Date(a.subscriptionCreatedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })) : '–'}</b><span>subscribed since</span></div>
          <div><b class="num">${u.numStartups ?? '–'}</b><span>Claude Code starts</span></div><div><b class="num">${esc(u.installMethod || '–')}</b><span>install</span></div></div></div>
      ${s.limited || w.limited ? `<div class="x-banner bad">You are at your ${s.limited ? 'session' : 'weekly'} limit. It resets ${esc(at(s.limited ? s.resetAt : w.nextReset))} (in <span data-until="${esc(s.limited ? s.resetAt : w.nextReset)}">${until(s.limited ? s.resetAt : w.nextReset)}</span>).<span id="acc-fb"></span></div>` : ''}
      <div class="x-limits">
        ${s.idle ? `<div class="x-card x-limit"><div class="x-eyebrow">Session · 5-hour window</div><div class="x-limit-v">Not started</div><p class="sub">Your next message opens a fresh 5-hour window.${s.lastEnded ? ` The last one ended ${esc(ago(s.lastEnded))}.` : ''}</p></div>`
          : limitCard('lim-s', 'Session · 5-hour window', s, `${s.exact ? 'Resets' : 'Window ends'} ${esc(at(s.resetAt))} · in <b data-until="${esc(s.resetAt)}">${until(s.resetAt)}</b>${s.exact ? '' : ' (estimated from when it started)'}`)}
        ${limitCard('lim-w', 'This week', w, w.nextReset ? `Resets ${esc(at(w.nextReset))} · in <b data-until="${esc(w.nextReset)}">${until(w.nextReset)}</b>` : 'Reset time appears after your first weekly-limit notice')}
      </div>
      <div class="grid-2"><div>
        <section><div class="section-head"><h2>Usage by day</h2><span class="sub">tokens counted toward limits, last 14 days</span></div>
          <div class="x-panel x-pad"><div class="x-days">${u.days.map(d => `<div class="x-day" title="${esc(d.day)}: ${fmtTok(d.w)} tokens · ${d.msgs} replies"><i style="height:${Math.max(2, (d.w / maxDay) * 100)}%"></i><span>${esc(new Date(d.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'narrow' }))}</span></div>`).join('')}</div>
          <div class="sub" style="margin-top:8px">Busiest day: ${fmtTok(maxDay)} tokens.</div></div></section>
        <section><div class="section-head"><h2>Models this week</h2></div><div class="x-panel x-pad">${bars(u.models.map(m => [m.model.replace(/^claude-/, ''), m.w]), { fmt: fmtTok })}</div></section>
        <section><div class="section-head"><h2>Recent 5-hour windows</h2></div>
          <table class="list"><tr><th>Started</th><th>Tokens</th><th>Replies</th><th></th></tr>${u.windows.map(x => `<tr><td>${esc(at(x.start))}</td><td class="num">${fmtTok(x.used)}</td><td class="num">${x.msgs}</td><td>${x.hit ? '<span class="chip bad">limit hit</span>' : ''}</td></tr>`).join('')}</table></section>
      </div><div>
        <section><div class="section-head"><h2>Sessions</h2><a href="#/chats">Conversations</a></div><div id="acc-sessions"></div></section>
        <section><div class="section-head"><h2>Limit notices</h2><span class="sub">what Claude Code told you, with reset times</span></div>
          ${u.limits.length ? `<div class="x-list">${u.limits.map(l => `<div class="x-row"><b>${l.kind === 'weekly' ? 'Weekly' : l.kind === 'session' ? 'Session' : esc(l.kind)} limit · ${esc(at(l.t))}</b><span class="sub">${esc(l.text)}${l.resetAt ? ` → ${esc(at(l.resetAt))}` : ''}</span></div>`).join('')}</div>` : '<div class="empty">You have not hit a limit in the last 40 days.</div>'}</section>
      </div></div>
      <p class="sub">${esc(u.note)} Your login tokens are never read.</p>`;
    if ($('#acc-fb')) offerFallback($('#acc-fb'));
    const em = $('.x-email');
    if (em) em.onclick = () => { em.textContent = em.textContent.includes('•••') ? a.emailAddress : a.emailAddress.replace(/^(.).*(@.*)$/, '$1•••$2'); };
    this.sessions();
  },
  sessions() {
    const box = $('#acc-sessions'); if (!box || !O) return;
    const list = [...O.sessions].sort((x, y) => String(y.lastTs).localeCompare(String(x.lastTs)));
    const total = list.reduce((a2, x) => a2 + (x.cost || 0), 0);
    setHTML(box, `<div class="x-stats" style="grid-template-columns:repeat(3,1fr)"><div class="x-stat"><b>${list.length}</b><span>sessions</span></div><div class="x-stat claude"><b>${list.filter(x => x.live).length}</b><span>open now</span></div><div class="x-stat"><b>$${total.toFixed(0)}</b><span>API-equivalent cost</span></div></div>
      <div class="x-list">${list.slice(0, 12).map(x => `<a class="x-row" href="#/chats/${encodeURIComponent(x.id)}"><b>${x.live ? '<span class="pulse" style="background:var(--club)"></span>' : ''}${esc(x.title)}</b><span class="sub">${esc(x.project)} · ${x.prompts} messages · ${esc(ago(x.lastTs))}${x.cost != null ? ` · $${x.cost.toFixed(2)}` : ''}${x.model ? ` · ${esc(x.model.replace(/^claude-/, ''))}` : ''}</span></a>`).join('')}</div>`);
  },
};
