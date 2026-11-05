'use strict';
/* Code: browse the folders Claude has worked in, read files with highlighting, see what Claude changed in them, and
   ask Claude to explain a file. Read-only; secrets-like files are hidden by the server. */

function codeBrowser(el, start, file) {
  el.innerHTML = `<div class="x-code"><aside class="x-tree x-panel"><div class="x-tree-head"><select class="field" id="cb-root" aria-label="Folder"></select></div><div id="cb-tree" class="x-tree-body"></div></aside>
    <section class="x-viewer x-panel"><div class="x-viewer-head" id="cb-head"><span class="sub">Pick a file on the left.</span></div><div class="x-viewer-body" id="cb-body"></div></section></div>`;
  const open = new Set();
  let root = null, cur = null;
  const tree = el.querySelector('#cb-tree');
  async function roots() {
    const rs = await api('/api/fs/roots');
    const sel = el.querySelector('#cb-root');
    const want = start || (file ? rs.find(r => file.toLowerCase().startsWith(r.toLowerCase())) : null) || rs[0];
    sel.innerHTML = rs.map(r => `<option value="${esc(r)}" ${want && r.toLowerCase() === want.toLowerCase() ? 'selected' : ''}>${esc(shortPath(r))}</option>`).join('');
    if (want && !rs.some(r => r.toLowerCase() === want.toLowerCase())) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(want)}" selected>${esc(shortPath(want))}</option>`);
    sel.onchange = () => { root = sel.value; open.clear(); renderTree(); };
    root = sel.value;
    if (file) { let p = file; while (p.length > root.length) { p = p.replace(/[\\/][^\\/]+$/, ''); open.add(p.toLowerCase()); } }
    await renderTree();
    if (file) showFile(file);
  }
  const cache = new Map();
  async function listing(dir) {
    if (!cache.has(dir)) cache.set(dir, api('/api/fs/list?path=' + encodeURIComponent(dir)).catch(e => ({ entries: [], error: e.message })));
    return cache.get(dir);
  }
  async function branch(dir, depth) {
    const l = await listing(dir);
    if (l.error) return `<div class="sub x-pad">${esc(l.error)}</div>`;
    let html = '';
    for (const e of l.entries) {
      if (e.dir) {
        const isOpen = open.has(e.path.toLowerCase());
        html += `<button type="button" class="x-node dir ${isOpen ? 'open' : ''} ${e.heavy ? 'heavy' : ''}" data-dir="${esc(e.path)}" style="--d:${depth}"><span class="x-tw">${isOpen ? '▾' : '▸'}</span>${esc(e.name)}</button>`;
        if (isOpen) html += await branch(e.path, depth + 1);
      } else html += `<button type="button" class="x-node file ${cur && cur.toLowerCase() === e.path.toLowerCase() ? 'sel' : ''}" data-file="${esc(e.path)}" style="--d:${depth}"><span class="x-ext x-ext-${esc(langOf(e.name))}"></span>${esc(e.name)}</button>`;
    }
    if (l.more) html += `<div class="sub" style="padding-left:calc(var(--d)*14px + 14px)">… ${l.more} more</div>`;
    return html;
  }
  async function renderTree() { tree.innerHTML = await branch(root, 0) || '<div class="sub x-pad">Empty folder.</div>'; }
  tree.addEventListener('click', async e => {
    const d = e.target.closest('[data-dir]');
    if (d) { const k = d.dataset.dir.toLowerCase(); if (open.has(k)) open.delete(k); else open.add(k); await renderTree(); return; }
    const f = e.target.closest('[data-file]');
    if (f) { showFile(f.dataset.file); $$('.x-node.sel', tree).forEach(n => n.classList.remove('sel')); f.classList.add('sel'); }
  });
  async function showFile(p) {
    cur = p;
    const head = el.querySelector('#cb-head'), body = el.querySelector('#cb-body');
    body.innerHTML = '<div class="x-thinking"><i></i><i></i><i></i></div>';
    let f;
    try { f = await api('/api/fs/read?path=' + encodeURIComponent(p)); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const rel = f.path.slice(f.root.length + 1);
    head.innerHTML = `<div class="x-crumbs x-mono">${rel.split(/[\\/]/).map(esc).join('<span>/</span>')}</div>
      <div class="tools"><span class="sub">${bytes(f.size)}${f.text ? ` · ${f.text.split('\n').length} lines` : ''}${f.mtime ? ` · changed ${esc(ago(f.mtime))}` : ''}</span>
        <button class="btn" type="button" data-c="explain">✦ Explain with Claude</button><button class="btn" type="button" data-c="vscode">VS Code</button><button class="btn" type="button" data-c="copy">Copy path</button></div>`;
    head.onclick = ev => {
      const b = ev.target.closest('[data-c]'); if (!b) return;
      if (b.dataset.c === 'vscode') api('/api/open', { method: 'POST', body: { path: f.path } }).then(() => toast('Opening in VS Code')).catch(err => toast(err.message));
      if (b.dataset.c === 'copy') copy(f.path, 'Path copied');
      if (b.dataset.c === 'explain') explainFile(f.path, f.root);
    };
    if (f.tooLarge || f.binary) { body.innerHTML = `<div class="empty">${f.binary ? 'Binary file' : 'File too large to show'} (${bytes(f.size)}).</div>`; return; }
    const lines = f.text.split('\n');
    body.innerHTML = `<div id="cb-edits"></div><div class="x-src">${lines.map((l, i) => `<div class="x-ln" id="L${i + 1}"><span class="x-lno">${i + 1}</span><code>${hl(l, f.lang) || ' '}</code></div>`).join('')}</div>`;
    // Claude's recent edits to this file, newest first
    api('/api/activity?hours=72&limit=1500').then(a => {
      const mine = a.events.filter(e => e.file && e.file.toLowerCase() === f.path.toLowerCase()).reverse().slice(0, 12);
      if (!mine.length || cur !== p) return;
      el.querySelector('#cb-edits').innerHTML = `<details class="x-edits" open><summary>Claude changed this file ${mine.length} time${mine.length > 1 ? 's' : ''} recently</summary>${mine.map(e => editCard(e)).join('')}</details>`;
    }).catch(() => {});
  }
  roots().catch(e => { tree.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  return { showFile };
}

function explainFile(path, root) {
  const m = modal(`<div class="x-eyebrow">Claude explains · read-only</div><h2 class="x-title">${esc(path.split(/[\\/]/).pop())}</h2>
    <div class="tools" id="ex-opts"><select class="field" id="ex-model"><option value="sonnet">Sonnet · faster</option><option value="opus">Opus · deeper</option></select><button class="btn primary" type="button" id="ex-go">Explain</button>
    <span class="sub">Claude may read the files it imports. Nothing is changed.</span></div><div id="ex-run"></div>`, { wide: true });
  m.el.querySelector('#ex-go').onclick = async () => {
    try {
      const r = await api('/api/runs', { method: 'POST', body: { kind: 'file', file: path, cwd: root, model: m.el.querySelector('#ex-model').value } });
      m.el.querySelector('#ex-opts').hidden = true;
      runView(m.el.querySelector('#ex-run'), r.id);
    } catch (e) { toast(e.message); }
  };
}

views.code = {
  key: () => 'code',
  mount(el, args, query) {
    el.innerHTML = `<div class="view-head"><h1>Code</h1><span class="sub">Read-only view of the folders Claude has worked in. Files that may hold secrets are hidden.</span></div><div id="code-root"></div>`;
    const p = query.get('path');
    this.cb = codeBrowser($('#code-root'), query.get('root'), p);
  },
  route(args, query) { const p = query.get('path'); if (p && this.cb) this.cb.showFile(p); },
  update() {},
};
