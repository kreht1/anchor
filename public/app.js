'use strict';
/* Anchor front end: plain JS, no build step. Views mount once and then refresh their live parts only,
   so typing, scrolling and open panels survive the 3-second refresh. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let O = null;               // latest overview from the server
let current = null;         // mounted view {name, key, update, unmount}
const lastStatus = new Map();
let notifyOn = false;
try { notifyOn = localStorage.getItem('anchor-notify') === '1' && 'Notification' in window && Notification.permission === 'granted'; } catch { /* ignore */ }

// ---------------------------------------------------------------- helpers
async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (init.method && init.method !== 'GET') {
    init.headers['x-anchor'] = '1';
    if (init.body && typeof init.body !== 'string') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(init.body); }
  }
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

const ms = ts => (ts ? (typeof ts === 'number' ? ts : Date.parse(ts)) : NaN);
function ago(ts) {
  const t = ms(ts); if (isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function dur(sec) {
  if (sec == null || isNaN(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
function bytes(n) {
  if (n == null || isNaN(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
const rate = n => (n == null ? '–' : `${bytes(n)}/s`);
const clock = ts => { const t = ms(ts); return isNaN(t) ? '' : new Date(t).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }); };

function spark(values, color = 'var(--run)', { max = null, cls = 'spark' } = {}) {
  const v = (values || []).map(x => (x == null ? null : Number(x)));
  const pts = v.filter(x => x != null);
  if (pts.length < 2) return `<svg class="${cls}" aria-hidden="true"></svg>`;
  const top = max ?? Math.max(...pts, 1e-9);
  const W = 100, H = 30, n = v.length;
  let d = '', first = null, last = null;
  v.forEach((x, i) => {
    if (x == null) return;
    const px = (i / (n - 1)) * W, py = H - (Math.min(x, top) / top) * (H - 2) - 1;
    d += `${d ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
    if (first == null) first = px; last = px;
  });
  return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}L${last},${H}L${first},${H}Z" fill="${color}" opacity="0.14"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------------------------------------------------------------- neon rings & counting numbers
const RING_R = 22, RING_C = 2 * Math.PI * RING_R;
function ring(grad, frac, label) {
  const f = Math.max(0, Math.min(1, frac || 0));
  return `<svg class="ring" viewBox="0 0 54 54" aria-hidden="true"><circle class="track" cx="27" cy="27" r="${RING_R}"/>
    <circle class="arc" cx="27" cy="27" r="${RING_R}" stroke="url(#${grad})" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - f)}" transform="rotate(-90 27 27)"/>
    <text x="27" y="28">${esc(label ?? '')}</text></svg>`;
}
// updates a ring in place so the arc glides instead of jumping
function setRing(svg, frac, label) {
  if (!svg) return;
  const f = Math.max(0, Math.min(1, frac || 0));
  svg.querySelector('.arc').setAttribute('stroke-dashoffset', RING_C * (1 - f));
  svg.querySelector('text').textContent = label ?? '';
}
function countTo(el, value, fmt = v => Math.round(v)) {
  if (!el) return;
  const from = Number(el.dataset.v || 0), to = Number(value) || 0;
  el.dataset.v = to;
  if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// 3D tilt + holographic sheen that follows the pointer on any .tilt surface
document.addEventListener('pointermove', e => {
  const el = e.target.closest && e.target.closest('.tilt');
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const k = Math.min(1, 260 / Math.max(r.width, 1)) * 6;
  el.style.setProperty('--ry', `${(x - 0.5) * k}deg`);
  el.style.setProperty('--rx', `${(0.5 - y) * k}deg`);
  el.style.setProperty('--mx', `${x * 100}%`);
  el.style.setProperty('--my', `${y * 100}%`);
});
document.addEventListener('pointerout', e => {
  const el = e.target.closest && e.target.closest('.tilt');
  if (el && !el.contains(e.relatedTarget)) { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); }
});

// ---------------------------------------------------------------- markdown (escape first, then a small safe subset)
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const url = u.replace(/&amp;/g, '&');
    return /^https?:\/\//i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<span title="${esc(url)}">${t}</span>`;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
function md(src) {
  if (!src) return '';
  const blocks = [];
  let text = String(src).replace(/```([\w+-]*)[^\n]*\n([\s\S]*?)(```|$)/g, (_, lang, code) => `\n\u0001${blocks.push(code.replace(/\n$/, '')) - 1}\u0001\n`);
  text = esc(text);
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\u0001(\d+)\u0001$/.exec(l.trim());
    if (fence) { out.push(`<pre><code>${esc(blocks[fence[1]])}</code></pre>`); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { const n = Math.min(4, h[1].length + 1); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(l); i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*&gt;\s?/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${inline(q.join('<br>'))}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) { items.push({ d: m[1].length, t: m[3] }); i++; continue; }
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].t += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const base = items[0].d;
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(it => `<li${it.d > base ? ' style="margin-left:1.2em"' : ''}>${inline(it.t.replace(/^\[( |x)\]\s*/i, (_, x) => (x.trim() ? '☑ ' : '☐ ')))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s|^\s*([-*+]|\d+[.)])\s|^\u0001|^\s*&gt;/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++]);
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
    else i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------- shared components
const STATUS_LABEL = { running: 'Running', completed: 'Done', failed: 'Failed', killed: 'Killed', stopped: 'Stopped', ended: 'Ended', 'ended?': 'Ended' };
function statusChip(s) {
  const cls = s === 'running' ? 'run' : s === 'completed' ? 'ok' : s === 'failed' || s === 'killed' ? 'bad' : '';
  return `<span class="chip ${cls}">${s === 'running' ? '<span class="pulse"></span>' : ''}${esc(STATUS_LABEL[s] || s || 'Unknown')}</span>`;
}
function kindLabel(t) { return t.kind === 'job' ? `Run${t.stage ? ` · ${t.stage}` : ''}${t.pid ? ` · pid ${t.pid}` : ''}` : t.kind === 'agent' ? `Agent${t.agentType ? ` (${t.agentType})` : ''}` : t.kind === 'monitor' ? 'Monitor' : t.download ? 'Download' : 'Shell'; }

function taskStrip(t, { tail = true } = {}) {
  const running = t.status === 'running';
  const started = ms(t.startedAt);
  const elapsed = running && !isNaN(started) ? (Date.now() - started) / 1000 : null;
  const p = t.progress && t.progress.pct;
  const title = t.description || t.command || t.summary || t.id;
  const lastOut = t.output && t.output.mtime ? `output ${ago(t.output.mtime)}` : '';
  return `<button class="fs tilt" data-s="${esc(t.status)}" data-task="${esc(t.sessionId)}|${esc(t.id)}" type="button">
    <span class="bar"></span>
    <span class="body">
      <span class="title" style="display:block">${esc(title)}</span>
      <span class="meta" style="display:block">${esc(t.project || '')} · ${esc(kindLabel(t))}${t.output && t.output.size != null ? ` · ${bytes(t.output.size)} log` : ''}${lastOut ? ` · ${lastOut}` : ''}</span>
      ${running ? `<span class="prog ${p == null ? 'indet' : ''}" style="display:block"><i style="width:${p ?? 0}%"></i></span>` : ''}
      ${running && tail && t.tail ? `<span class="tail" style="display:block">${esc(t.tail.trim().split('\n').slice(-2).join('\n'))}</span>` : ''}
      ${!running && t.summary ? `<span class="meta" style="display:block">${esc(t.summary)}</span>` : ''}
    </span>
    <span class="side">
      ${running ? `<span class="num">${p != null ? `${p}%` : esc(dur(elapsed))}</span><span>${p != null ? esc(dur(elapsed)) : 'running'}</span>`
    : `${statusChip(t.status)}<span>${esc(ago(t.endedAt || t.output?.mtime || t.startedAt))}</span>`}
    </span>
  </button>`;
}

function sessionRow(s) {
  const live = s.live ? `<span class="state ${s.live.status === 'busy' ? 'busy' : 'idle'}">${s.live.status === 'busy' ? '<span class="pulse"></span>Working' : 'Waiting for you'}</span>` : `<span>${esc(ago(s.lastTs))}</span>`;
  const busy = s.live && s.live.status === 'busy';
  return `<a class="sess tilt ${s.live ? 'live' : ''} ${busy ? 'busy' : ''}" href="#/chats/${encodeURIComponent(s.id)}">
    <span class="idx">${esc((s.project || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase())}<b>${busy ? '♦' : s.live ? '♠' : '♣'}</b></span>
    <span class="t">${esc(s.title)}</span><span class="m">${live}</span>
    <span class="proj">${esc(s.project)} · ${s.prompts} message${s.prompts === 1 ? '' : 's'}${s.tasksRunning ? ` · <span style="color:var(--run)">${s.tasksRunning} running</span>` : ''}</span>
    <span class="m">${s.cost != null ? `$${s.cost.toFixed(2)}` : ''}</span>
    ${s.lastPrompt ? `<span class="p">You: ${esc(s.lastPrompt.replace(/\s+/g, ' ').slice(0, 220))}</span>` : ''}
  </a>`;
}

function bindTaskClicks(root) {
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-task]');
    if (!b) return;
    const [sid, tid] = b.dataset.task.split('|');
    openTask(sid, tid);
  });
}

// ---------------------------------------------------------------- status strip
function renderStrip() {
  const strip = $('#strip');
  if (!strip.dataset.ready) {
    strip.innerHTML = `<div id="readouts">
        <div class="readout"><div id="r-live-ring">${ring('g-aurora', 0, '0')}</div><div><div class="v"><span id="r-live">0</span><small>live</small></div><div class="k" id="r-live-k">Claude sessions</div></div></div>
        <div class="readout" id="r-run-box"><div id="r-run-ring">${ring('g-solar', 0, '0')}</div><div><div class="v"><span id="r-run">0</span></div><div class="k">tasks in flight</div></div></div>
        <div class="readout" id="r-gpu-box"><div id="r-gpu-ring">${ring('g-violet', 0, '–')}</div><div><div class="v"><span id="r-gpu">0</span><small>%</small></div><div class="k" id="r-gpu-k">GPU</div></div></div>
        <div class="readout"><div><div class="v" id="r-net">–</div><div class="k">download speed</div></div><div id="r-net-spark"></div></div>
        <div class="readout"><div id="r-cpu-ring">${ring('g-mint', 0, '–')}</div><div><div class="v"><span id="r-cpu">0</span><small>%</small></div><div class="k">CPU</div></div></div>
      </div>
      <div class="search" role="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Search every conversation  ( / )" aria-label="Search every conversation" autocomplete="off"><div class="results" id="results" hidden></div></div>`;
    strip.dataset.ready = '1';
    bindSearch();
  }
  if (!O) return;
  const sys = O.system || {};
  const g = sys.gpu && sys.gpu.gpus && sys.gpu.gpus[0];
  const live = O.sessions.filter(s => s.live);
  const busy = live.filter(s => s.live.status === 'busy').length;
  const running = O.tasks.filter(t => t.status === 'running').length;
  countTo($('#r-live'), live.length);
  setRing($('#r-live-ring svg'), live.length ? busy / live.length || 0.15 : 0, busy ? `${busy}` : '·');
  $('#r-live-k').textContent = busy ? `${busy} working now` : live.length ? 'waiting for you' : 'Claude sessions';
  countTo($('#r-run'), running);
  setRing($('#r-run-ring svg'), Math.min(1, running / 5), String(running));
  $('#r-run-box').classList.toggle('run', running > 0);
  $('#r-gpu-box').hidden = !g;
  if (g) {
    countTo($('#r-gpu'), g.util || 0);
    setRing($('#r-gpu-ring svg'), (g.memUsedMB || 0) / (g.memTotalMB || 1), `${Math.round(((g.memUsedMB || 0) / (g.memTotalMB || 1)) * 100)}`);
    $('#r-gpu-k').textContent = `GPU · ${bytes((g.memUsedMB || 0) * 1048576)} memory`;
  }
  $('#r-net').textContent = sys.net ? rate(sys.net.rx) : '–';
  setHTML($('#r-net-spark'), spark(sys.history && sys.history.net, 'var(--done)'));
  const cpu = sys.cpu && sys.cpu.pct != null ? sys.cpu.pct : 0;
  countTo($('#r-cpu'), cpu);
  setRing($('#r-cpu-ring svg'), cpu / 100, `${Math.round(cpu)}`);
}

// replaces markup only when it changed, so entrance animations and hover state are not replayed every refresh
function setHTML(el, html) {
  if (el && el._html !== html) { el.innerHTML = html; el._html = html; }
}

let searchTimer = null;
function bindSearch() {
  const q = $('#q'), box = $('#results');
  q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const s = q.value.trim();
    if (s.length < 2) { box.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const hits = await api('/api/search?q=' + encodeURIComponent(s)).catch(() => []);
      const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
      box.innerHTML = hits.length ? hits.map(h => `<a class="result" href="#/chats/${encodeURIComponent(h.sessionId)}?at=${encodeURIComponent(h.ts || '')}">
          <div class="meta">${esc(h.project)} · ${esc(h.title || '')} · ${h.role === 'you' ? 'you' : 'Claude'} · ${esc(ago(h.ts))}</div>
          <div>${esc(h.snippet).replace(re, m => `<mark>${m}</mark>`)}</div></a>`).join('')
        : `<div class="result">Nothing matches “${esc(s)}”.</div>`;
      box.hidden = false;
    }, 220);
  });
  box.addEventListener('click', e => { if (e.target.closest('a')) { box.hidden = true; } });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) box.hidden = true; });
}

// ---------------------------------------------------------------- views
const views = {};

views.overview = {
  mount(el) {
    this.dealt = false;
    el.innerHTML = `<div class="table">
        <div class="hand" id="hand"><div class="title"><h1>The table</h1><p id="ov-sub">Dealing your sessions…</p></div>
          <div class="hint"><span class="suit-d">♦</span> working · <span class="suit-s">♠</span> waiting for you · <span class="suit-c">♣</span> closed · click a card to open it</div></div>
        <div class="pot"><div class="stat" id="st-run"><div class="v" id="st-run-v">0</div><div class="k">tasks in play</div></div>
          <div class="stat"><div class="v" id="st-live-v">0</div><div class="k">live sessions</div></div>
          <div class="stat"><div class="v" id="st-proj-v">0</div><div class="k">projects on the table</div></div></div></div>
      <div class="grid-2"><div id="ov-left"></div><div id="ov-right"></div></div>`;
    bindTaskClicks(el);
  },
  update() {
    const running = O.tasks.filter(t => t.status === 'running');
    const day = Date.now() - 86400e3;
    const recent = O.tasks.filter(t => t.status !== 'running' && ms(t.endedAt || t.output?.mtime || t.startedAt) > day).slice(0, 6);
    const sys = O.system || {};
    const dls = O.tasks.filter(t => t.download && t.status === 'running');
    const live = O.sessions.filter(s => s.live);
    const idle = O.sessions.filter(s => !s.live).slice(0, 5);
    const doing = O.board.filter(i => i.status === 'doing');
    const todo = O.board.filter(i => i.status === 'todo').sort((a, b) => (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0));
    const projects = new Set(O.sessions.map(s => s.project)).size;
    const busyN = live.filter(s => s.live.status === 'busy').length;
    $('#ov-sub').textContent = busyN ? `Claude is playing ${busyN} hand${busyN > 1 ? 's' : ''} right now.` : live.length ? 'Your move: Claude is waiting for you.' : 'All quiet. Your latest sessions are dealt below.';
    const rest = idle.slice(0, Math.max(0, 7 - live.length));
    const hand = [...rest.slice(0, Math.ceil(rest.length / 2)), ...live.slice(0, 7), ...rest.slice(Math.ceil(rest.length / 2))]; // live cards in the middle of the fan
    const step = hand.length > 5 ? 8 : 10;
    const old = $('#hand');
    const sig = hand.map(s => `${s.id}:${s.live ? s.live.status : ''}:${s.prompts}:${s.title}`).join('|');
    if (old._sig !== sig) {
    old._sig = sig;
    $$('.pcard', old).forEach(c => c.remove());
    old.insertAdjacentHTML('beforeend', hand.map((s, i) => {
      const busy = s.live && s.live.status === 'busy';
      const suit = busy ? '♦' : s.live ? '♠' : '♣';
      const accent = busy ? 'var(--dia)' : s.live ? 'var(--spade)' : 'var(--ink)';
      const rank = esc((s.project || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?');
      return `<a class="pcard ${s.live ? 'live' : ''} ${busy ? 'busy' : ''}" href="#/chats/${encodeURIComponent(s.id)}" style="--rot:${((i - (hand.length - 1) / 2) * step).toFixed(1)}deg;${s.live ? "z-index:10;" : ""}--d:${this.dealt ? 0 : i * 80}ms;--accent:${accent};${this.dealt ? 'animation:none' : ''}" title="${esc(s.title)}">
        <span class="idx tl">${rank}<b>${suit}</b></span><span class="pip">${suit}</span>
        <span class="pt">${esc(s.title)}</span><span class="pp">${esc(s.project)} · ${s.prompts} msg${busy ? ' · working' : ''}</span>
        <span class="idx br">${rank}<b>${suit}</b></span></a>`;
    }).join(''));
    this.dealt = true; // the deal animation plays once per visit, not on every refresh
    }
    countTo($('#st-run-v'), running.length); $('#st-run').classList.toggle('hot', running.length > 0);
    countTo($('#st-live-v'), live.length); countTo($('#st-proj-v'), projects);
    setHTML($('#ov-left'), `
      <section><div class="section-head"><h2>Running now</h2><a href="#/tasks">All tasks</a></div>
        ${running.length ? `<div class="strips">${running.map(t => taskStrip(t)).join('')}</div>` : '<div class="empty">Nothing is running. Background commands and agents that Claude starts show up here with their live output.</div>'}</section>
      <section><div class="section-head"><h2>Downloads</h2><a href="#/downloads">Details</a></div>
        <div class="dl"><span class="n">Network</span><span class="r">${sys.net ? `↓ ${rate(sys.net.rx)}  ↑ ${rate(sys.net.tx)}` : 'measuring…'}</span>${spark(sys.history && sys.history.net, 'var(--done)')}</div>
        ${dls.length ? '' : (sys.partials || []).length || (sys.watch || []).length ? '' : '<div class="empty">No downloads in progress.</div>'}
        ${(sys.partials || []).map(dlRow).join('')}${(sys.watch || []).filter(w => !w.missing).map(dlRow).join('')}
        ${dls.length ? `<div class="sub" style="margin:6px 0">Started by Claude: ${dls.map(t => esc(t.description || t.id)).join(', ')}</div>` : ''}</section>
      <section><div class="section-head"><h2>Finished in the last day</h2></div>
        ${recent.length ? `<div class="strips">${recent.map(t => taskStrip(t, { tail: false })).join('')}</div>` : '<div class="empty">No tasks finished in the last 24 hours.</div>'}</section>`);
    setHTML($('#ov-right'), `
      <section><div class="section-head"><h2>Live sessions</h2><a href="#/chats">All conversations</a></div>
        ${live.length ? `<div class="sessions">${live.map(sessionRow).join('')}</div>` : '<div class="empty">No Claude Code session is open right now.</div>'}
        ${live.filter(s => s.lastClaude).slice(0, 2).map(s => `<div class="voice"><div class="sub">Latest from Claude in ${esc(s.project)} · ${esc(ago(s.lastClaudeTs))}</div><div class="bubble" style="max-height:220px;overflow:auto">${md(s.lastClaude)}</div></div>`).join('')}</section>
      <section><div class="section-head"><h2>Next up</h2><a href="#/board">Board</a></div>
        ${doing.length + todo.length ? `<div class="sessions">${[...doing, ...todo].slice(0, 7).map(i => `<a class="sess" href="#/board"><span class="t">${esc(i.title)}</span><span class="m">${i.status === 'doing' ? '<span class="state busy">In progress</span>' : 'Planned'}</span><span class="proj">${esc(i.project || 'No project')}${i.source === 'claude' ? ' · added by Claude' : ''}</span></a>`).join('')}</div>`
    : '<div class="empty">The board is empty. Add work on the Board page, or ask Claude to plan something and it will appear here.</div>'}</section>
      <section><div class="section-head"><h2>Recent sessions</h2></div><div class="sessions">${idle.map(sessionRow).join('')}</div></section>`);
  },
};

function dlRow(d) {
  return `<div class="dl tilt"><span class="n" title="${esc(d.path)}">${esc(d.label || d.path)}</span>
    <span class="r">${bytes(d.size)}${d.target ? ` of ${bytes(d.target)}` : ''}${d.rate ? ` · ${rate(d.rate)}` : ''}${d.eta ? ` · ${dur(d.eta)} left` : ''}</span>
    ${d.line ? `<span class="tail" style="grid-column:1/3;font-family:var(--mono);font-size:12px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.line)}</span>` : ''}
    <span class="pth">${esc(d.path)}${d.files ? ` · ${d.files} files` : ''}</span><span class="r" style="font-size:12px;color:var(--ink-3)">${d.mtime ? `changed ${esc(ago(d.mtime))}` : ''}</span>
    ${d.pct != null ? `<span class="prog"><i style="width:${d.pct.toFixed(1)}%;background:var(--done)"></i></span>` : ''}</div>`;
}

// ---- conversations
let chat = null; // {id, items, start, total, live}
views.chats = {
  mount(el, args) {
    el.innerHTML = `<div class="chat-layout"><div class="chat-list"><div class="filter"><input id="chat-filter" type="search" placeholder="Filter sessions" aria-label="Filter sessions"></div><div id="chat-items"></div></div>
      <div class="reader" id="reader"><div class="thread"><div class="empty">Pick a conversation on the left. Every Claude Code session on this computer is listed, newest first.</div></div></div></div>`;
    $('#chat-filter').addEventListener('input', () => views.chats.update());
    this.open(args[0]);
  },
  key: args => 'chats',
  route(args, query) { this.open(args[0], query.get('at')); },
  update() {
    const f = ($('#chat-filter') || {}).value?.toLowerCase() || '';
    const groups = new Map();
    for (const s of O.sessions) {
      if (f && !(`${s.title} ${s.project} ${s.lastPrompt || ''}`.toLowerCase().includes(f))) continue;
      if (!groups.has(s.project)) groups.set(s.project, []);
      groups.get(s.project).push(s);
    }
    const sel = chat && chat.id;
    setHTML($('#chat-items'), [...groups].map(([p, list]) => `<div class="group">${esc(p)}</div>${list.map(s => `<a class="chat-item" href="#/chats/${encodeURIComponent(s.id)}" ${s.id === sel ? 'aria-current="page"' : ''}>
        <div class="t">${s.live ? '<span class="pulse" style="background:var(--done)"></span>' : ''}${esc(s.title)}</div><div class="m">${esc(ago(s.lastTs))} · ${s.prompts} msg${s.cost != null ? ` · $${s.cost.toFixed(2)}` : ''}</div></a>`).join('')}`).join('') || '<div class="empty" style="margin:12px">No sessions match.</div>');
    if (chat && chat.live) refreshChat();
  },
  async open(id, at) {
    if (!id) { chat = null; return; }
    if (chat && chat.id === id) { if (at) scrollToTs(at); return; }
    chat = { id, items: [], start: 0, total: 0, showTools: (localStorage.getItem('anchor-tools') ?? '1') === '1' };
    $('#reader').innerHTML = '<div class="thread"><div class="empty">Loading conversation…</div></div>';
    try {
      const c = await api(`/api/session/${encodeURIComponent(id)}?limit=300`);
      Object.assign(chat, { items: c.items, start: c.start, total: c.total, session: c.session, live: !!c.session.live });
      renderReader();
      if (at) scrollToTs(at); else { const r = $('#reader'); r.scrollTop = r.scrollHeight; }
      if (O) views.chats.update();
    } catch (e) { $('#reader').innerHTML = `<div class="thread"><div class="empty">Could not open this conversation: ${esc(e.message)}</div></div>`; }
  },
  unmount() { chat = null; },
};

function itemHtml(it, idx) {
  const when = `<span title="${esc(clock(it.ts))}">${esc(clock(it.ts))}</span>`;
  switch (it.k) {
    case 'you': return `<div class="msg you" data-ts="${esc(it.ts)}" data-i="${idx}"><div class="who"><span class="av">Y</span><b>You</b>${when}${it.images ? ` · ${it.images} image${it.images > 1 ? 's' : ''}` : ''}</div><div class="bubble">${md(it.text)}</div></div>`;
    case 'claude': return `<div class="msg claude" data-ts="${esc(it.ts)}" data-i="${idx}"><div class="who"><span class="av">✦</span><b>Claude</b>${when}</div><div class="bubble">${md(it.text)}</div></div>`;
    case 'tool': return `<details class="toolrow ${it.isError ? 'err' : ''}" data-ts="${esc(it.ts)}"><summary><b>${esc(it.name)}</b><span>${esc(it.summary)}</span>${it.bg ? `<button class="chip run" type="button" data-task="${esc(chat.id)}|${esc(it.bg)}">task ${esc(it.bg)}</button>` : ''}</summary>
        <pre>${esc(it.input)}</pre>${it.result != null ? `<pre>${esc(it.result)}</pre>` : ''}</details>`;
    case 'event': return `<div class="event" data-ts="${esc(it.ts)}"><span>${esc(it.text)} · ${esc(clock(it.ts))}</span></div>`;
    case 'divider': return `<div class="divider">${esc(it.text)} · ${esc(clock(it.ts))}</div>`;
    case 'summary': return `<details class="summary-box"><summary>Summary written when the conversation was compacted</summary><div class="bubble">${md(it.text)}</div></details>`;
    case 'error': return `<div class="event"><span style="color:var(--fail)">${esc(it.text)}</span></div>`;
    default: return '';
  }
}

function checklist(s) {
  const todos = (s.todos || []).map(t => ({ t: t.content, s: t.status }));
  const list = (s.taskList || []).map(t => ({ t: t.subject, s: t.status }));
  const all = [...todos, ...list];
  if (!all.length) return '';
  const mark = st => (st === 'completed' ? '☑' : st === 'in_progress' ? '◐' : '☐');
  return `<details class="plan" ${s.live ? 'open' : ''}><summary>Claude's checklist (${all.filter(x => x.s === 'completed').length}/${all.length} done)</summary>
    <ul style="list-style:none;padding-left:4px;margin:8px 0 0">${all.map(x => `<li style="${x.s === 'completed' ? 'color:var(--ink-3);text-decoration:line-through' : x.s === 'in_progress' ? 'color:var(--run)' : ''}">${mark(x.s)} ${esc(x.t)}</li>`).join('')}</ul></details>`;
}

function renderReader() {
  const s = chat.session;
  const r = $('#reader');
  const keep = $('#composer'); // survives re-renders: typed text and a running reply stay put
  r.innerHTML = `<div class="reader-head"><h1>${esc(s.title)}</h1>
      <div class="tools">
        ${s.live ? `<span class="chip ${s.live.status === 'busy' ? 'run' : 'ok'}">${s.live.status === 'busy' ? '<span class="pulse"></span>Working' : 'Waiting for you'}</span>` : `<span class="chip">Closed · ${esc(ago(s.lastTs))}</span>`}
        <a class="chip" href="#/project?key=${encodeURIComponent((s.cwd || '').toLowerCase())}">${esc(s.project)}</a>${s.model ? `<span class="chip claude">${esc(s.model)}</span>` : ''}${s.cost != null ? `<span class="chip">$${s.cost.toFixed(2)}</span>` : ''}
        <button class="btn" type="button" id="tg-tools" aria-pressed="${chat.showTools}">Tool calls</button>
        ${s.tasksTotal ? `<a class="btn" href="#/tasks?s=${encodeURIComponent(s.id)}">Tasks (${s.tasksTotal})</a>` : ''}
        ${s.cwd ? `<button class="btn" type="button" id="open-cwd">Open folder in VS Code</button>` : ''}
        <button class="btn" type="button" id="copy-resume" title="claude --resume ${esc(s.id)}">Copy resume command</button>
      </div></div>
    <div class="thread ${chat.showTools ? '' : 'hide-tools'}" id="thread">
      ${checklist(s)}
      ${chat.start > 0 ? `<p style="text-align:center"><button class="btn" type="button" id="earlier">Show ${Math.min(300, chat.start)} earlier items (${chat.start} more)</button></p>` : ''}
      ${chat.items.map((it, i) => itemHtml(it, chat.start + i)).join('')}
    </div>
    <button class="btn jump" type="button" id="jump" hidden>Jump to latest</button>
    ${s.cwd ? composerHtml(s) : ''}`;
  if (keep && keep.dataset.sid === s.id && $('#composer')) $('#composer').replaceWith(keep); else bindComposer(s);
  $('#tg-tools').onclick = () => {
    chat.showTools = !chat.showTools;
    try { localStorage.setItem('anchor-tools', chat.showTools ? '1' : '0'); } catch { /* ignore */ }
    $('#thread').classList.toggle('hide-tools', !chat.showTools);
    $('#tg-tools').setAttribute('aria-pressed', chat.showTools);
  };
  const oc = $('#open-cwd');
  if (oc) oc.onclick = () => api('/api/open', { method: 'POST', body: { path: s.cwd } }).then(() => toast('Opening in VS Code')).catch(e => toast(e.message));
  $('#copy-resume').onclick = () => copy(`claude --resume ${s.id}`, 'Resume command copied');
  const e = $('#earlier');
  if (e) e.onclick = loadEarlier;
  bindTaskClicks($('#thread'));
  r.onscroll = () => { $('#jump').hidden = r.scrollHeight - r.scrollTop - r.clientHeight < 400; };
  $('#jump').onclick = () => { r.scrollTop = r.scrollHeight; };
}

async function loadEarlier() {
  const r = $('#reader');
  const h = r.scrollHeight;
  const c = await api(`/api/session/${encodeURIComponent(chat.id)}?limit=300&before=${chat.start}`);
  chat.items = [...c.items, ...chat.items];
  chat.start = c.start;
  renderReader();
  r.scrollTop = r.scrollHeight - h;
}

let chatBusy = false;
async function refreshChat() {
  if (chatBusy || !chat) return;
  chatBusy = true;
  try {
    const id = chat.id;
    const c = await api(`/api/session/${encodeURIComponent(id)}?limit=300`);
    if (!chat || chat.id !== id) return;
    const changed = c.total !== chat.total || JSON.stringify(c.session.live) !== JSON.stringify(chat.session.live);
    if (!changed) return;
    const r = $('#reader');
    const atBottom = r.scrollHeight - r.scrollTop - r.clientHeight < 80;
    const keepFrom = chat.start;
    const open = new Set($$('details[open]', r).map(d => d.dataset.ts));
    // keep the earlier pages the reader already loaded
    const merged = keepFrom < c.start ? [...chat.items.slice(0, c.start - keepFrom), ...c.items] : c.items;
    Object.assign(chat, { items: merged, start: Math.min(keepFrom, c.start), total: c.total, session: c.session, live: !!c.session.live });
    const top = r.scrollTop;
    renderReader();
    $$('details', r).forEach(d => { if (open.has(d.dataset.ts)) d.open = true; });
    r.scrollTop = atBottom ? r.scrollHeight : top;
  } catch { /* next poll retries */ } finally { chatBusy = false; }
}

function scrollToTs(ts) {
  const target = $$('#thread [data-ts]').find(n => n.dataset.ts >= ts) || null;
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.add('highlight');
}

// ---- tasks
views.tasks = {
  mount(el, args, query) {
    this.filter = query.get('s') ? 'session' : 'all';
    this.session = query.get('s');
    el.innerHTML = `<div class="view-head"><h1>Tasks</h1><span class="sub">Background commands, downloads and agents that Claude started, in every session</span></div>
      <div class="filters" id="tk-filters"></div><div class="strips" id="tk-list"></div>`;
    el.querySelector('#tk-filters').addEventListener('click', e => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      this.filter = b.dataset.f; this.update();
    });
    bindTaskClicks(el);
  },
  update() {
    const F = {
      all: () => true, running: t => t.status === 'running', downloads: t => t.download, failed: t => ['failed', 'killed'].includes(t.status),
      agents: t => t.kind === 'agent', session: t => t.sessionId === this.session,
    };
    const counts = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, O.tasks.filter(f).length]));
    const label = { all: 'All', running: 'Running', downloads: 'Downloads', failed: 'Failed', agents: 'Agents', session: 'This session' };
    setHTML($('#tk-filters'), Object.keys(F).filter(k => k !== 'session' || this.session).map(k => `<button class="btn" type="button" data-f="${k}" aria-pressed="${this.filter === k}">${label[k]} <span class="num">${counts[k]}</span></button>`).join(''));
    const list = O.tasks.filter(F[this.filter] || F.all).slice(0, 250);
    setHTML($('#tk-list'), list.length ? list.map(t => taskStrip(t)).join('') : '<div class="empty">No tasks in this view.</div>');
  },
};

// ---- board
const COLS = [['todo', 'Planned'], ['doing', 'In progress'], ['blocked', 'Waiting'], ['done', 'Done']];
views.board = {
  mount(el) {
    el.innerHTML = `<div class="view-head"><h1>Board</h1><span class="sub">Planned and pending work. Claude adds to it from any session; drag cards to change their state.</span></div>
      <form class="addform" id="add"><input name="title" placeholder="What needs doing?" aria-label="Task" required maxlength="300">
        <input name="project" placeholder="Project" aria-label="Project" list="projects"><datalist id="projects"></datalist>
        <select name="priority" aria-label="Priority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select>
        <button class="btn primary" type="submit">Add to board</button></form>
      <div class="board" id="cols"></div><section style="margin-top:28px" id="checklists"></section>`;
    $('#add').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/api/board', { method: 'POST', body: Object.fromEntries(f) });
        e.target.reset(); toast('Added to the board'); poll();
      } catch (err) { toast(err.message); }
    });
    const cols = $('#cols');
    cols.addEventListener('dragstart', e => { const c = e.target.closest('.card'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); } });
    cols.addEventListener('dragend', e => { const c = e.target.closest('.card'); if (c) c.classList.remove('dragging'); });
    cols.addEventListener('dragover', e => { const c = e.target.closest('.col'); if (c) { e.preventDefault(); $$('.col', cols).forEach(x => x.classList.toggle('drop', x === c)); } });
    cols.addEventListener('dragleave', e => { if (!e.relatedTarget || !cols.contains(e.relatedTarget)) $$('.col', cols).forEach(x => x.classList.remove('drop')); });
    cols.addEventListener('drop', async e => {
      const c = e.target.closest('.col'); if (!c) return;
      e.preventDefault(); $$('.col', cols).forEach(x => x.classList.remove('drop'));
      await setItem(e.dataTransfer.getData('text/plain'), { status: c.dataset.col });
    });
    cols.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.closest('.card').dataset.id;
      const item = O.board.find(i => i.id === id);
      if (b.dataset.act === 'done') await setItem(id, { status: item.status === 'done' ? 'todo' : 'done' });
      if (b.dataset.act === 'edit') {
        const t = prompt('Edit the task', item.title); if (t == null) return;
        const n = prompt('Notes (optional)', item.notes || ''); await setItem(id, { title: t, notes: n ?? item.notes });
      }
      if (b.dataset.act === 'del' && confirm(`Delete “${item.title}”?`)) { await api(`/api/board/${id}`, { method: 'DELETE' }); toast('Deleted'); poll(); }
    });
    cols.addEventListener('keydown', async e => {
      const c = e.target.closest('.card'); if (!c || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const i = COLS.findIndex(([k]) => k === c.closest('.col').dataset.col);
      const next = COLS[i + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) { await setItem(c.dataset.id, { status: next[0] }); setTimeout(() => { const n = $(`.card[data-id="${c.dataset.id}"]`); if (n) n.focus(); }, 300); }
    });
  },
  update() {
    setHTML($('#projects'), [...new Set(O.sessions.map(s => s.project))].map(p => `<option value="${esc(p)}">`).join(''));
    const pr = { high: 0, normal: 1, low: 2 };
    setHTML($('#cols'), COLS.map(([k, label]) => {
      let items = O.board.filter(i => i.status === k);
      items = k === 'done' ? items.sort((a, b) => String(b.doneAt || b.updatedAt).localeCompare(String(a.doneAt || a.updatedAt))).slice(0, 40)
        : items.sort((a, b) => pr[a.priority] - pr[b.priority] || String(a.createdAt).localeCompare(String(b.createdAt)));
      return `<div class="col" data-col="${k}"><h2><span><span class="dot"></span>${label}</span><span class="num">${O.board.filter(i => i.status === k).length}</span></h2>
        ${items.map(i => `<div class="card tilt ${i.priority}" draggable="true" tabindex="0" data-id="${esc(i.id)}" aria-label="${esc(i.title)}. Use left and right arrows to move.">
          <div class="ct" style="${k === 'done' ? 'text-decoration:line-through;color:var(--ink-3)' : ''}">${esc(i.title)}</div>
          ${i.notes ? `<div class="cn">${esc(i.notes)}</div>` : ''}
          <div class="cm">${i.project ? `<span class="chip">${esc(i.project)}</span>` : ''}${i.source === 'claude' ? '<span class="chip claude">Claude</span>' : ''}${i.priority === 'high' ? '<span class="chip bad">High</span>' : ''}<span>${esc(ago(i.updatedAt))}</span></div>
          <div class="acts"><button type="button" data-act="done" title="${k === 'done' ? 'Reopen' : 'Mark done'}" aria-label="${k === 'done' ? 'Reopen' : 'Mark done'}">✓</button><button type="button" data-act="edit" title="Edit" aria-label="Edit">✎</button><button type="button" data-act="del" title="Delete" aria-label="Delete">×</button></div>
        </div>`).join('') || '<div class="sub" style="padding:6px 4px">Nothing here.</div>'}</div>`;
    }).join(''));
    const lists = O.sessions.filter(s => (s.todos && s.todos.length) || (s.taskList && s.taskList.length)).slice(0, 6);
    setHTML($('#checklists'), lists.length ? `<h2>Checklists inside Claude sessions</h2>${lists.map(s => `<div><div class="sub" style="margin:10px 0 4px"><a href="#/chats/${encodeURIComponent(s.id)}">${esc(s.project)}: ${esc(s.title)}</a></div>${checklist(s)}</div>`).join('')}` : '');
  },
};
async function setItem(id, patch) {
  try { await api(`/api/board/${id}`, { method: 'PATCH', body: patch }); poll(); } catch (e) { toast(e.message); }
}

// ---- downloads
views.downloads = {
  mount(el) {
    el.innerHTML = `<div class="view-head"><h1>Downloads</h1><span class="sub">Network speed, downloads Claude started, browser downloads and folders you watch</span></div>
      <div class="meters" id="dl-meters"></div>
      <div class="grid-2"><div>
        <section><h2>Started by Claude</h2><div class="strips" id="dl-tasks"></div></section>
        <section><h2>Browser downloads</h2><div id="dl-partials"></div></section></div>
      <div><section><h2>Watched files and folders</h2><p class="sub" style="margin-top:-4px">Track anything that grows on disk, like a dataset or a model cache. Add an expected size to get a progress bar and time left.</p>
        <div id="dl-watch"></div>
        <form class="inline-form" id="watch-form"><input class="field" name="path" placeholder="Full path, e.g. C:\\data\\dataset" required aria-label="Path">
          <input class="field" name="label" placeholder="Name (optional)" aria-label="Name"><input class="field" name="gb" type="number" min="0" step="0.01" placeholder="Size in GB" aria-label="Expected size in GB">
          <button class="btn primary" type="submit">Watch</button></form></section></div></div>`;
    $('#watch-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        await api('/api/watch', { method: 'POST', body: { path: f.path.trim().replace(/^"|"$/g, ''), label: f.label, target: f.gb ? Number(f.gb) * 1073741824 : null } });
        e.target.reset(); toast('Watching'); poll();
      } catch (err) { toast(err.message); }
    });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-unwatch]'); if (!b) return;
      await api(`/api/watch/${encodeURIComponent(b.dataset.unwatch)}`, { method: 'DELETE' }); poll();
    });
    bindTaskClicks(el);
  },
  update() {
    const s = O.system || {};
    const net = (s.history && s.history.net) || [];
    const peak = Math.max(0, ...net.filter(x => x != null));
    setHTML($('#dl-meters'), `
      <div class="meter"><div class="k">Download now</div><div class="v">${s.net ? rate(s.net.rx) : '–'}</div>${spark(net, 'var(--done)')}</div>
      <div class="meter"><div class="k">Upload now</div><div class="v">${s.net ? rate(s.net.tx) : '–'}</div></div>
      <div class="meter"><div class="k">Peak in the last 9 minutes</div><div class="v">${rate(peak)}</div><div class="d">at ${bytes(peak)}/s, 1 GB takes ${peak > 0 ? dur(1073741824 / peak) : '–'}</div></div>`);
    const tasks = O.tasks.filter(t => t.download).slice(0, 12);
    setHTML($('#dl-tasks'), tasks.length ? tasks.map(t => taskStrip(t)).join('') : '<div class="empty">No download commands found in your sessions.</div>');
    setHTML($('#dl-partials'), (s.partials || []).length ? s.partials.map(dlRow).join('') : '<div class="empty">No browser download in progress in Downloads or on the Desktop.</div>');
    setHTML($('#dl-watch'), (s.watch || []).map(w => w.missing ? `<div class="dl"><span class="n">${esc(w.label)}</span><span class="r"><button class="btn" type="button" data-unwatch="${esc(w.id)}">Stop watching</button></span><span class="pth">${esc(w.path)} · not found yet</span></div>`
      : dlRow(w).replace('</div>', '') + `<span></span><span class="r"><button class="btn" type="button" data-unwatch="${esc(w.id)}">Stop watching</button></span></div>`).join('') || '<div class="empty">Nothing watched yet.</div>');
  },
};

// ---- machine
views.system = {
  mount(el) {
    el.innerHTML = `<div class="view-head"><h1>Machine</h1><span class="sub" id="sys-sub"></span></div><div class="meters" id="sys-meters"></div>
      <section><h2>Disks</h2><table class="list" id="sys-disks"></table></section>
      <section><h2>Processes worth knowing about</h2><table class="list" id="sys-procs"></table></section>`;
    this.expanded = new Set();
    $('#sys-procs').addEventListener('click', e => {
      const d = e.target.closest('td.cmd div'); if (!d) return;
      const pid = d.closest('tr').dataset.pid;
      if (this.expanded.has(pid)) this.expanded.delete(pid); else this.expanded.add(pid);
      d.classList.toggle('full');
    });
  },
  update() {
    const s = O.system || {};
    const g = s.gpu && s.gpu.gpus && s.gpu.gpus[0];
    const h = s.history || {};
    const memUsed = s.mem ? s.mem.total - s.mem.free : null;
    $('#sys-sub').textContent = [s.cpu && s.cpu.model, s.cpu && `${s.cpu.cores} threads`, g && g.name].filter(Boolean).join(' · ');
    const M = [
      g && { id: 'gpu', grad: 'g-solar', k: 'GPU load', f: (g.util || 0) / 100, ring: g.temp != null ? `${g.temp}°` : '', v: `${g.util ?? '–'}<small>%</small>`, d: `${g.temp != null ? `${g.temp} °C` : ''}${g.powerW != null ? ` · ${Math.round(g.powerW)} W` : ''}`, h: h.gpu, col: 'var(--run)' },
      g && { id: 'vram', grad: 'g-violet', k: 'GPU memory', f: g.memUsedMB / g.memTotalMB, ring: `${Math.round((g.memUsedMB / g.memTotalMB) * 100)}`, v: `${bytes(g.memUsedMB * 1048576)}<small>of ${bytes(g.memTotalMB * 1048576)}</small>`, d: `${bytes((g.memTotalMB - g.memUsedMB) * 1048576)} free`, h: h.vram, col: 'var(--claude)' },
      { id: 'cpu', grad: 'g-aurora', k: 'CPU', f: (s.cpu && s.cpu.pct || 0) / 100, ring: '', v: `${s.cpu && s.cpu.pct != null ? Math.round(s.cpu.pct) : '–'}<small>%</small>`, d: s.cpu ? `${s.cpu.cores} threads` : '', h: h.cpu, col: 'var(--you)' },
      { id: 'ram', grad: 'g-mint', k: 'Memory', f: s.mem ? memUsed / s.mem.total : 0, ring: s.mem ? `${Math.round((memUsed / s.mem.total) * 100)}` : '', v: `${bytes(memUsed)}<small>of ${bytes(s.mem && s.mem.total)}</small>`, d: s.mem ? `${bytes(s.mem.free)} free` : '', h: h.ram, col: 'var(--done)' },
    ].filter(Boolean);
    const box = $('#sys-meters');
    if (box.dataset.ids !== M.map(m => m.id).join()) {
      box.innerHTML = M.map(m => `<div class="meter tilt" id="m-${m.id}">${ring(m.grad, 0, '')}<div class="k">${m.k}</div><div class="v"></div><div class="d"></div><div class="sp"></div></div>`).join('');
      box.dataset.ids = M.map(m => m.id).join();
    }
    for (const m of M) {
      const el = $(`#m-${m.id}`);
      setRing($('svg.ring', el), m.f, m.ring);
      setHTML($('.v', el), m.v); setHTML($('.d', el), m.d);
      setHTML($('.sp', el), spark(m.h, m.col, { max: 100 }));
    }
    setHTML($('#sys-disks'), `<tr><th>Drive</th><th>Used</th><th>Free</th><th style="width:40%"></th></tr>` + (s.disks || []).map(d => {
      const p = (d.used / (d.used + d.free)) * 100;
      return `<tr><td>${esc(d.name)}</td><td>${bytes(d.used)}</td><td>${bytes(d.free)}</td><td><div class="hbar ${p > 95 ? 'crit' : p > 85 ? 'warn' : ''}"><i style="width:${p.toFixed(1)}%"></i></div></td></tr>`;
    }).join(''));
    const procs = (s.procs || []).filter(p => !/Get-NetAdapterStatistics/.test(p.cmd));
    setHTML($('#sys-procs'), `<tr><th>Program</th><th>CPU</th><th>Memory</th><th>Running for</th><th>Command</th></tr>` + procs.map(p => `<tr data-pid="${p.pid}"><td>${esc(p.name)}<div class="sub">pid ${p.pid}</div></td><td class="num">${p.cpuPct != null ? `${p.cpuPct}%` : '–'}</td><td class="num">${bytes(p.memMB * 1048576)}</td><td>${p.started ? esc(dur((Date.now() - ms(p.started)) / 1000)) : ''}</td><td class="cmd"><div class="${this.expanded.has(String(p.pid)) ? 'full' : ''}" title="Click to show it all">${esc(p.cmd)}</div></td></tr>`).join(''));
  },
};

// ---- plans & artifacts
views.library = {
  mount(el) {
    el.innerHTML = `<div class="view-head"><h1>Plans &amp; artifacts</h1></div><div class="grid-2"><div id="lib-plans"><div class="empty">Loading plans…</div></div><div><section id="lib-art"></section><section id="lib-cost"></section></div></div>`;
    api('/api/plans').then(disk => { this.disk = disk; this.update(); }).catch(() => { this.disk = []; });
  },
  update() {
    const fromSessions = O.sessions.flatMap(s => s.plans.map(p => ({ ...p, project: s.project, id: s.id })));
    const plans = [...fromSessions.map(p => ({ title: (/^#\s+(.+)$/m.exec(p.plan) || [])[1] || `Plan in ${p.project}`, when: p.ts, text: p.plan, where: p.project, link: p.id })),
      ...(this.disk || []).map(p => ({ title: p.title, when: p.mtime, text: p.text, where: 'Saved plan file' }))].sort((a, b) => String(b.when).localeCompare(String(a.when)));
    setHTML($('#lib-plans'), `<h2>Plans</h2>` + (plans.length ? plans.slice(0, 30).map(p => `<details class="plan"><summary>${esc(p.title)}</summary><div class="sub">${esc(p.where)} · ${esc(ago(p.when))}${p.link ? ` · <a href="#/chats/${encodeURIComponent(p.link)}">open conversation</a>` : ''}</div><div class="bubble" style="margin-top:8px">${md(p.text)}</div></details>`).join('')
      : '<div class="empty">No plans yet. When Claude works in plan mode, its plans collect here.</div>'));
    const arts = O.sessions.flatMap(s => s.artifacts.map(a => ({ ...a, project: s.project }))).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    setHTML($('#lib-art'), `<h2>Published artifacts</h2>` + (arts.length ? arts.map(a => `<div class="art"><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a><span class="sub">${esc(a.project)} · ${esc(ago(a.ts))}</span></div>`).join('') : '<div class="empty">No artifacts published yet.</div>'));
    const spend = O.sessions.filter(s => s.cost).sort((a, b) => b.cost - a.cost);
    const total = spend.reduce((a, s) => a + s.cost, 0);
    setHTML($('#lib-cost'), spend.length ? `<h2>Usage by session</h2><p class="sub" style="margin-top:-4px">Equivalent API cost reported by Claude Code: $${total.toFixed(2)} in total.</p><table class="list">${spend.slice(0, 15).map(s => `<tr><td><a href="#/chats/${encodeURIComponent(s.id)}">${esc(s.title)}</a><div class="sub">${esc(s.project)}</div></td><td class="num" style="text-align:right">$${s.cost.toFixed(2)}</td></tr>`).join('')}</table>` : '');
  },
};

// ---------------------------------------------------------------- task drawer
let drawerTimer = null;
async function openTask(sid, tid) {
  const t = O && O.tasks.find(x => x.sessionId === sid && x.id === tid);
  const d = $('#drawer');
  d.innerHTML = `<header><div class="row"><h2>${esc((t && (t.description || t.command)) || tid)}</h2><button class="btn" type="button" id="dclose">Close</button></div>
      <div class="tools">${t ? statusChip(t.status) : ''}<span class="chip">${esc(t ? kindLabel(t) : 'Task')}</span><span class="chip">${esc(tid)}</span>${t && t.project ? `<span class="chip">${esc(t.project)}</span>` : ''}
        ${t && t.startedAt ? `<span class="sub">started ${esc(clock(t.startedAt))}</span>` : ''}
        ${t && t.outputFile ? `<button class="btn" type="button" id="dopen">Open log in VS Code</button><button class="btn" type="button" id="dcopy">Copy log path</button>` : ''}
        ${sid === "_jobs" ? "" : `<a class="btn" href="#/chats/${encodeURIComponent(sid)}">Conversation</a>`}</div>
      ${t && t.command ? `<div class="cmdline">${esc(t.command)}</div>` : ''}${t && t.summary ? `<div class="sub">${esc(t.summary)}</div>` : ''}</header>
    <pre class="out" id="dout">Loading output…</pre>`;
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('open');
  $('#dclose').onclick = closeDrawer;
  if ($('#dopen')) $('#dopen').onclick = () => api('/api/open', { method: 'POST', body: { path: t.outputFile } }).then(() => toast('Opening in VS Code')).catch(e => toast(e.message));
  if ($('#dcopy')) $('#dcopy').onclick = () => copy(t.outputFile, 'Log path copied');
  $('#dclose').focus();
  const load = async () => {
    const out = $('#dout'); if (!out) return;
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
    try {
      const o = await api(`/api/task/${encodeURIComponent(sid)}/${encodeURIComponent(tid)}?bytes=200000`);
      if (o.kind === 'agent') {
        out.style.whiteSpace = 'normal';
        out.innerHTML = `<div class="thread" style="padding:0;max-width:none">${o.items.map(it => it.k === 'tool' ? `<div class="toolrow"><b>${esc(it.name)}</b> ${esc(it.summary)}</div>` : it.k === 'claude' || it.k === 'you' ? `<div class="msg ${it.k === 'you' ? 'you' : 'claude'}"><div class="who"><b>${it.k === 'you' ? 'Task' : 'Agent'}</b></div><div class="bubble">${md(it.text)}</div></div>` : '').join('')}</div>`;
      } else {
        out.textContent = (o.truncated ? `… showing the last ${bytes(o.text.length)} of ${bytes(o.size)}\n\n` : '') + (o.text || '(no output yet)');
      }
      if (atBottom) out.scrollTop = out.scrollHeight;
    } catch (e) { out.textContent = `Could not read the output: ${e.message}`; }
  };
  await load();
  const outEl = $('#dout'); if (outEl) outEl.scrollTop = outEl.scrollHeight;
  clearInterval(drawerTimer);
  if (!t || t.status === 'running') drawerTimer = setInterval(load, 2000);
}
// ---------------------------------------------------------------- composer: send a message into a conversation
function composerHtml(s) {
  const live = !!s.live;
  return `<form class="x-composer" id="composer" data-sid="${esc(s.id)}">
    ${live ? `<div class="x-composer-warn">This session is open${s.live.entrypoint ? ` in ${esc(s.live.entrypoint.replace('claude-', ''))}` : ''}. Anchor sends your message as a separate headless turn on the same conversation; the open window will not show it until it is reopened. Typing in that window is usually better.</div>` : ''}
    <textarea class="field" name="text" rows="2" placeholder="Message Claude in this conversation…  (Ctrl+Enter to send)" required></textarea>
    <div class="tools"><label class="x-check"><input type="checkbox" name="edits"> Allow file edits</label>
      <select class="field" name="model" aria-label="Model"><option value="">Same model</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select>
      <span class="sub">${live ? 'Headless turn' : 'Resumes the conversation'} · read-only unless you allow edits · no commands</span>
      <button class="btn primary" type="submit">Send</button></div><div id="composer-run"></div></form>`;
}
function bindComposer(s) {
  const f = $('#composer'); if (!f) return;
  f.text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); f.requestSubmit(); } });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    if (s.live && !confirm('This session is open elsewhere. Send as a separate headless turn anyway?')) return;
    try {
      const r = await api('/api/runs', { method: 'POST', body: { kind: 'chat', sessionId: s.id, cwd: s.cwd, text: d.text, allowEdits: !!d.edits, model: d.model || undefined } });
      f.text.value = '';
      runView($('#composer-run'), r.id, { compact: true, onDone: () => { if (chat) { chat.total = -1; refreshChat(); } } });
    } catch (err) { toast(err.message); }
  });
}

function closeDrawer() {
  clearInterval(drawerTimer);
  const d = $('#drawer'); d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); $('#scrim').classList.remove('open');
}
$('#scrim').addEventListener('click', closeDrawer);

function copy(text, msg) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(msg)).catch(() => prompt('Copy this:', text));
}

// ---------------------------------------------------------------- router & polling
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, qs] = h.split('?');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'overview', args: parts.slice(1), query: new URLSearchParams(qs || '') };
}

function route() {
  const r = parseHash();
  const v = views[r.name] || views.overview;
  const name = views[r.name] ? r.name : 'overview';
  const navName = { project: 'projects' }[name] || name;
  $$('[data-nav]').forEach(a => { if (a.dataset.nav === navName) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (current && current.name === name && v.route) { v.route(r.args, r.query); return; }
  if (current && current.view.unmount) current.view.unmount();
  closeDrawer();
  const el = $('#view');
  el.scrollTop = 0;
  current = { name, view: v };
  v.mount(el, r.args, r.query);
  el.classList.remove('warp'); void el.offsetWidth; el.classList.add('warp');
  if (O) v.update();
  if (name === 'chats' && r.query.get('at')) setTimeout(() => views.chats.route(r.args, r.query), 400);
}

function notifyChanges() {
  for (const t of O.tasks) {
    const key = `${t.sessionId}|${t.id}`;
    const prev = lastStatus.get(key);
    if (prev === 'running' && t.status !== 'running' && notifyOn) {
      try { new Notification(`${STATUS_LABEL[t.status] || t.status}: ${t.description || t.id}`, { body: `${t.project || ''} ${t.summary || ''}`.trim(), icon: 'icon-tile.png', tag: key }); } catch { /* ignore */ }
    }
    lastStatus.set(key, t.status);
  }
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    O = await api('/api/overview');
    notifyChanges();
    renderStrip();
    const running = O.tasks.filter(t => t.status === 'running').length;
    document.title = running ? `(${running}) Anchor` : 'Anchor';
    $('#c-now').textContent = running || '';
    $('#c-now').classList.toggle('hot', running > 0);
    $('#c-chats').textContent = O.sessions.length;
    $('#c-tasks').textContent = O.tasks.length;
    $('#c-board').textContent = O.board.filter(i => i.status !== 'done').length || '';
    const agents = O.tasks.filter(t => t.kind === 'agent' && t.status === 'running').length;
    $('#c-live').textContent = agents || (O.sessions.some(s => s.live && s.live.status === 'busy') ? '●' : '');
    $('#c-live').classList.toggle('hot', agents > 0);
    $('#c-proj').textContent = new Set(O.sessions.map(s => s.project)).size;
    const dl = O.tasks.filter(t => t.download && t.status === 'running').length + ((O.system && O.system.partials) || []).length;
    $('#c-dl').textContent = dl || '';
    $('#c-dl').classList.toggle('hot', dl > 0);
    $('#foot-status').textContent = `Updated ${new Date().toLocaleTimeString()} · v${O.version}`;
    if (current) {
      const main = $('#view');
      const top = main.scrollTop;
      current.view.update();
      main.scrollTop = top;
    }
  } catch (e) {
    $('#foot-status').textContent = `Server not reachable (${e.message}). Start it with: anchor start`;
  } finally { polling = false; }
}

function themeLabel() {
  const t = (window.ANCHOR_THEMES || []).find(x => x.id === document.documentElement.dataset.theme);
  $('#theme').textContent = `Theme: ${t ? t.name : 'Neon Deck'}`;
}
themeLabel();
$('#theme').addEventListener('click', () => { location.hash = '#/themes'; });
const nb = $('#notify');
if (!('Notification' in window)) nb.hidden = true;
const nbLabel = () => { nb.textContent = notifyOn ? 'Task alerts on' : 'Notify me when tasks finish'; };
nbLabel();
nb.addEventListener('click', async () => {
  if (notifyOn) { notifyOn = false; } else { notifyOn = (await Notification.requestPermission()) === 'granted'; }
  try { localStorage.setItem('anchor-notify', notifyOn ? '1' : '0'); } catch { /* ignore */ }
  nbLabel();
  if (notifyOn) toast('You will get a desktop alert when a task finishes');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDrawer(); const r = $('#results'); if (r) r.hidden = true; }
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
});
// the newer views live in public/ext/*.js, loaded after this file; start once they have registered
window.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('hashchange', route);
  renderStrip();
  route();
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, 3000);
  setInterval(() => { if (document.hidden) poll(); }, 15000);
});
