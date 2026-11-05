'use strict';
/* Skills: a ledger of every installed Claude Code skill: on/off, 30 days of real use, what it costs each session,
   and health; a Claude-powered GitHub skill finder with a quarantine-and-scan install flow; message hints. */

let SKD = null; // last /api/skills payload
async function loadSkills(fresh) { SKD = await api('/api/skills' + (fresh ? '?fresh=1' : '')); return SKD; }

const HEALTH = {
  working: { label: 'Working', cls: 'ok', star: '#ffd27a' },
  failing: { label: 'Failing', cls: 'bad', star: '#ff6b6b' },
  untested: { label: 'Untested', cls: '', star: '#9fb3ff' },
  off: { label: 'Off', cls: '', star: '#5b5b66' },
};
const SOURCE_LABEL = { user: 'Yours', plugin: 'Plugin', 'claude.ai': 'claude.ai', 'built-in': 'Built in', project: 'Project' };

function healthChip(h) { const x = HEALTH[h] || HEALTH.untested; return `<span class="chip ${x.cls} x-health h-${h}"><i></i>${x.label}</span>`; }
function usageLine(u) {
  if (!u) return 'Never used yet';
  const projects = Object.keys(u.projects || {});
  return `${u.uses} use${u.uses === 1 ? '' : 's'}${u.errors ? ` · ${u.errors} failed` : ''} · last ${ago(u.last)}${projects.length ? ` · ${projects.slice(0, 3).join(', ')}${projects.length > 3 ? '…' : ''}` : ''}`;
}

function skillDetail(s) {
  const m = modal(`<div class="x-skill-detail">
      <div class="x-eyebrow">${esc(s.group)} · ${esc(SOURCE_LABEL[s.source] || s.source)}${s.version ? ` · v${esc(s.version)}` : ''}</div>
      <h2 class="x-title">${esc(s.name)}</h2>
      <div class="tools" style="margin:8px 0 14px">${healthChip(s.health)}<span class="chip">${esc(s.id)}</span>${s.files ? `<span class="chip">${s.files} files</span>` : ''}</div>
      <p>${esc(s.description)}</p>
      <div class="x-kv"><div><b>Usage</b><span>${esc(usageLine(s.usage))}</span></div>
        ${s.usage && s.usage.byYou ? `<div><b>Typed by you</b><span>${s.usage.byYou} time${s.usage.byYou > 1 ? 's' : ''} as /${esc(s.name)}</span></div>` : ''}
        <div><b>Folder</b><span class="x-mono">${esc(shortPath(s.dir || ''))}</span></div></div>
      <h3>Your verdict</h3>
      <p class="sub">Mark how it really behaves for you; the list uses your verdict over the automatic one.</p>
      <div class="tools" id="vd">${['working', 'failing', 'untested'].map(v => `<button class="btn" type="button" data-v="${v}" aria-pressed="${s.verdict && s.verdict.verdict === v}">${HEALTH[v].label}</button>`).join('')}
        ${s.verdict ? '<button class="btn" type="button" data-v="">Clear</button>' : ''}</div>
      <textarea class="field x-note" id="vnote" placeholder="Note (what worked, what broke)" rows="2">${esc(s.verdict ? s.verdict.note : '')}</textarea>
      <div class="tools" style="margin-top:14px">${s.dir ? '<button class="btn" type="button" id="sk-open">Open folder in VS Code</button>' : ''}
        ${s.toggle ? `<button class="btn ${s.enabled ? '' : 'primary'}" type="button" id="sk-tg">${s.enabled ? 'Turn off' : 'Turn on'}${s.toggle === 'plugin' ? ' plugin' : ''}</button>` : ''}</div>
      ${s.preview ? `<h3>Instructions</h3><div class="bubble x-skill-md">${md(s.preview)}${s.lines > 40 ? `<p class="sub">… ${s.lines} lines in SKILL.md</p>` : ''}</div>` : ''}
    </div>`, { wide: true });
  m.el.querySelector('#vd').addEventListener('click', async e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    try { await api('/api/skills/verdict', { method: 'POST', body: { id: s.id, verdict: b.dataset.v || null, note: m.el.querySelector('#vnote').value } }); toast('Verdict saved'); m.close(); refreshSkillViews(); } catch (err) { toast(err.message); }
  });
  const o = m.el.querySelector('#sk-open');
  if (o) o.onclick = () => api('/api/open', { method: 'POST', body: { path: s.dir } }).then(() => toast('Opening in VS Code')).catch(err => toast(err.message));
  const t = m.el.querySelector('#sk-tg');
  if (t) t.onclick = async () => { await toggleSkill(s, !s.enabled); m.close(); };
}

async function toggleSkill(s, enabled) {
  if (s.toggle === 'plugin' && !confirm(`${enabled ? 'Turn on' : 'Turn off'} the whole “${s.plugin}” plugin? This changes enabledPlugins in ~/.claude/settings.json (a backup is kept).`)) return;
  try { const r = await api('/api/skills/toggle', { method: 'POST', body: { id: s.id, source: s.source, enabled } }); toast(r.note || 'Done'); refreshSkillViews(true); } catch (e) { toast(e.message); }
}
function refreshSkillViews(fresh) { loadSkills(fresh).then(() => { if (current && current.view.render) current.view.render(); }).catch(() => {}); }

// ---------------------------------------------------------------- skills list
views.skills = {
  mount(el) {
    this.f = { q: '', src: 'all', h: 'all', sort: 'used' };
    el.innerHTML = `<div class="x-sk-head"><div><h1>Skills</h1><p class="x-sk-lede" id="sk-sub">Reading your skills…</p></div>
        <div class="tools"><label class="x-check" title="Every Claude Code session (with the Anchor plugin) gets a rule to check and use matching skills before acting, plus your proven and failing skills"><button class="x-switch" type="button" role="switch" id="sk-disc" aria-checked="true"><i></i></button> Skill discipline</label>
          <button class="btn primary" type="button" id="sk-find">Find skills with Claude</button></div></div>
      <div id="sk-weight" class="x-sk-weight"></div>
      <div class="x-sk-bar"><input class="field" id="sk-q" type="search" placeholder="Filter by name or what it does" aria-label="Filter skills">
        <div class="tools" id="sk-src"></div><div class="tools" id="sk-h"></div>
        <label class="x-sk-sort">Sort <select class="field" id="sk-sort" aria-label="Sort skills">
          <option value="used">Most used</option><option value="recent">Used lately</option><option value="heavy">Heaviest</option><option value="name">Name</option></select></label></div>
      <div id="sk-list" class="x-ledger" role="table" aria-label="Skills"><div class="empty">Loading…</div></div>
      <details class="x-panel x-pad x-match" id="sk-match"><summary><b>Message hints</b> <span class="sub" id="sk-match-sum">how often a skill Anchor named was then used</span></summary>
        <div class="x-match-try"><input class="field" id="sk-try" type="search" placeholder="Try a message, e.g. make a chart of the results" aria-label="Try the skill matcher"><div id="sk-try-out" class="tools"></div></div>
        <div id="sk-match-body" class="sub">Loading…</div></details>`;
    $('#sk-q').addEventListener('input', e => { this.f.q = e.target.value.toLowerCase(); this.render(); });
    $('#sk-sort').addEventListener('change', e => { this.f.sort = e.target.value; this.render(); });
    el.addEventListener('click', e => {
      const f = e.target.closest('[data-fs]'); if (f) { this.f.src = f.dataset.fs; this.render(); return; }
      const h = e.target.closest('[data-fh]'); if (h) { this.f.h = h.dataset.fh; this.render(); return; }
      const sw = e.target.closest('.x-switch[data-i]'); if (sw) { e.stopPropagation(); const s = SKD.skills[sw.dataset.i]; if (s) toggleSkill(s, !s.enabled); return; }
      const c = e.target.closest('[data-skill]'); if (c) skillDetail(SKD.skills[c.dataset.skill]);
    });
    el.addEventListener('keydown', e => { const c = e.target.closest('[data-skill]'); if (c && (e.key === 'Enter' || e.key === ' ') && !e.target.closest('.x-switch')) { e.preventDefault(); skillDetail(SKD.skills[c.dataset.skill]); } });
    $('#sk-find').onclick = () => openFinder();
    const disc = $('#sk-disc');
    api('/api/settings').then(st => disc.setAttribute('aria-checked', st.skillDiscipline)).catch(() => {});
    disc.onclick = async e => { e.stopPropagation(); const on = disc.getAttribute('aria-checked') !== 'true';
      try { const st = await api('/api/settings', { method: 'POST', body: { skillDiscipline: on } }); disc.setAttribute('aria-checked', st.skillDiscipline);
        toast(st.skillDiscipline ? 'Skill discipline on: new sessions check and use matching skills first' : 'Skill discipline off'); } catch (err) { toast(err.message); } };
    let tq = 0;
    $('#sk-try').addEventListener('input', e => { clearTimeout(tq); const v = e.target.value.trim(); tq = setTimeout(async () => {
      if (!v) { setHTML($('#sk-try-out'), ''); return; }
      try { const r = await api('/api/skills/match?q=' + encodeURIComponent(v));
        setHTML($('#sk-try-out'), r.length ? r.map(x => `<span class="chip claude" title="matched: ${esc(x.hit.join(', '))}">${esc(x.id)}</span>`).join('') : '<span class="sub">No skill is named for this message.</span>');
      } catch (err) { setHTML($('#sk-try-out'), `<span class="sub">${esc(err.message)}</span>`); } }, 250); });
    this.matches();
    loadSkills().then(() => this.render()).catch(e => { $('#sk-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
    this.timer = setInterval(() => loadSkills().then(() => this.render()).catch(() => {}), 20000);
  },
  unmount() { clearInterval(this.timer); },
  update() {},
  async matches() {
    const box = $('#sk-match-body'); if (!box) return;
    let r; try { r = await api('/api/skills/matches'); } catch (e) { box.textContent = e.message; return; }
    if (!r.total) { box.innerHTML = 'No hints logged yet. They appear once the Anchor plugin is installed and you send messages.'; return; }
    const known = r.matches.filter(m => m.known), pct = known.length ? Math.round(100 * known.filter(m => m.used.length).length / known.length) : 0;
    const missed = Object.entries(r.missed).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const ago = t => { const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
    const sum = $('#sk-match-sum'); if (sum) sum.textContent = `${pct}% of named skills were then used (${known.filter(m => m.used.length).length} of ${known.length} messages)`;
    setHTML(box, `<div class="x-match-head"><b class="num">${pct}%</b><span>of the messages with a named skill led Claude to use one (${known.filter(m => m.used.length).length} of ${known.length})</span></div>
      ${missed.length ? `<div class="tools" style="margin:8px 0"><span class="sub">Named but not used most often:</span>${missed.map(([k, n]) => `<span class="chip">${esc(k)} · ${n}</span>`).join('')}</div>` : ''}
      <div class="x-match-list">${r.matches.slice(0, 10).map(m => `<div class="x-match-row"><span class="sub">${ago(m.t)}${m.project ? ' · ' + esc(m.project) : ''}</span><span>${m.skills.map(k => `<span class="chip ${m.used.includes(k) ? 'ok' : ''}">${m.used.includes(k) ? '✓ ' : ''}${esc(k)}</span>`).join(' ')}</span></div>`).join('')}</div>`);
  },
  render() {
    if (!SKD || !$('#sk-list')) return;
    const all = SKD.skills.map((s, i) => ({ ...s, i }));
    const on = all.filter(s => s.enabled);
    const used = on.filter(s => s.usage && s.usage.uses), idle = on.filter(s => !(s.usage && s.usage.uses));
    const w = l => l.reduce((n, s) => n + ((s.weight && s.weight.listed) || 0), 0);
    const wUsed = w(used), wIdle = w(idle), wAll = wUsed + wIdle || 1;
    const kf = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    $('#sk-sub').textContent = `${all.length} skills from ${SKD.plugins.length} plugins and your own folders. ${used.length} earn their place; ${idle.length} have never been used.`;
    setHTML($('#sk-weight'), `<div class="x-sk-wtext"><b>${kf(wAll)} tokens</b> describe your skills to every new session${wIdle ? `, ${kf(wIdle)} of them for skills you never use` : ''}.</div>
      <div class="x-sk-wbar" role="img" aria-label="${kf(wUsed)} for used skills, ${kf(wIdle)} for unused"><i class="u" style="width:${(100 * wUsed / wAll).toFixed(1)}%"></i><i class="n" style="width:${(100 * wIdle / wAll).toFixed(1)}%"></i></div>
      <div class="x-sk-wkey"><span><i class="u"></i>used ${kf(wUsed)}</span><span><i class="n"></i>never used ${kf(wIdle)}</span>${wIdle > 1500 ? '<a href="#/tokens">Switch the unused ones off on the Tokens page</a>' : ''}</div>`);
    const srcs = ['all', ...new Set(all.map(s => s.source))];
    setHTML($('#sk-src'), srcs.map(x => `<button class="btn" type="button" data-fs="${x}" aria-pressed="${this.f.src === x}">${x === 'all' ? 'All' : SOURCE_LABEL[x] || x}</button>`).join(''));
    setHTML($('#sk-h'), ['all', 'working', 'failing', 'untested', 'off'].map(x => `<button class="btn" type="button" data-fh="${x}" aria-pressed="${this.f.h === x}">${x === 'all' ? 'Any state' : HEALTH[x].label}</button>`).join(''));
    const uses = s => (s.usage ? s.usage.uses : 0), last = s => (s.usage && s.usage.last ? Date.parse(s.usage.last) : 0);
    const order = { used: (a, b) => uses(b) - uses(a) || last(b) - last(a), recent: (a, b) => last(b) - last(a) || uses(b) - uses(a),
      heavy: (a, b) => ((b.weight && b.weight.loaded) || 0) - ((a.weight && a.weight.loaded) || 0), name: () => 0 }[this.f.sort];
    const list = all.filter(s => (this.f.src === 'all' || s.source === this.f.src) && (this.f.h === 'all' || s.health === this.f.h) &&
      (!this.f.q || `${s.name} ${s.description} ${s.group}`.toLowerCase().includes(this.f.q)))
      .sort((a, b) => order(a, b) || a.name.localeCompare(b.name));
    // 30 days, oldest first; each cell is a day, shaded by how many times the skill was loaded
    const days = [...Array(30)].map((_, k) => new Date(Date.now() - (29 - k) * 86400000).toISOString().slice(0, 10));
    const peak = Math.max(1, ...list.map(s => Math.max(0, ...days.map(d => (s.usage && s.usage.days && s.usage.days[d]) || 0))));
    const strip = s => {
      const by = (s.usage && s.usage.days) || {};
      const n30 = days.reduce((n, d) => n + (by[d] || 0), 0);
      return `<span class="x-strip" role="img" aria-label="${n30} uses in the last 30 days">${days.map(d => { const n = by[d] || 0; const lv = !n ? 0 : Math.min(4, Math.ceil(4 * n / peak)); return `<i class="l${lv}" title="${d}: ${n}"></i>`; }).join('')}</span>`;
    };
    const maxLoad = Math.max(1, ...list.map(s => (s.weight && s.weight.loaded) || 0));
    const head = `<div class="x-lrow x-lhead" role="row"><span role="columnheader"><span class="sr-only">On</span></span><span role="columnheader">Skill</span><span role="columnheader" class="x-lc-strip">Last 30 days</span><span role="columnheader" class="x-lc-num">Uses</span><span role="columnheader" class="x-lc-last">Last used</span><span role="columnheader" class="x-lc-w" title="Tokens when Claude loads it; the small number is what it costs every session just by being listed">Size when loaded</span><span role="columnheader">State</span></div>`;
    const row = s => `<div class="x-lrow ${s.enabled ? '' : 'is-off'} ${uses(s) ? '' : 'is-idle'}" role="row" data-skill="${s.i}" tabindex="0" aria-label="${esc(s.name)}: details">
        <span role="cell">${s.toggle ? `<button class="x-switch" type="button" role="switch" aria-checked="${s.enabled}" data-i="${s.i}" aria-label="${esc(s.name)} ${s.enabled ? 'on' : 'off'}" title="${s.toggle === 'plugin' ? 'Switches the whole plugin' : s.enabled ? 'Turn off' : 'Turn on'}"><i></i></button>` : `<span class="x-lock" title="${s.source === 'claude.ai' ? 'Managed in your claude.ai settings' : 'Part of Claude Code'}" aria-label="managed elsewhere">⊘</span>`}</span>
        <span role="cell" class="x-lname"><b>${esc(s.name)}</b><small>${esc(s.group && s.group !== s.name ? s.group : SOURCE_LABEL[s.source] || s.source)}</small></span>
        <span role="cell" class="x-lc-strip">${strip(s)}</span>
        <span role="cell" class="x-lc-num">${uses(s) || '–'}</span>
        <span role="cell" class="x-lc-last">${s.usage && s.usage.last ? esc(ago(s.usage.last)) : 'never'}</span>
        <span role="cell" class="x-lc-w"><span class="x-wmeter"${s.weight && s.weight.loaded ? '' : ' hidden'}><i style="width:${(100 * ((s.weight && s.weight.loaded) || 0) / maxLoad).toFixed(0)}%"></i></span><span class="x-wnum">${s.weight && s.weight.loaded ? `${kf(s.weight.loaded)}<small>${kf(s.weight.listed)} per session</small>` : '<span class="sub" title="Built into Claude Code: its size is not visible here">–</span>'}</span></span>
        <span role="cell">${healthChip(s.health)}</span></div>`;
    setHTML($('#sk-list'), (list.length ? head + list.map(row).join('') : '<div class="empty">No skill matches these filters. Clear the search or pick All.</div>') +
      (SKD.orphans.length && this.f.src === 'all' && !this.f.q ? `<div class="x-sk-orphans"><b>Used, but not installed here</b> <span class="sub">skills or commands that appear in your transcripts</span>
        <div class="tools">${SKD.orphans.map(o => `<span class="chip" title="${esc(usageLine(o.usage))}">${esc(o.id)} · ${o.usage.uses}</span>`).join('')}</div></div>` : ''));
  },
};

// ---------------------------------------------------------------- finder: Claude searches GitHub, then quarantine + scan + install
function openFinder(prefill) {
  const m = modal(`<div class="x-finder">
      <div class="x-eyebrow">Claude searches GitHub for you</div><h2 class="x-title">Find skills for a task</h2>
      <p class="sub">Claude looks for skills (folders with a SKILL.md) that fit your task, opens each one and rates its safety. Nothing is installed until you inspect it: Anchor downloads it into a quarantine folder, scans every file, and installs only when you say so.</p>
      <form id="fd" class="x-form"><textarea class="field" name="task" rows="2" required placeholder="e.g. turn my research notes into slide decks, review pull requests, write Kaggle notebooks">${esc(prefill || '')}</textarea>
        <div class="tools"><select class="field" name="cwd" aria-label="Project" title="Claude reads this project's notes and memory first, so it knows what your work is"><option value="">No specific project</option></select>
        <select class="field" name="model"><option value="sonnet">Sonnet · faster, cheaper</option><option value="opus">Opus · more thorough</option></select>
        <button class="btn primary" type="submit">Search with Claude</button>
        <span class="sub">or inspect a repository yourself:</span><input class="field" name="repo" placeholder="https://github.com/owner/repo"><input class="field" name="path" placeholder="folder (optional)"><button class="btn" type="button" id="fd-inspect">Inspect</button></div></form>
      <div id="fd-run"></div><div id="fd-results"></div>
      <div id="fd-past"></div></div>`, { wide: true });
  const run = m.el.querySelector('#fd-run'), results = m.el.querySelector('#fd-results');
  let rv = null;
  const show = id => {
    if (rv) rv.stop();
    results.innerHTML = '';
    rv = runView(run, id, { compact: true, onDone: r => renderFound(results, r.skills) });
  };
  m.el.querySelector('#fd').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { const r = await api('/api/runs', { method: 'POST', body: { kind: 'skills', task: f.task, model: f.model, cwd: f.cwd || undefined } }); show(r.id); } catch (err) { toast(err.message); }
  });
  // projects to choose from; the most recently active one is preselected
  api('/api/projects').then(ps => {
    const sel = m.el.querySelector('[name="cwd"]');
    const list = ps.filter(p => p.cwd && p.exists);
    sel.insertAdjacentHTML('beforeend', list.map((p, i) => `<option value="${esc(p.cwd)}" ${i === 0 ? 'selected' : ''}>For ${esc(p.name)}</option>`).join(''));
  }).catch(() => {});
  m.el.querySelector('#fd-inspect').onclick = () => {
    const f = Object.fromEntries(new FormData(m.el.querySelector('#fd')));
    inspectRepo(f.repo, f.path);
  };
  api('/api/runs').then(rs => {
    const past = rs.filter(r => r.kind === 'skills').slice(0, 8);
    if (past.length) m.el.querySelector('#fd-past').innerHTML = `<h3>Earlier searches</h3><div class="x-list">${past.map(r => `<button class="x-row" type="button" data-run="${esc(r.id)}"><b>${esc(r.task || r.title)}</b><span class="sub">${esc(ago(r.startedAt))} · ${esc(r.status)}${r.skills ? ` · ${r.skills.length} found` : ''}</span></button>`).join('')}</div>`;
  }).catch(() => {});
  m.el.querySelector('#fd-past').addEventListener('click', e => { const b = e.target.closest('[data-run]'); if (b) show(b.dataset.run); });
}

function renderFound(el, list) {
  if (!list) { el.innerHTML = '<div class="empty">Claude did not return a usable list this time. Read its answer above, or search again.</div>'; return; }
  if (!list.length) { el.innerHTML = '<div class="empty">No suitable skill found.</div>'; return; }
  const badge = { safe: ['ok', 'Looks safe'], review: ['', 'Read first'], avoid: ['bad', 'Avoid'] };
  el.innerHTML = `<h3>What Claude found</h3><div class="x-grid">${list.map((s, i) => `<div class="x-card x-found s-${s.safety}">
      <div class="x-skill-top"><span class="x-glyph">${esc((s.name[0] || '?').toUpperCase())}</span><div class="x-skill-name"><b>${esc(s.name)}</b><span class="x-mono">${esc(s.repo.replace('https://github.com/', ''))}${s.path ? '/' + esc(s.path) : ''}</span></div>
      <span class="chip ${badge[s.safety][0]}">${badge[s.safety][1]}</span></div>
      <p class="x-desc">${esc(s.why)}</p>${s.notes ? `<p class="sub">${esc(s.notes)}</p>` : ''}
      <div class="tools"><a class="btn" href="${esc(s.repo)}${s.path ? '/tree/HEAD/' + esc(s.path) : ''}" target="_blank" rel="noopener noreferrer">Open on GitHub</a>
        ${s.safety === 'avoid' ? '' : `<button class="btn primary" type="button" data-ins="${i}">Inspect &amp; install</button>`}</div></div>`).join('')}</div>`;
  el.onclick = e => { const b = e.target.closest('[data-ins]'); if (b) { const s = list[b.dataset.ins]; inspectRepo(s.repo, s.path); } };
}

async function inspectRepo(repo, sub) {
  const m = modal('<div class="x-thinking"><i></i><i></i><i></i> Downloading into quarantine and scanning every file…</div>', { wide: true });
  let meta;
  try { meta = await api('/api/hub/inspect', { method: 'POST', body: { repo, path: sub } }); } catch (e) { m.el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const danger = meta.flags.filter(f => f.level === 'danger'), review = meta.flags.filter(f => f.level === 'review');
  const verdict = danger.length ? ['bad', `${danger.length} serious warning${danger.length > 1 ? 's' : ''}`] : review.length ? ['', `${review.length} thing${review.length > 1 ? 's' : ''} to read first`] : ['ok', 'No risky patterns found'];
  m.el.innerHTML = `<div class="x-eyebrow">Quarantine · nothing has been run or installed</div><h2 class="x-title">${esc(repo.replace('https://github.com/', ''))}${meta.sub ? '/' + esc(meta.sub) : ''}</h2>
    <div class="tools" style="margin:6px 0 14px"><span class="chip ${verdict[0]}">${verdict[1]}</span><span class="chip">${meta.fileCount} files</span><span class="chip x-mono">commit ${esc(meta.commit.slice(0, 8))}</span></div>
    ${meta.flags.length ? `<div class="x-flags">${meta.flags.slice(0, 40).map(f => `<div class="x-flag ${f.level}"><b>${f.level === 'danger' ? 'Danger' : 'Review'}</b><span>${esc(f.why)}</span><span class="x-mono">${esc(f.file)}${f.line ? ':' + f.line : ''}</span>${f.match ? `<code>${esc(f.match)}</code>` : ''}</div>`).join('')}</div>` : ''}
    ${meta.skills.length ? meta.skills.map((s, i) => `<details class="plan x-panel" ${i === 0 ? 'open' : ''}><summary>${esc(s.name)} <span class="sub">${esc(s.rel || '(repository root)')}</span></summary>
        <p class="sub">${esc(s.description)}</p><div class="bubble x-skill-md">${md(s.skillMd.replace(/^---[\s\S]*?---/, ''))}</div>
        <div class="tools" style="margin-top:12px"><input class="field" data-name="${i}" value="${esc(s.name.replace(/\s+/g, '-'))}" aria-label="Folder name">
          <label class="x-check"><input type="checkbox" data-ack="${i}"> I read the instructions${danger.length ? ' and the warnings' : ''}</label>
          <button class="btn primary" type="button" data-install="${i}" disabled>Install to ~/.claude/skills</button></div></details>`).join('')
    : '<div class="empty">No SKILL.md found in that folder.</div>'}
    <h3>Files</h3><div class="x-files">${meta.files.slice(0, 200).map(f => `<button type="button" class="x-file" data-rel="${esc(f.rel)}"><span class="x-mono">${esc(f.rel)}</span><span class="sub">${bytes(f.size)}</span></button>`).join('')}</div>
    <pre class="x-fileview" id="hub-file" hidden></pre>
    <div class="tools" style="margin-top:14px"><button class="btn" type="button" id="hub-discard">Discard download</button></div>`;
  m.el.addEventListener('change', e => { const c = e.target.closest('[data-ack]'); if (c) m.el.querySelector(`[data-install="${c.dataset.ack}"]`).disabled = !c.checked; });
  m.el.addEventListener('click', async e => {
    const f = e.target.closest('[data-rel]');
    if (f) {
      try { const r = await api(`/api/hub/${meta.id}/file?rel=${encodeURIComponent(f.dataset.rel)}`); const v = m.el.querySelector('#hub-file'); v.hidden = false; v.innerHTML = r.text.split('\n').map(l => hl(l, langOf(f.dataset.rel))).join('\n'); v.scrollIntoView({ block: 'nearest' }); } catch (err) { toast(err.message); }
    }
    const b = e.target.closest('[data-install]');
    if (b) {
      const s = meta.skills[b.dataset.install];
      try { const r = await api('/api/hub/install', { method: 'POST', body: { id: meta.id, rel: s.rel, name: m.el.querySelector(`[data-name="${b.dataset.install}"]`).value } }); toast(`Installed to ${r.dest}`); refreshSkillViews(true); m.close(); } catch (err) { toast(err.message); }
    }
    if (e.target.closest('#hub-discard')) { await api(`/api/hub/${meta.id}`, { method: 'DELETE' }).catch(() => {}); toast('Download discarded'); m.close(); }
  });
}

