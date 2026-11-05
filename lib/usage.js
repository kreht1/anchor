'use strict';
// Account and usage, entirely from local files: the signed-in account's profile fields in ~/.claude.json (never the
// login tokens, which live in .credentials.json and are never read), token counts from every transcript (main sessions
// and subagents), and the "You've hit your session/weekly limit · resets 10:40pm" notices with their timestamps.
// Limits: Claude's session limit is a 5-hour window; the weekly limit resets on a fixed weekly time. Percentages are
// estimates calibrated on the user's own past limit hits, and say so.
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const KEEP_MS = 40 * 86400e3;
const WINDOW_MS = 5 * 3600e3;
const files = new Map(); // file -> {offset, rest, seen:Set}
let entries = [];         // {t, model, i, o, cw, cr, file}
let limits = [];          // {t, kind, text, resetAt}

const ACCOUNT_FIELDS = ['displayName', 'fullName', 'emailAddress', 'organizationName', 'organizationType', 'organizationRole', 'workspaceRole',
  'billingType', 'seatTier', 'userRateLimitTier', 'organizationRateLimitTier', 'hasExtraUsageEnabled', 'accountCreatedAt', 'subscriptionCreatedAt', 'claudeCodeTrialEndsAt'];

function account() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(path.dirname(P.CLAUDE), '.claude.json'), 'utf8')); } catch {
    try { j = JSON.parse(fs.readFileSync(path.join(P.CLAUDE, '.claude.json'), 'utf8')); } catch { /* not signed in */ }
  }
  const a = j.oauthAccount || null;
  const out = a ? Object.fromEntries(ACCOUNT_FIELDS.filter(k => a[k] != null).map(k => [k, a[k]])) : null;
  const plan = !a ? 'API key or not signed in'
    : /max/i.test(`${a.organizationType} ${a.userRateLimitTier} ${a.organizationRateLimitTier}`)
      ? `Claude Max${/20x/i.test(`${a.userRateLimitTier} ${a.organizationRateLimitTier}`) ? ' 20×' : /5x/i.test(`${a.userRateLimitTier} ${a.organizationRateLimitTier}`) ? ' 5×' : ''}`
      : /pro/i.test(a.organizationType || '') ? 'Claude Pro' : /team/i.test(a.organizationType || '') ? 'Claude Team' : /enterprise/i.test(a.organizationType || '') ? 'Claude Enterprise' : (a.organizationType || 'Claude account');
  return { account: out, plan, installMethod: j.installMethod || null, numStartups: j.numStartups || null, firstStartTime: j.firstStartTime || null };
}

// "resets 10:40pm (Africa/Algiers)", "resets 12pm", "resets Nov 3, 12pm (...)", "resets Nov 3 at 12pm"
function resetTime(text, at) {
  const m = /resets\s+(?:([A-Z][a-z]{2})\s+(\d{1,2}),?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;
  let h = Number(m[3]) % 12;
  if (/pm/i.test(m[5])) h += 12;
  const d = new Date(at);
  if (m[1]) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase());
    if (mon >= 0) { d.setMonth(mon, Number(m[2])); if (d.getTime() < at - 86400e3) d.setFullYear(d.getFullYear() + 1); }
  }
  d.setHours(h, Number(m[4] || 0), 0, 0);
  if (!m[1] && d.getTime() <= at) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function listFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(P.PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(P.PROJECTS, d.name);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const n of names) {
      if (n.isFile() && n.name.endsWith('.jsonl')) out.push(path.join(dir, n.name));
      else if (n.isDirectory()) {
        const sub = path.join(dir, n.name, 'subagents');
        try { for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(path.join(sub, f)); } catch { /* none */ }
      }
    }
  }
  return out;
}

function scan() {
  const cutoff = Date.now() - KEEP_MS;
  for (const file of listFiles()) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    let f = files.get(file);
    if (!f || st.size < f.offset) { f = { offset: 0, rest: '', seen: new Set() }; files.set(file, f); entries = entries.filter(e => e.file !== file); limits = limits.filter(l => l.file !== file); }
    if (st.size === f.offset) continue;
    const fd = fs.openSync(file, 'r');
    try {
      while (f.offset < st.size) {
        const n = Math.min(8 << 20, st.size - f.offset);
        const buf = Buffer.alloc(n);
        const got = fs.readSync(fd, buf, 0, n, f.offset);
        if (!got) break;
        f.offset += got;
        const lines = (f.rest + buf.toString('utf8', 0, got)).split('\n');
        f.rest = lines.pop();
        for (const line of lines) {
          const hasUsage = line.includes('"usage"'), hasLimit = line.includes('hit your');
          if (!hasUsage && !hasLimit) continue;
          let d;
          try { d = JSON.parse(line); } catch { continue; }
          const t = Date.parse(d.timestamp);
          if (!(t >= cutoff)) continue;
          const m = d.message;
          if (hasUsage && d.type === 'assistant' && m && m.usage && m.model !== '<synthetic>') {
            const key = `${m.id}|${d.requestId || ''}`;
            if (!f.seen.has(key)) {
              f.seen.add(key);
              const u = m.usage;
              entries.push({ t, model: m.model || 'unknown', i: u.input_tokens || 0, o: u.output_tokens || 0, cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0, file });
            }
          }
          if (hasLimit && d.type === 'assistant' && m && Array.isArray(m.content)) {
            for (const b of m.content) {
              const lm = b.type === 'text' && /You've hit your ([\w ]+?) limit[^\n]*/.exec(b.text || '');
              if (lm) limits.push({ t, kind: /week/i.test(lm[1]) ? 'weekly' : /session/i.test(lm[1]) ? 'session' : lm[1].trim(), text: lm[0].slice(0, 160), resetAt: resetTime(lm[0], t), file });
            }
          }
        }
      }
    } finally { fs.closeSync(fd); }
  }
  entries = entries.filter(e => e.t >= cutoff).sort((a, b) => a.t - b.t);
  limits = limits.filter(l => l.t >= cutoff).sort((a, b) => a.t - b.t);
}

// what counts toward limits: fresh input + output + cache writes; cache reads are discounted heavily (counted at 10%)
const weight = e => e.i + e.o + e.cw + e.cr * 0.1;

function windows() {
  const out = [];
  let cur = null;
  for (const e of entries) {
    if (!cur || e.t >= cur.start + WINDOW_MS) {
      const start = Math.floor(e.t / 3600e3) * 3600e3; // the window opens on the hour of its first message
      cur = { start, end: start + WINDOW_MS, w: 0, o: 0, msgs: 0, hit: null };
      out.push(cur);
    }
    cur.w += weight(e); cur.o += e.o; cur.msgs++;
  }
  // a session-limit notice inside a window tells us roughly where your cap sits
  for (const l of limits.filter(x => x.kind === 'session')) {
    const w = out.find(x => l.t >= x.start && l.t < x.end + 3600e3);
    if (w && !w.hit) w.hit = { t: l.t, w: entries.filter(e => e.t >= w.start && e.t <= l.t).reduce((a, e) => a + weight(e), 0), resetAt: l.resetAt };
  }
  return out;
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

function summary() {
  scan();
  const now = Date.now();
  const W = windows();
  const last = W[W.length - 1];
  const active = last && now < last.end ? last : null;
  const sessionCap = median(W.filter(w => w.hit).map(w => w.hit.w));
  const lastSessionHit = [...limits].reverse().find(l => l.kind === 'session');
  // exact reset if Claude told us in this window, otherwise the window's 5-hour end
  const exactReset = active && lastSessionHit && lastSessionHit.t >= active.start && lastSessionHit.resetAt > now ? lastSessionHit.resetAt : null;
  const weeklyHits = limits.filter(l => l.kind === 'weekly');
  const lastWeekly = weeklyHits[weeklyHits.length - 1] || null;
  let nextWeekly = lastWeekly && lastWeekly.resetAt ? lastWeekly.resetAt : null;
  while (nextWeekly && nextWeekly < now) nextWeekly += 7 * 86400e3; // the weekly reset repeats at the same time each week
  // the week runs from the last reset (when known) rather than over a rolling 7 days
  const weekStart = nextWeekly ? nextWeekly - 7 * 86400e3 : now - 7 * 86400e3;
  const week = entries.filter(e => e.t >= weekStart);
  const weeklyCap = median(weeklyHits.filter(l => l.resetAt).map(l => entries.filter(e => e.t > l.resetAt - 7 * 86400e3 && e.t <= l.t).reduce((a, e) => a + weight(e), 0)).filter(Boolean));
  const days = [];
  for (let k = 13; k >= 0; k--) {
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - k);
    const d1 = d0.getTime() + 86400e3;
    const es = entries.filter(e => e.t >= d0.getTime() && e.t < d1);
    days.push({ day: d0.toISOString().slice(0, 10), w: Math.round(es.reduce((a, e) => a + weight(e), 0)), o: es.reduce((a, e) => a + e.o, 0), msgs: es.length });
  }
  const models = {};
  for (const e of week) { const m = models[e.model] || (models[e.model] = { w: 0, o: 0, msgs: 0 }); m.w += weight(e); m.o += e.o; m.msgs++; }
  return {
    ...account(),
    now: new Date(now).toISOString(),
    session: active ? {
      start: new Date(active.start).toISOString(), resetAt: new Date(exactReset || active.end).toISOString(), exact: !!exactReset,
      used: Math.round(active.w), output: active.o, msgs: active.msgs, cap: sessionCap ? Math.round(sessionCap) : null,
      pct: sessionCap ? Math.min(100, Math.round((active.w / sessionCap) * 100)) : null, limited: !!exactReset,
    } : { idle: true, lastEnded: last ? new Date(last.end).toISOString() : null },
    weekly: { start: new Date(weekStart).toISOString(), used: Math.round(week.reduce((a, e) => a + weight(e), 0)), output: week.reduce((a, e) => a + e.o, 0), msgs: week.length,
      cap: weeklyCap ? Math.round(weeklyCap) : null, pct: weeklyCap ? Math.min(100, Math.round((week.reduce((a, e) => a + weight(e), 0) / weeklyCap) * 100)) : null,
      nextReset: nextWeekly ? new Date(nextWeekly).toISOString() : null, limited: !!(lastWeekly && lastWeekly.resetAt > now) },
    windows: W.slice(-12).reverse().map(w => ({ start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString(), used: Math.round(w.w), msgs: w.msgs, hit: w.hit ? new Date(w.hit.t).toISOString() : null })),
    limits: limits.slice(-20).reverse().map(l => ({ t: new Date(l.t).toISOString(), kind: l.kind, text: l.text, resetAt: l.resetAt ? new Date(l.resetAt).toISOString() : null })),
    days, models: Object.entries(models).map(([model, v]) => ({ model, ...v, w: Math.round(v.w) })).sort((a, b) => b.w - a.w),
    note: 'Built only from files on this computer. Percentages are estimates from the points where you hit a limit before; Claude\'s own /usage is the exact figure.',
  };
}

module.exports = { summary, resetTime };
