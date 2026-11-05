'use strict';
/* Scholar studio: Claude makes slide decks, Word documents, Excel workbooks, LaTeX papers, posters, publication figures
   and motion-design videos with your skills and the tools on this computer. Every option is yours to set; every result
   can be revised in the same conversation. */

const FMT = [
  ['slides', 'Slide deck', '▭', 'PowerPoint .pptx with speaker notes, charts and a real layout'],
  ['word', 'Word document', '¶', 'Papers, reports, chapters, proposals: real styles, captions, references'],
  ['excel', 'Excel workbook', '▦', 'Live formulas, tables, charts, dashboards'],
  ['latex', 'LaTeX paper', '∑', 'Journal or conference classes, BibTeX, vector figures, compiled PDF'],
  ['poster', 'Academic poster', '▯', 'A0 or 36×48 in, readable from two metres'],
  ['figures', 'Publication figures', '◔', 'Matplotlib figures as PDF, SVG and 300-dpi PNG, with the script'],
  ['video', 'Motion-design video', '▶', 'Kinetic typography and animated charts, rendered to MP4'],
];
const STYLE = ['Minimal and elegant', 'Bold and graphic', 'Academic and sober', 'Corporate', 'Playful', 'Dark with neon accents', 'Editorial (magazine)'];
const sel = (name, opts, v) => `<select class="field" name="${name}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
const num = (name, v, min, max) => `<input class="field" type="number" name="${name}" value="${v}" min="${min}" max="${max}">`;
const txt = (name, ph, v = '') => `<input class="field" name="${name}" placeholder="${esc(ph)}" value="${esc(v)}">`;
const cb = (name, label, on = true) => `<label class="x-check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;
const row = (label, html) => `<div class="x-opt"><span>${label}</span>${html}</div>`;
const palette = () => row('Palette', `<span class="tools"><input type="color" name="c1" value="#1f3a5f"><input type="color" name="c2" value="#e4572e"><input type="color" name="c3" value="#f5f2ea">
  <label class="x-check"><input type="checkbox" name="usePalette"> use these colours</label></span>`);

const OPTS = {
  slides: () => row('Slides', num('slides', 12, 1, 80)) + row('Shape', sel('aspect', ['16:9', '4:3'])) + row('Style', sel('style', STYLE)) + palette()
    + row('Fonts', txt('fonts', 'e.g. Inter for titles, Source Sans for text')) + row('Density', sel('density', ['One idea per slide, strong visuals', 'Balanced text and visuals', 'Dense, for reading not presenting']))
    + row('Extras', cb('notes', 'speaker notes') + cb('charts', 'charts from the data in sources', false) + cb('template', 'use a template from sources', false)),
  word: () => row('Kind', sel('kind', ['Research paper', 'Report', 'Thesis chapter', 'Literature review', 'Proposal', 'Letter', 'CV'])) + row('Pages', num('pages', 8, 1, 200))
    + row('Page', sel('page', ['A4', 'Letter'])) + row('Citations', sel('citations', ['APA 7', 'IEEE', 'Vancouver', 'Harvard', 'Chicago', 'None']))
    + row('Sections', txt('sections', 'leave empty for the usual ones')) + row('Fonts', txt('fonts', 'e.g. Cambria 11 pt, 1.15 spacing'))
    + row('Extras', cb('toc', 'table of contents') + cb('figures', 'figures from the data in sources', false)),
  excel: () => row('Purpose', txt('purpose', 'e.g. clean and analyse my survey results')) + row('Sheets', txt('sheets', 'leave empty: Data, Analysis, Dashboard, Notes'))
    + row('Look', sel('style', ['Professional', 'Minimal', 'Colourful'])) + row('Extras', cb('charts', 'charts on a dashboard')),
  latex: () => row('Class', sel('cls', ['article', 'IEEEtran (conference)', 'elsarticle (Elsevier)', 'llncs (Springer LNCS)', 'revtex4-2 (APS)', 'report (thesis)', 'beamer (slides)']))
    + row('Pages', num('pages', 8, 1, 300)) + row('Bibliography', sel('bib', ['BibTeX, numeric', 'BibTeX, author-year (natbib)', 'biblatex + biber'])) + row('Sections', txt('sections', 'leave empty for the usual ones')),
  poster: () => row('Size', sel('size', ['A0 portrait (841 x 1189 mm)', 'A0 landscape (1189 x 841 mm)', '36 x 48 in portrait', '48 x 36 in landscape'])) + row('Sections', txt('sections', 'leave empty: Background, Methods, Results, Conclusions, References'))
    + row('Style', sel('style', STYLE)) + palette() + row('Fonts', txt('fonts', 'optional')),
  figures: () => row('Figures', `<textarea class="field" name="figs" rows="3" placeholder="e.g. Fig 1: accuracy per model with 95% CIs; Fig 2: ..."></textarea>`)
    + row('Width', sel('width', ['single-column (3.5 in)', 'double-column (7.2 in)', 'slide 16:9'])) + row('Style', sel('style', ['Journal, colour-blind safe', 'Nature-like', 'Minimal monochrome', 'Presentation, large fonts'])),
  video: () => row('Length', `${num('seconds', 30, 3, 600)} <span class="sub">seconds</span>`) + row('Frame', sel('resolution', ['1920x1080', '1080x1920 (vertical)', '1080x1080', '3840x2160'])) + row('FPS', sel('fps', ['30', '60', '24']))
    + row('Engine', sel('engine', ['python (Pillow + ffmpeg, no install)', 'manim', 'remotion (downloads packages)'])) + row('Style', sel('style', ['Clean kinetic typography', 'Bold motion graphics', 'Animated data story', 'Calm explainer', 'Neon / synthwave']))
    + palette() + row('Fonts', txt('fonts', 'optional')) + row('Script', `<textarea class="field" name="script" rows="4" placeholder="Scenes and on-screen text, or leave empty and Claude writes the storyboard from the brief"></textarea>`),
};

function collectOptions(type, f) {
  const d = Object.fromEntries(new FormData(f));
  const o = { audience: d.audience, language: d.language, tone: d.tone, research: !!d.research };
  for (const el of f.querySelectorAll('#sc-opts [name]')) {
    if (['c1', 'c2', 'c3', 'usePalette'].includes(el.name)) continue;
    o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  if (d.usePalette) o.palette = `primary ${d.c1}, accent ${d.c2}, background ${d.c3}`;
  if (type === 'video') { o.engine = String(o.engine || 'python').split(' ')[0]; o.resolution = String(o.resolution).split(' ')[0]; }
  return o;
}

function toolbox(el, st) {
  const t = st.tools;
  const chip = (ok, label) => `<span class="chip ${ok ? 'ok' : ''}">${ok ? '✓' : '·'} ${label}</span>`;
  el.innerHTML = `<div class="tools">${chip(t.pptx, 'python-pptx')}${chip(t.docx, 'python-docx')}${chip(t.openpyxl, 'openpyxl')}${chip(t.matplotlib, 'matplotlib')}${chip(t.pillow, 'Pillow')}
      ${chip(t.ffmpeg, 'ffmpeg')}${chip(t.npx, 'Node / npx')}${chip(!!t.latex, t.latex ? `LaTeX (${t.latex})` : 'LaTeX')}${chip(!!t.soffice, 'LibreOffice previews')}${chip(t.manim, 'manim')}</div>
    <div class="tools" style="margin-top:8px" id="sc-inst"></div><pre class="x-fileview" id="sc-log" hidden></pre>`;
  api('/api/installs').then(list => {
    const want = [!(t.pptx && t.docx && t.openpyxl) && 'py-office', !t.pandas && 'py-charts', !t.latex && 'latex', !t.soffice && 'libreoffice'].filter(Boolean);
    const items = list.filter(i => want.includes(i.id));
    el.querySelector('#sc-inst').innerHTML = items.length ? items.map(i => `<button class="btn" type="button" data-inst="${esc(i.id)}" title="${esc(i.size)}">Install ${esc(i.title)} <span class="sub">${esc(i.size)}</span></button>`).join('')
      : '<span class="sub">Everything the studio uses is installed.</span>';
  }).catch(() => {});
  el.onclick = async e => {
    const b = e.target.closest('[data-inst]'); if (!b) return;
    if (!confirm(`Install ${b.textContent.trim()}? It downloads from the internet.`)) return;
    await api(`/api/installs/${b.dataset.inst}`, { method: 'POST', body: {} }).catch(err => toast(err.message));
    const log = el.querySelector('#sc-log'); log.hidden = false;
    const tick = setInterval(async () => {
      const j = (await api('/api/installs').catch(() => [])).find(i => i.id === b.dataset.inst);
      if (!j || !j.job || !document.body.contains(log)) { clearInterval(tick); return; }
      log.textContent = `${j.title}: ${j.job.status}\n${j.job.log.slice(-10).join('\n')}`;
      if (j.job.status !== 'running') { clearInterval(tick); toast(`${j.title}: ${j.job.status}`); }
    }, 1500);
  };
}

views.scholar = {
  key: () => 'scholar',
  mount(el, args) {
    if (args[0]) { this.project(el, args[0]); return; }
    el.innerHTML = `<div class="view-head"><h1>Scholar</h1><span class="sub">Claude makes the document, deck, paper or video; you set every option and revise until it is right.</span></div>
      <section><div class="section-head"><h2>Toolbox</h2><span class="sub" id="sc-root"></span></div><div class="x-panel x-pad" id="sc-tools"><div class="x-thinking"><i></i><i></i><i></i> Checking what this computer can do…</div></div></section>
      <div class="x-scholar"><form class="x-panel x-pad x-form" id="sc-form">
        <div class="x-formats">${FMT.map(([k, l, g, d], i) => `<label class="x-format"><input type="radio" name="type" value="${k}" ${i === 0 ? 'checked' : ''}><span class="x-fg">${g}</span><b>${l}</b><small>${d}</small></label>`).join('')}</div>
        <input class="field" name="title" placeholder="Title" required>
        <textarea class="field" name="brief" rows="5" required placeholder="The brief: what it is for, the key message, what must be in it, what to avoid."></textarea>
        <div id="sc-opts" class="x-opts"></div>
        <div class="x-opts">${row('Audience', txt('audience', 'e.g. thesis committee, conference, first-year students'))}${row('Language', txt('language', 'English', 'English'))}${row('Tone', txt('tone', 'clear and precise'))}
          ${row('Sources', `<textarea class="field" name="sources" rows="2" placeholder="Files or folders to base it on, one full path per line (copied into the project; originals untouched)"></textarea>`)}
          ${row('Research', cb('research', 'let Claude search the web for facts and references (cited)', false))}
          ${row('Claude', `<span class="tools">${sel('model', ['sonnet', 'opus'])}${sel('effort', ['medium', 'high', 'low'])}</span>`)}</div>
        <div class="tools"><button class="btn primary" type="submit">Make it</button><span class="sub">It works in its own folder and uses your pptx, docx, xlsx and pdf skills.</span></div></form>
      <section><div class="section-head"><h2>Your projects</h2></div><div id="sc-list" class="x-list"></div></section></div>`;
    const f = $('#sc-form');
    const drawOpts = () => { $('#sc-opts').innerHTML = OPTS[f.type.value](); };
    f.addEventListener('change', e => { if (e.target.name === 'type') drawOpts(); });
    drawOpts();
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const type = f.type.value;
      const body = { type, title: f.title.value, brief: f.brief.value, options: collectOptions(type, f), sources: f.sources.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean), model: f.model.value, effort: f.effort.value };
      try { const r = await api('/api/studio', { method: 'POST', body }); location.hash = `#/scholar/${r.project.id}`; } catch (err) { toast(err.message); }
    });
    api('/api/studio').then(st => {
      if (!$('#sc-tools')) return;
      $('#sc-root').textContent = st.root;
      toolbox($('#sc-tools'), st);
      $('#sc-list').innerHTML = st.projects.length ? st.projects.map(p => `<a class="x-row" href="#/scholar/${esc(p.id)}"><b>${esc((FMT.find(x => x[0] === p.type) || [])[2] || '')} ${esc(p.title)}</b>
        <span class="sub">${esc((FMT.find(x => x[0] === p.type) || [])[1] || p.type)} · ${esc(p.lastStatus || '')} · ${esc(ago(p.updatedAt))}</span></a>`).join('') : '<div class="empty">Nothing made yet.</div>';
    }).catch(e => toast(e.message));
  },
  route(args) { this.unmount(); this.mount($('#view'), args); },
  unmount() { if (this.rv) this.rv.stop(); this.rv = null; clearInterval(this.timer); },
  update() {},
  async project(el, id) {
    el.innerHTML = '<div id="sp"><div class="x-thinking"><i></i><i></i><i></i></div></div>';
    let p;
    try { p = await api(`/api/studio/${encodeURIComponent(id)}`); } catch (e) { $('#sp').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const st = await api('/api/studio').catch(() => ({ tools: {} }));
    const fm = FMT.find(x => x[0] === p.type) || ['', p.type, '•'];
    $('#sp').innerHTML = `<div class="x-hero x-panel"><div class="x-hero-main"><div class="x-eyebrow"><a href="#/scholar">Scholar</a> · ${esc(fm[1])}</div><h1>${esc(p.title)}</h1>
        <div class="x-mono sub">${esc(p.folder)}</div><div class="tools" style="margin-top:10px"><button class="btn" type="button" data-sp="folder">Open folder</button><button class="btn" type="button" data-sp="del">Remove from list</button></div></div></div>
      <section><div class="section-head"><h2>Claude</h2><span class="sub">${esc(p.model)} · ${esc(p.effort)}</span></div><div id="sp-run"></div>
        <form class="x-form" id="sp-rev"><textarea class="field" name="text" rows="2" placeholder="What should change? e.g. make slide 4 a timeline, warmer palette, cut the intro to one page"></textarea>
          <div class="tools">${sel('model', ['sonnet', 'opus'], p.model)}<button class="btn primary" type="submit">Revise</button><span class="sub">Continues the same conversation, so Claude remembers what it made.</span></div></form></section>
      <section><div class="section-head"><h2>Results</h2><span class="sub" id="sp-count"></span></div><div id="sp-files" class="x-results"></div></section>
      <section><div class="section-head"><h2>Working files</h2></div><div id="sp-other" class="x-files"></div></section>`;
    const running = p.runsInfo.find(r => r.status === 'running') || p.runsInfo[0];
    const showRun = rid => { if (this.rv) this.rv.stop(); this.rv = runView($('#sp-run'), rid, { onDone: () => this.files(p.id, st.tools) }); };
    if (running) showRun(running.id);
    $('#sp-rev').addEventListener('submit', async e => {
      e.preventDefault();
      try { const r = await api(`/api/studio/${p.id}/revise`, { method: 'POST', body: { text: e.target.text.value, model: e.target.model.value } }); e.target.text.value = ''; showRun(r.run.id); } catch (err) { toast(err.message); }
    });
    $('#sp').addEventListener('click', async e => {
      const b = e.target.closest('[data-sp]');
      if (b && b.dataset.sp === 'folder') api(`/api/studio/${p.id}/open`, { method: 'POST', body: {} }).catch(err => toast(err.message));
      if (b && b.dataset.sp === 'del' && confirm('Remove from the list? The folder and its files are kept.')) { await api(`/api/studio/${p.id}`, { method: 'DELETE' }); location.hash = '#/scholar'; }
      const o = e.target.closest('[data-open]'); if (o) api(`/api/studio/${p.id}/open`, { method: 'POST', body: { rel: o.dataset.open } }).then(() => toast('Opening')).catch(err => toast(err.message));
      const pv = e.target.closest('[data-prev]');
      if (pv) { pv.textContent = 'Rendering…'; try { await api(`/api/studio/${p.id}/preview`, { method: 'POST', body: { rel: pv.dataset.prev } }); this.files(p.id, st.tools); } catch (err) { toast(err.message); pv.textContent = 'Preview'; } }
    });
    this.files(p.id, st.tools);
    this.timer = setInterval(() => this.files(p.id, st.tools), 6000);
  },
  async files(id, t) {
    let p;
    try { p = await api(`/api/studio/${encodeURIComponent(id)}`); } catch { return; }
    const box = $('#sp-files'); if (!box) return;
    const sig = p.files.map(f => f.rel + f.mtime).join('|');
    if (box._sig === sig) return;
    box._sig = sig;
    const url = (rel, dl) => `/api/studio/${p.id}/file?rel=${encodeURIComponent(rel)}${dl ? '&download=1' : ''}`;
    const outs = p.files.filter(f => f.output && !/^output\/previews\//.test(f.rel) || f.rel === 'README.md');
    const previews = new Map(p.files.filter(f => /^output\/previews\/.+\.pdf$/.test(f.rel)).map(f => [f.rel.split('/').pop().replace(/\.pdf$/, ''), f.rel]));
    $('#sp-count').textContent = `${outs.length} file${outs.length === 1 ? '' : 's'}`;
    const card = f => {
      const name = f.rel.split('/').pop(), base = name.replace(/\.[^.]+$/, '');
      let view = '';
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(f.ext)) view = `<img src="${url(f.rel)}" alt="${esc(name)}" loading="lazy">`;
      else if (['mp4', 'webm'].includes(f.ext)) view = `<video src="${url(f.rel)}" controls preload="metadata"></video>`;
      else if (f.ext === 'pdf') view = `<iframe src="${url(f.rel)}" title="${esc(name)}"></iframe>`;
      else if (['pptx', 'docx', 'xlsx'].includes(f.ext)) view = previews.has(base) ? `<iframe src="${url(previews.get(base))}" title="${esc(name)} preview"></iframe>`
        : `<div class="x-doc"><span>${{ pptx: '▭', docx: '¶', xlsx: '▦' }[f.ext]}</span>${t.soffice ? `<button class="btn" type="button" data-prev="${esc(f.rel)}">Preview</button>` : '<span class="sub">Install LibreOffice in the toolbox for previews</span>'}</div>`;
      else if (['md', 'tex', 'bib', 'txt', 'csv', 'py'].includes(f.ext)) view = `<div class="x-textprev" data-text="${esc(f.rel)}"></div>`;
      return `<div class="x-card x-result"><div class="x-result-view">${view}</div><div class="x-skill-top"><div class="x-skill-name"><b>${esc(name)}</b><span>${bytes(f.size)} · ${esc(ago(f.mtime))}</span></div></div>
        <div class="tools"><button class="btn" type="button" data-open="${esc(f.rel)}">Open in app</button><a class="btn" href="${url(f.rel, true)}">Download</a></div></div>`;
    };
    box.innerHTML = outs.length ? outs.map(card).join('') : '<div class="empty">Results appear here as Claude makes them.</div>';
    for (const el of box.querySelectorAll('[data-text]')) {
      fetch(url(el.dataset.text)).then(r => r.text()).then(tx => { el.innerHTML = /\.md$/.test(el.dataset.text) ? `<div class="bubble">${md(tx.slice(0, 20000))}</div>` : `<pre>${esc(tx.slice(0, 20000))}</pre>`; }).catch(() => {});
    }
    const other = p.files.filter(f => !f.output && f.rel !== 'README.md');
    $('#sp-other').innerHTML = other.slice(0, 200).map(f => `<button type="button" class="x-file" data-open="${esc(f.rel)}"><span class="x-mono">${esc(f.rel)}</span><span class="sub">${bytes(f.size)}</span></button>`).join('') || '<span class="sub">None yet.</span>';
  },
};
