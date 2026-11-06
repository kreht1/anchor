'use strict';
// Per-agent cost: what each subagent of a session spent, measured the same way for every agent, from its own
// transcript. It counts every attempt (a run that crashed and was resumed is still one agent), removes idle stalls
// from the time, and shows how much of the cost was the conversation being re-read at a large context. Use it to
// compare two ways of doing the same job (with and without a skill, two models, two prompts).
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const IDLE = 5 * 60e3;          // a gap longer than this between two events is a stall, not work
const BIG = 150000;             // replies sent with more context than this are the expensive ones
const weight = u => u.i + u.o + u.cw + u.cr * 0.1; // same weighting as `anchor tokens`: what counts toward limits

// Session folders that have subagents, newest first.
function sessions() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(P.PROJECTS); } catch { return out; }
  for (const p of projects) {
    const dir = path.join(P.PROJECTS, p);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name, 'subagents');
      try { const st = fs.statSync(sub); out.push({ id: e.name, project: p, dir: sub, mtime: st.mtimeMs }); } catch { /* no subagents */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function measure(file) {
  const u = { i: 0, o: 0, cw: 0, cr: 0 }, seen = new Set();
  let replies = 0, tools = 0, peak = 0, bigCr = 0, first = 0, last = 0, prev = 0, idle = 0, model = '', images = 0;
  const names = {};
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const t = Date.parse(j.timestamp || '');
    if (t) { if (!first) first = t; if (prev && t - prev > IDLE) idle += t - prev; prev = t; last = t; }
    const m = j.message;
    if (j.type === 'user' && m && Array.isArray(m.content)) for (const c of m.content) if (c.type === 'tool_result' && Array.isArray(c.content)) images += c.content.filter(x => x.type === 'image').length;
    if (j.type !== 'assistant' || !m) continue;
    for (const c of m.content || []) if (c.type === 'tool_use') { tools++; names[c.name] = (names[c.name] || 0) + 1; }
    if (!m.usage || seen.has(m.id)) continue;
    seen.add(m.id); replies++;
    if (m.model && m.model !== '<synthetic>') model = m.model;
    const x = m.usage, i = x.input_tokens || 0, cr = x.cache_read_input_tokens || 0, cw = x.cache_creation_input_tokens || 0;
    u.i += i; u.o += x.output_tokens || 0; u.cw += cw; u.cr += cr;
    const ctx = i + cr + cw;
    if (ctx > peak) peak = ctx;
    if (ctx > BIG) bigCr += cr;
  }
  const wall = last - first;
  const top = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')} ${c}`);
  return { replies, tools, ...u, weighted: Math.round(weight(u)), peak, bigShare: weight(u) ? Math.round(bigCr * 0.1 / weight(u) * 100) : 0,
    images, wallMin: Math.round(wall / 60e3), activeMin: Math.round((wall - idle) / 60e3), model, top };
}

// Every subagent of one session (the newest one with subagents when no id is given).
function report({ session } = {}) {
  const all = sessions();
  const s = session ? all.find(x => x.id.startsWith(session)) : all[0];
  if (!s) return { error: session ? `no session ${session} with subagents` : 'no session with subagents yet' };
  const agents = [];
  for (const f of fs.readdirSync(s.dir).filter(f => /^agent-.+\.jsonl$/.test(f))) {
    const id = f.slice(6, -6);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(s.dir, `agent-${id}.meta.json`), 'utf8')); } catch { /* older runs have none */ }
    const r = measure(path.join(s.dir, f));
    if (r && r.replies) agents.push({ id, description: meta.description || meta.agentType || id, type: meta.agentType || '', depth: meta.spawnDepth || 1, ...r });
  }
  agents.sort((a, b) => b.weighted - a.weighted);
  return { session: s.id, project: s.project, agents };
}

const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

function text(r) {
  if (r.error) return r.error;
  const L = [`Subagents of session ${r.session.slice(0, 8)} (${r.agents.length}), most expensive first. Weighted = fresh input + output + cache written + 10% of cache read.`, ''];
  for (const a of r.agents) {
    L.push(`${a.description}${a.depth > 1 ? '  (nested)' : ''}`);
    L.push(`  ${fmt(a.weighted)} weighted · ${a.replies} replies · ${a.tools} tool calls · output ${fmt(a.o)} · cache written ${fmt(a.cw)} · cache read ${fmt(a.cr)}`);
    L.push(`  peak context ${fmt(a.peak)} · ${a.bigShare}% of the cost was re-reading a context over 150k · ${a.images} images · ${a.activeMin} min working (${a.wallMin} min with stalls)`);
    L.push(`  ${a.model || 'model ?'} · most used: ${a.top.join(', ')}`);
  }

  return L.join('\n');
}

module.exports = { report, text, measure, sessions };
