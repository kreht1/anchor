'use strict';
// Every Claude Code skill on this machine: your own (~/.claude/skills), plugin skills, claude.ai synced skills, the
// ones built into Claude Code, and project skills (<project>/.claude/skills). Usage comes from the transcripts.
// Turning a skill off moves its folder into the Anchor data folder (and back); a plugin is switched in settings.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const T = require('./transcripts');
const kv = require('./kv');

const DISABLED = path.join(P.DATA, 'disabled-skills');
const SETTINGS = path.join(P.CLAUDE, 'settings.json');
const SAFE_NAME = /^[\w.@+-]{1,100}$/;

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv2 = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv2) continue;
    let v = kv2[2].trim();
    if (v === '|' || v === '>' || v === '>-' || v === '|-') { // block scalar
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(' ');
    }
    out[kv2[1]] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}

function readSkill(dir, base) {
  const file = path.join(dir, 'SKILL.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fm = frontmatter(text);
  let files = 0;
  try { files = fs.readdirSync(dir, { recursive: true }).length; } catch { /* unreadable */ }
  const body = text.replace(/^---[\s\S]*?---\r?\n?/, '');
  return { ...base, name: fm.name || path.basename(dir), description: fm.description || '', dir, file, files,
    lines: body.split('\n').length, preview: body.slice(0, 1600), mtime: fs.statSync(file).mtimeMs,
    // tokens: listed in every session (name + description, as Claude Code shows it) and the whole file when loaded
    weight: { listed: Math.round((Math.min((fm.description || '').length, 1100) + (fm.name || '').length + 8) / 3.6), loaded: Math.round(text.length / 3.6) } };
}

function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name)); } catch { return []; }
}

const projectKey = cwd => 'p-' + crypto.createHash('sha1').update(cwd.toLowerCase()).digest('hex').slice(0, 10);

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function pluginList() {
  const inst = readJson(path.join(P.CLAUDE, 'plugins', 'installed_plugins.json'), {});
  const enabled = readJson(SETTINGS, {}).enabledPlugins || {};
  const out = [];
  for (const [key, arr] of Object.entries(inst.plugins || {})) {
    const e = Array.isArray(arr) ? arr[0] : arr;
    if (!e || !e.installPath) continue;
    out.push({ key, name: key.split('@')[0], marketplace: key.split('@')[1] || '', version: e.version, installPath: e.installPath,
      enabled: enabled[key] !== false, installedAt: e.installedAt, updatedAt: e.lastUpdated });
  }
  return out;
}

// Claude Code unpacks some of its built-in skills to <temp>/claude/bundled-skills/<version>/<hash>/; newest wins
function bundledDirs() {
  const ver = v => path.basename(v).split('.').map(n => n.padStart(6, '0')).join('.');
  const versions = subdirs(path.join(os.tmpdir(), 'claude', 'bundled-skills')).sort((a, b) => ver(b).localeCompare(ver(a)));
  const byName = new Map();
  for (const v of versions) for (const h of subdirs(v)) {
    const dirs = fs.existsSync(path.join(h, 'SKILL.md')) ? [h] : subdirs(h);
    for (const d of dirs) { const n = frontmatter(readText(path.join(d, 'SKILL.md'))).name || path.basename(d); if (!byName.has(n) && !/^[0-9a-f]{32}$/.test(n)) byName.set(n, d); }
  }
  return [...byName.values()];
}
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function projectRoots() {
  const seen = new Map();
  for (const x of T.allStates()) if (x.st.cwd && fs.existsSync(x.st.cwd)) seen.set(x.st.cwd.toLowerCase(), { cwd: x.st.cwd, project: x.project });
  return [...seen.values()];
}

function discover() {
  const list = [];
  const userDir = path.join(P.CLAUDE, 'skills');
  for (const d of subdirs(userDir)) {
    if (path.basename(d) === 'synced') continue;
    const s = readSkill(d, { source: 'user', group: 'Your skills', toggle: 'move', enabled: true });
    if (s) list.push({ ...s, id: s.name });
  }
  for (const d of subdirs(path.join(DISABLED, 'user'))) {
    const s = readSkill(d, { source: 'user', group: 'Your skills', toggle: 'move', enabled: false });
    if (s) list.push({ ...s, id: s.name });
  }
  for (const acct of subdirs(path.join(userDir, 'synced'))) {
    for (const d of subdirs(acct)) {
      const s = readSkill(d, { source: 'claude.ai', group: 'claude.ai', toggle: null, enabled: true });
      if (s && !list.some(x => x.id === 'anthropic-skills:' + s.name)) list.push({ ...s, id: 'anthropic-skills:' + s.name });
    }
  }
  for (const p of pluginList()) {
    for (const d of subdirs(path.join(p.installPath, 'skills'))) {
      const s = readSkill(d, { source: 'plugin', group: p.name, plugin: p.key, toggle: 'plugin', enabled: p.enabled, version: p.version });
      if (s) list.push({ ...s, id: `${p.name}:${s.name}` });
    }
  }
  for (const d of bundledDirs()) {
    const base = { source: 'built-in', group: 'Built into Claude Code', toggle: null, enabled: true };
    const s = readSkill(d, base) || { ...base, name: path.basename(d), dir: d, files: 0, lines: 0, mtime: fs.statSync(d).mtimeMs,
      description: 'Built into Claude Code. Its instructions live inside the app; only its reference files are on disk.' };
    if (!list.some(x => x.id === s.name)) list.push({ ...s, id: s.name });
  }
  for (const r of projectRoots()) {
    const on = subdirs(path.join(r.cwd, '.claude', 'skills')).map(d => [d, true]);
    const off = subdirs(path.join(DISABLED, projectKey(r.cwd))).map(d => [d, false]);
    for (const [d, enabled] of [...on, ...off]) {
      const s = readSkill(d, { source: 'project', group: `Project: ${r.project}`, project: r.project, cwd: r.cwd, toggle: 'move', enabled });
      if (s) list.push({ ...s, id: s.name });
    }
  }
  return list;
}

// usage per skill id across every transcript; plugin skills are invoked as "plugin:skill"
function usage() {
  const u = {};
  for (const x of T.allStates()) {
    for (const [name, k] of Object.entries(x.st.skills)) {
      const e = u[name] || (u[name] = { uses: 0, errors: 0, byYou: 0, last: null, lastError: null, projects: {}, sessions: 0, days: {} });
      e.uses += k.uses; e.errors += k.errors; e.byYou += k.byYou; e.sessions++;
      for (const [d, n] of Object.entries(k.days || {})) e.days[d] = (e.days[d] || 0) + n;
      if (!e.last || k.last > e.last) e.last = k.last;
      if (k.lastError && (!e.lastError || k.lastError > e.lastError)) e.lastError = k.lastError;
      e.projects[x.project] = (e.projects[x.project] || 0) + k.uses;
    }
  }
  return u;
}

const BUILTIN_COMMANDS = new Set('model fast compact clear help config resume init review cost login logout status memory mcp agents permissions doctor exit context usage add-dir ide vim theme hooks export rewind bug release-notes upgrade terminal-setup statusline output-style plugin plugins skills todos tasks bashes security-review pr-comments install-github-app privacy-settings feedback effort loop schedule'.split(' '));
let listCache = null;

function list(fresh) {
  if (!fresh && listCache && Date.now() - listCache.at < 15000) return listCache.v;
  const v = build();
  listCache = { at: Date.now(), v };
  // a small snapshot for the session-start hook (which must stay instant): which skills are proven, failing or off
  try {
    const ids = h => v.skills.filter(x => x.health === h).sort((x, y) => ((y.usage && y.usage.uses) || 0) - ((x.usage && x.usage.uses) || 0)).map(x => x.id);
    // plus a compact index of the enabled skills for the per-message matcher (lib/skillmatch.js)
    const index = v.skills.filter(x => x.enabled !== false).map(x => ({ id: x.id, name: x.name, description: String(x.description || '').slice(0, 4000) }));
    const superpowers = v.plugins.some(p => p.name === 'superpowers' && p.enabled);
    kv.write('skills-snapshot.json', { at: new Date().toISOString(), proven: ids('working'), failing: ids('failing'), off: ids('off'), total: v.skills.length, superpowers, index });
  } catch { /* snapshot is a convenience */ }
  return v;
}

function build() {
  const skills = discover();
  const u = usage();
  const verdicts = kv.read('skill-verdicts.json', {});
  const known = new Set();
  for (const s of skills) {
    const short = s.id.includes(':') ? s.id.split(':').pop() : s.id;
    const stat = u[s.id] || (s.source === 'plugin' || s.source === 'claude.ai' ? null : u[short]) || null;
    known.add(s.id); if (stat && !u[s.id]) known.add(short);
    s.usage = stat;
    s.verdict = verdicts[s.id] || null;
    const errRate = stat && stat.uses ? stat.errors / stat.uses : 0;
    s.health = !s.enabled ? 'off' : s.verdict ? s.verdict.verdict : !stat ? 'untested' : errRate > 0.3 ? 'failing' : 'working';
  }
  // things invoked as skills that are no longer installed (or were slash commands)
  const orphans = Object.entries(u).filter(([k]) => !known.has(k) && !BUILTIN_COMMANDS.has(k)).map(([k, v]) => ({ id: k, usage: v }))
    .sort((a, b) => b.usage.uses - a.usage.uses).slice(0, 40);
  return { skills, plugins: pluginList(), orphans };
}

function moveDir(from, to) {
  if (fs.existsSync(to)) throw new Error('a skill with that name is already there');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
}

function setPlugin(key, enabled) {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  const s = JSON.parse(raw);
  const bak = path.join(P.DATA, 'backups', `settings-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, raw);
  s.enabledPlugins = { ...(s.enabledPlugins || {}), [key]: !!enabled };
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
}

function toggle(id, source, enabled) {
  const s = discover().find(x => x.id === id && x.source === source);
  if (!s) throw new Error('unknown skill');
  listCache = null;
  if (s.enabled === !!enabled) return { ok: true };
  if (s.toggle === 'plugin') { setPlugin(s.plugin, enabled); return { ok: true, note: `Plugin ${s.plugin} turned ${enabled ? 'on' : 'off'} (all its skills). New sessions pick it up.` }; }
  if (s.toggle !== 'move') throw new Error('this skill is managed outside Claude Code on this machine and cannot be switched here');
  const folder = path.basename(s.dir);
  if (!SAFE_NAME.test(folder)) throw new Error('unexpected folder name');
  const home = s.source === 'user' ? path.join(P.CLAUDE, 'skills') : path.join(s.cwd, '.claude', 'skills');
  const off = path.join(DISABLED, s.source === 'user' ? 'user' : projectKey(s.cwd));
  if (enabled) moveDir(s.dir, path.join(home, folder)); else moveDir(s.dir, path.join(off, folder));
  return { ok: true, note: `${s.name} ${enabled ? 'restored' : 'parked in the Anchor data folder'}. New sessions pick it up.` };
}

function setVerdict(id, verdict, note) {
  const v = kv.read('skill-verdicts.json', {});
  if (!verdict) delete v[id];
  else {
    if (!['working', 'failing', 'untested'].includes(verdict)) throw new Error('verdict must be working, failing or untested');
    v[id] = { verdict, note: String(note || '').slice(0, 1000), at: new Date().toISOString() };
  }
  kv.write('skill-verdicts.json', v);
  listCache = null;
  return { ok: true };
}

module.exports = { list, toggle, setVerdict, projectRoots, frontmatter, SAFE_NAME };
