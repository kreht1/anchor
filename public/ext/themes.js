'use strict';
/* Themes: a gallery of live previews. Each card is the real UI in miniature under that theme's tokens. */

function themePreview(t) {
  return `<div class="x-tp" data-theme="${t.id}" data-family="${t.family}" data-tone="${t.tone || 'dark'}">
    <div class="x-tp-rail"><span class="x-tp-logo mark"></span><i></i><i class="on"></i><i></i><i></i></div>
    <div class="x-tp-main"><div class="x-tp-h">Table</div>
      <div class="fs x-tp-strip" data-s="running"><span class="bar"></span><span class="body"><span class="title" style="display:block">Training run</span><span class="prog" style="display:block"><i style="width:64%"></i></span></span></div>
      <div class="x-tp-row"><span class="chip ok">Done</span><span class="chip claude">Claude</span><span class="chip bad">Failed</span></div>
      <div class="x-tp-row"><span class="btn primary">Start</span><span class="btn">Cancel</span></div></div></div>`;
}

views.themes = {
  mount(el) {
    el.innerHTML = `<div class="view-head"><h1>Themes</h1><span class="sub">Every theme restyles the whole app: colour, type, corners, surfaces and motion. Your choice is saved in this browser.</span></div>
      <div class="x-themes" id="th-grid"></div>`;
    this.render();
    $('#th-grid').addEventListener('click', e => {
      const c = e.target.closest('[data-pick]'); if (!c) return;
      const t = applyAnchorTheme(c.dataset.pick);
      try { localStorage.setItem('mc-theme', t.id); } catch { /* storage blocked */ }
      themeLabel(); this.render(); toast(`${t.name} applied`);
    });
  },
  update() {},
  render() {
    const cur = document.documentElement.dataset.theme;
    $('#th-grid').innerHTML = ANCHOR_THEMES.map(t => `<button type="button" class="x-theme ${t.id === cur ? 'is-cur' : ''}" data-pick="${t.id}" aria-pressed="${t.id === cur}">
        ${themePreview(t)}<span class="x-theme-meta"><b>${esc(t.name)}</b><span class="chip">${esc(t.mood)}</span>${t.id === cur ? '<span class="chip ok">In use</span>' : ''}<small>${esc(t.blurb)}</small></span></button>`).join('');
  },
};
