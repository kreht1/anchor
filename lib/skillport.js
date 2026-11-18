'use strict';
// Skill bridge: brings Claude skills (yours, plugin skills, claude.ai skills, ones found on GitHub) to Codex.
// Codex reads the same SKILL.md format, so a port is a careful copy into ~/.agents/skills/<name>, plus:
//  * a frontmatter Codex accepts (name: lowercase-hyphen, <=64 chars; description <=1024 chars; no BOM, which makes
//    Codex skip the skill silently);
//  * Claude path variables (${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_SKILL_DIR}) resolved to real folders, so scripts and
//    references still load; plugin skills point at their plugin folder instead of copying it;
//  * a short "Running in Codex" note that maps only the Claude tools this skill actually names to Codex's own
//    (Read -> shell, Edit/Write -> apply_patch, TodoWrite -> update_plan, Skill -> $name, ...), and names its sibling
//    skills the way Codex calls them;
//  * an honest verdict: works as-is, adapted, or Claude-only (needs something Codex doesn't have).
// The original is never touched; every port records its source and hash so `sync` refreshes it when the source changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CX = require('./codex');

const DEST = CX.PATHS.AGENTS_SKILLS;
const MARK = '.anchor-port.json';
const NOTE_START = '<!-- anchor:codex-note -->';

// Claude tools and what Codex uses instead. `re` finds the tool in a skill's text (code spans, "the X tool", X(...)).
const TOOLS = [
  { id: 'Read', re: /`Read`|\bRead tool\b|\bRead\(/, codex: 'read files with the shell (`cat`, `sed -n 10,80p`, `Get-Content`), only the lines you need' },
  { id: 'Grep/Glob', re: /`(Grep|Glob)`|\b(Grep|Glob) tool\b|\b(Grep|Glob)\(/, codex: 'search with `rg` (ripgrep) and `rg --files`' },
  { id: 'Edit/Write', re: /`(Edit|Write|MultiEdit)`|\b(Edit|Write|MultiEdit) tool\b|\b(Edit|Write|MultiEdit)\(/, codex: 'change files with `apply_patch`' },
  { id: 'Bash', re: /`Bash`|\bBash tool\b|\bBash\(|`PowerShell` tool|\bPowerShell tool\b/, codex: 'run commands with your shell tool' },
  { id: 'NotebookEdit', re: /NotebookEdit/, codex: 'edit notebooks as JSON with `apply_patch`, or with `jupyter nbconvert`/a small script' },
  { id: 'TodoWrite', re: /TodoWrite|TaskCreate|TaskUpdate|\btodo list\b/i, codex: 'keep the checklist with `update_plan`' },
  { id: 'Skill', re: /\bSkill tool\b|`Skill`|\bSkill\(|invoke (it|the skill|skills?) with the Skill/i, codex: 'a skill is used by opening its SKILL.md (Codex lists each skill with its path) or when the user types `$skill-name`' },
  { id: 'Task/Agent', re: /\b(Task|Agent) tool\b|`(Task|Agent)`|\bsubagents?\b|dispatch(ing)? (an? )?agent/i, codex: 'Codex can start subagents when the user enables them; otherwise do the subagent\'s part yourself, one step at a time, and keep each step\'s output short' },
  { id: 'WebFetch/WebSearch', re: /WebFetch|WebSearch|\bweb[_ ]search tool\b/i, codex: 'use Codex web search when it is turned on (`--search` or `web_search` in config); otherwise `curl` the page' },
  { id: 'AskUserQuestion', re: /AskUserQuestion/, codex: 'ask the user in plain text and wait for the answer' },
  { id: 'Plan mode', re: /EnterPlanMode|ExitPlanMode|\bplan mode\b/i, codex: 'write the plan in your reply (or with `update_plan`) and wait for approval before changing files' },
  { id: 'CLAUDE.md', re: /CLAUDE\.md/, codex: 'project instructions live in AGENTS.md for Codex (CLAUDE.md, if present, still says what the project wants)' },
  { id: 'slash commands', re: /(^|\s)\/(compact|clear)\b/, codex: '`/compact` works the same; `/new` replaces `/clear`' },
];
// things Codex has no counterpart for: a skill built around one of these cannot work the same
// A skill is Claude-only when its description says it is built on one of these, or its SKILL.md leans on it at least
// `min` times (a passing mention, like skill-creator's note about Cowork, does not count).
const CLAUDE_ONLY = [
  { id: 'Artifacts', re: /\bartifacts?\b|ArtifactData|ArtifactComments|claude\.ai\/(artifact|code\/artifact)/i, min: 3, desc: /HTML artifact|Artifact tool|claude\.ai\/artifact/i },
  { id: 'Claude in Chrome', re: /mcp__claude-in-chrome|Claude in Chrome|chrome-browser/i, min: 3, desc: /Claude in Chrome|mcp__claude-in-chrome/i },
  { id: 'claude.ai connectors', re: /mcp__claude_ai_|\bconnectors?\b/i, min: 6, desc: /docs-connector|Claude Docs|mcp__claude_ai_|\bconnector call\b/i },
  { id: 'the Claude app / Cowork', re: /\bCowork\b|\bClaude app\b|computer-use__|Claude_Browser|built-in browser pane/i, min: 99, desc: /\bCowork\b|\bClaude app\b|built-in browser|desktop app|computer use/i },
  { id: 'Claude Code plugin system', re: /\/plugin (install|marketplace)|plugin-authoring|\bstatusLine\b/, min: 3 },
];

const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// Codex skill names: lowercase letters, digits, hyphens; <=64 chars
function codexName(id) {
  const base = String(id).split(':').pop();
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'skill';
}

function splitFront(text) {
  text = String(text || '').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: '', body: text };
}

// every text file in a skill folder (SKILL.md first), capped, for the verdict
function skillTexts(dir, max = 40) {
  const out = [];
  const walk = d => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max || e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|txt|ya?ml|json)$/i.test(e.name) && e.name !== MARK) { try { if (fs.statSync(p).size < 400000) out.push({ rel: path.relative(dir, p), text: readText(p) }); } catch { /* skip */ } }
    }
  };
  const main = path.join(dir, 'SKILL.md');
  out.push({ rel: 'SKILL.md', text: readText(main) });
  walk(dir);
  return out.filter((f, i, a) => a.findIndex(x => x.rel === f.rel) === i);
}

// -> { verdict: 'works'|'adapted'|'claude-only', tools: [...], blockers: [...], why }
function assess(skill) {
  const files = skill.dir ? skillTexts(skill.dir) : [{ rel: 'SKILL.md', text: skill.text || '' }];
  const main = files[0] ? files[0].text : '';
  const all = files.map(f => f.text).join('\n');
  const tools = TOOLS.filter(t => t.re.test(all)).map(t => t.id);
  const blockers = [];
  // the description counts only when it names a Claude product outright ("artifact" or "connector" alone are common words)
  const desc = String(skill.description || '');
  for (const c of CLAUDE_ONLY) {
    const inMain = (main.match(new RegExp(c.re.source, c.re.flags + 'g')) || []).length;
    if (inMain >= c.min || (c.desc && c.desc.test(desc))) blockers.push(c.id);
  }
  if (skill.source === 'built-in' && !main.trim()) blockers.push('instructions built into Claude Code (not on disk)');
  const verdict = blockers.length ? 'claude-only' : tools.length || /\$\{CLAUDE_(PLUGIN_ROOT|SKILL_DIR)\}/.test(all) ? 'adapted' : 'works';
  const why = verdict === 'claude-only' ? `needs ${blockers.join(', ')}, which Codex does not have`
    : verdict === 'adapted' ? `Anchor maps ${tools.length ? tools.join(', ') : 'its Claude paths'} to Codex` : 'plain instructions; nothing Claude-specific';
  return { verdict, tools, blockers, why };
}

function codexNote(tools, siblings) {
  const lines = TOOLS.filter(t => tools.includes(t.id)).map(t => `- ${t.id}: ${t.codex}.`);
  const have = siblings.filter(s => s.inCodex), miss = siblings.filter(s => !s.inCodex);
  if (have.length) lines.push(`- Other skills this one names are in Codex as: ${have.map(s => `${s.from} → \`$${s.to}\``).join(', ')}.`);
  if (miss.length) lines.push(`- Not in Codex yet: ${miss.map(s => s.from).join(', ')}. When this skill sends you to one, tell the user it can be added with \`anchor codex port ${miss[0].from}\` and carry on with your own judgment for that step.`);
  if (!lines.length) return '';
  return `\n\n${NOTE_START}\n## Running in Codex (added by Anchor)\nThis skill was written for Claude Code. In Codex, follow it the same way, with these equivalents:\n${lines.join('\n')}\n`;
}

// the frontmatter Codex wants; keeps other keys (license, allowed-tools are harmless) and quotes safely
function codexFront(front, name, description) {
  const keep = front.split(/\r?\n/).filter(l => l.trim() && !/^(name|description)\s*:/.test(l) && !/^\s/.test(l));
  const desc = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 1024);
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n${keep.length ? keep.join('\n') + '\n' : ''}---\n`;
}

// resolve Claude path variables; plugin skills keep pointing at the plugin's own folder for scripts and references
function resolveVars(text, skill, destDir) {
  const pluginRoot = skill.pluginRoot || (skill.dir && skill.source === 'plugin' ? path.resolve(skill.dir, '..', '..') : null);
  const fwd = p => p.split(path.sep).join('/');
  let out = text.replace(/\$\{CLAUDE_SKILL_DIR\}|\$CLAUDE_SKILL_DIR\b/g, fwd(destDir));
  if (pluginRoot) out = out.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, fwd(pluginRoot));
  return out;
}

// sibling skills named as plugin:skill; which of them Codex has (ported, or native under that name)
function siblingsOf(body, skill, known) {
  const out = [];
  let have = null;
  for (const k of known) {
    if (k.id === skill.id || !k.id.includes(':') || !body.includes(k.id)) continue;
    if (!have) have = new Set(CX.skills().flatMap(s => [s.name, s.plugin ? `${s.plugin}:${s.name}` : null]).filter(Boolean));
    const to = codexName(k.id);
    out.push({ from: k.id, to: have.has(k.id) ? k.id : to, inCodex: have.has(to) || have.has(k.id) });
  }
  return out.slice(0, 20);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.anchor-source.json' || e.name === MARK) continue;
    const a = path.join(src, e.name), b = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

// skill: { id, name, description, dir, source, plugin? }. known: other skills, for sibling names
function port(skill, { known = [], force = false, name } = {}) {
  if (!skill || !skill.dir) throw new Error('this skill has no folder on disk to port');
  const src = readText(path.join(skill.dir, 'SKILL.md'));
  if (!src) throw new Error('no SKILL.md in that folder');
  const a = assess(skill);
  if (a.verdict === 'claude-only' && !force) throw new Error(`${skill.id} is Claude-only: ${a.why}. Port it anyway with force.`);
  const target = codexName(name || skill.id);
  const dest = path.join(DEST, target);
  const prev = readMark(dest);
  if (fs.existsSync(dest) && !prev) throw new Error(`~/.agents/skills/${target} already exists and was not made by Anchor`);
  if (prev && prev.source && prev.source.id !== skill.id) throw new Error(`~/.agents/skills/${target} is already the port of ${prev.source.id}`);
  const { front, body } = splitFront(src);
  const fm = require('./skills').frontmatter(src.replace(/^﻿/, ''));
  const tmp = dest + '.anchor-tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  // a plugin skill's folder is copied too (references, scripts); the plugin root stays where it is
  copyDir(skill.dir, tmp);
  let out = codexFront(front, target, fm.description || skill.description || '') + resolveVars(body.replace(new RegExp(`\\n*${NOTE_START}[\\s\\S]*$`), ''), skill, dest);
  out = out.replace(/\r\n/g, '\n') + codexNote(a.tools, siblingsOf(body, skill, known));
  fs.writeFileSync(path.join(tmp, 'SKILL.md'), out);
  // other .md files in the folder may use the same variables
  for (const f of skillTexts(tmp, 80)) if (f.rel !== 'SKILL.md' && /\$\{?CLAUDE_(PLUGIN_ROOT|SKILL_DIR)/.test(f.text)) fs.writeFileSync(path.join(tmp, f.rel), resolveVars(f.text, skill, dest));
  const mark = { by: 'Anchor', at: new Date().toISOString(), verdict: a.verdict, tools: a.tools, blockers: a.blockers,
    source: { id: skill.id, name: skill.name, source: skill.source, plugin: skill.plugin || null, dir: skill.source === 'github' ? null : skill.dir, hash: sha(src), origin: skill.origin || null } };
  fs.writeFileSync(path.join(tmp, MARK), JSON.stringify(mark, null, 1));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(tmp, dest);
  return { ok: true, name: target, dest, verdict: a.verdict, why: a.why, call: `$${target}` };
}

function readMark(dir) { try { return JSON.parse(readText(path.join(dir, MARK)) || 'null'); } catch { return null; } }

function ported() {
  let dirs = [];
  try { dirs = fs.readdirSync(DEST, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.endsWith('.anchor-tmp')).map(d => path.join(DEST, d.name)); } catch { /* none yet */ }
  return dirs.map(d => { const m = readMark(d); return m ? { name: path.basename(d), dir: d, ...m } : null; }).filter(Boolean);
}

function unport(name) {
  const n = codexName(name);
  const dir = path.join(DEST, n);
  if (!readMark(dir)) throw new Error(`${n} is not a skill Anchor ported`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, removed: n };
}

// re-port every port whose source changed; drop ports whose source is gone (only Anchor's own folders)
function sync(all) {
  const byId = new Map(all.map(s => [s.id, s]));
  const res = { updated: [], same: [], missing: [] };
  for (const p of ported()) {
    if (p.source.source === 'github') { res.same.push(p.name); continue; } // installed straight from GitHub: no local source
    const s = byId.get(p.source.id) || (p.source.dir && fs.existsSync(path.join(p.source.dir, 'SKILL.md')) ? { ...p.source, id: p.source.id, dir: p.source.dir } : null);
    if (!s) { res.missing.push(p.name); continue; }
    const h = sha(readText(path.join(s.dir, 'SKILL.md')));
    if (h === p.source.hash) { res.same.push(p.name); continue; }
    try { port(s, { known: all, force: true, name: p.name }); res.updated.push(p.name); } catch (e) { res.missing.push(`${p.name} (${e.message})`); }
  }
  return res;
}

// the dashboard's view: every Claude skill with its verdict and whether it is in Codex already
function catalog(claudeSkills) {
  const done = new Map(ported().map(p => [p.source.id, p]));
  const native = new Set(CX.skills().filter(s => s.source !== 'agents' || !s.port).map(s => s.name));
  return claudeSkills.map(s => {
    const a = assess(s);
    const p = done.get(s.id);
    const stale = p && s.dir ? sha(readText(path.join(s.dir, 'SKILL.md'))) !== p.source.hash : false;
    return { id: s.id, name: s.name, description: s.description, source: s.source, group: s.group, enabled: s.enabled !== false,
      verdict: a.verdict, why: a.why, tools: a.tools, blockers: a.blockers, codexName: codexName(s.id),
      inCodex: !!p || native.has(codexName(s.id)), ported: p ? { name: p.name, at: p.at, stale } : null };
  });
}

// re-write every port's Codex note (after a batch, so siblings ported in the same batch are named as in Codex)
function relink(all) {
  const byId = new Map(all.map(s => [s.id, s]));
  for (const p of ported()) {
    const s = byId.get(p.source.id);
    if (s && s.dir) { try { port(s, { known: all, force: true, name: p.name }); } catch { /* leave it as it was */ } }
  }
}

module.exports = { port, unport, ported, sync, relink, assess, catalog, codexName, DEST, TOOLS, CLAUDE_ONLY, splitFront };
