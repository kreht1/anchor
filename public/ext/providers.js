'use strict';
/* Providers: keep working when your Claude plan hits a limit. Set up OpenRouter, Ollama, Groq, LM Studio or any
   compatible endpoint, test it, and launch Claude Code on it in a new terminal; normal sessions stay unchanged. */

let PRD = null;
async function loadProviders() { PRD = await api('/api/providers'); return PRD; }

function providerForm(base, existing) {
  const p = existing || { ...base, id: '', keyEnv: base.keyEnv || '' };
  const m = modal(`<div class="x-eyebrow">${existing ? 'Edit provider' : 'New provider'} · ${p.kind === 'openai' ? 'through the Anchor bridge' : 'direct'}</div>
    <h2 class="x-title">${esc(p.name)}</h2><p class="sub">${esc(base.note || '')}</p>
    <form class="x-form" id="pf">
      <label class="x-label">Name</label><input class="field" name="name" value="${esc(p.name)}" required>
      <label class="x-label">Base URL</label><input class="field x-mono" name="baseUrl" value="${esc(p.baseUrl)}" placeholder="${p.kind === 'openai' ? 'https://host/v1' : 'https://host (no /v1)'}" required>
      ${base.needsKey !== false || existing ? `<label class="x-label">Key</label>
      <div class="x-keyrow"><label class="x-check"><input type="radio" name="ks" value="env" ${p.keyEnv ? 'checked' : ''}> From an environment variable (recommended)</label>
        <input class="field x-mono" name="keyEnv" value="${esc(p.keyEnv || '')}" placeholder="e.g. ${esc(base.keyEnv || 'MY_API_KEY')}"></div>
      <div class="x-keyrow"><label class="x-check"><input type="radio" name="ks" value="save" ${!p.keyEnv ? 'checked' : ''}> Saved by Anchor (encrypted with your Windows account)</label>
        <input class="field x-mono" name="key" type="password" autocomplete="off" placeholder="${existing && existing.key && existing.key.source === 'saved' ? 'saved; type to replace' : 'paste the key'}"></div>
      <p class="sub">The key never leaves this computer except to the provider itself, and Anchor never shows it again.</p>` : ''}
      <label class="x-label">Models</label>
      <div class="tools"><input class="field x-mono" name="main" list="pm-list" value="${esc(p.models.main)}" placeholder="main model (needs tool calling)" style="flex:2 1 260px">
        <input class="field x-mono" name="fast" list="pm-list" value="${esc(p.models.fast)}" placeholder="fast model (optional)" style="flex:1 1 200px">
        <button class="btn" type="button" id="pm-load" ${existing ? '' : 'disabled title="Save first, then load the model list"'}>Load models</button></div>
      <datalist id="pm-list"></datalist><div class="sub" id="pm-info"></div>
      ${p.kind === 'openai' ? `<label class="x-label">Max output tokens (optional)</label><input class="field" name="maxOutput" type="number" min="256" value="${esc(p.maxOutput || '')}" placeholder="the provider's limit, e.g. 8192">` : ''}
      <div class="tools"><button class="btn primary" type="submit">Save</button>${existing ? '<button class="btn" type="button" id="pf-test">Test</button>' : ''}<span class="sub" id="pf-msg"></span></div>
    </form>`, { wide: true });
  const f = m.el.querySelector('#pf');
  const body = () => {
    const d = Object.fromEntries(new FormData(f));
    return { id: p.id || undefined, preset: p.preset || base.preset, kind: p.kind, name: d.name, baseUrl: d.baseUrl, models: { main: d.main, fast: d.fast }, maxOutput: d.maxOutput,
      keyEnv: d.ks === 'env' ? d.keyEnv : '', key: d.ks === 'save' && d.key ? d.key : undefined };
  };
  f.addEventListener('submit', async e => {
    e.preventDefault();
    try { const r = await api('/api/providers', { method: 'POST', body: body() }); p.id = r.id; toast('Saved'); await loadProviders(); if (current && current.view.render) current.view.render(); m.close(); providerForm(base, PRD.profiles.find(x => x.id === r.id)); }
    catch (err) { m.el.querySelector('#pf-msg').textContent = err.message; }
  });
  const load = m.el.querySelector('#pm-load');
  if (load) load.onclick = async () => {
    load.disabled = true; m.el.querySelector('#pm-info').textContent = 'Asking the provider for its models…';
    try {
      const ms = await api(`/api/providers/${encodeURIComponent(p.id)}/models`, { method: 'POST', body: {} });
      m.el.querySelector('#pm-list').innerHTML = ms.map(x => `<option value="${esc(x.id)}">${x.free ? 'free · ' : ''}${x.tools === false ? 'no tools · ' : x.tools ? 'tools · ' : ''}${x.context ? Math.round(x.context / 1000) + 'k ctx' : ''}</option>`).join('');
      const tools = ms.filter(x => x.tools), free = ms.filter(x => x.free);
      m.el.querySelector('#pm-info').textContent = `${ms.length} models${tools.length ? `, ${tools.length} with tool calling` : ''}${free.length ? `, ${free.length} free` : ''}. Click a model box to pick from the list.`;
    } catch (err) { m.el.querySelector('#pm-info').textContent = err.message; } finally { load.disabled = false; }
  };
  const t = m.el.querySelector('#pf-test');
  if (t) t.onclick = async () => {
    const msg = m.el.querySelector('#pf-msg'); msg.textContent = 'Testing…';
    try { await api('/api/providers', { method: 'POST', body: body() }); const r = await api(`/api/providers/${encodeURIComponent(p.id)}/test`, { method: 'POST', body: {} }); msg.textContent = `Works: “${r.reply}” in ${r.ms} ms`; }
    catch (err) { msg.textContent = `Failed: ${err.message}`; }
  };
}

function launchDialog(p, preset) {
  const projects = O ? [...new Map(O.sessions.filter(s => s.cwd).map(s => [s.cwd.toLowerCase(), s])).values()] : [];
  const m = modal(`<div class="x-eyebrow">Launch Claude Code on ${esc(p.name)}</div><h2 class="x-title">${esc(p.models.main || 'no model set')}</h2>
    <p class="sub">A new terminal opens with Claude Code using this provider. Your normal sessions and your Claude plan are not touched.</p>
    <form class="x-form" id="lf"><label class="x-label">Folder</label>
      <select class="field" name="cwd">${projects.map(s => `<option value="${esc(s.cwd)}" ${preset && preset.cwd === s.cwd ? 'selected' : ''}>${esc(s.project)} · ${esc(shortPath(s.cwd))}</option>`).join('')}<option value="">Home folder</option></select>
      <label class="x-label">Conversation</label>
      <label class="x-check"><input type="radio" name="mode" value="new" checked> Start fresh in that folder</label>
      <label class="x-check"><input type="radio" name="mode" value="resume" ${preset && preset.resume ? 'checked' : ''}> Continue a conversation</label>
      <select class="field" name="resume">${(O ? O.sessions : []).slice(0, 30).map(s => `<option value="${esc(s.id)}" ${preset && preset.resume === s.id ? 'selected' : ''}>${esc(s.project)} · ${esc(s.title.slice(0, 70))} · ${esc(ago(s.lastTs))}</option>`).join('')}</select>
      <p class="sub">Continuing works best with Claude models. Other models can stumble on a long conversation written by Claude; start fresh if it errors.</p>
      <div class="tools"><button class="btn primary" type="submit">Open terminal</button><span class="sub" id="lf-msg"></span></div></form>`, { wide: true });
  m.el.querySelector('#lf').addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const sess = d.mode === 'resume' && O ? O.sessions.find(s => s.id === d.resume) : null;
    try {
      const r = await api(`/api/providers/${encodeURIComponent(p.id)}/launch`, { method: 'POST', body: { cwd: sess ? sess.cwd : d.cwd || undefined, resume: sess ? sess.id : undefined } });
      m.el.querySelector('#lf-msg').innerHTML = `Opened. Same thing from any terminal: <code>${esc(r.command)}</code>`;
    } catch (err) { m.el.querySelector('#lf-msg').textContent = err.message; }
  });
}

views.providers = {
  mount(el) {
    el.innerHTML = `<div class="view-head"><h1>Providers</h1><span class="sub">Keep working when your Claude plan hits a limit: a local model, a free endpoint, or pay-as-you-go.</span></div>
      <div class="x-banner" style="border-left-color:var(--spade)">Anchor launches a <b>separate</b> Claude Code on the provider you pick (also from any terminal with <code>anchor claude &lt;profile&gt;</code>).
        Your normal sessions keep using your Claude plan. OpenAI-style providers (Groq, LM Studio, OpenRouter's other models) go through the Anchor bridge on this computer.
        Pick models that support <b>tool calling</b>; Claude Code is an agent and needs it.</div>
      <section><div class="section-head"><h2>Your providers</h2><span class="sub" id="pv-fb"></span></div><div class="x-grid" id="pv-list"></div></section>
      <section><div class="section-head"><h2>Failover chain</h2><span class="sub">try providers in order; skip one that is rate-limited or out of quota</span></div>
        <div class="tools"><button class="btn primary" type="button" id="pv-chain">Make a failover chain</button></div><div id="pv-events" style="margin-top:10px"></div></section>
      <section><div class="section-head"><h2>Claude Code Router</h2><span class="sub">the most popular multi-provider router, managed from here</span></div><div id="pv-ccr" class="x-panel x-pad"><div class="x-thinking"><i></i><i></i><i></i></div></div></section>
      <section><div class="section-head"><h2>Add one</h2></div><div class="x-grid" id="pv-presets"></div></section>`;
    el.addEventListener('click', e => {
      const add = e.target.closest('[data-preset]'); if (add) { providerForm(PRD.presets.find(x => x.preset === add.dataset.preset)); return; }
      const b = e.target.closest('[data-pa]'); if (!b) return;
      const p = PRD.profiles.find(x => x.id === b.dataset.id);
      const base = PRD.presets.find(x => x.preset === p.preset) || { note: '', needsKey: true };
      if (b.dataset.pa === 'edit') providerForm(base, p);
      if (b.dataset.pa === 'launch') launchDialog(p);
      if (b.dataset.pa === 'test') { b.textContent = 'Testing…'; api(`/api/providers/${encodeURIComponent(p.id)}/test`, { method: 'POST', body: {} }).then(r => toast(`${p.name} works: “${r.reply}” in ${r.ms} ms`)).catch(err => toast(`${p.name}: ${err.message}`)).finally(() => { b.textContent = 'Test'; }); }
      if (b.dataset.pa === 'fallback') api('/api/providers/fallback', { method: 'POST', body: { id: PRD.fallback === p.id ? null : p.id } }).then(() => loadProviders()).then(() => this.render());
      if (b.dataset.pa === 'del' && confirm(`Delete ${p.name}? Its saved key is deleted too.`)) api(`/api/providers/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).then(() => loadProviders()).then(() => this.render());
    });
    loadProviders().then(() => { this.render(); this.ccr(); }).catch(e => toast(e.message));
    $('#pv-chain').onclick = () => chainForm();
    this.timer = setInterval(() => { this.ccr(); this.events(); }, 8000);
    this.events();
  },
  unmount() { clearInterval(this.timer); },
  update() {},
  async events() {
    const ev = await api('/api/bridge-events').catch(() => []);
    const box = $('#pv-events'); if (!box) return;
    setHTML(box, ev.length ? '<div class="x-list">' + ev.slice(0, 8).map(e => '<div class="x-row"><b>' + esc(e.chain) + ' → ' + (e.member ? esc(e.member) : 'none available') + '</b><span class="sub">' + esc(ago(e.t)) + (e.skipped.length ? ' · skipped: ' + esc(e.skipped.join(' | ')) : '') + '</span></div>').join('') + '</div>' : '');
  },
  async ccr() {
    const box = $('#pv-ccr'); if (!box) return;
    let st;
    try { st = await api('/api/ccr'); } catch (e) { box.innerHTML = '<div class="sub">' + esc(e.message) + '</div>'; return; }
    const inst = await api('/api/installs').catch(() => []);
    const job = (inst.find(i => i.id === 'ccr') || inst.find(i => i.id === 'ccr-update') || {}).job;
    const linked = PRD && PRD.profiles.find(p => p.preset === 'ccr');
    const sig = JSON.stringify([st, job && job.status, job && job.log.length, !!linked]);
    if (box._sig === sig) return;
    box._sig = sig;
    const log = job ? '<pre class="x-fileview" style="margin-top:10px">' + esc(job.status) + '\n' + esc(job.log.slice(-12).join('\n')) + '</pre>' : '';
    box.innerHTML = !st.installed
      ? '<p>Claude Code Router is not installed. It routes Claude Code to many providers (OpenRouter, Gemini, Groq, DeepSeek, local models) and has its own web UI.</p><div class="tools">'
        + (st.nodeOk ? '<button class="btn primary" type="button" data-ccr="install">Install (about 25 MB download)</button>' : '<span class="chip bad">needs Node.js 22+, you have ' + esc(st.node) + '</span>')
        + '<a class="btn" href="https://github.com/musistudio/claude-code-router" target="_blank" rel="noopener noreferrer">About it</a></div>' + log
      : '<div class="tools"><span class="chip ok">installed · v' + esc(st.version) + '</span><span class="chip ' + (st.manager.up ? 'ok' : '') + '">service ' + (st.manager.up ? 'running' : 'stopped') + '</span>'
        + '<span class="chip ' + (st.gateway.up ? 'ok' : 'bad') + '">gateway ' + (st.gateway.up ? 'up' : 'down') + ' · :' + st.gateway.port + '</span></div>'
        + '<div class="tools" style="margin-top:10px">' + (st.manager.up ? '<button class="btn" type="button" data-ccr="stop">Stop</button>' : '<button class="btn primary" type="button" data-ccr="start">Start</button>')
        + '<button class="btn" type="button" data-ccr="ui">Open CCR\'s UI</button>'
        + (linked ? '<span class="sub">Linked as provider “' + esc(linked.name) + '”</span>' : '<button class="btn" type="button" data-ccr="link">Use it as an Anchor provider</button>')
        + '<button class="btn" type="button" data-ccr="update">Update</button></div>'
        + '<p class="sub">In CCR\'s UI: add providers and models, set routing, and create a client key (API Keys). Then “Use it as an Anchor provider” and paste that key, so Anchor can launch it and use it in a failover chain.</p>'
        + (st.profiles.length ? '<h3>CCR agent profiles</h3><div class="tools">' + st.profiles.map(n => '<button class="btn" type="button" data-ccr-profile="' + esc(n) + '">Launch “' + esc(n) + '”</button>').join('') + '</div>' : '') + log;
    box.onclick = async e => {
      const b = e.target.closest('[data-ccr]'), pr = e.target.closest('[data-ccr-profile]');
      if (pr) { const cwd = O && O.sessions[0] && O.sessions[0].cwd; api('/api/ccr/launch', { method: 'POST', body: { name: pr.dataset.ccrProfile, cwd } }).then(() => toast('Opening a terminal')).catch(err => toast(err.message)); return; }
      if (!b) return;
      const a = b.dataset.ccr;
      if (a === 'install' || a === 'update') {
        if (!confirm(a === 'install' ? 'Download and install Claude Code Router from npm (about 25 MB)?' : 'Update Claude Code Router from npm (about 25 MB)?')) return;
        await api('/api/installs/' + (a === 'install' ? 'ccr' : 'ccr-update'), { method: 'POST', body: {} }).then(() => toast('Installing in the background')).catch(err => toast(err.message));
      } else if (a === 'link') providerForm(PRD.presets.find(x => x.preset === 'ccr'));
      else {
        b.disabled = true;
        try { const r = await api('/api/ccr/' + a, { method: 'POST', body: {} }); toast(r.out ? r.out.split('\n').filter(Boolean).pop() : 'Done'); } catch (err) { toast(err.message); }
        b.disabled = false;
      }
      box._sig = ''; this.ccr();
    };
  },
  render() {
    if (!PRD || !$('#pv-list')) return;
    const fb = PRD.profiles.find(p => p.id === PRD.fallback);
    $('#pv-fb').textContent = fb ? `Fallback: ${fb.name} (offered when you hit a limit)` : 'Star one as your fallback to get a one-click switch when you hit a limit';
    $('#pv-list').innerHTML = PRD.profiles.length ? PRD.profiles.map(p => `<div class="x-card" style="--accent:${p.kind === 'openai' ? 'var(--you)' : 'var(--spade)'}">
        <div class="x-skill-top"><span class="x-glyph">${esc(p.name[0].toUpperCase())}</span><div class="x-skill-name"><b>${esc(p.name)}</b><span class="x-mono">${p.kind === 'chain' ? esc(p.members.map(id => (PRD.profiles.find(x => x.id === id) || { name: id }).name).join(' → ')) : esc(p.baseUrl)}</span></div>
          <button class="btn" type="button" data-pa="fallback" data-id="${esc(p.id)}" title="Use as fallback" aria-pressed="${PRD.fallback === p.id}">${PRD.fallback === p.id ? '★' : '☆'}</button></div>
        <div class="tools"><span class="chip ${p.kind === 'openai' ? '' : 'claude'}">${p.kind === 'chain' ? 'failover chain' : p.kind === 'openai' ? 'via bridge' : 'direct'}</span>
          ${p.kind === 'chain' ? '' : `<span class="chip ${p.key.source === 'none' && !/ollama|lmstudio/.test(p.preset) ? 'bad' : 'ok'}">${p.key.source === 'env' ? `key: $${esc(p.key.name)}${p.key.set ? '' : ' (not set!)'}` : p.key.source === 'saved' ? 'key saved, encrypted' : /ollama|lmstudio/.test(p.preset) ? 'no key needed' : 'no key'}</span>`}
          ${p.kind === 'chain' ? '' : `<span class="chip x-mono">${esc(p.models.main || 'no model')}</span>`}</div>
        <div class="tools"><button class="btn primary" type="button" data-pa="launch" data-id="${esc(p.id)}">Launch Claude Code</button><button class="btn" type="button" data-pa="test" data-id="${esc(p.id)}">Test</button>
          ${p.kind === 'chain' ? '' : `<button class="btn" type="button" data-pa="edit" data-id="${esc(p.id)}">Edit</button>`}<button class="btn" type="button" data-pa="del" data-id="${esc(p.id)}">Delete</button></div></div>`).join('')
      : '<div class="empty">None yet. Add one below. Ollama or LM Studio run free on your own computer; OpenRouter and GroqCloud have free models.</div>';
    $('#pv-presets').innerHTML = PRD.presets.map(x => `<button type="button" class="x-card tilt" data-preset="${esc(x.preset)}" style="--accent:${x.kind === 'openai' ? 'var(--you)' : 'var(--spade)'}">
        <div class="x-skill-top"><span class="x-glyph">${esc(x.name[0])}</span><div class="x-skill-name"><b>${esc(x.name)}</b><span>${x.kind === 'openai' ? 'through the Anchor bridge' : 'direct'} · ${x.needsKey ? 'needs a key' : 'no key'}</span></div></div>
        <p class="x-desc">${esc(x.note)}</p></button>`).join('');
  },
};

// one-click switch offered on the Account page when a limit is reached
async function offerFallback(box) {
  try {
    const d = await loadProviders();
    const fb = d.profiles.find(p => p.id === d.fallback) || d.profiles[0];
    if (!fb) { box.innerHTML = ' <a class="btn" href="#/providers">Set up a fallback provider</a>'; return; }
    box.innerHTML = ` <button class="btn primary" type="button">Continue on ${esc(fb.name)}</button>`;
    box.querySelector('button').onclick = () => { const s = O && O.sessions[0]; launchDialog(fb, s ? { cwd: s.cwd, resume: s.id } : null); };
  } catch { /* providers unavailable */ }
}

// a failover chain: pick providers and their order
function chainForm() {
  const cands = PRD.profiles.filter(p => p.kind !== 'chain' && p.models.main).map(p => ({ ...p, off: false }));
  if (cands.length < 2) { toast('Set up at least two providers with a model first'); return; }
  const order = cands.map(p => p.id);
  const m = modal('<div class="x-eyebrow">Failover chain</div><h2 class="x-title">Try these in order</h2>'
    + '<p class="sub">Each request goes to the first provider that answers. One that is rate-limited, out of quota, down or missing its model is skipped and rested for a while. Each uses its own models.</p>'
    + '<form class="x-form" id="cf"><input class="field" name="name" value="Fallback chain" required><div id="cf-list" class="x-list"></div>'
    + '<label class="x-label">Rest a failed provider for (seconds)</label><input class="field" name="cooldown" type="number" min="15" max="3600" value="120">'
    + '<div class="tools"><button class="btn primary" type="submit">Save chain</button><span class="sub" id="cf-msg"></span></div></form>', { wide: true });
  const draw = () => {
    m.el.querySelector('#cf-list').innerHTML = order.map((id, i) => {
      const p = cands.find(x => x.id === id);
      return '<div class="x-row" style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px"><input type="checkbox" data-on="' + esc(id) + '"' + (p.off ? '' : ' checked') + '>'
        + '<span><b>' + (i + 1) + '. ' + esc(p.name) + '</b> <span class="sub x-mono">' + esc(p.models.main) + '</span></span>'
        + '<span class="tools"><button class="btn" type="button" data-up="' + i + '"' + (i ? '' : ' disabled') + '>↑</button><button class="btn" type="button" data-down="' + i + '"' + (i < order.length - 1 ? '' : ' disabled') + '>↓</button></span></div>';
    }).join('');
  };
  draw();
  m.el.addEventListener('click', e => {
    const u = e.target.closest('[data-up]'), d = e.target.closest('[data-down]');
    if (u) { const i = +u.dataset.up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); }
    if (d) { const i = +d.dataset.down; [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); }
  });
  m.el.addEventListener('change', e => { const c = e.target.closest('[data-on]'); if (c) cands.find(x => x.id === c.dataset.on).off = !c.checked; });
  m.el.querySelector('#cf').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/providers', { method: 'POST', body: { kind: 'chain', name: f.name, cooldown: f.cooldown, members: order.filter(id => !cands.find(x => x.id === id).off) } });
      toast('Chain saved: launch it like any provider, or star it as your fallback');
      await loadProviders(); if (current && current.view.render) current.view.render(); m.close();
    } catch (err) { m.el.querySelector('#cf-msg').textContent = err.message; }
  });
}
