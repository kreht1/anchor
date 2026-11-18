'use strict';
// Codex (OpenAI's coding agent) as a second home for Anchor. Codex reads Claude plugin marketplaces and plugins
// directly, runs plugin hooks (SessionStart, UserPromptSubmit, PreToolUse) with the same JSON as Claude Code, and loads
// SKILL.md folders from ~/.agents/skills, ~/.codex/skills and its plugin cache. This file knows where Codex keeps
// things, reads its session logs (tokens, context, rate limits) and lists the skills Codex can see.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./paths');

const HOME = process.env.CODEX_HOME || path.join(P.HOME, '.codex');
const AGENTS_SKILLS = process.env.ANCHOR_AGENTS_SKILLS || path.join(P.HOME, '.agents', 'skills'); // the cross-agent skills folder Codex reads; Anchor ports here
const PATHS = {
  HOME,
  CONFIG: path.join(HOME, 'config.toml'),
  AGENTS_MD: path.join(HOME, 'AGENTS.md'),
  SESSIONS: path.join(HOME, 'sessions'),
  SKILLS: path.join(HOME, 'skills'),
  PLUGIN_CACHE: path.join(HOME, 'plugins', 'cache'),
  AGENTS_SKILLS,
};

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => path.join(d, x.name)); } catch { return []; } };

// is this hook call coming from Codex? The hooks file passes --agent codex; the stdin payload is a fallback
// (Codex adds `model` and `turn_id`, and its transcripts live under ~/.codex/sessions)
function isCodex(flag, input) {
  if (flag === 'codex') return true;
  if (flag === 'claude') return false;
  const t = String((input && input.transcript_path) || '').toLowerCase().replace(/\\/g, '/');
  return t.includes('/.codex/sessions/') || /\/rollout-[^/]*\.jsonl$/.test(t);
}

// --------------------------------------------------------------- install state
// how to start codex: on Windows npm installs a codex.cmd, which only cmd.exe can run (fixed arguments only)
function run(args) {
  return process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'codex', ...args]] : ['codex', args];
}

let verCache = null;
function version() {
  if (verCache && Date.now() - verCache.at < 60000) return verCache.v;
  let v = null;
  try {
    const [cmd, args] = run(['--version']);
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    v = (/(\d+\.\d+\.\d+[\w.-]*)/.exec(out) || [])[1] || out.trim() || null;
  } catch { v = null; }
  verCache = { at: Date.now(), v };
  return v;
}

// a tiny TOML reader for the two tables Anchor cares about: [marketplaces.x] and [plugins."x@y"]
function config() {
  const text = readText(PATHS.CONFIG);
  const out = { marketplaces: {}, plugins: {}, features: {}, text };
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const h = /^\[(.+)\]$/.exec(line);
    if (h) {
      const parts = [...h[1].matchAll(/"([^"]+)"|([^.]+)/g)].map(m => (m[1] || m[2]).trim());
      cur = null;
      if (parts[0] === 'marketplaces' && parts[1]) cur = out.marketplaces[parts[1]] = {};
      else if (parts[0] === 'plugins' && parts[1]) cur = out.plugins[parts[1]] = {};
      else if (parts[0] === 'features' && parts.length === 1) cur = out.features;
      continue;
    }
    const kv = /^([\w.-]+)\s*=\s*(.+)$/.exec(line);
    if (cur && kv) {
      let v = kv[2].trim();
      if (/^(true|false)$/.test(v)) v = v === 'true';
      else v = v.replace(/^'(.*)'$|^"(.*)"$/, (m, a, b) => (a !== undefined ? a : b));
      cur[kv[1]] = v;
    }
  }
  return out;
}

function loggedIn() {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true;
  try { const a = JSON.parse(readText(path.join(HOME, 'auth.json')) || '{}'); return !!(a.tokens || a.OPENAI_API_KEY || a.api_key); } catch { return false; }
}

function status() {
  const ver = version();
  const cfg = config();
  const plugin = cfg.plugins['anchor@anchor'];
  const installed = subdirs(path.join(PATHS.PLUGIN_CACHE, 'anchor', 'anchor')).map(d => path.basename(d)).sort();
  return {
    installed: !!ver, version: ver, home: HOME, exists: fs.existsSync(HOME), loggedIn: loggedIn(),
    marketplace: !!cfg.marketplaces.anchor, marketplaceSource: cfg.marketplaces.anchor ? cfg.marketplaces.anchor.source : null,
    plugin: !!plugin, pluginEnabled: !!plugin && plugin.enabled !== false, pluginVersions: installed,
    hooksFeature: cfg.features.hooks !== false && cfg.features.codex_hooks !== false,
    // approvals live in [hooks.state."anchor@anchor:..."] with the hash of the plugin's code at approval time
    hooksApproved: cfg.text.includes('[hooks.state."anchor@anchor:'),
    agentsNote: readText(PATHS.AGENTS_MD).includes('<!-- anchor:start -->'),
  };
}

// --------------------------------------------------------------- sessions
// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, one JSON event per line:
//   {type:'session_meta', payload:{id, cwd, timestamp, cli_version}}
//   {type:'event_msg', payload:{type:'token_count', info:{total_token_usage, last_token_usage, model_context_window}, rate_limits}}
//   {type:'event_msg', payload:{type:'user_message', message}}   {type:'turn_context', payload:{model, cwd}}
function rollouts(days = 30) {
  const out = [], cut = Date.now() - days * 86400000;
  for (const y of subdirs(PATHS.SESSIONS)) for (const m of subdirs(y)) for (const d of subdirs(m)) {
    let files = [];
    try { files = fs.readdirSync(d).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(d, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs >= cut) out.push({ file, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function tailLines(file, bytes = 600000) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').split('\n');
    if (n < size) lines.shift();
    return lines;
  } finally { fs.closeSync(fd); }
}

const userText = p => {
  if (!p) return '';
  if (p.type === 'user_message') return String(p.message || '');
  if (p.type === 'message' && p.role === 'user') return (p.content || []).map(c => c.text || '').join('\n');
  return '';
};
// what Codex itself injects as a "user" message (AGENTS.md, environment context): not the person's words
const injected = t => /^\s*<(environment_context|user_instructions|INSTRUCTIONS|permissions)/i.test(t) || /^# AGENTS\.md instructions/i.test(t);

// the governor's view of a Codex session: context of the last turn, when it happened, the last human prompts
function sessionState(file) {
  const out = { context: 0, last: 0, ttlMin: 0, prompts: [], window: 0 };
  if (!file) return out;
  let lines; try { lines = tailLines(file); } catch { return out; }
  let found = false;
  for (let i = lines.length - 1; i >= 0 && (out.prompts.length < 6 || !found); i--) {
    let d; try { d = JSON.parse(lines[i]); } catch { continue; }
    const t = Date.parse(d.timestamp || '') || 0;
    if (!out.last && t) out.last = t;
    const p = d.payload || {};
    if (!found && p.type === 'token_count' && p.info) {
      const u = p.info.last_token_usage || p.info.total_token_usage || {};
      out.context = u.input_tokens || 0; // OpenAI counts cached input inside input_tokens
      out.window = p.info.model_context_window || 0;
      found = true;
    }
    // interactive sessions log a user_message event; `codex exec` only the response item. Read both, keep one copy.
    if ((d.type === 'event_msg' && p.type === 'user_message') || (d.type === 'response_item' && p.type === 'message' && p.role === 'user')) {
      const txt = userText(p);
      if (txt.trim() && !injected(txt) && out.prompts[out.prompts.length - 1] !== txt) out.prompts.push(txt);
    }
  }
  return out;
}

// one pass over a rollout: totals, the last rate-limit snapshot, project, model
function summarize(file) {
  const s = { id: null, cwd: null, model: null, started: null, last: null, prompts: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0, context: 0, window: 0, limits: null, limitsAt: null, firstPrompt: '' };
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return s; }
  const items = []; let events = 0; // user prompts as response items (codex exec) and as events (interactive)
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    const t = d.timestamp || null;
    if (t) { if (!s.started) s.started = t; s.last = t; }
    if (d.type === 'session_meta') { s.id = p.id || s.id; s.cwd = p.cwd || s.cwd; if (p.timestamp) s.started = p.timestamp; }
    else if (d.type === 'turn_context') { s.model = p.model || s.model; s.cwd = p.cwd || s.cwd; }
    else if (d.type === 'event_msg' && p.type === 'user_message') { const txt = userText(p); if (txt.trim() && !injected(txt)) { events++; if (!s.firstPrompt) s.firstPrompt = txt.slice(0, 200); } }
    else if (d.type === 'response_item' && p.type === 'message' && p.role === 'user') { const txt = userText(p); if (txt.trim() && !injected(txt)) items.push(txt); }
    else if (d.type === 'event_msg' && p.type === 'token_count') {
      const tot = p.info && p.info.total_token_usage;
      if (tot) { s.input = tot.input_tokens || 0; s.cached = tot.cached_input_tokens || 0; s.output = tot.output_tokens || 0; s.reasoning = tot.reasoning_output_tokens || 0; s.total = tot.total_tokens || (s.input + s.output); }
      const last = p.info && p.info.last_token_usage;
      if (last) s.context = last.input_tokens || 0;
      if (p.info && p.info.model_context_window) s.window = p.info.model_context_window;
      if (p.rate_limits) { s.limits = p.rate_limits; s.limitsAt = t; }
    }
  }
  s.prompts = events || items.length;
  if (!s.firstPrompt && items.length) s.firstPrompt = items[0].slice(0, 200);
  s.fresh = Math.max(0, s.input - s.cached) + s.output; // what this session cost beyond cache reads
  if (!s.id) s.id = (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(path.basename(file)) || [])[1] || path.basename(file, '.jsonl');
  return s;
}

const sumCache = new Map();
function sessions(days = 14, limit = 60) {
  return rollouts(days).slice(0, limit).map(r => {
    const c = sumCache.get(r.file);
    if (c && c.mtime === r.mtime) return c.v;
    const v = { ...summarize(r.file), file: r.file, project: null };
    if (v.cwd) v.project = path.basename(v.cwd);
    sumCache.set(r.file, { mtime: r.mtime, v });
    return v;
  });
}

// Codex reports its own limits in every token_count event: primary (the short window) and secondary (the week),
// each {used_percent, window_minutes, resets_at|resets_in_seconds}. The newest snapshot wins.
function limitWindow(w, at) {
  if (!w) return null;
  let reset = null;
  if (w.resets_at) reset = new Date(typeof w.resets_at === 'number' ? w.resets_at * (w.resets_at < 1e12 ? 1000 : 1) : w.resets_at).toISOString();
  else if (w.resets_in_seconds != null && at) reset = new Date(Date.parse(at) + w.resets_in_seconds * 1000).toISOString();
  const m = w.window_minutes || null;
  // Plus/Pro: a 5-hour window and a week; the free plan: one 30-day window
  const label = !m ? 'Limit' : m <= 2880 ? `${Math.round(m / 60)}-hour window` : m === 10080 ? 'Week' : `${Math.round(m / 1440)}-day window`;
  return { pct: w.used_percent != null ? Math.round(w.used_percent) : null, minutes: m, label, resetAt: reset };
}

function usage(days = 7) {
  const list = sessions(days, 400);
  const since5h = Date.now() - 5 * 3600000;
  const tot = { tokens: 0, fresh: 0, input: 0, cached: 0, output: 0, sessions: list.length, last5h: 0 };
  let snap = null;
  for (const s of list) {
    tot.tokens += s.total; tot.fresh += s.fresh || 0; tot.input += s.input; tot.cached += s.cached; tot.output += s.output;
    if (s.last && Date.parse(s.last) >= since5h) tot.last5h += s.total;
    if (s.limits && (!snap || s.limitsAt > snap.at)) snap = { at: s.limitsAt, l: s.limits };
  }
  const limits = snap ? { at: snap.at, primary: limitWindow(snap.l.primary, snap.at), secondary: limitWindow(snap.l.secondary, snap.at) } : null;
  return { days, ...tot, cacheShare: tot.input ? Math.round((tot.cached / tot.input) * 100) : 0, limits, recent: list.slice(0, 12) };
}

// --------------------------------------------------------------- skills Codex can see
function skillsIn(dir, source, extra = {}) {
  const { frontmatter } = require('./skills');
  return subdirs(dir).filter(d => !path.basename(d).startsWith('.')).map(d => {
    const text = readText(path.join(d, 'SKILL.md'));
    if (!text) return null;
    const fm = frontmatter(text.replace(/^﻿/, ''));
    let port = null;
    try { port = JSON.parse(readText(path.join(d, '.anchor-port.json')) || 'null'); } catch { /* not ported */ }
    return { name: fm.name || path.basename(d), description: fm.description || '', dir: d, source, port, bom: text.charCodeAt(0) === 0xfeff, ...extra };
  }).filter(Boolean);
}

function skills() {
  const out = [...skillsIn(AGENTS_SKILLS, 'agents'), ...skillsIn(PATHS.SKILLS, 'codex')];
  for (const mk of subdirs(PATHS.PLUGIN_CACHE)) for (const pl of subdirs(mk)) {
    const vers = subdirs(pl).sort();
    const cur = vers[vers.length - 1];
    if (cur) out.push(...skillsIn(path.join(cur, 'skills'), 'plugin', { plugin: path.basename(pl) }));
  }
  return out;
}

module.exports = { PATHS, run, isCodex, status, config, version, sessionState, summarize, sessions, usage, skills, rollouts, limitWindow };
