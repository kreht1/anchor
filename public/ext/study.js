'use strict';
/* Study: give Claude a folder and a goal (what is this workspace about, teach me the code function by function, map
   the architecture, onboarding guide, or your own question). Claude reads only; the result is kept as a document. */

const STUDY_MODES = [
  ['overview', 'What is this workspace about?', 'Purpose, topic, who it is for, state, main parts, glossary'],
  ['code', 'Teach me the code', 'Each module and function: what it does, why it exists, how it is structured'],
  ['architecture', 'Map the architecture', 'Components, data flow (diagram), dependencies, weak spots'],
  ['onboarding', 'Onboarding guide', 'Setup, files to read first, how to change things safely'],
  ['custom', 'Ask my own question', 'Anything about the folder'],
];

function studyPanel(el, cwd) {
  el.innerHTML = `<div class="x-study"><form class="x-panel x-pad x-form" id="st-form">
      <label class="x-label">Folder</label><input class="field x-mono" name="cwd" required value="${esc(cwd || '')}" placeholder="C:\\path\\to\\folder">
      <label class="x-label">What should Claude do?</label>
      <div class="x-modes">${STUDY_MODES.map(([k, t, d], i) => `<label class="x-mode"><input type="radio" name="mode" value="${k}" ${i === 0 ? 'checked' : ''}><span><b>${t}</b><small>${d}</small></span></label>`).join('')}</div>
      <textarea class="field" name="question" rows="2" placeholder="Your question (for “Ask my own question”)" hidden></textarea>
      <div class="tools"><select class="field" name="model"><option value="sonnet">Sonnet · fast and thorough</option><option value="opus">Opus · deepest</option></select>
        <select class="field" name="effort"><option value="medium">Normal effort</option><option value="high">High effort</option><option value="low">Quick pass</option></select>
        <button class="btn primary" type="submit">Start studying</button><span class="sub">Read-only: Claude can Read, Glob and Grep, nothing else.</span></div></form>
    <div id="st-run"></div><section><div class="section-head"><h2>Earlier studies</h2></div><div id="st-past" class="x-list"></div></section></div>`;
  const form = el.querySelector('#st-form');
  form.addEventListener('change', () => { form.question.hidden = form.mode.value !== 'custom'; });
  let rv = null;
  const show = id => { if (rv) rv.stop(); rv = runView(el.querySelector('#st-run'), id, { onDone: past }); el.querySelector('#st-run').scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try { const r = await api('/api/runs', { method: 'POST', body: { kind: 'study', cwd: f.cwd.trim().replace(/^"|"$/g, ''), mode: f.mode, question: f.question, model: f.model, effort: f.effort } }); show(r.id); past(); } catch (err) { toast(err.message); }
  });
  async function past() {
    const rs = (await api('/api/runs').catch(() => [])).filter(r => (r.kind === 'study' || r.kind === 'file') && (!cwd || String(r.cwd).toLowerCase() === cwd.toLowerCase()));
    el.querySelector('#st-past').innerHTML = rs.length ? rs.map(r => `<div class="x-row x-run-row"><button type="button" class="x-row-main" data-run="${esc(r.id)}"><b>${esc(r.title)}</b>
        <span class="sub">${esc(shortPath(r.cwd))} · ${esc(ago(r.startedAt))} · ${esc(r.status)}${r.cost != null ? ` · $${Number(r.cost).toFixed(2)}` : ''}</span><span class="x-preview">${esc(r.preview || '')}</span></button>
        <button class="btn" type="button" data-del="${esc(r.id)}" title="Delete">✕</button></div>`).join('') : '<div class="empty">No studies yet.</div>';
  }
  el.querySelector('#st-past').addEventListener('click', async e => {
    const d = e.target.closest('[data-del]');
    if (d) { if (confirm('Delete this study?')) { await api(`/api/runs/${d.dataset.del}`, { method: 'DELETE' }).catch(err => toast(err.message)); past(); } return; }
    const b = e.target.closest('[data-run]'); if (b) show(b.dataset.run);
  });
  past();
}

views.study = {
  mount(el, args, query) {
    el.innerHTML = `<div class="view-head"><h1>Study</h1><span class="sub">Point Claude at a folder; it reads everything that matters and writes you a document you can keep.</span></div><div id="study-root"></div>`;
    studyPanel($('#study-root'), query.get('cwd') || '');
  },
  update() {},
};
