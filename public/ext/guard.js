'use strict';
/* Guard: what Anchor stops Claude Code from doing. Every command and file write goes through the rules below (in any
   session with the Anchor plugin, bypass mode included). Critical rules block, high-risk ones ask you first. */

const MODES = [['block', 'Block'], ['ask', 'Ask me'], ['allow', 'Allow']];

views.guard = {
  mount(el) {
    el.innerHTML = `<div class="x-guard-hero x-panel"><div class="x-shield" id="gd-shield"><svg viewBox="0 0 64 72" aria-hidden="true"><path d="M32 3 6 13v20c0 17 11 29 26 36 15-7 26-19 26-36V13z"/><path class="tick" d="m20 36 9 9 16-18"/></svg></div>
        <div><div class="x-eyebrow">Anchor Guard</div><h1 id="gd-title">On</h1><p class="sub" id="gd-sub"></p>
          <div class="tools"><button class="x-switch" type="button" role="switch" id="gd-on" aria-checked="true"><i></i></button><span class="sub">Checks every command and file write before it runs, in every session with the Anchor plugin, bypass mode included.</span></div></div>
        <div class="x-hero-kpis" id="gd-kpis"></div></div>
      <div class="grid-2"><div>
        <section><div class="section-head"><h2>Rules</h2><span class="sub">critical rules block by default; the rest ask you</span></div><div id="gd-rules" class="x-list"></div></section>
        <section><div class="section-head"><h2>Protected paths</h2><span class="sub">nothing under these may be edited, moved or deleted</span></div>
          <textarea class="field" id="gd-prot" rows="5" placeholder="One per line: a folder, a file, or a pattern like **/*.lock or C:\\work\\frozen\\**"></textarea>
          <div class="tools" style="margin-top:8px"><button class="btn primary" type="button" id="gd-save">Save paths</button><select class="field" id="gd-add"><option value="">Protect a project folder…</option></select></div></section>
      </div><div>
        <section><div class="section-head"><h2>Try it</h2><span class="sub">see what the guard would do with a command</span></div>
          <div class="tools"><input class="field x-mono" id="gd-cmd" placeholder="e.g. rm -rf checkpoints" style="flex:1"><button class="btn" type="button" id="gd-try">Check</button></div><div id="gd-res" style="margin-top:10px"></div></section>
        <section><div class="section-head"><h2>What it stopped</h2></div><div id="gd-log" class="x-list"></div></section>
      </div></div>`;
    el.addEventListener('click', async e => {
      const m = e.target.closest('[data-mode]');
      if (m) { this.s.rules[m.dataset.rule] = m.dataset.mode; await this.save(); }
    });
    $('#gd-on').onclick = async () => { this.s.enabled = !this.s.enabled; await this.save(); };
    $('#gd-save').onclick = async () => { this.s.protected = $('#gd-prot').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean); await this.save(); toast('Protected paths saved'); };
    $('#gd-add').onchange = e => { if (!e.target.value) return; $('#gd-prot').value = ($('#gd-prot').value.trim() + '\n' + e.target.value).trim(); e.target.value = ''; };
    const tryIt = async () => {
      const r = await api('/api/guard/test', { method: 'POST', body: { command: $('#gd-cmd').value, cwd: O && O.sessions[0] && O.sessions[0].cwd } }).catch(err => ({ error: err.message }));
      $('#gd-res').innerHTML = r.error ? `<div class="sub">${esc(r.error)}</div>` : r.decision === 'allow' ? '<div class="x-verdict ok">✓ Allowed: this runs normally.</div>'
        : `<div class="x-verdict ${r.decision === 'deny' ? 'bad' : 'warn'}">${r.decision === 'deny' ? '⛔ Blocked' : '✋ Asks you first'}: ${esc(r.title)}<span>${esc(r.why)}</span></div>`;
    };
    $('#gd-try').onclick = tryIt; $('#gd-cmd').addEventListener('keydown', e => { if (e.key === 'Enter') tryIt(); });
    this.load();
  },
  update() {},
  async load() {
    const d = await api('/api/guard');
    this.s = d.settings; this.rules = d.rules; this.recent = d.recent;
    this.render();
    if (O) setHTML($('#gd-add'), '<option value="">Protect a project folder…</option>' + [...new Set(O.sessions.map(s => s.cwd).filter(Boolean))].map(c => `<option value="${esc(c)}">${esc(shortPath(c))}</option>`).join(''));
  },
  async save() { this.s = await api('/api/guard', { method: 'POST', body: this.s }); this.render(); },
  render() {
    const s = this.s, on = s.enabled;
    $('#gd-shield').classList.toggle('off', !on);
    $('#gd-on').setAttribute('aria-checked', on);
    $('#gd-title').textContent = on ? 'On guard' : 'Off';
    $('#gd-sub').textContent = on ? 'Mass deletes, workspace wipes, emptied bins, deleted models and disk tools are stopped before they run.' : 'Claude Code runs without Anchor checks. Turn it back on to protect your work.';
    const week = this.recent.filter(r => Date.now() - Date.parse(r.t) < 7 * 86400e3);
    setHTML($('#gd-kpis'), [['blocked', this.recent.filter(r => r.decision === 'deny').length], ['asked', this.recent.filter(r => r.decision === 'ask').length], ['this week', week.length]]
      .map(([k, v]) => `<div><b class="num">${v}</b><span>${k}</span></div>`).join(''));
    if (document.activeElement !== $('#gd-prot')) $('#gd-prot').value = (s.protected || []).join('\n');
    setHTML($('#gd-rules'), this.rules.map(r => {
      const mode = s.rules[r.id] || (r.severity === 'critical' ? 'block' : 'ask');
      return `<div class="x-rule ${r.severity}"><div><b>${esc(r.title)}</b><span class="sub">${esc(r.example)}</span></div>
        <div class="x-seg" role="radiogroup" aria-label="${esc(r.title)}">${MODES.map(([k, l]) => `<button type="button" role="radio" aria-checked="${mode === k}" data-rule="${r.id}" data-mode="${k}">${l}</button>`).join('')}</div></div>`;
    }).join(''));
    setHTML($('#gd-log'), this.recent.length ? this.recent.slice(0, 40).map(r => `<div class="x-row x-logrow ${r.decision}"><b>${r.decision === 'deny' ? '⛔' : '✋'} <span class="x-mono">${esc(r.what)}</span></b>
      <span class="sub">${esc((this.rules.find(x => x.id === r.rule) || {}).title || r.rule)} · ${esc(r.why || '')} · ${esc(shortPath(r.cwd || ''))} · ${esc(ago(r.t))}</span></div>`).join('')
      : '<div class="empty">Nothing stopped yet. When Claude tries something destructive, it shows up here.</div>');
  },
};
