'use strict';
/* Live: Claude and its agents at work. Agents on the left with what each is doing; the stream on the right shows every
   step, with the actual before/after of each file edit, as it happens. */

function editCard(e) {
  const name = String(e.file || '').split(/[\\/]/).pop();
  const lang = langOf(name);
  let body = '', add = 0, del = 0;
  if (e.edits) for (const x of e.edits) { const d = diffHtml(x.old, x.new, lang); body += d.html; add += d.add; del += d.del; }
  else if (e.write != null) { const d = diffHtml('', e.write, lang); body = d.html; add = e.lines || d.add; }
  const err = e.result && e.result.err;
  return `<article class="x-edit ${err ? 'is-err' : ''}" data-ts="${esc(e.ts)}">
    <header><span class="x-edit-kind">${e.tool === 'Write' ? 'Wrote' : 'Edited'}</span><a class="x-mono" href="#/code?path=${encodeURIComponent(e.file)}" title="${esc(e.file)}">${esc(name)}</a>
      <span class="x-adds">+${add}</span><span class="x-dels">−${del}</span>${e.all ? '<span class="chip">all matches</span>' : ''}${err ? '<span class="chip bad">refused</span>' : ''}
      <span class="sub" style="margin-left:auto">${e.agent ? `${esc(e.agent.type)} · ` : ''}${esc(new Date(e.ts).toLocaleTimeString())}</span></header>${body}
    ${err ? `<div class="x-err">${esc(e.result.text)}</div>` : ''}</article>`;
}

function stepRow(e) {
  if (e.kind === 'say') return `<div class="x-say"><span class="x-who">${e.agent ? esc(e.agent.type) : 'Claude'}</span><div class="bubble">${md(e.text)}</div></div>`;
  if (e.file) return editCard(e);
  const icon = { Bash: '⌘', PowerShell: '⌘', Read: '◉', Grep: '⌕', Glob: '⌕', WebSearch: '◎', WebFetch: '◎', Agent: '✦', Task: '✦', Skill: '✧', TodoWrite: '☑' }[e.tool] || '•';
  return `<div class="x-tool ${e.result && e.result.err ? 'is-err' : ''}"><span class="x-ic">${icon}</span><b>${esc(e.tool)}</b><span class="x-sum">${esc(e.agentLaunch ? `${e.agentLaunch.type}: ${e.agentLaunch.description}` : e.summary)}</span>
    <span class="sub">${e.agent ? esc(e.agent.type) + ' · ' : ''}${esc(new Date(e.ts).toLocaleTimeString())}</span>${e.command ? `<pre class="x-cmd">${esc(e.command)}</pre>` : ''}</div>`;
}

views.live = {
  mount(el) {
    this.filter = 'all'; this.kind = 'all'; this.follow = true; this.sig = '';
    el.innerHTML = `<div class="view-head"><h1>Live</h1><span class="sub" id="lv-sub">Watching transcripts…</span>
        <span class="tools" style="margin-left:auto"><button class="btn" type="button" id="lv-kind" data-k="all">Everything</button><button class="btn" type="button" id="lv-follow" aria-pressed="true">Follow</button>
        <select class="field" id="lv-hours"><option value="2">Last 2 h</option><option value="6" selected>Last 6 h</option><option value="24">Last day</option></select></span></div>
      <div class="x-live"><aside><div id="lv-agents"></div></aside><section class="x-stream" id="lv-stream"><div class="x-thinking"><i></i><i></i><i></i></div></section></div>`;
    $('#lv-agents').addEventListener('click', e => { const a = e.target.closest('[data-agent]'); if (a) { this.filter = this.filter === a.dataset.agent ? 'all' : a.dataset.agent; this.sig = ''; this.load(); } });
    $('#lv-follow').onclick = () => { this.follow = !this.follow; $('#lv-follow').setAttribute('aria-pressed', this.follow); };
    $('#lv-kind').onclick = () => { const order = ['all', 'edits', 'agents']; this.kind = order[(order.indexOf(this.kind) + 1) % 3]; $('#lv-kind').textContent = { all: 'Everything', edits: 'File edits only', agents: 'Agents only' }[this.kind]; this.sig = ''; this.load(); };
    $('#lv-hours').onchange = () => { this.sig = ''; this.load(); };
    this.load();
    this.timer = setInterval(() => { if (!document.hidden) this.load(); }, 2500);
  },
  unmount() { clearInterval(this.timer); },
  update() {},
  async load() {
    if (this.busy) return; this.busy = true;
    try {
      const a = await api(`/api/activity?hours=${$('#lv-hours').value}&limit=500`);
      if (!$('#lv-stream')) return;
      const running = a.agents.filter(x => x.running);
      const edits = a.events.filter(e => e.file).length;
      $('#lv-sub').textContent = `${running.length} agent${running.length === 1 ? '' : 's'} working · ${a.events.length} steps · ${edits} file edits in view`;
      const main = [...new Map(a.events.filter(e => !e.agent).map(e => [e.sessionId, e])).values()];
      setHTML($('#lv-agents'), `<div class="x-eyebrow">Sessions</div>${main.map(e => `<button type="button" class="x-agent ${e.busy ? 'is-run' : ''} ${this.filter === 's:' + e.sessionId ? 'sel' : ''}" data-agent="s:${esc(e.sessionId)}">
          <span class="x-orb"></span><b>${esc(e.project)}</b><span class="sub">${esc(String(e.session).slice(0, 60))}</span></button>`).join('') || '<div class="sub">No session activity in this window.</div>'}
        <div class="x-eyebrow" style="margin-top:16px">Agents</div>${a.agents.map(g => `<button type="button" class="x-agent ${g.running ? 'is-run' : ''} ${this.filter === 'a:' + g.id ? 'sel' : ''}" data-agent="a:${esc(g.id)}">
          <span class="x-orb"></span><b>${esc(g.description || g.type)}</b><span class="sub">${esc(g.type)} · ${esc(g.project)} · ${g.running ? 'working' : g.finished ? 'finished' : 'quiet'} ${esc(ago(g.lastActivity))}</span>
          <span class="x-doing">${esc(g.doing)}</span><span class="sub">${g.edits} edit${g.edits === 1 ? '' : 's'} · ${g.tools} steps</span></button>`).join('') || '<div class="sub">No agents in this window.</div>'}`);
      let ev = a.events;
      if (this.filter.startsWith('a:')) ev = ev.filter(e => e.agent && e.agent.id === this.filter.slice(2));
      if (this.filter.startsWith('s:')) ev = ev.filter(e => e.sessionId === this.filter.slice(2));
      if (this.kind === 'edits') ev = ev.filter(e => e.file);
      if (this.kind === 'agents') ev = ev.filter(e => e.agent);
      ev = ev.slice(-180);
      const sig = ev.length + ':' + (ev[ev.length - 1] || {}).id + ':' + this.filter + this.kind;
      if (sig === this.sig) return;
      this.sig = sig;
      const s = $('#lv-stream');
      const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 120;
      s.innerHTML = ev.length ? ev.map(stepRow).join('') : '<div class="empty">Nothing in this window yet. When Claude or an agent works, every step and file change streams in here.</div>';
      if (this.follow && (atBottom || !this.seen)) s.scrollTop = s.scrollHeight;
      this.seen = true;
    } catch (e) { const s = $('#lv-stream'); if (s) s.innerHTML = `<div class="empty">${esc(e.message)}</div>`; } finally { this.busy = false; }
  },
};
