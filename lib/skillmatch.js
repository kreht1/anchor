'use strict';
// Per-message skill matching for the UserPromptSubmit hook. It must stay instant and offline: it reads only the skills
// snapshot Anchor writes, scores every enabled skill against the message (name and quoted trigger words count most, words
// shared by many skills count least) and names the best one to three. It logs which skills it named, never the message.
const fs = require('fs');
const path = require('path');
const kv = require('./kv');
const P = require('./paths');

const STOP = new Set(('a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our so ' +
  'that the their them then there these this to up use used uses using was we what when where which while who why will with you your ' +
  'skill skills claude user users want wants need needs make makes any all also only other more most should must just like via ' +
  'one two each about after before over under than them they theirs here please ok yes let lets get got thing things way it\'s ' +
  'work works working new file files tool tools task tasks help request asks asked whenever trigger triggers ' +
  // everyday chat words that skill descriptions happen to contain; alone they say nothing about the task, and a wrong
  // hint costs a whole skill load (1k to 12k tokens)
  'send sends sent sending message messages call calls calling check checks checking first instead right left now today ' +
  'tomorrow perfect proceed continue done thanks thank good great sure maybe probably really double accurate accurately ' +
  'rest start started microsoft google desktop computer person people someone anything everything something').split(' '));
const LOG = path.join(P.DATA, 'skill-match.jsonl');

// everyday words -> the words skill descriptions use
const SYN = { excel: 'spreadsheet xlsx', powerpoint: 'pptx deck slide', ppt: 'pptx deck slide', slides: 'deck pptx', presentation: 'deck slide',
  word: 'docx document', chart: 'plot graph visualization', graph: 'chart plot', plot: 'chart graph', dashboard: 'chart visualization',
  crash: 'bug debug', crashes: 'bug debug', broken: 'bug debug', error: 'bug debug', fails: 'bug debug', failing: 'bug debug',
  pdf: 'pdf', codebase: 'architecture', repo: 'codebase', ui: 'frontend design', website: 'frontend', page: 'frontend',
  test: 'test', tests: 'test', plan: 'plan', brainstorm: 'brainstorm', idea: 'brainstorm', design: 'design' };
const LOOSE = new Set('word dashboard codebase repo ui website page idea design'.split(' '));
const stem = w => w.replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s)$/, '').replace(/e$/, '').replace(/([bdgmnpt])\1$/, '$1').slice(0, 14);
function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9+#.\- ]+/g, ' ').split(/[\s.\-]+/)
    .filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}
// quoted trigger words and phrases in a description, e.g. "deck", "slides", "chart"
const triggers = desc => [...String(desc || '').matchAll(/["“']([^"”']{2,40})["”']/g)].map(m => m[1].toLowerCase().trim()).filter(t => t && !STOP.has(t));

// built-in skills ship without a SKILL.md on disk: what each is for, in the words people use
const HINTS = { dataviz: '"chart" "graph" "plot" "dashboard" "visualization" "heatmap" "legend" "axis" "palette" "colors" data',
  run: '"run the app" "start the app" "screenshot" launch server "see it working" "confirm it works"',
  'claude-api': '"Claude API" "Anthropic SDK" anthropic model pricing "tool use" streaming "prompt caching" agent llm' };

function index(skills) {
  const docs = skills.map(s => {
    s = HINTS[s.id] ? { ...s, description: `${s.description} ${HINTS[s.id]}` } : s;
    const nameW = words(String(s.name || s.id).replace(/[:_]/g, ' '));
    const trig = triggers(s.description);
    const tw = {};
    for (const w of words(s.description)) tw[w] = Math.max(tw[w] || 0, 1);
    for (const t of trig) for (const w of words(t)) tw[w] = Math.max(tw[w] || 0, 2.5);
    for (const w of nameW) tw[w] = Math.max(tw[w] || 0, 3);
    return { id: s.id, tw, nameW: new Set(nameW), trigW: new Set(trig.filter(t => !t.includes(' ')).flatMap(words)), phrases: trig.filter(t => t.includes(' ')) };
  });
  const df = {};
  for (const d of docs) for (const w of Object.keys(d.tw)) df[w] = (df[w] || 0) + 1;
  const N = docs.length || 1;
  for (const d of docs) for (const w of Object.keys(d.tw)) d.tw[w] *= Math.log(1 + N / df[w]);
  return docs;
}

// only the user's own words: drop the tagged blocks a client attaches to a message (browser instructions, IDE
// selections, system reminders, pasted content), any <tag>…</tag> spanning at least a line or two
const ownWords = p => String(p || '').replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<\/?[a-z][\w-]*[^>]*>/gi, ' ');

// strict (the token saver, on by default): a skill is named only on real evidence, since a wrong hint makes Claude
// load a whole skill for nothing: its name, one of its quoted trigger phrases, or two of its words at a high score
function match(prompt, snap, max = 3, strict = false) {
  const text = ownWords(prompt);
  if (text.trim().startsWith('/') || text.trim().split(/\s+/).length < 3) return [];
  const skip = new Set([...(snap.off || []), ...(snap.failing || [])]);
  const pool = (snap.index || []).filter(s => !skip.has(s.id));
  if (!pool.length) return [];
  const base = new Set(words(text)), low = text.toLowerCase();
  // an unambiguous synonym ("excel" -> xlsx) counts like the user's own word; a loose one ("website" -> frontend)
  // adds a little score and is never evidence on its own
  const syn = new Set();
  for (const w of low.split(/[^a-z0-9]+/)) if (SYN[w]) for (const x of words(SYN[w])) if (!base.has(x)) (LOOSE.has(w) ? syn : base).add(x);
  const scored = index(pool).map(d => {
    let score = 0, own = 0, named = false, phrase = false, trig = false; const hit = [];
    for (const w of base) if (d.tw[w]) { score += d.tw[w]; own++; hit.push(w); if (d.nameW.has(w)) named = true; if (d.trigW.has(w)) trig = true; }
    for (const w of syn) if (d.tw[w]) { score += d.tw[w] * 0.6; hit.push(w); }
    for (const ph of d.phrases) if (low.includes(ph)) { score += 4; hit.push(ph); phrase = true; }
    return { id: d.id, score, hit, own, named, phrase, trig };
  }).filter(x => strict
    ? (x.phrase && x.score >= 5) || (x.named && x.score >= 5) || (x.trig && x.score >= 9) || (x.own >= 2 && x.score >= 8)
    : x.score >= 4.5 && (x.hit.length >= 2 || x.score >= 6)).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  return scored.filter(x => x.score >= scored[0].score * (strict ? 0.7 : 0.55)).slice(0, strict ? Math.min(max, 2) : max);
}

// skills already named in a session, from the tail of the match log (cheap: the last 64 KB)
function namedIn(session) {
  const out = new Set();
  try {
    const fd = fs.openSync(LOG, 'r');
    try {
      const size = fs.fstatSync(fd).size, n = Math.min(size, 65536), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes(session)) continue;
        try { const e = JSON.parse(line); if (e.session === session) for (const k of e.skills || []) out.add(k); } catch { /* partial first line */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* no log yet */ }
  return out;
}

// the hook: stdin is the UserPromptSubmit payload; prints extra context or nothing
function hook(raw) {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { return ''; }
  const settings = kv.read('settings.json', {});
  if (settings.skillDiscipline === false) return '';
  const lean = settings.tokenSaver !== false;
  const snap = kv.read('skills-snapshot.json', {});
  let m = match(input.prompt, snap, 3, lean);
  // the token saver never names the same skill twice in one session: Claude already has the hint, or the skill
  if (lean && m.length && input.session_id) {
    const seen = namedIn(input.session_id);
    m = m.filter(x => !seen.has(x.id));
  }
  if (!m.length) return '';
  try {
    fs.mkdirSync(P.DATA, { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), session: input.session_id || null, cwd: input.cwd || null, skills: m.map(x => x.id), why: m.map(x => x.hit.slice(0, 4)) }) + '\n');
  } catch { /* logging is a convenience */ }
  const list = m.map(x => `${x.id} (matched: ${x.hit.slice(0, 4).join(', ')})`).join('; ');
  const note = lean
    ? `Anchor skill hint: ${m.map(x => x.id).join(', ')}. Load it only if it clearly fits this request.`
    : `Anchor skill match for this message: ${list}. If one fits, invoke it with the Skill tool before you act or answer; if none fits, ignore this note.`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } });
}

// the report: each logged match, and whether that session then used one of the named skills
function report(states, limit = 300) {
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-limit).map(l => JSON.parse(l)); } catch { return { matches: [], total: 0, used: 0, missed: {} }; }
  const byId = new Map(states.map(x => [x.st.id, x]));
  const missed = {}, out = [];
  let used = 0;
  for (const e of lines) {
    const s = e.session && byId.get(e.session);
    const after = s ? e.skills.filter(k => { const u = s.st.skills[k] || s.st.skills[k.split(':').pop()]; return u && u.last && u.last >= e.t; }) : [];
    const ok = after.length > 0;
    if (ok) used++; else for (const k of e.skills) missed[k] = (missed[k] || 0) + 1;
    out.push({ t: e.t, skills: e.skills, used: after, project: s ? s.project : null, known: !!s });
  }
  return { matches: out.reverse(), total: lines.length, used, missed };
}

module.exports = { match, hook, report, words, namedIn, LOG };
