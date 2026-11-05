'use strict';
// The live feed: what Claude and its agents are doing right now, read from the tails of recently active transcripts
// (the main session file and each subagent's). Every file edit keeps its before/after text so the page can show a diff.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const T = require('./transcripts');
const { redact } = require('./redact');

const TAIL = 1.5e6;
const cache = new Map(); // file -> {size, events, results}
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '\n…' : s);

function readTail(file, size) {
  const n = Math.min(TAIL, size);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    let s = buf.toString('utf8');
    if (size > n) s = s.slice(s.indexOf('\n') + 1);
    return s;
  } finally { fs.closeSync(fd); }
}

function describe(name, inp) {
  const v = inp.description || inp.file_path || inp.notebook_path || inp.path || inp.pattern || inp.query || inp.url || inp.command || inp.skill || inp.prompt || '';
  return redact(String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 240));
}

function parse(file) {
  const st = fs.statSync(file);
  const c = cache.get(file);
  if (c && c.size === st.size) return c;
  const events = [];
  const results = new Map();
  for (const line of readTail(file, st.size).split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const content = d.message && Array.isArray(d.message.content) ? d.message.content : null;
    if (!content) continue;
    if (d.type === 'assistant') {
      for (const b of content) {
        if (b.type === 'text' && b.text && b.text.trim()) events.push({ id: d.uuid, ts: d.timestamp, kind: 'say', text: clip(redact(b.text.trim()), 1200) });
        if (b.type !== 'tool_use') continue;
        const inp = b.input || {};
        const e = { id: b.id, ts: d.timestamp, kind: 'tool', tool: b.name, summary: describe(b.name, inp) };
        if (b.name === 'Edit') Object.assign(e, { file: inp.file_path, edits: [{ old: clip(redact(inp.old_string || ''), 6000), new: clip(redact(inp.new_string || ''), 6000) }], all: !!inp.replace_all });
        else if (b.name === 'MultiEdit') Object.assign(e, { file: inp.file_path, edits: (inp.edits || []).slice(0, 12).map(x => ({ old: clip(redact(x.old_string || ''), 4000), new: clip(redact(x.new_string || ''), 4000) })) });
        else if (b.name === 'Write') Object.assign(e, { file: inp.file_path, write: clip(redact(inp.content || ''), 8000), lines: String(inp.content || '').split('\n').length });
        else if (b.name === 'NotebookEdit') Object.assign(e, { file: inp.notebook_path, edits: [{ old: '', new: clip(redact(inp.new_source || ''), 6000) }] });
        else if (b.name === 'Bash' || b.name === 'PowerShell') e.command = clip(redact(inp.command || ''), 1500);
        else if (b.name === 'Agent' || b.name === 'Task') e.agentLaunch = { type: inp.subagent_type || 'general-purpose', description: inp.description || '' };
        events.push(e);
      }
    } else if (d.type === 'user') {
      for (const b of content) if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x.text || '').join('\n') : '';
        results.set(b.tool_use_id, { err: !!b.is_error, text: clip(redact(text), b.is_error ? 800 : 300), ts: d.timestamp });
      }
    }
  }
  const v = { size: st.size, events: events.slice(-400), results };
  cache.set(file, v);
  if (cache.size > 120) cache.delete(cache.keys().next().value);
  return v;
}

function feed({ hours = 6, limit = 300, session = null } = {}) {
  const since = Date.now() - hours * 3600e3;
  const out = [];
  const agents = [];
  for (const x of T.allStates()) {
    const st = x.st;
    if (session && st.id !== session) continue;
    let mtime = 0;
    try { mtime = fs.statSync(st.file).mtimeMs; } catch { continue; }
    const subdir = path.join(path.dirname(st.file), st.id, 'subagents');
    let subs = [];
    try { subs = fs.readdirSync(subdir).filter(f => f.endsWith('.jsonl')); } catch { /* no agents */ }
    const subTimes = subs.map(f => { try { return fs.statSync(path.join(subdir, f)).mtimeMs; } catch { return 0; } });
    if (Math.max(mtime, ...subTimes) < since) continue;
    const who = { sessionId: st.id, project: x.project, session: st.customTitle || st.aiTitle || st.firstPrompt || '(untitled)', live: !!x.live, busy: !!(x.live && x.live.status === 'busy') };
    if (mtime >= since) {
      const p = parse(st.file);
      for (const e of p.events) if (Date.parse(e.ts) >= since) out.push({ ...e, ...who, agent: null, result: p.results.get(e.id) || null });
    }
    subs.forEach((f, i) => {
      if (subTimes[i] < since) return;
      const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(subdir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* still starting */ }
      const p = parse(path.join(subdir, f));
      const running = !meta.finished && x.live && Date.now() - subTimes[i] < 20 * 60e3;
      const edits = p.events.filter(e => e.file).length;
      const last = p.events[p.events.length - 1];
      agents.push({ id, ...who, type: meta.agentType || 'agent', description: meta.description || '', running, finished: !!meta.finished,
        lastActivity: new Date(subTimes[i]).toISOString(), edits, tools: p.events.filter(e => e.kind === 'tool').length,
        doing: last ? (last.kind === 'tool' ? `${last.tool} · ${last.summary}` : last.text.slice(0, 160)) : 'starting…',
        files: [...new Set(p.events.filter(e => e.file).map(e => e.file))].slice(-8) });
      for (const e of p.events) if (Date.parse(e.ts) >= since) out.push({ ...e, ...who, agent: { id, type: meta.agentType || 'agent', description: meta.description || '' }, result: p.results.get(e.id) || null });
    });
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  agents.sort((a, b) => (b.running - a.running) || String(b.lastActivity).localeCompare(String(a.lastActivity)));
  return { events: out.slice(-limit), agents: agents.slice(0, 60), now: new Date().toISOString() };
}

module.exports = { feed };
