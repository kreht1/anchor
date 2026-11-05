'use strict';
// Claude Code status line: context size, how long the prompt cache stays warm, and the 5-hour / weekly limits.
//   Anchor · ctx 142k · cache 38m · 5h 41% · wk 23%
// Claude Code runs it after every reply, so it is cheap: the transcript tail only, and usage cached for a minute.
const fs = require('fs');
const path = require('path');
const kv = require('./kv');
const P = require('./paths');
const G = require('./governor');

const k = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`;

function limits() {
  const c = kv.read('statusline-usage.json', {});
  if (c.t && Date.now() - c.t < 60000) return c;
  let s = {};
  try {
    const u = require('./usage').summary();
    s = { t: Date.now(), session: u.session && !u.session.idle ? u.session.pct : null, week: u.weekly ? u.weekly.pct : null };
  } catch { s = { t: Date.now() }; }
  kv.write('statusline-usage.json', s);
  return s;
}

function line(input) {
  const parts = ['Anchor'];
  const st = G.sessionState(input.transcript_path);
  if (st.context) {
    parts.push(`ctx ${k(st.context)}${st.context >= G.TIERS[0] ? ' (/compact soon)' : ''}`);
    const left = st.last ? st.ttlMin - (Date.now() - st.last) / 60000 : null;
    if (left != null) parts.push(left > 0 ? `cache ${Math.ceil(left)}m` : 'cache cold');
  }
  const l = limits();
  if (l.session != null) parts.push(`5h ${l.session}%`);
  if (l.week != null) parts.push(`wk ${l.week}%`);
  return parts.join(' · ');
}

// prints what it would set; with apply, writes it into ~/.claude/settings.json (the previous status line is kept)
function install(apply) {
  const file = path.join(P.CLAUDE, 'settings.json');
  const cmd = `node "${path.join(P.HOME, '.anchor', 'anchor.js').replace(/\\/g, '/')}" statusline`;
  const want = { type: 'command', command: cmd, padding: 0 };
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  if (s.statusLine && s.statusLine.command === cmd) return 'The Anchor status line is already set.';
  if (!apply) return `This adds to ${file}:\n  "statusLine": ${JSON.stringify(want)}\n${s.statusLine ? `(it replaces your current status line, which Anchor keeps a copy of)\n` : ''}Run: anchor statusline install --apply`;
  if (s.statusLine) kv.write('statusline-previous.json', s.statusLine);
  s.statusLine = want;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  return `Status line set in ${file}. It shows from the next reply.${s.statusLine ? '' : ''}`;
}

module.exports = { line, install };
