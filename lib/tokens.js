'use strict';
// The token audit: where the tokens of the last days went, read from Claude Code's own transcripts, and what to change.
// It looks at what every session pays before any work starts (instructions, memory, skill and tool listings, hook
// notes), at what work costs (large tool outputs, files read again and again, skills loaded, the prompt cache being
// rebuilt, very long sessions), and turns the biggest items into concrete fixes. Read-only; nothing leaves the computer.
const fs = require('fs');
const path = require('path');
const P = require('./paths');

// rough tokens for text: about 4 characters per token in English, fewer for code and other scripts
const tok = n => Math.round((typeof n === 'number' ? n : String(n || '').length) / 3.6);
const IMAGE_TOKENS = 1600;
const BIG_OUTPUT = 4000;      // a tool result above this many tokens is worth a look
const REBUILD = 15000;        // cache written in one reply after the first: the prompt cache was rebuilt
const LONG_CONTEXT = 150000;  // replies sent with this much context are expensive even when cached

function listFiles(cutoff) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(P.PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(P.PROJECTS, d.name);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const add = (file, sub) => { try { const st = fs.statSync(file); if (st.mtimeMs >= cutoff) out.push({ file, sub, size: st.size, mtime: st.mtimeMs, project: d.name }); } catch { /* gone */ } };
    for (const n of names) {
      if (n.isFile() && n.name.endsWith('.jsonl')) add(path.join(dir, n.name), false);
      else if (n.isDirectory()) {
        const sub = path.join(dir, n.name, 'subagents');
        try { for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) add(path.join(sub, f), true); } catch { /* none */ }
      }
    }
  }
  return out;
}

// attachments that put text in front of the model at the start of a session, and the field that holds it
const LISTED = { skill_listing: 'content', deferred_tools_delta: 'addedLines', agent_listing_delta: 'addedLines', mcp_instructions_delta: 'addedBlocks' };
const textLen = c => typeof c === 'string' ? c.length
  : Array.isArray(c) ? c.reduce((n, b) => n + (typeof b === 'string' ? b.length : b.type === 'text' ? (b.text || '').length : b.type === 'image' ? IMAGE_TOKENS * 3.6 : JSON.stringify(b).length), 0) : 0;

function what(name, input) {
  input = input || {};
  const s = input.file_path || input.notebook_path || input.command || input.pattern || input.url || input.query || input.description || input.skill || input.prompt || '';
  return String(s).replace(/\s+/g, ' ').slice(0, 140);
}

// one transcript file -> its facts; cached by size and mtime, so the server's repeated audits stay cheap
const cache = new Map();
function parse(f) {
  const c = cache.get(f.file);
  if (c && c.size === f.size && c.mtime === f.mtime) return c.r;
  const r = { file: f.file, sub: f.sub, project: f.project, cwd: null, session: null, title: null, replies: 0, i: 0, o: 0, cw: 0, cr: 0,
    first: null, last: null, maxCtx: 0, longReplies: 0, rebuilds: [], outputs: [], toolTotals: {}, reads: {}, skills: {}, hooks: {}, listing: {} };
  let text;
  try { text = fs.readFileSync(f.file, 'utf8'); } catch { return r; }
  const seen = new Set(), uses = new Map();
  let prevT = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const t = Date.parse(d.timestamp) || null;
    if (d.cwd && !r.cwd) r.cwd = d.cwd;
    if (d.sessionId && !r.session) r.session = d.sessionId;
    if (d.type === 'ai-title' && d.aiTitle) r.title = String(d.aiTitle).slice(0, 120);
    if (d.type === 'attachment' && d.attachment) {
      const a = d.attachment;
      if (a.type === 'hook_additional_context') {
        const k = String(a.hookName || a.hookEvent || 'hook').split(':')[0];
        const h = r.hooks[k] || (r.hooks[k] = { n: 0, chars: 0 });
        h.n++; h.chars += textLen(a.content);
      } else if (LISTED[a.type]) {
        // what the model is told up front (only the fields it sees); the largest one seen stands for the session
        r.listing[a.type] = Math.max(r.listing[a.type] || 0, textLen(a[LISTED[a.type]]) || 0);
      }
      continue;
    }
    const m = d.message;
    if (d.type === 'assistant' && m && m.usage && m.model !== '<synthetic>') {
      if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') uses.set(b.id, { name: b.name, input: b.input });
      const key = m.id || d.uuid;
      if (seen.has(key)) continue;
      seen.add(key);
      const u = m.usage;
      const i = u.input_tokens || 0, o = u.output_tokens || 0, cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
      r.i += i; r.o += o; r.cw += cw; r.cr += cr;
      const ctx = i + cw + cr;
      r.maxCtx = Math.max(r.maxCtx, ctx);
      if (ctx >= LONG_CONTEXT) r.longReplies++;
      if (r.replies > 0 && cw >= REBUILD) r.rebuilds.push({ t, tokens: cw, idleMin: prevT && t ? Math.round((t - prevT) / 60000) : null });
      r.replies++;
      if (t) { r.first = r.first || t; r.last = t; prevT = t; }
      continue;
    }
    if (d.type === 'user' && m && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const use = uses.get(b.tool_use_id) || { name: '?', input: {} };
          const n = tok(textLen(b.content));
          r.toolTotals[use.name] = (r.toolTotals[use.name] || 0) + n;  // every result, for the catalogue's ranking
          if (n >= BIG_OUTPUT) r.outputs.push({ tool: use.name, tokens: n, what: what(use.name, use.input), t });
          if (use.name === 'Read' && use.input && use.input.file_path) {
            const k = String(use.input.file_path).toLowerCase().replace(/\\/g, '/');
            const e = r.reads[k] || (r.reads[k] = { path: use.input.file_path, n: 0, tokens: 0, partial: 0 });
            e.n++; e.tokens += n; if (use.input.offset || use.input.limit) e.partial++;
          }
        } else if (b.type === 'text' && d.isMeta && /^Base directory for this skill:/.test(b.text || '')) {
          // a skill's instructions entering the conversation; named after the Skill call that loaded it
          const use = d.sourceToolUseID && uses.get(d.sourceToolUseID);
          const name = (use && use.input && use.input.skill) || path.basename(/^Base directory for this skill:\s*(.+)$/m.exec(b.text)[1].trim());
          const s = r.skills[name] || (r.skills[name] = { n: 0, tokens: 0 });
          s.n++; s.tokens += tok(b.text);
        }
      }
    }
  }
  r.outputs.sort((a, b) => b.tokens - a.tokens);
  r.outputs = r.outputs.slice(0, 40);
  cache.set(f.file, { size: f.size, mtime: f.mtime, r });
  return r;
}

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
// Claude Code's folder name for a project: every character that is not a letter or digit becomes '-'
const projectDir = cwd => path.join(P.PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, '-'));

// what a session in this folder reads before any work: user and project instructions, the memory index
function standing(cwd) {
  const items = [];
  const add = (what, file, note) => { const t = readText(file); if (t) items.push({ what, file, tokens: tok(t), note }); };
  add('CLAUDE.md (all projects)', path.join(P.CLAUDE, 'CLAUDE.md'));
  if (cwd) {
    add('CLAUDE.md (project)', path.join(cwd, 'CLAUDE.md'));
    add('.claude/CLAUDE.md (project)', path.join(cwd, '.claude', 'CLAUDE.md'));
    add('CLAUDE.local.md', path.join(cwd, 'CLAUDE.local.md'));
    add('Memory index', path.join(projectDir(cwd), 'memory', 'MEMORY.md'), 'loaded into every session in this folder');
  }
  return items;
}

const add = (a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k]; return a; };
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));

function audit({ days = 7 } = {}) {
  days = Math.max(1, Math.min(Number(days) || 7, 60));
  const cutoff = Date.now() - days * 86400000;
  const files = listFiles(cutoff);
  const parsed = files.map(parse).filter(r => r.replies > 0);
  const main = parsed.filter(r => !r.sub), subs = parsed.filter(r => r.sub);
  const sum = rs => rs.reduce((a, r) => add(a, { i: r.i, o: r.o, cw: r.cw, cr: r.cr, replies: r.replies }), { i: 0, o: 0, cw: 0, cr: 0, replies: 0 });
  const weight = x => x.i + x.o + x.cw + x.cr * 0.1; // what counts toward limits (cache reads are heavily discounted)
  const all = sum(parsed), subTotals = sum(subs);

  // outputs, re-reads, skills, hooks, rebuilds across sessions
  const outputs = parsed.flatMap(r => r.outputs.map(o => ({ ...o, session: r.session, project: r.cwd ? path.basename(r.cwd) : r.project, sub: r.sub })))
    .sort((a, b) => b.tokens - a.tokens);
  const rereads = [];
  for (const r of parsed) for (const e of Object.values(r.reads)) {
    if (e.n >= 3) rereads.push({ path: e.path, times: e.n, tokens: e.tokens, wasted: Math.round(e.tokens * (e.n - 1) / e.n), partial: e.partial, project: r.cwd ? path.basename(r.cwd) : r.project, session: r.session });
  }
  rereads.sort((a, b) => b.wasted - a.wasted);
  const skills = {};
  for (const r of parsed) for (const [k, s] of Object.entries(r.skills)) { const e = skills[k] || (skills[k] = { name: k, loads: 0, tokens: 0, sessions: 0 }); e.loads += s.n; e.tokens += s.tokens; e.sessions++; }
  const skillList = Object.values(skills).sort((a, b) => b.tokens - a.tokens);
  const hooks = {};
  for (const r of main) for (const [k, h] of Object.entries(r.hooks)) { const e = hooks[k] || (hooks[k] = { hook: k, notes: 0, tokens: 0 }); e.notes += h.n; e.tokens += tok(h.chars); }
  const rebuilds = parsed.flatMap(r => r.rebuilds.map(x => ({ ...x, session: r.session, project: r.cwd ? path.basename(r.cwd) : r.project })));
  const idleRebuilds = rebuilds.filter(x => x.idleMin != null && x.idleMin >= 55);
  const longSessions = main.filter(r => r.longReplies >= 10).map(r => ({ session: r.session, title: r.title, project: r.cwd ? path.basename(r.cwd) : r.project, replies: r.replies, longReplies: r.longReplies, maxCtx: r.maxCtx, cacheRead: r.cr }))
    .sort((a, b) => b.cacheRead - a.cacheRead);

  // what each session pays up front, from the busiest folder's latest session
  const byCwd = {};
  for (const r of main) if (r.cwd) byCwd[r.cwd] = (byCwd[r.cwd] || 0) + weight(r);
  const busiest = Object.entries(byCwd).sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
  const latest = main.filter(r => r.cwd === busiest[0]).sort((a, b) => b.last - a.last)[0] || main.sort((a, b) => b.last - a.last)[0];
  const upfront = [...standing(busiest[0])];
  if (latest) {
    const L = latest.listing;
    const names = { skill_listing: 'Skill list', deferred_tools_delta: 'Tool names (MCP, browser)', mcp_instructions_delta: 'MCP instructions', agent_listing_delta: 'Subagent types' };
    for (const [k, chars] of Object.entries(L)) if (chars > 400) upfront.push({ what: names[k] || k, tokens: tok(chars), kind: k });
    const ss = latest.hooks.SessionStart;
    if (ss) upfront.push({ what: 'Plugin notes at start', tokens: tok(ss.chars / Math.max(1, ss.n)) });
  }
  upfront.sort((a, b) => b.tokens - a.tokens);
  const upfrontTotal = upfront.reduce((n, x) => n + x.tokens, 0);

  // the fixes, biggest first, each with what it would have saved over the period
  const tips = [];
  const bigOut = outputs.reduce((n, o) => n + o.tokens, 0);
  if (outputs.length) {
    const byTool = {};
    for (const o of outputs) byTool[o.tool] = (byTool[o.tool] || 0) + o.tokens;
    const top = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
    tips.push({ id: 'outputs', title: `${outputs.length} tool results over ${fmt(BIG_OUTPUT)} tokens (${fmt(bigOut)} in all)`,
      detail: `Biggest by tool: ${top}. Each one stays in the conversation and is paid again, from cache, on every later reply. Cap command output (| tail -40, --quiet, -q), read files by line range, grep before reading, and send wide searches to an Explore subagent so only its summary comes back.`,
      saves: Math.round(bigOut * 0.6) });
  }
  const docs = outputs.filter(o => o.tool === 'Read' && /\.(pdf|png|jpe?g|gif|webp)$/i.test(o.what));
  if (docs.length) {
    const n = docs.reduce((s, o) => s + o.tokens, 0);
    tips.push({ id: 'documents', title: `${docs.length} PDFs or images read whole (${fmt(n)})`,
      detail: `Largest: ${docs.slice(0, 3).map(o => `${path.basename(o.what)} ${fmt(o.tokens)}`).join(', ')}. Read a PDF a few pages at a time (pages: "1-3"), or pull out its text first (pdftotext, or a short script) and grep that; take one screenshot to check a render instead of several.`,
      saves: Math.round(n * 0.7) });
  }
  // skills never used, still described to every session
  try {
    const snap = require('./kv').read('skills-snapshot.json', {});
    const used = new Set([...(snap.proven || []), ...(snap.failing || [])]);
    const idle = (snap.index || []).filter(s => !used.has(s.id) && s.id !== 'anchor:anchor' && !/^anchor:/.test(s.id));
    const per = idle.reduce((s, x) => s + tok(Math.min(String(x.description || '').length, 1100) + String(x.name || '').length + 8), 0);
    if (idle.length >= 5 && per > 600) tips.push({ id: 'idle-skills', title: `${idle.length} skills you have never used are described to every session (about ${fmt(per)} each time)`,
      detail: `For example ${idle.slice(0, 6).map(s => s.id).join(', ')}. Switch off the ones you don't need on the Skills page (they can be switched back on any time); a whole plugin can be switched off there too.`,
      saves: per * main.length, skills: idle.map(s => s.id) });
  } catch { /* no snapshot yet */ }
  const wasted = rereads.reduce((n, x) => n + x.wasted, 0);
  if (rereads.length) tips.push({ id: 'rereads', title: `${rereads.length} files read 3 or more times in one session (${fmt(wasted)} spent on repeats)`,
    detail: `Worst: ${rereads.slice(0, 3).map(x => `${path.basename(x.path)} ×${x.times}`).join(', ')}. After an edit the file does not need reading again; when only a part matters, read that range.`, saves: wasted });
  const skillTok = skillList.reduce((n, s) => n + s.tokens, 0);
  if (skillList.length) tips.push({ id: 'skills', title: `Skills loaded ${skillList.reduce((n, s) => n + s.loads, 0)} times (${fmt(skillTok)} of instructions)`,
    detail: `Heaviest: ${skillList.slice(0, 4).map(s => `${s.name} ${fmt(s.tokens / s.loads)} each ×${s.loads}`).join(', ')}. A skill is worth loading for real work it was made for; for a quick question, a status check or a one-line change it is not. Anchor's token saver keeps its own skill hints to clear matches.`,
    saves: Math.round(skillTok * 0.35) });
  const idleTok = idleRebuilds.reduce((n, x) => n + x.tokens, 0);
  if (rebuilds.length) tips.push({ id: 'cache', title: `The prompt cache was rebuilt ${rebuilds.length} times (${fmt(rebuilds.reduce((n, x) => n + x.tokens, 0))} written)`,
    detail: `${idleRebuilds.length} of them after an hour or more away (${fmt(idleTok)}): the cache had expired, so the whole conversation was paid again in full. Coming back to a different topic, start with /clear; to keep going on a long one, /compact before a break makes the rebuild small. Switching model or effort mid-session also rebuilds it.`,
    saves: Math.round(idleTok * 0.7) });
  if (longSessions.length) tips.push({ id: 'long', title: `${longSessions.length} sessions ran with more than ${fmt(LONG_CONTEXT)} tokens of context`,
    detail: `Every reply in them re-reads the whole conversation (cheaper from cache, but it adds up: ${fmt(longSessions.reduce((n, s) => n + s.cacheRead, 0))} cached tokens read). Between separate tasks use /clear; within one long task, /compact keeps what matters.`,
    saves: Math.round(longSessions.reduce((n, s) => n + s.cacheRead, 0) * 0.1 * 0.4) });
  const heavyStanding = upfront.filter(x => x.file && x.tokens > 1500);
  if (heavyStanding.length) tips.push({ id: 'standing', title: `${heavyStanding.map(x => x.what.split(' (')[0]).join(', ')}: ${fmt(heavyStanding.reduce((n, x) => n + x.tokens, 0))} read by every session`,
    detail: `Keep these short: one line per fact, details in separate files that are read only when needed. Anchor's token-audit skill can trim them with you.`,
    saves: Math.round(heavyStanding.reduce((n, x) => n + x.tokens * 0.4, 0) * main.length) });
  if (subs.length) tips.push({ id: 'agents', title: `${subs.length} subagent runs (${fmt(weight(subTotals))} of ${fmt(weight(all))})`,
    detail: 'Subagents keep the main conversation small, which pays off for wide searches. For mechanical work, ask for a smaller model (model: haiku or sonnet) in the Agent call; don\'t spawn several where one would do.', saves: 0 });
  tips.sort((a, b) => b.saves - a.saves);

  return {
    days, from: new Date(cutoff).toISOString(), to: new Date().toISOString(),
    sessions: main.length, subagents: subs.length,
    totals: { ...all, weighted: Math.round(weight(all)), subagentWeighted: Math.round(weight(subTotals)) },
    upfront: { items: upfront, total: upfrontTotal, folder: busiest[0] || null },
    outputs: outputs.slice(0, 15), rereads: rereads.slice(0, 12), skills: skillList.slice(0, 20),
    toolTotals: parsed.reduce((t, r) => { for (const [k, v] of Object.entries(r.toolTotals || {})) t[k] = (t[k] || 0) + v; return t; }, {}),
    hooks: Object.values(hooks).sort((a, b) => b.tokens - a.tokens),
    rebuilds: { count: rebuilds.length, tokens: rebuilds.reduce((n, x) => n + x.tokens, 0), idle: idleRebuilds.length, idleTokens: idleTok },
    longSessions: longSessions.slice(0, 10), tips,
  };
}

// the same audit, as text for `anchor tokens` and for Claude (the token-audit skill reads this)
function text(a) {
  const L = [];
  L.push(`Token audit, last ${a.days} day${a.days > 1 ? 's' : ''}: ${a.sessions} sessions, ${a.subagents} subagent runs, ${fmt(a.totals.replies)} replies.`);
  L.push(`Counted toward limits: about ${fmt(a.totals.weighted)} (fresh input ${fmt(a.totals.i)}, output ${fmt(a.totals.o)}, cache written ${fmt(a.totals.cw)}, cache read ${fmt(a.totals.cr)} at 10%).`);
  L.push('');
  L.push(`Before any work, each session in ${a.upfront.folder ? path.basename(a.upfront.folder) : 'your busiest folder'} reads about ${fmt(a.upfront.total)} tokens:`);
  for (const x of a.upfront.items.slice(0, 8)) L.push(`  ${fmt(x.tokens).padStart(5)}  ${x.what}${x.file ? `  (${x.file})` : ''}`);
  L.push('');
  L.push('What to change, biggest saving first:');
  a.tips.forEach((t, i) => { L.push(`${i + 1}. ${t.title}${t.saves ? `  (would have saved about ${fmt(t.saves)})` : ''}`); L.push(`   ${t.detail}`); });
  if (a.outputs.length) { L.push(''); L.push('Largest tool results:'); for (const o of a.outputs.slice(0, 8)) L.push(`  ${fmt(o.tokens).padStart(5)}  ${o.tool.padEnd(10)} ${o.what}  [${o.project}${o.sub ? ', subagent' : ''}]`); }
  if (a.rereads.length) { L.push(''); L.push('Files read again and again (same session):'); for (const x of a.rereads.slice(0, 6)) L.push(`  ×${String(x.times).padEnd(3)} ${fmt(x.wasted).padStart(5)} repeated  ${x.path}`); }
  if (a.skills.length) { L.push(''); L.push('Skills loaded:'); for (const s of a.skills.slice(0, 8)) L.push(`  ${fmt(s.tokens).padStart(5)}  ${s.name} ×${s.loads}`); }
  if (a.hooks.length) { L.push(''); L.push('Notes added by hooks:'); for (const h of a.hooks) L.push(`  ${fmt(h.tokens).padStart(5)}  ${h.hook} (${h.notes} notes)`); }
  L.push('');
  L.push('Token counts are estimates from the transcripts (about 3.6 characters per token).');
  return L.join('\n');
}

module.exports = { audit, text, fmt, tok };
