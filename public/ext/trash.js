'use strict';
/* Trash: leftovers your Claude sessions made that you should delete afterwards (temp bundles, build caches, scratch
   databases, logs), plus anything Anchor Guard stopped Claude from deleting. Delete moves them to the Recycle Bin, so
   a mistake can be undone; Keep takes an item off the list and leaves the file alone. */

views.trash = {
  mount(el) {
    el.innerHTML = `<div class="x-panel x-trash-hero"><div><div class="x-eyebrow">Trash</div><h1 id="tr-title">Nothing to clean</h1>
        <p class="sub" id="tr-sub">Files your sessions left for you to delete show up here: temp files, build caches, scratch databases, and anything Guard stopped Claude from deleting.</p>
        <div class="tools" style="margin-top:12px"><button class="btn primary" type="button" id="tr-all" hidden>Delete all</button>
          <button class="btn" type="button" id="tr-refresh">Refresh</button></div></div>
        <div class="x-hero-kpis" id="tr-kpis"></div></div>
      <section><div class="section-head"><h2>To delete</h2><span class="sub">Delete moves to the Recycle Bin · Keep takes it off this list and leaves the file</span></div>
        <div id="tr-list" class="x-list"></div></section>
      <section><div class="section-head"><h2>Add something yourself</h2></div>
        <div class="tools"><input class="field x-mono" id="tr-path" placeholder="A file or folder, e.g. C:\\Users\\me\\Downloads\\bundle.bin" style="flex:1"><button class="btn" type="button" id="tr-add">Add</button></div></section>`;
    el.addEventListener('click', async e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const { act, id } = b.dataset;
      if (act === 'del' && !b.classList.contains('armed')) { this.arm(b, 'Click to confirm'); return; }
      b.disabled = true;
      try {
        if (act === 'del') { const r = await api('/api/trash/empty', { method: 'POST', body: { ids: [id] } }); toast(r.failed.length ? `Not deleted: ${r.failed[0].error}` : 'Moved to the Recycle Bin'); }
        if (act === 'keep') { await api('/api/trash/keep', { method: 'POST', body: { ids: [id] } }); toast('Kept, and taken off the list'); }
        if (act === 'show') await api('/api/trash/show', { method: 'POST', body: { id } });
      } catch (err) { toast(err.message); }
      this.load();
    });
    $('#tr-all').onclick = async e => {
      const b = e.currentTarget;
      if (!b.classList.contains('armed')) { this.arm(b, `Delete ${this.items.length} item${this.items.length > 1 ? 's' : ''}? Click again`); return; }
      b.disabled = true;
      try { const r = await api('/api/trash/empty', { method: 'POST', body: { ids: [] } }); toast(`${r.deleted} moved to the Recycle Bin${r.failed.length ? `, ${r.failed.length} could not be deleted` : ''}`); }
      catch (err) { toast(err.message); }
      b.disabled = false; this.load();
    };
    $('#tr-refresh').onclick = () => this.load();
    const add = async () => {
      const p = $('#tr-path').value.trim();
      if (!p) return;
      try { const r = await api('/api/trash/add', { method: 'POST', body: { path: p } }); toast(r.ok ? 'Added to the Trash' : r.error); if (r.ok) $('#tr-path').value = ''; }
      catch (err) { toast(err.message); }
      this.load();
    };
    $('#tr-add').onclick = add; $('#tr-path').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    this.load();
  },
  update() {},
  // a destructive button needs a second click within 4 seconds
  arm(b, label) {
    const was = b.textContent;
    b.classList.add('armed', 'danger'); b.textContent = label;
    setTimeout(() => { if (b.isConnected) { b.classList.remove('armed', 'danger'); b.textContent = was; } }, 4000);
  },
  async load() {
    try { this.items = await api('/api/trash'); } catch (err) { this.items = []; toast(err.message); }
    this.render();
  },
  render() {
    const items = this.items || [], total = items.reduce((n, i) => n + (i.size || 0), 0);
    const n = items.length;
    $('#tr-title').textContent = n ? `${n} thing${n > 1 ? 's' : ''} to clean up` : 'Nothing to clean';
    $('#tr-sub').textContent = n ? `${bytes(total)} your sessions left behind. Delete what you don't need; it goes to the Recycle Bin.`
      : 'Files your sessions left for you to delete show up here: temp files, build caches, scratch databases, and anything Guard stopped Claude from deleting.';
    const all = $('#tr-all'); all.hidden = !n; all.disabled = false; all.classList.remove('armed', 'danger'); all.textContent = `Delete all (${bytes(total)})`;
    setHTML($('#tr-kpis'), [['items', n], ['space', bytes(total)], ['from Guard', items.filter(i => i.from === 'guard').length]]
      .map(([k, v]) => `<div><b class="num">${v}</b><span>${k}</span></div>`).join(''));
    const badge = document.querySelector('[data-nav="trash"] .x-badge');
    if (badge) { badge.textContent = n; badge.hidden = !n; }
    setHTML($('#tr-list'), n ? items.map(i => `<div class="x-row x-trash-row">
        <div class="x-trash-main"><b class="x-mono" title="${esc(i.path)}">${i.dir ? '📁' : '📄'} ${esc(shortPath(i.path))}</b>
          <span class="sub">${esc(i.why || 'No reason given')}</span>
          <span class="sub">${esc(bytes(i.size || 0))}${i.partial ? '+' : ''} · ${i.from === 'guard' ? 'stopped by Guard' : i.from === 'you' ? 'added by you' : 'left by Claude'}${i.project ? ` · ${esc(i.project)}` : ''} · ${esc(ago(i.added))}</span></div>
        <div class="tools"><button class="btn" type="button" data-act="show" data-id="${esc(i.id)}">Show</button>
          <button class="btn" type="button" data-act="keep" data-id="${esc(i.id)}">Keep</button>
          <button class="btn primary" type="button" data-act="del" data-id="${esc(i.id)}">Delete</button></div></div>`).join('')
      : '<div class="empty">The Trash is empty. When a session leaves temporary files behind, or Guard stops Claude from deleting something, it appears here with a one-click Delete.</div>');
  },
};
