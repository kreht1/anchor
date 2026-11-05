'use strict';
/* Model Lab: open a model file and see it down to the neuron. Structure comes from the file itself; every connection
   drawn is a real weight sampled from it (orange positive, blue negative, opacity = magnitude). Nothing in the file is
   run: pickles are read with a locked-down unpickler on the server. */

const ML = { list: [], model: null, path: null, layers: [], samples: new Map(), sel: null, neuron: null, win: 0, view: { x: 0, y: 0, k: 1 }, raf: 0 };
const fmtN = n => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// any CSS colour a theme uses (hex, rgb(), rgba(), names) as [r, g, b]
const rgbOf = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true }), memo = new Map();
  return col => {
    if (memo.has(col)) return memo.get(col);
    c.clearRect(0, 0, 1, 1); c.fillStyle = '#888'; c.fillStyle = col || '#888'; c.fillRect(0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data, v = [d[0], d[1], d[2]];
    memo.set(col, v); return v;
  };
})();
// the theme's colours, read once per frame: positive weights wear the accent, negative ones the cool suit colour
function mlPalette() {
  const s = getComputedStyle(document.documentElement), v = n => s.getPropertyValue(n).trim();
  const p = { ink: v('--ink') || '#111', dim: v('--ink-3') || '#888', pos: v('--dia') || '#ff6b1a', card: v('--card') || '#fff', body: v('--body') || 'sans-serif', mono: v('--mono') || 'monospace' };
  p.posRGB = rgbOf(p.pos); p.cardRGB = rgbOf(p.card);
  // negative weights need a colour that reads as different from the accent; some themes' cool suit is too close to it
  const far = c => Math.hypot(...rgbOf(c).map((x, i) => x - p.posRGB[i]));
  const cands = ['--spade', '--you', '--club', '--heart'].map(v).filter(Boolean);
  p.neg = cands.find(c => far(c) >= 140) || cands.sort((a, b) => far(b) - far(a))[0] || '#2b59ff';
  p.negRGB = rgbOf(p.neg);
  const root = document.documentElement.style; // the HTML parts (histograms, filters, key) use these too
  if (root.getPropertyValue('--w-pos') !== p.pos) root.setProperty('--w-pos', p.pos);
  if (root.getPropertyValue('--w-neg') !== p.neg) root.setProperty('--w-neg', p.neg);
  return p;
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const fitCols = W => Math.max(3, Math.min(12, Math.floor((W - 140) / 150) + 1));
function mlClip(g, text, max) { // shorten from the front so the distinctive end stays
  if (g.measureText(text).width <= max) return text;
  let t = text; while (t.length > 2 && g.measureText('…' + t).width > max) t = t.slice(1);
  return '…' + t;
}

function family(m) {
  const names = m.tensors.map(t => t.name).join('\n');
  const count = re => new Set((names.match(re) || []).map(x => x.replace(/\D+/g, ''))).size;
  if (/blocks\.\d+\.attn|encoder\.layer\.\d+\.attention|layers\.\d+\.self_attn|transformer\.h\.\d+|blk\.\d+\.attn/.test(names)) {
    const n = count(/(?:blocks|layer|layers|h|blk)\.(\d+)\./g), d = (m.tensors.find(t => /(cls_token|embed|wte|tok_embeddings|token_embd)/.test(t.name)) || {}).shape;
    const vit = /patch_embed|cls_token|pos_embed/.test(names);
    return `${vit ? 'Vision Transformer' : 'Transformer'} · ${n} blocks${d ? ` · width ${d[d.length - 1]}` : ''}`;
  }
  if (/layer[1-4]\.\d+\.(conv|bn)\d/.test(names)) return `ResNet-style CNN · ${count(/layer[1-4]\.(\d+)\./g)}+ residual blocks per stage`;
  if (/\b(enc|down|encoder)\b.*\n[\s\S]*\b(dec|up|decoder)\b/.test(names)) return 'Encoder–decoder (U-Net-style)';
  if (m.tensors.some(t => t.shape.length === 4)) return 'Convolutional network';
  if (m.tensors.some(t => t.shape.length === 2)) return 'Fully connected network';
  return m.format;
}

function layersOf(m) {
  return m.tensors.filter(t => t.shape.length >= 2 && !/(running_|num_batches|pos_embed|position_embedding|rel_pos|mask_token|cls_token|freqs|rope)/i.test(t.name) && t.numel > 1)
    .map(t => {
      const s = t.shape, mod = t.name.replace(/\.(weight|kernel|w|W|bias)$/, '');
      const kind = s.length === 4 ? 'conv' : s.length === 2 ? (/embed|wte|tok_|token/i.test(t.name) ? 'embedding' : /attn|attention|q_proj|k_proj|v_proj|qkv|query|key|value/i.test(t.name) ? 'attention' : 'linear') : 'tensor';
      return { mod, tensor: t.name, shape: s, out: s[0], inp: s.length >= 2 ? s[1] : 1, kind, k: s.length === 4 ? `${s[2]}×${s[3]}` : null, numel: t.numel };
    });
}

function tree(m) {
  const root = { name: 'model', n: 0, kids: new Map() };
  for (const t of m.tensors) {
    const parts = t.name.split('.');
    let node = root; root.n += t.numel;
    for (const p of parts.slice(0, -1)) { if (!node.kids.has(p)) node.kids.set(p, { name: p, n: 0, kids: new Map(), leaf: [] }); node = node.kids.get(p); node.n += t.numel; }
    (node.leaf = node.leaf || []).push(t);
  }
  return root;
}

async function loadSamples(names, cap = 24) {
  const need = names.filter(n => !ML.samples.has(n));
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 60) {
    const r = await api('/api/models/samples', { method: 'POST', body: { path: ML.path, names: need.slice(i, i + 60), cap } });
    for (const s of r.samples) ML.samples.set(s.name, s);
  }
}

// ---------------------------------------------------------------- the neuron canvas
function drawNeurons(cv, t) {
  const g = cv.getContext('2d'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const P = mlPalette(), { ink, pos, neg, dim } = P;
  const fitN = fitCols(W);
  ML.fitN = fitN;
  let L = ML.layers.slice(ML.win, ML.win + fitN);
  if (!L.length) return;
  if (ML.win === 0) L = [{ mod: 'input', tensor: null, shape: [L[0].inp], out: L[0].inp, inp: 0, kind: 'input', k: null }, ...L.slice(0, fitN - 1)];
  const v = ML.view;
  g.save(); g.translate(v.x + W / 2, v.y + H / 2); g.scale(v.k, v.k); g.translate(-W / 2, -H / 2);
  const gap = (W - 140) / Math.max(1, L.length - 1), tight = gap < 170;
  const colX = i => 70 + i * gap;
  const MAXN = Math.max(8, Math.min(24, Math.floor((H - 130) / 17))), top = tight ? 96 : 66, bottom = H - 36;
  // neuron positions per column, with the real row each one stands for
  const cols = L.map((l, i) => {
    const n = Math.min(MAXN, l.out), x = L.length === 1 ? W / 2 : colX(i);
    const smp = l.tensor ? ML.samples.get(l.tensor) : null;
    const norms = smp && smp.rowNorm ? smp.rowNorm : null, maxN = norms ? Math.max(...norms, 1e-9) : 1;
    return { l, x, n, ys: Array.from({ length: n }, (_, j) => top + (n === 1 ? (bottom - top) / 2 : (j / (n - 1)) * (bottom - top))),
      rows: Array.from({ length: n }, (_, j) => Math.round((j / Math.max(1, n - 1)) * (l.out - 1))), norm: j => (norms ? norms[Math.min(norms.length - 1, Math.round((j / Math.max(1, n - 1)) * (norms.length - 1)))] / maxN : 0.5) };
  });
  ML._cols = cols;
  // connections: layer i+1's sampled weights, from its inputs (the column before) to its neurons
  const pulses = [];
  for (let i = 1; i < cols.length; i++) {
    const a = cols[i - 1], b = cols[i], smp = ML.samples.get(b.l.tensor);
    if (!smp || !smp.matrix) continue;
    const M = smp.matrix, per = b.l.shape.length === 4 ? b.l.shape[2] * b.l.shape[3] : 1, inCh = b.l.shape[1];
    let mx = 1e-9; for (const row of M.values) for (const w of row) mx = Math.max(mx, Math.abs(w));
    M.values.forEach((row, ri) => {
      const jb = Math.round((M.rows[ri] / Math.max(1, M.totalRows - 1)) * (b.n - 1));
      row.forEach((w, ci) => {
        const ch = Math.floor(M.cols[ci] / per), ja = Math.round((ch / Math.max(1, inCh - 1)) * (a.n - 1));
        const s = Math.abs(w) / mx;
        if (s < 0.08) return;
        const sel = ML.neuron && ML.neuron.col === i && ML.neuron.j === jb;
        g.strokeStyle = w >= 0 ? pos : neg; g.globalAlpha = sel ? Math.min(1, 0.2 + s) : 0.05 + s * 0.4; g.lineWidth = sel ? 1.2 + s * 2.4 : 0.4 + s * 1.6;
        g.beginPath(); g.moveTo(a.x, a.ys[ja]); g.bezierCurveTo(a.x + 60, a.ys[ja], b.x - 60, b.ys[jb], b.x, b.ys[jb]); g.stroke();
        if (s > 0.55) pulses.push([a.x, a.ys[ja], b.x, b.ys[jb], w >= 0 ? pos : neg, s, ri * 0.37 + ci * 0.11 + i]);
      });
    });
  }
  g.globalAlpha = 1;
  // signals flowing along the strongest weights
  for (const [x1, y1, x2, y2, c, s, ph] of pulses.slice(0, 220)) {
    const q = ((t * 0.45 + ph) % 1), x = lerpB(x1, x1 + 60, x2 - 60, x2, q), y = lerpB(y1, y1, y2, y2, q);
    g.fillStyle = c; g.globalAlpha = 0.9 * s; g.beginPath(); g.arc(x, y, 2 + s * 2.5, 0, 6.28); g.fill();
  }
  g.globalAlpha = 1;
  // neurons and labels
  cols.forEach((c, i) => {
    const sel = ML.sel === c.l.tensor;
    c.ys.forEach((y, j) => {
      const nz = c.l.kind === 'input' ? 0.25 : c.norm(j), r = c.l.kind === 'conv' ? 7 : 6;
      g.beginPath(); c.l.kind === 'conv' ? g.rect(c.x - r, y - r, r * 2, r * 2) : g.arc(c.x, y, r, 0, 6.28);
      g.fillStyle = mixc(P.cardRGB, P.posRGB, nz); g.fill(); g.lineWidth = ML.neuron && ML.neuron.col === i && ML.neuron.j === j ? 3 : 1; g.strokeStyle = ink; g.globalAlpha = 0.85; g.stroke(); g.globalAlpha = 1;
    });
    g.textAlign = 'center';
    if (c.l.out > c.n) { g.fillStyle = dim; g.font = `10.5px ${P.body}`; g.fillText(`+${fmtN(c.l.out - c.n)} more`, c.x, bottom + 22); }
    // labels: up to a column's width; neighbours alternate height only when columns are tight
    const lift = tight && i % 2 === 0 ? 30 : 0, room = (tight ? gap * 2 : gap) - 16;
    const seg = c.l.mod.split('.'), lab = seg.slice(-2).join('.');
    g.fillStyle = sel ? pos : ink; g.font = `600 12px ${P.body}`;
    g.fillText(mlClip(g, lab, room), c.x, top - 42 - lift);
    g.fillStyle = dim; g.font = `10.5px ${P.mono}`;
    g.fillText(mlClip(g, c.l.kind === 'input' ? `${c.l.out} channels` : `${c.l.kind}${c.l.k ? ' ' + c.l.k : ''} ${c.l.shape.slice(0, 2).join('×')}`, room), c.x, top - 27 - lift);
  });
  g.restore();
}
const lerpB = (a, b, c, d, t) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
const mixc = (from, to, k) => `rgb(${from.map((f, i) => Math.round(f * (1 - k) + to[i] * k)).join(',')})`; // weight-norm brightness: card → accent

// ---------------------------------------------------------------- inspector pieces
function heatmap(cv, M) {
  if (!cv) return;
  const R = M.values.length, C = M.values[0].length, s = 8, P = mlPalette();
  cv.width = C * s; cv.height = R * s;
  const g = cv.getContext('2d');
  let mx = 1e-9; for (const r of M.values) for (const w of r) mx = Math.max(mx, Math.abs(w));
  g.clearRect(0, 0, cv.width, cv.height);
  M.values.forEach((r, i) => r.forEach((w, j) => { const k = Math.sqrt(Math.min(1, Math.abs(w) / mx)); g.fillStyle = rgba(w >= 0 ? P.posRGB : P.negRGB, k); g.fillRect(j * s, i * s, s - 1, s - 1); }));
  ML.heat = M; ML.heatTheme = document.documentElement.dataset.theme;
}
function histo(h) {
  const mx = Math.max(...h.counts, 1);
  return `<div class="x-histo">${h.counts.map((c, i) => { const v = h.lo + (h.hi - h.lo) * (i + 0.5) / h.counts.length; return `<i title="${v.toFixed(4)}: ${c}" style="height:${Math.max(2, (c / mx) * 100)}%;background:${v >= 0 ? 'var(--w-pos, var(--dia))' : 'var(--w-neg, var(--spade))'}"></i>`; }).join('')}</div>
    <div class="x-histo-axis"><span>${h.lo.toFixed(3)}</span><span>0</span><span>${h.hi.toFixed(3)}</span></div>`;
}
function kernels(K) {
  // each filter on its own scale, so its pattern shows even when its weights are small
  return `<div class="x-kernels">${K.map(k => {
    const mx = Math.max(1e-9, ...k.flat().map(Math.abs));
    return `<div class="x-kernel" style="grid-template-columns:repeat(${k[0].length},1fr)">${k.flat().map(w => `<i style="background:color-mix(in srgb, var(${w >= 0 ? '--w-pos' : '--w-neg'}) ${Math.round(Math.sqrt(Math.abs(w) / mx) * 100)}%, transparent)"></i>`).join('')}</div>`;
  }).join('')}</div>`;
}

async function inspectLayer(name) {
  ML.sel = name;
  const box = $('#ml-insp'); if (!box) return;
  box.innerHTML = '<div class="x-thinking"><i></i><i></i><i></i> Reading weights…</div>';
  try { await loadSamples([name], 48); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const s = ML.samples.get(name), t = ML.model.tensors.find(x => x.name === name);
  if (!s || s.error) { box.innerHTML = `<div class="empty">${esc((s && s.error) || 'no sample')}</div>`; return; }
  // a 48-cap sample replaces the 24-cap one used for the canvas only if the canvas does not need it
  const st = s.stats;
  const nb = ML.neuron && ML.neuron.tensor === name && s.matrix ? s.matrix.values[Math.min(s.matrix.values.length - 1, Math.round((ML.neuron.row / Math.max(1, s.matrix.totalRows - 1)) * (s.matrix.values.length - 1)))] : null;
  const bars = a => { const m = Math.max(...a.map(Math.abs), 1e-9); return `<div class="x-histo">${a.map(w => `<i style="height:${Math.max(2, (Math.abs(w) / m) * 100)}%;background:var(${w >= 0 ? '--w-pos' : '--w-neg'})"></i>`).join('')}</div>`; };
  box.innerHTML = `<div class="x-ml-insp-grid">
    <div class="x-ml-block"><div class="x-eyebrow">Tensor</div><h3 class="x-mono x-ml-tname">${esc(name)}</h3>
      <div class="tools"><span class="chip">${esc(t.shape.join(' × '))}</span><span class="chip">${esc(t.dtype)}</span><span class="chip">${fmtN(t.numel)} values</span></div>
      <div class="x-statgrid">${[['mean', st.mean], ['std', st.std], ['min', st.min], ['max', st.max], ['|mean|', st.absMean], ['zeros', st.zeros]].map(([k, v]) => `<div><span>${k}</span><b class="num">${k === 'zeros' ? (v * 100).toFixed(1) + '%' : Number(v).toPrecision(3)}</b></div>`).join('')}</div></div>
    <div class="x-ml-block"><h4>Distribution</h4>${histo(s.hist)}
      ${nb ? `<h4>Neuron ${ML.neuron.row}: its incoming weights</h4>${bars(nb)}` : ''}
      ${s.vector ? `<h4>Values</h4>${bars(s.vector.slice(0, 96))}` : ''}
      ${s.kernels ? `<h4>Filters <span class="sub">averaged over input channels</span></h4>${kernels(s.kernels)}` : ''}</div>
    ${s.matrix ? `<div class="x-ml-block"><h4>Weights <span class="sub">${s.matrix.values.length} of ${fmtN(s.matrix.totalRows)} neurons × ${s.matrix.values[0].length} of ${fmtN(s.matrix.totalCols)} inputs</span></h4><canvas id="ml-heat" class="x-heat-cv"></canvas></div>` : ''}</div>`;
  ML.heat = null;
  if (s.matrix) heatmap($('#ml-heat'), s.matrix);
}

function treeHtml(node, depth = 0, total) {
  total = total || node.n || 1;
  const kids = [...node.kids.values()].sort((a, b) => b.n - a.n);
  const leaf = (node.leaf || []).map(t => `<button type="button" class="x-tnode leaf" data-tensor="${esc(t.name)}" style="--d:${depth + 1}"><span class="x-mono">${esc(t.name.split('.').pop())}</span><span class="sub">${esc(t.shape.join('×'))} · ${fmtN(t.numel)}</span></button>`).join('');
  return kids.map(k => `<details class="x-tdet" ${depth < 1 ? 'open' : ''}><summary class="x-tnode" style="--d:${depth}"><b>${esc(k.name)}</b><span class="x-tbar"><i style="width:${((k.n / total) * 100).toFixed(2)}%"></i></span><span class="sub">${fmtN(k.n)}</span></summary>${treeHtml(k, depth + 1, total)}</details>`).join('') + leaf;
}

// ---------------------------------------------------------------- the view
views.models = {
  mount(el, args, query) {
    el.innerHTML = `<div class="view-head"><h1>Model Lab</h1><span class="sub">Open a checkpoint and see it down to the neuron. Every line is a real weight. Nothing in the file is run.</span></div>
      <div class="x-ml"><aside class="x-panel x-ml-list"><div class="x-pad" style="padding-bottom:6px"><input class="field" id="ml-q" type="search" placeholder="Filter models" style="width:100%">
          <input class="field x-mono" id="ml-path" placeholder="…or paste a model path" style="width:100%;margin-top:6px"></div><div id="ml-files" class="x-ml-files"><div class="x-thinking"><i></i><i></i><i></i></div></div></aside>
        <section id="ml-main"><div class="empty">Pick a model on the left. Anchor reads PyTorch (.pt .pth .ckpt), safetensors, NumPy (.npz), GGUF, ONNX and Keras files.</div></section></div>`;
    $('#ml-q').addEventListener('input', () => this.list());
    $('#ml-path').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) this.open(e.target.value.trim().replace(/^"|"$/g, '')); });
    $('#ml-files').addEventListener('click', e => { const b = e.target.closest('[data-model]'); if (b) this.open(b.dataset.model); });
    api('/api/models/scan').then(l => { ML.list = l; this.list(); }).catch(e => { $('#ml-files').innerHTML = `<div class="sub x-pad">${esc(e.message)}</div>`; });
    if (query.get('path')) this.open(query.get('path'));
  },
  unmount() { cancelAnimationFrame(ML.raf); },
  update() {},
  list() {
    const q = ($('#ml-q').value || '').toLowerCase();
    const items = ML.list.filter(m => !q || m.path.toLowerCase().includes(q)).slice(0, 300);
    $('#ml-files').innerHTML = items.length ? items.map(m => `<button type="button" class="x-ml-file ${ML.path === m.path ? 'sel' : ''}" data-model="${esc(m.path)}"><b>${esc(/^(state|model|best|last|checkpoint|weights|pytorch_model)\.\w+$/i.test(m.name) ? m.path.split(/[\\/]/).slice(-2).join('/') : m.name)}</b><span class="sub">${esc(shortPath(m.path.slice(0, -m.name.length - 1)))} · ${bytes(m.size)}</span></button>`).join('')
      : '<div class="sub x-pad">No model files found in the folders Claude has worked in.</div>';
  },
  async open(p) {
    ML.path = p; ML.samples = new Map(); ML.sel = null; ML.neuron = null; ML.win = 0; ML.view = { x: 0, y: 0, k: 1 };
    this.list();
    const main = $('#ml-main');
    main.innerHTML = '<div class="x-thinking"><i></i><i></i><i></i> Reading the model safely…</div>';
    let m;
    try { m = await api('/api/models/inspect?path=' + encodeURIComponent(p)); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    ML.model = m; ML.layers = layersOf(m);
    const kinds = ML.layers.reduce((a, l) => ((a[l.kind] = (a[l.kind] || 0) + 1), a), {});
    main.innerHTML = `<div class="x-hero x-panel"><div class="x-hero-main"><div class="x-eyebrow">${esc(m.format)}</div><h1 class="x-ml-title" title="${esc(p)}">${esc(p.split(/[\\/]/).pop()).replace(/([_-])/g, '$1<wbr>')}</h1>
        <div class="sub">${esc(family(m))}</div><div class="tools" style="margin-top:10px">${Object.entries(m.dtypes).map(([d, n]) => `<span class="chip">${esc(d)} · ${fmtN(n)}</span>`).join('')}${Object.entries(kinds).map(([k, n]) => `<span class="chip claude">${n} ${k}</span>`).join('')}</div></div>
        <div class="x-hero-kpis"><div><b class="num">${fmtN(m.params)}</b><span>parameters</span></div><div><b class="num">${m.tensorCount}</b><span>tensors</span></div><div><b class="num">${bytes(m.size)}</b><span>on disk</span></div></div></div>
      ${m.notes.length ? `<p class="sub">${m.notes.map(esc).join(' ')}</p>` : ''}
      <div class="x-ml-body"><div class="x-panel x-ml-canvas">
          <div class="x-ml-hud"><span class="sub" id="ml-hover">Hover a neuron; click to inspect. Scroll to zoom, drag to move.</span><span class="x-ml-key"><i style="background:var(--w-pos, var(--dia))"></i>positive<i style="background:var(--w-neg, var(--spade))"></i>negative</span></div>
          <canvas id="ml-cv"></canvas>
          <div class="x-ml-nav"><button class="btn" type="button" id="ml-prev" aria-label="Earlier layers">◀</button><input type="range" id="ml-win" min="0" max="${Math.max(0, ML.layers.length - 1)}" value="0"><button class="btn" type="button" id="ml-next" aria-label="Later layers">▶</button><span class="sub" id="ml-pos"></span></div></div>
        <section class="x-panel x-pad x-ml-insp" id="ml-insp"><div class="sub">Click a layer or a neuron to see its weights.</div></section></div>
      <section><div class="section-head"><h2>Every module</h2><span class="sub">parameter share by module; click a tensor to inspect it</span></div><div class="x-panel x-pad x-ml-tree" id="ml-tree">${treeHtml(tree(m))}</div></section>`;
    $('#ml-tree').addEventListener('click', e => { const b = e.target.closest('[data-tensor]'); if (b) { const i = ML.layers.findIndex(l => l.tensor === b.dataset.tensor); if (i >= 0) this.setWin(Math.max(0, i - 2)); inspectLayer(b.dataset.tensor); } });
    const win = $('#ml-win');
    win.oninput = () => this.setWin(+win.value);
    $('#ml-prev').onclick = () => this.setWin(Math.max(0, ML.win - (ML.fitN || 8) + 1));
    $('#ml-next').onclick = () => this.setWin(Math.min(ML.layers.length - 1, ML.win + (ML.fitN || 8) - 1));
    this.bindCanvas();
    this.setWin(0);
    if (ML.layers[0]) inspectLayer(ML.layers[0].tensor);
  },
  async setWin(i) {
    ML.win = i; $('#ml-win').value = i;
    const cvw = ($('#ml-cv') || {}).clientWidth || 800;
    ML.fitN = fitCols(cvw);
    const L = ML.layers.slice(i, i + (ML.fitN || 8));
    $('#ml-pos').textContent = ML.layers.length ? `layers ${i + 1}–${i + L.length} of ${ML.layers.length}` : 'no weight layers';
    try { await loadSamples(L.map(l => l.tensor), 24); } catch (e) { toast(e.message); }
  },
  bindCanvas() {
    const cv = $('#ml-cv');
    cancelAnimationFrame(ML.raf);
    const loop = t => {
      if (!document.body.contains(cv)) return;
      drawNeurons(cv, t / 1000);
      if (ML.heat && ML.heatTheme !== document.documentElement.dataset.theme) heatmap($('#ml-heat'), ML.heat); // follow a theme switch
      ML.raf = requestAnimationFrame(loop);
    };
    ML.raf = requestAnimationFrame(loop);
    const toWorld = (ex, ey) => { const r = cv.getBoundingClientRect(), W = cv.clientWidth, H = cv.clientHeight, v = ML.view; return [((ex - r.left) - v.x - W / 2) / v.k + W / 2, ((ey - r.top) - v.y - H / 2) / v.k + H / 2]; };
    const pick = e => {
      const [x, y] = toWorld(e.clientX, e.clientY);
      let best = null;
      (ML._cols || []).forEach((c, i) => c.ys.forEach((yy, j) => { const d = Math.hypot(c.x - x, yy - y); if (d < 12 && (!best || d < best.d)) best = { d, i, j, c }; }));
      return best;
    };
    let drag = null;
    cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, vx: ML.view.x, vy: ML.view.y, moved: false }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', e => {
      if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; ML.view.x = drag.vx + dx; ML.view.y = drag.vy + dy; return; }
      const b = pick(e);
      $('#ml-hover').textContent = b ? `${b.c.l.mod} · neuron ${b.c.rows[b.j]} of ${b.c.l.out} · weight norm ${(b.c.norm(b.j)).toFixed(2)} (relative)` : 'Hover a neuron; click to inspect. Scroll to zoom, drag to move.';
      cv.style.cursor = b ? 'pointer' : 'grab';
    });
    cv.addEventListener('pointerup', e => {
      const was = drag; drag = null;
      if (was && was.moved) return;
      const b = pick(e);
      if (b) { ML.neuron = { col: b.i, j: b.j, row: b.c.rows[b.j], tensor: b.c.l.tensor }; inspectLayer(b.c.l.tensor); }
    });
    cv.addEventListener('wheel', e => { e.preventDefault(); ML.view.k = Math.max(0.4, Math.min(5, ML.view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); }, { passive: false });
  },
};
