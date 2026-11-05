'use strict';
/* Shared pieces for the newer Anchor views: a live Claude-run viewer, line diffs, a small syntax highlighter, a
   force-directed canvas graph and a modal. Uses the helpers from app.js ($, esc, api, md, ago, toast...). */

// ---------------------------------------------------------------- modal
function modal(html, { wide = false, onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'x-modal-back';
  back.innerHTML = `<div class="x-modal x-panel ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><button class="btn x-close" type="button" aria-label="Close">✕</button><div class="x-modal-body">${html}</div></div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', key); if (onClose) onClose(); };
  const key = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key);
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('.x-close')) close(); });
  return { el: back.querySelector('.x-modal-body'), close };
}

// ---------------------------------------------------------------- line diff (LCS on lines; falls back for huge inputs)
function lineDiff(a, b) {
  const A = String(a ?? '').split('\n'), B = String(b ?? '').split('\n');
  if (A.length * B.length > 400000) return [...A.map(t => ({ t, k: '-' })), ...B.map(t => ({ t, k: '+' }))];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: A[i], k: ' ' }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: A[i++], k: '-' });
    else out.push({ t: B[j++], k: '+' });
  }
  while (i < n) out.push({ t: A[i++], k: '-' });
  while (j < m) out.push({ t: B[j++], k: '+' });
  return out;
}
function diffHtml(oldText, newText, lang) {
  const rows = lineDiff(oldText, newText);
  const add = rows.filter(r => r.k === '+').length, del = rows.filter(r => r.k === '-').length;
  // collapse long unchanged runs
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.k !== ' ') for (let k = Math.max(0, i - 2); k <= Math.min(rows.length - 1, i + 2); k++) keep[k] = true; });
  let html = '', skipped = 0;
  rows.forEach((r, i) => {
    if (!keep[i] && rows.length > 12) { skipped++; return; }
    if (skipped) { html += `<div class="dl-skip">⋯ ${skipped} unchanged line${skipped > 1 ? 's' : ''}</div>`; skipped = 0; }
    html += `<div class="dl-row ${r.k === '+' ? 'add' : r.k === '-' ? 'del' : ''}"><span class="dl-sign">${r.k === ' ' ? '' : r.k}</span><span class="dl-code">${hl(r.t, lang) || ' '}</span></div>`;
  });
  if (skipped) html += `<div class="dl-skip">⋯ ${skipped} unchanged line${skipped > 1 ? 's' : ''}</div>`;
  return { html: `<div class="x-diff">${html}</div>`, add, del };
}

// ---------------------------------------------------------------- syntax highlighting (escape first, one pass per line)
const KW = {
  js: 'await|async|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|yield|true|false|null|undefined|interface|type|enum|implements|private|public|protected|readonly',
  py: 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None|self',
  sh: 'if|then|else|elif|fi|for|while|do|done|case|esac|function|in|return|export|local|echo|cd|set',
  c: 'auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|int|long|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|while|class|public|private|namespace|using|new|true|false|null|package|import|func|var|fn|let|mut|impl|pub|use|mod|match|self|final|override|async|await',
  sql: 'select|from|where|and|or|insert|into|values|update|set|delete|create|table|drop|join|left|right|inner|on|group|by|order|limit|as|not|null|primary|key|index',
};
KW.ts = KW.js; KW.rs = KW.c; KW.go = KW.c; KW.java = KW.c; KW.cs = KW.c; KW.dart = KW.c + '|' + KW.js; KW.ps = KW.sh + '|param|foreach|switch|try|catch|function';
const kwRe = {};
function hl(line, lang) {
  const s = esc(line);
  if (!lang || lang === 'txt' || lang === 'md') return s;
  const cmt = lang === 'py' || lang === 'sh' || lang === 'yaml' || lang === 'toml' || lang === 'ps' ? '#' : lang === 'sql' ? '--' : lang === 'css' || lang === 'html' || lang === 'json' ? null : '//';
  if (!kwRe[lang] && KW[lang]) kwRe[lang] = new RegExp(`\\b(${KW[lang]})\\b`, lang === 'sql' ? 'gi' : 'g');
  const parts = [];
  // tokens: strings, comments, numbers; everything else gets keyword colouring
  const re = new RegExp(`(&quot;(?:[^&]|&(?!quot;))*?&quot;|&#39;(?:[^&]|&(?!#39;))*?&#39;|\`[^\`]*\`)${cmt ? `|(${cmt.replace(/[/#-]/g, '\\$&')}.*$)` : ''}|(\\b\\d+(?:\\.\\d+)?\\b)`, 'g');
  let last = 0, m;
  while ((m = re.exec(s))) {
    parts.push(kw(s.slice(last, m.index), lang));
    if (m[1]) parts.push(`<span class="hl-s">${m[1]}</span>`);
    else if (cmt && m[2]) parts.push(`<span class="hl-c">${m[2]}</span>`);
    else parts.push(`<span class="hl-n">${m[cmt ? 3 : 2]}</span>`);
    last = re.lastIndex;
    if (m[0] === '') re.lastIndex++;
  }
  parts.push(kw(s.slice(last), lang));
  return parts.join('');
}
function kw(s, lang) {
  if (lang === 'css') return s.replace(/([\w-]+)(\s*:)/g, '<span class="hl-k">$1</span>$2');
  if (lang === 'html') return s.replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="hl-k">$2</span>');
  if (lang === 'json' || lang === 'yaml' || lang === 'toml') return s.replace(/\b(true|false|null)\b/g, '<span class="hl-k">$1</span>');
  let out = kwRe[lang] ? s.replace(kwRe[lang], '<span class="hl-k">$1</span>') : s;
  out = out.replace(/\b([A-Za-z_]\w*)(?=\()/g, '<span class="hl-f">$1</span>');
  return out;
}
const langOf = f => {
  const e = String(f || '').split('.').pop().toLowerCase();
  return ({ js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', py: 'py', json: 'json', css: 'css', html: 'html', md: 'md', sh: 'sh', ps1: 'ps', yml: 'yaml', yaml: 'yaml', rs: 'rs', go: 'go', java: 'java', c: 'c', cpp: 'c', h: 'c', cs: 'cs', dart: 'dart', sql: 'sql', toml: 'toml' })[e] || 'txt';
};

// ---------------------------------------------------------------- live Claude run viewer
const RUN_STATUS = { running: 'Working', completed: 'Done', failed: 'Failed', stopped: 'Stopped' };
function runView(el, id, { onDone, compact = false, onUpdate } = {}) {
  let from = 0, timer = null, stopped = false, run = null;
  el.innerHTML = `<div class="x-run ${compact ? 'compact' : ''}"><div class="x-run-head"></div><div class="x-run-steps"></div><div class="x-run-final bubble"></div></div>`;
  const head = el.querySelector('.x-run-head'), steps = el.querySelector('.x-run-steps'), final = el.querySelector('.x-run-final');
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await api(`/api/runs/${encodeURIComponent(id)}?from=${from}`);
      run = r;
      for (const e of r.events) {
        if (e.type === 'text') continue;
        steps.insertAdjacentHTML('beforeend', `<div class="x-step ${e.type}"><span class="x-dot"></span><span>${esc(e.text)}</span><time>${esc(new Date(e.t).toLocaleTimeString())}</time></div>`);
      }
      from = r.eventCount;
      if (r.events.length) steps.scrollTop = steps.scrollHeight;
      const tools = steps.querySelectorAll('.x-step.tool').length;
      head.innerHTML = `<span class="chip ${r.status === 'running' ? 'run' : r.status === 'completed' ? 'ok' : 'bad'}">${r.status === 'running' ? '<span class="pulse"></span>' : ''}${RUN_STATUS[r.status] || r.status}</span>
        <span class="chip">${esc(r.sandbox === 'read' ? 'read-only' : r.sandbox === 'web' ? 'web + read' : r.sandbox === 'edit' ? 'can edit files' : 'can run commands')}</span>
        ${r.model ? `<span class="chip claude">${esc(r.model)}${r.effort ? ` · ${esc(r.effort)}` : ''}</span>` : ''}
        <span class="sub">${tools} step${tools === 1 ? '' : 's'} · started ${esc(ago(r.startedAt))}${r.cost != null ? ` · $${Number(r.cost).toFixed(2)}` : ''}</span>
        <span style="margin-left:auto;display:flex;gap:6px">${r.final ? '<button class="btn" type="button" data-x="copy">Copy</button>' : ''}${r.status === 'running' ? '<button class="btn" type="button" data-x="stop">Stop</button>' : ''}</span>`;
      if (r.final && final._t !== r.final) { final._t = r.final; final.innerHTML = md(r.final); mermaidLite(final); }
      if (!r.final && r.status === 'running') final.innerHTML = '<div class="x-thinking"><i></i><i></i><i></i> Claude is reading…</div>';
      if (onUpdate) onUpdate(r);
      if (r.status !== 'running') { stopped = true; if (onDone) onDone(r); return; }
    } catch (e) { head.innerHTML = `<span class="chip bad">${esc(e.message)}</span>`; }
    timer = setTimeout(tick, 1200);
  };
  head.addEventListener('click', e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'stop') api(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => toast('Stopping')).catch(err => toast(err.message));
    if (b.dataset.x === 'copy' && run) copy(run.final, 'Copied');
  });
  tick();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
// mermaid blocks are shown as readable source with a label (no external renderer is loaded)
function mermaidLite(root) {
  root.querySelectorAll('pre code').forEach(c => { if (/^\s*(flowchart|graph|sequenceDiagram|classDiagram)\b/.test(c.textContent)) c.parentElement.classList.add('x-mermaid'); });
}

// ---------------------------------------------------------------- force-directed canvas graph
function forceGraph(canvas, { nodes, links, color, size, label, onPick, onHover, labels = 24, keepPerNode = 0 }) {
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim() || '#fff', ink3 = css.getPropertyValue('--ink-3').trim() || '#888';
  const N = nodes.map((n, i) => ({ ...n, x: Math.cos(i * 2.4) * 30 * Math.sqrt(i + 1), y: Math.sin(i * 2.4) * 30 * Math.sqrt(i + 1), vx: 0, vy: 0, r: size(n) }));
  const idx = new Map(N.map((n, i) => [n.id, i]));
  let E = links.map(l => ({ a: idx.get(l.a ?? l.s), b: idx.get(l.b ?? l.t), w: l.w || 1 })).filter(e => e.a != null && e.b != null);
  // a readable map: each node keeps only its strongest few links
  if (keepPerNode) {
    const keep = new Set();
    N.forEach((_, i) => E.map((e, k) => [e, k]).filter(([e]) => e.a === i || e.b === i).sort((x, y) => y[0].w - x[0].w).slice(0, keepPerNode).forEach(([, k]) => keep.add(k)));
    E = E.filter((_, k) => keep.has(k));
  }
  let view = { x: 0, y: 0, k: 1 }, alpha = 1, hover = -1, drag = null, pan = null, raf = 0, W = 0, H = 0, dpr = 1;
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
  };
  resize();
  const ro = new ResizeObserver(() => { resize(); draw(); });
  ro.observe(canvas);
  const maxW = Math.max(1, ...E.map(e => e.w));
  [...N].sort((a, b) => b.r - a.r).slice(0, labels).forEach(n => { n.big = true; });
  function step() {
    const n = N.length;
    const rep = 2600 + n * 22;
    for (let i = 0; i < n; i++) {
      const a = N[i];
      for (let j = i + 1; j < n; j++) {
        const b = N[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 640000) continue;
        const f = (rep * alpha) / d2, d = Math.sqrt(d2);
        const minD = a.r + b.r + 6;
        const push = d < minD ? (minD - d) * 0.5 : 0;
        dx /= d; dy /= d;
        a.vx += dx * (f + push); a.vy += dy * (f + push); b.vx -= dx * (f + push); b.vy -= dy * (f + push);
      }
    }
    for (const e of E) {
      const a = N[e.a], b = N[e.b];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 60 + (a.r + b.r) * 1.2;
      const k = 0.02 * alpha * (0.3 + 0.7 * (e.w / maxW));
      const f = (d - target) * k;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const a of N) {
      a.vx -= a.x * 0.004 * alpha; a.vy -= a.y * 0.004 * alpha;
      if (drag && N[drag.i] === a) continue;
      a.x += a.vx *= 0.6; a.y += a.vy *= 0.6;
    }
    alpha = Math.max(0, alpha * 0.993 - 0.0003);
  }
  function toScreen(p) { return [(p.x - view.x) * view.k + W / 2, (p.y - view.y) * view.k + H / 2]; }
  function toWorld(x, y) { return [(x - W / 2) / view.k + view.x, (y - H / 2) / view.k + view.y]; }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const nb = hover >= 0 ? new Set(E.filter(e => e.a === hover || e.b === hover).flatMap(e => [e.a, e.b])) : null;
    for (const e of E) {
      const [x1, y1] = toScreen(N[e.a]), [x2, y2] = toScreen(N[e.b]);
      const on = nb && (e.a === hover || e.b === hover);
      ctx.strokeStyle = on ? color(N[hover]) : ink3;
      ctx.globalAlpha = on ? 0.9 : nb ? 0.06 : 0.12 + 0.35 * (e.w / maxW);
      ctx.lineWidth = on ? 2 : Math.max(0.6, 2.4 * (e.w / maxW));
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const labelsToDraw = [];
    N.forEach((n, i) => {
      const [x, y] = toScreen(n);
      const r = Math.max(2.5, n.r * view.k);
      const dim = nb && !nb.has(i);
      ctx.globalAlpha = dim ? 0.2 : 1;
      const c = color(n);
      ctx.shadowColor = c; ctx.shadowBlur = i === hover ? 24 : 8;
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      if (i === hover) { ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.stroke(); }
      if (n.big || i === hover || (nb && nb.has(i))) labelsToDraw.push({ i, x, y, r, pri: i === hover ? 1e9 : nb && nb.has(i) ? 1e6 + n.r : n.r });
    });
    // labels: most important first, skipping any that would overlap one already drawn
    ctx.globalAlpha = 1; ctx.textAlign = 'center';
    const placed = [];
    for (const L of labelsToDraw.sort((p, q) => q.pri - p.pri)) {
      const text = label(N[L.i]).slice(0, 34);
      ctx.font = `${L.i === hover ? 650 : 500} ${Math.min(14, 10.5 + L.r / 5)}px ${css.getPropertyValue('--body')}`;
      const w = ctx.measureText(text).width, box = { x1: L.x - w / 2 - 3, x2: L.x + w / 2 + 3, y1: L.y + L.r + 2, y2: L.y + L.r + 18 };
      if (L.i !== hover && placed.some(p => p.x1 < box.x2 && box.x1 < p.x2 && p.y1 < box.y2 && box.y1 < p.y2)) continue;
      placed.push(box);
      ctx.lineWidth = 3; ctx.strokeStyle = css.getPropertyValue('--card').trim() || '#000'; ctx.strokeText(text, L.x, L.y + L.r + 14);
      ctx.fillStyle = ink; ctx.fillText(text, L.x, L.y + L.r + 14);
    }
  }
  function loop() { if (alpha > 0.002 || drag) step(); draw(); raf = requestAnimationFrame(loop); }
  // fit after the layout settles a bit
  for (let i = 0; i < 600; i++) step();
  const fit = () => {
    const xs = N.map(n => n.x), ys = N.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    view.x = (minX + maxX) / 2; view.y = (minY + maxY) / 2;
    view.k = Math.min(2.2, 0.92 * Math.min(W / Math.max(1, maxX - minX + 120), H / Math.max(1, maxY - minY + 120)));
  };
  fit();
  loop();
  const pick = (ev) => {
    const r = canvas.getBoundingClientRect();
    const [wx, wy] = toWorld(ev.clientX - r.left, ev.clientY - r.top);
    let best = -1, bd = Infinity;
    N.forEach((n, i) => { const d = Math.hypot(n.x - wx, n.y - wy); if (d < n.r + 8 / view.k && d < bd) { bd = d; best = i; } });
    return best;
  };
  canvas.addEventListener('pointerdown', ev => {
    canvas.setPointerCapture(ev.pointerId);
    const i = pick(ev);
    if (i >= 0) drag = { i, moved: false }; else pan = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  });
  canvas.addEventListener('pointermove', ev => {
    if (drag) {
      const r = canvas.getBoundingClientRect();
      const [wx, wy] = toWorld(ev.clientX - r.left, ev.clientY - r.top);
      N[drag.i].x = wx; N[drag.i].y = wy; drag.moved = true; alpha = Math.max(alpha, 0.25);
    } else if (pan) {
      view.x = pan.vx - (ev.clientX - pan.x) / view.k; view.y = pan.vy - (ev.clientY - pan.y) / view.k;
    } else {
      const i = pick(ev);
      if (i !== hover) { hover = i; canvas.style.cursor = i >= 0 ? 'pointer' : 'grab'; if (onHover) onHover(i >= 0 ? N[i] : null); }
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (drag && !drag.moved && onPick) onPick(N[drag.i]);
    drag = null; pan = null;
  });
  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const [wx, wy] = toWorld(ev.clientX - r.left, ev.clientY - r.top);
    view.k = Math.max(0.15, Math.min(6, view.k * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const [nx, ny] = toWorld(ev.clientX - r.left, ev.clientY - r.top);
    view.x += wx - nx; view.y += wy - ny;
  }, { passive: false });
  return { destroy() { cancelAnimationFrame(raf); ro.disconnect(); }, fit, reheat() { alpha = 0.6; } };
}

// project link helper used by several views
const projHref = key => `#/project?key=${encodeURIComponent(key)}`;
const shortPath = p => String(p || '').replace(/^[a-z]:\\users\\[^\\]+\\/i, '~\\');
