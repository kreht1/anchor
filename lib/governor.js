'use strict';
// Anchor token governor (UserPromptSubmit). Most of a heavy user's limit goes on two things a tool-output trimmer
// cannot touch: long conversations re-read on every reply, and the prompt cache rebuilt in full after a break. So:
//  * cache-cold guard: a big session whose cache has expired is stopped once, with the cost and the cheap choices
//    (/compact, /clear); sending the same message again goes through;
//  * context tiers: past 120k / 200k / 300k Claude is told, once per tier, to suggest /compact at the next milestone;
//  * topic switch: an unrelated request in a big session suggests /clear.
// It reads only the tail of the session transcript and never blocks scripted (SDK) sessions.
const fs = require('fs');
const crypto = require('crypto');
const kv = require('./kv');
const { words } = require('./skillmatch');

const TIERS = [120000, 200000, 300000];
const GUARD_MIN_CTX = 60000;
const TOPIC_MIN_CTX = 80000;
const STATE = 'governor.json';
const k = n => `${Math.round(n / 1000)}k`;

function tail(file, bytes = 600000) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString('utf8').split('\n');
    if (n < size) lines.shift();  // the first line is cut
    return lines;
  } finally { fs.closeSync(fd); }
}

// context of the last main-thread reply, when it happened, its cache tier, and the last human prompts
function sessionState(file) {
  const out = { context: 0, last: 0, ttlMin: 60, prompts: [] };
  if (!file) return out;
  let lines;
  try { lines = tail(file); } catch { return out; }
  let found = false;
  for (let i = lines.length - 1; i >= 0 && (out.prompts.length < 6 || !found); i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.isSidechain) continue;
    const t = Date.parse(d.timestamp || '') || 0;
    if (!out.last && t) out.last = t;
    const u = d.type === 'assistant' && d.message && d.message.usage;
    if (u && !found) {
      out.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const cc = u.cache_creation || {};
      if (cc.ephemeral_5m_input_tokens && !cc.ephemeral_1h_input_tokens) out.ttlMin = 5;
      found = true;
    }
    const c = d.type === 'user' && !d.isMeta && d.message && d.message.content;
    if (typeof c === 'string' && c.trim() && !/^\s*</.test(c)) out.prompts.push(c);
  }
  return out;
}

const hash = s => crypto.createHash('sha1').update(String(s).trim()).digest('hex').slice(0, 16);

function overlap(prompt, previous) {
  const a = new Set(words(prompt)), b = new Set(previous.flatMap(p => words(p)));
  if (a.size < 6 || !b.size) return 1;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

// -> {} | { note } | { block: true, reason }
function decide(input, settings = kv.read('settings.json', {}), entry = process.env.CLAUDE_CODE_ENTRYPOINT || 'cli') {
  if (settings.governor === false || !input || !input.transcript_path) return {};
  const prompt = String(input.prompt || '');
  if (/^\s*\//.test(prompt)) return {};  // slash commands (/compact, /clear ...) pass untouched
  const st = sessionState(input.transcript_path);
  if (!st.context) return {};
  const all = kv.read(STATE, {});
  const sid = input.session_id || input.transcript_path;
  const me = all[sid] || (all[sid] = { tiers: [] });
  const save = () => {
    me.t = Date.now();
    const cut = Date.now() - 14 * 86400000;
    for (const [id, v] of Object.entries(all)) if ((v.t || 0) < cut) delete all[id];
    kv.write(STATE, all);
  };
  const awayMin = st.last ? (Date.now() - st.last) / 60000 : 0;
  const mode = settings.cacheGuard || 'block';
  const interactive = !/^sdk/i.test(entry);

  // cache-cold guard
  if (mode !== 'off' && st.context >= GUARD_MIN_CTX && awayMin >= st.ttlMin && me.coldAt !== st.last) {
    const away = awayMin >= 120 ? `${Math.round(awayMin / 60)} h` : `${Math.round(awayMin)} min`;
    if (mode === 'block' && interactive) {
      if (me.blocked && me.blocked.hash === hash(prompt) && Date.now() - me.blocked.at < 30 * 60000) {
        me.coldAt = st.last; delete me.blocked; save(); return {};
      }
      me.blocked = { hash: hash(prompt), at: Date.now() }; save();
      return { block: true, reason: `Anchor: this session holds about ${k(st.context)} tokens and its prompt cache expired (${away} away, the cache lasts ${st.ttlMin} min). Sending now re-pays the whole ${k(st.context)}.\n` +
        `  /compact  keeps a summary and continues for a fraction of that\n  /clear    starts fresh, if this is a new topic\n  or send the same message again to go ahead anyway.\n(Change this with: anchor cacheguard warn | off)` };
    }
    me.coldAt = st.last; save();
    return { note: `Anchor: this session's prompt cache had expired (${away} away), so this reply re-reads about ${k(st.context)} tokens at full price. Tell the user in one line that /compact before a break, or /clear for a new topic, avoids this.` };
  }

  const notes = [];
  const tier = TIERS.filter(t => st.context >= t).pop();
  if (tier && !me.tiers.includes(tier)) {
    me.tiers.push(tier);
    notes.push(`Anchor: this session's context is about ${k(st.context)} tokens, and every reply re-reads all of it. At the next natural milestone (a task done, tests passing), suggest /compact to the user in one line; if the next request is a different topic, suggest /clear. Say it once.`);
  } else if (st.context >= TOPIC_MIN_CTX && st.prompts.length >= 2 && overlap(prompt, st.prompts.slice(0, 5)) < 0.12 && Date.now() - (me.topicAt || 0) > 30 * 60000) {
    me.topicAt = Date.now();
    notes.push(`Anchor: this request looks unrelated to the rest of this ${k(st.context)}-token session. Before starting, suggest in one line that the user run /clear (or start a new session) so the old context is not re-read on every reply; then continue if they prefer.`);
  }
  if (!notes.length) return {};
  save();
  return { note: notes.join('\n') };
}

module.exports = { decide, sessionState, TIERS };
