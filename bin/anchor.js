#!/usr/bin/env node
'use strict';
// mc: start/open Anchor and manage its board from any terminal or any Claude session.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const P = require('../lib/paths');
const store = require('../lib/store');

const ROOT = path.resolve(__dirname, '..');
const URL_ = `http://127.0.0.1:${P.PORT}/`;
const LOG = path.join(P.DATA, 'server.log');
const MARK_START = '<!-- anchor:start -->';
const MARK_END = '<!-- anchor:end -->';

const HELP = `Anchor: a dashboard for every Claude Code session on this computer.

  anchor start                 start the dashboard in the background (if needed) and open it
  anchor open [--browser] [--page account|live|skills|...]
                           open it (app window by default; --browser for a normal tab)
  anchor usage                 your current 5-hour window, the week, and when each resets (from local files)
  anchor tokens [--days N] [--json]
                           where your tokens went (last 7 days by default) and what to change, biggest saving first
  anchor saver on|off          the token saver: lean session note, working habits, stricter skill hints (on by default)
  anchor governor on|off       the token governor: /compact and /clear prompts as a session grows (on by default)
  anchor cacheguard block|warn|off
                           what happens when you return to a big session whose prompt cache expired (default: block once)
  anchor statusline install [--apply]
                           a status line with context size, cache-warm time and your limits (--apply writes it)
  anchor lean [--apply]        switch off skills and plugins you never use (lists them first; --apply does it)
  anchor catalog [install <id>]
                           token-saving tools from the web, ranked for your own usage; install one by id
  anchor export-skills [folder]
                           zip Anchor's skills for claude.ai, and a plugin for Claude Cowork
  anchor claude <profile> [claude options]
                           start Claude Code on a provider profile (OpenRouter, Ollama, Groq...) set up in Anchor
  anchor providers             list provider profiles
  anchor runs [--session id] [--json]
                           what each subagent of a session cost, measured the same way (compare two approaches)
  anchor trash [add <path...> --why "text" | keep <id> | rm <id> | empty [--permanent]]
                           leftovers to delete afterwards; emptying moves them to the Recycle Bin
  anchor status                is it running? where is the data?
  anchor stop                  stop the background server

  anchor add "title" [-p project] [-n notes] [--doing] [--high|--low]
                           add work to the board (from a Claude session it is tagged as Claude's)
  anchor list [--all] [-p project]
                           show open board items (--all includes done)
  anchor doing|done|todo|wait <id>      move an item          anchor rm <id>    delete it
  anchor note <id> "text"      replace an item's notes

  anchor watch <path> [--label name] [--gb size]   follow a download or growing folder
  anchor unwatch <path|id>

  anchor job <log file> [--label name] [-p project] [--pid N]
                           show a long run started outside Claude (training, scripts) with its live log
                           and progress (a progress.json next to the log is picked up automatically)
  anchor unjob <id|log>

  anchor codex [status]        is Anchor set up in Codex (OpenAI's coding agent)?
  anchor codex setup           add Anchor to Codex: plugin (hooks, skills), AGENTS.md note, your proven skills ported
  anchor codex skills [--json] every Claude skill with its Codex verdict: works as-is, adapted, or Claude-only
  anchor codex port <id...> [--force] [--name n]
                           bring Claude skills to Codex (~/.agents/skills), Claude tools mapped to Codex's
  anchor codex unport <name>   remove a ported skill          anchor codex sync   refresh ports whose source changed
  anchor codex usage [--days N]
                           Codex tokens, cache share, and its own limit windows with reset times
  anchor codex uninstall [--skills]

  anchor shortcut              put an "Anchor" shortcut on the desktop: one double-click starts everything
  anchor install              start at login, desktop shortcut, 'anchor' on PATH, Claude skill + CLAUDE.md note
  anchor uninstall             undo everything install did (keeps your board)
`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--project') out.project = argv[++i];
    else if (a === '-n' || a === '--notes') out.notes = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--gb') out.gb = Number(argv[++i]);
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--why') out.why = argv[++i];
    else if (a === '--pid') out.pid = Number(argv[++i]);
    else if (a === '--progress') out.progress = argv[++i];
    else if (a === '--page') out.page = String(argv[++i] || '').replace(/[^\w-]/g, '');
    else if (a === '--agent') out.agent = String(argv[++i] || '').toLowerCase();
    else if (a === '--name') out.name = argv[++i];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

function ping(timeout = 800) {
  return new Promise(resolve => {
    const req = http.get(`${URL_}api/ping`, { timeout, headers: { host: `127.0.0.1:${P.PORT}` } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function ensureServer() {
  if (await ping()) return true;
  fs.mkdirSync(P.DATA, { recursive: true });
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: ROOT });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (await ping()) return true;
  }
  console.error(`The server did not start. See ${LOG}`);
  return false;
}

function edgePath() {
  const c = [path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')];
  return c.find(p => p && fs.existsSync(p));
}

function openUi(browser, page) {
  const url = page ? `${URL_}#/${page}` : URL_;
  const app = !browser && process.platform === 'win32' && edgePath();
  if (app) spawn(app, [`--app=${url}`, '--window-size=1440,920'], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------- plugin hook
// A stable launcher in the data folder always points at the installed copy, so instructions can use one fixed path
// ("$HOME/.anchor/anchor.js") even after the plugin updates and moves to a new version folder.
const LAUNCHER = path.join(P.DATA, 'anchor.js');
function writeLauncher() {
  const body = `// Written by Anchor on each Claude Code session start; points at the installed copy.
require(${JSON.stringify(path.join(ROOT, 'bin', 'anchor.js'))});
`;
  fs.mkdirSync(P.DATA, { recursive: true });
  let cur = '';
  try { cur = fs.readFileSync(LAUNCHER, 'utf8'); } catch { /* first run */ }
  if (cur !== body) fs.writeFileSync(LAUNCHER, body);
}

// SessionStart hook: fast, silent, never fails the session
async function hook(agent) {
  let input = {};
  if (!process.stdin.isTTY) { try { let raw = ''; for await (const c of process.stdin) raw += c; input = JSON.parse(raw || '{}'); } catch { input = {}; } }
  if (require('../lib/codex').isCodex(agent, input)) return codexHook();
  try { writeLauncher(); } catch { /* read-only home: skip */ }
  let up = !!(await ping(300));
  if (!up) {
    try {
      const fd = fs.openSync(LOG, 'a');
      spawn(process.execPath, [path.join(ROOT, 'server.js')], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: ROOT }).unref();
      up = true;
    } catch { /* leave it */ }
  }
  const mc = 'node "$HOME/.anchor/anchor.js"';
  const lean = tokenSaverOn();
  let ctx = !up ? '' : lean
    ? `Anchor (local dashboard ${URL_}): anchor = ${mc}. Board: anchor add "title" -p <project> [--doing], anchor done <id>, anchor list. Usage and resets: anchor usage. Where tokens went: anchor tokens.`
    : `Anchor dashboard: ${URL_} (local only). Board: ${mc} add "title" -p <project> [--doing], ${mc} done <id>, ${mc} list. Usage and limit resets: ${mc} usage. The anchor skill has details.`;
  if (lean) ctx += `\n\n${LEAN_RULE}`;
  ctx += skillDiscipline(lean);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
}

// The token saver (on unless turned off in Anchor): a few working habits that cut input tokens without hurting results,
// stricter skill hints, and a shorter session note. About 120 tokens, which it pays back many times over.
const LEAN_RULE = 'TOKEN SAVER (set in Anchor): search before reading and read only the lines you need; cap command output (tail, head, quiet flags); batch independent tool calls; never re-read a file you just edited or wrote; PDFs a few pages at a time; wide multi-file searches go to an Explore subagent, mechanical subagent work to a smaller model; load a skill only when it clearly fits the real task, and once per session; keep answers short. When a session gets long, suggest /compact at a milestone, and /clear for a new topic. Long agent jobs: split into fresh phases that hand off through files. Leftover files for the user to delete: anchor trash add <path> --why "...". The token-saver skill has the details.';
function tokenSaverOn() { return require('../lib/kv').read('settings.json', {}).tokenSaver !== false; }

// Skill discipline (on unless turned off in Anchor): the superpowers-style rule that makes every session look for and
// use a matching skill before acting, with what Anchor knows about which skills work for this user.
function skillDiscipline(lean) {
  const kv = require('../lib/kv');
  if (kv.read('settings.json', {}).skillDiscipline === false) return '';
  const snap = kv.read('skills-snapshot.json', {});
  const few = (a, n) => (a || []).slice(0, n).join(', ');
  // superpowers already gives the general rule; then Anchor adds only what it knows about this user. With the token
  // saver, a skill is used when it clearly fits: a wrongly loaded skill costs 1k to 12k tokens for the whole session
  const rule = snap.superpowers
    ? (lean ? 'SKILLS (from Anchor). Anchor names a skill on a message only when it clearly matches; use it when it fits the real task.'
      : 'SKILLS (from Anchor). Anchor also names matching skills on each of your messages; treat those names as a strong hint.')
    : lean
      ? 'SKILL DISCIPLINE (set by the user in Anchor). Before real work (building, debugging, planning, documents, data), check your skills and invoke the one that clearly fits with the Skill tool first; process skills (planning, debugging, testing) come before implementation skills. Skip skills for quick questions, status checks and one-line changes, and never load one twice in a session. Anchor names a skill on a message when it clearly matches.'
      : "SKILL DISCIPLINE (set by the user in Anchor). Before you respond to any request, questions included, check the skills available to you. If a skill could plausibly apply, even with a small chance, invoke it with the Skill tool first and follow it; process skills (planning, debugging, brainstorming, testing) come before implementation skills. If it turns out not to fit, drop it. Don't re-invoke a skill already loaded this turn, and don't skip one because the task looks simple. Anchor also names matching skills on each message; treat those as a strong hint.";
  // turned-off skills are not listed to Claude at all, so the token saver doesn't repeat their names
  return `

${rule}${snap.proven && snap.proven.length ? ` Proven for this user: ${few(snap.proven, lean ? 10 : 25)}.` : ''}${snap.failing && snap.failing.length ? ` Reported failing (avoid unless asked): ${few(snap.failing, lean ? 8 : 15)}.` : ''}${snap.off && snap.off.length && !lean ? ` Turned off by the user (do not use): ${few(snap.off, 15)}.` : ''}`;
}

// ---------------------------------------------------------------- Codex
// The same aims in Codex's own words: its shell and apply_patch instead of Claude's tools, $skill / SKILL.md instead of
// the Skill tool, /new instead of /clear. Same board, same token saver, same skill hints.
const CODEX_LEAN = 'TOKEN SAVER (set in Anchor): search with rg before reading, and print only the lines you need (rg -n, sed -n, head, Select-Object -First); cap command output (tail, head, quiet flags); batch independent commands; never re-read a file you just patched; PDFs a few pages at a time; open a skill\'s SKILL.md only when it clearly fits the real task, and once per session; keep answers short. When a session gets long, suggest /compact at a milestone, and /new for a new topic. Long jobs: split into phases that hand off through files. Leftover files for the user to delete: anchor trash add <path> --why "...".';

function codexSkillRule(lean) {
  const kv = require('../lib/kv');
  if (kv.read('settings.json', {}).skillDiscipline === false) return '';
  const snap = require('../lib/skillmatch').codexSnapshot();
  const ids = new Set((snap.index || []).map(s => s.id));
  const proven = (kv.read('skills-snapshot.json', {}).proven || []).map(id => (snap.index || []).find(s => s.from === id || s.id === id)).filter(Boolean).map(s => s.id).filter(id => ids.has(id));
  const rule = lean
    ? 'SKILLS (from Anchor). Before real work (building, debugging, planning, documents, data), check your skills list; when one clearly fits, open its SKILL.md and follow it first; process skills (planning, debugging, testing) come before implementation skills. Skip skills for quick questions and one-line changes. Skills ported from Claude end with a "Running in Codex" note: follow it. Anchor names a skill on a message when it clearly matches.'
    : 'SKILL DISCIPLINE (set by the user in Anchor). Before you respond to any request, check your skills list. If a skill could plausibly apply, open its SKILL.md and follow it first; process skills (planning, debugging, brainstorming, testing) come before implementation skills. Skills ported from Claude end with a "Running in Codex" note that maps Claude tools to yours: follow it. Anchor also names matching skills on each message; treat those as a strong hint.';
  return `\n\n${rule}${proven.length ? ` Proven for this user: ${[...new Set(proven)].slice(0, lean ? 10 : 25).join(', ')}.` : ''}`;
}

async function codexHook() {
  // the launcher first: it also creates the data folder, which a first-ever run (no Claude Code) does not have yet
  try { writeLauncher(); } catch { /* read-only home */ }
  let up = !!(await ping(300));
  if (!up) {
    try { fs.mkdirSync(P.DATA, { recursive: true }); const fd = fs.openSync(LOG, 'a'); spawn(process.execPath, [path.join(ROOT, 'server.js')], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: ROOT }).unref(); up = true; } catch { /* leave it */ }
  }
  const mc = 'node "$HOME/.anchor/anchor.js"';
  const lean = tokenSaverOn();
  let ctx = up ? `Anchor (local dashboard ${URL_}): anchor = ${mc}. Board: anchor add "title" -p <project> [--doing], anchor done <id>, anchor list. Usage and resets: anchor codex usage. Run these with your shell; don't announce the bookkeeping.` : '';
  if (lean) ctx += `\n\n${CODEX_LEAN}`;
  ctx += codexSkillRule(lean);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx.trim() } }));
}

function agentsNote(mc) {
  return `${MARK_START}
# Anchor (dashboard at http://127.0.0.1:${P.PORT})
The user follows their coding-agent work in a local dashboard. Keep it useful, without asking:
- When you plan multi-step work or leave work pending, record each item: \`${mc} add "short title" -p <project> [-n "notes"] [--doing]\`. Move items as you go (\`${mc} doing|done <id>\`); \`${mc} list -p <project>\` shows what is open.
- When you start a long download into a known folder or file, also run \`${mc} watch "<path>" --label "<name>" [--gb <expected size>]\`.
- Skills ported from Claude by Anchor live in ~/.agents/skills; each ends with a "Running in Codex" note that maps Claude tools to yours.
${MARK_END}`;
}

function codexRun(args) {
  const [cmd, argv] = require('../lib/codex').run(args);
  const r = require('child_process').spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// where Codex should get Anchor from: this folder when it is a development checkout, else the public repository
function codexSource() { return /[\\/]\.(claude|codex)[\\/]plugins[\\/]|[\\/]codex[^\\/]*[\\/]plugins[\\/]cache[\\/]/i.test(ROOT) ? 'kreht1/anchor' : ROOT; }

function claudeSkillList() { return require('../lib/skills').list(true).skills; }

async function codex(a) {
  const CX = require('../lib/codex'), SP = require('../lib/skillport');
  const sub = a._.shift() || 'status';
  switch (sub) {
    case 'status': {
      const s = CX.status();
      const tick = b => (b ? '✓' : '·');
      console.log(`${tick(s.installed)} Codex ${s.installed ? s.version : 'not found (npm i -g @openai/codex)'}`);
      console.log(`${tick(s.loggedIn)} signed in${s.loggedIn ? '' : ' (run: codex login)'}`);
      console.log(`${tick(s.marketplace)} Anchor marketplace${s.marketplaceSource ? `  ${s.marketplaceSource}` : ''}`);
      console.log(`${tick(s.pluginEnabled)} Anchor plugin${s.pluginVersions.length ? `  ${s.pluginVersions.join(', ')}` : ''}`);
      console.log(`${tick(s.hooksFeature)} hooks feature${s.hooksFeature ? ' (approve Anchor\'s hooks once with /hooks inside Codex)' : ' is off in config.toml'}`);
      console.log(`${tick(s.agentsNote)} note in ${CX.PATHS.AGENTS_MD}`);
      const p = SP.ported();
      console.log(`${tick(p.length)} ${p.length} Claude skill${p.length === 1 ? '' : 's'} ported to ${SP.DEST}`);
      if (!s.plugin || !s.agentsNote) console.log('\nSet it all up with: anchor codex setup');
      break;
    }
    case 'setup': {
      const s = CX.status();
      if (!s.installed) { console.log('Codex is not installed. Install it first: npm i -g @openai/codex   (then: codex login)'); process.exitCode = 1; break; }
      const src = a.source || codexSource();
      if (!s.marketplace) { const r = codexRun(['plugin', 'marketplace', 'add', src]); console.log(r.ok ? `✓ marketplace added   ${src}` : `· marketplace: ${r.out.split('\n').pop()}`); }
      else console.log(`✓ marketplace          ${s.marketplaceSource}`);
      if (!s.plugin) { const r = codexRun(['plugin', 'add', 'anchor@anchor']); console.log(r.ok ? '✓ plugin installed     anchor@anchor' : `· plugin: ${r.out.split('\n').pop()}`); }
      else {
        // bring Codex's copy up to this version: refresh the marketplace, then add the plugin again (it replaces the cache)
        const ver = require('../package.json').version;
        if (!s.pluginVersions.includes(ver)) { codexRun(['plugin', 'marketplace', 'upgrade', 'anchor']); const r = codexRun(['plugin', 'add', 'anchor@anchor']); console.log(r.ok ? `✓ plugin updated       anchor@anchor ${ver}` : `· plugin update: ${r.out.split('\n').pop()}`); }
        else console.log(`✓ plugin installed     anchor@anchor ${ver}`);
      }
      const mc = process.platform === 'win32' && fs.existsSync(SHIM) ? 'anchor' : 'node "$HOME/.anchor/anchor.js"';
      fs.mkdirSync(CX.PATHS.HOME, { recursive: true });
      let md = ''; try { md = fs.readFileSync(CX.PATHS.AGENTS_MD, 'utf8'); } catch { /* none yet */ }
      const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
      md = re.test(md) ? md.replace(re, agentsNote(mc)) : `${md.replace(/\s*$/, '')}${md.trim() ? '\n\n' : ''}${agentsNote(mc)}\n`;
      fs.writeFileSync(CX.PATHS.AGENTS_MD, md);
      console.log(`✓ note for every Codex session  ${CX.PATHS.AGENTS_MD}`);
      try { writeLauncher(); } catch { /* fine */ }
      // the skills that already work for this user in Claude come along (Claude-only ones stay behind)
      if (!a['no-skills']) {
        const all = claudeSkillList();
        const proven = new Set(require('../lib/kv').read('skills-snapshot.json', {}).proven || []);
        const cat = SP.catalog(all);
        const done = [];
        for (const c of cat.filter(c => proven.has(c.id) && !c.inCodex && c.verdict !== 'claude-only' && !c.id.startsWith('anchor:'))) {
          try { done.push(SP.port(all.find(s => s.id === c.id), { known: all }).call); } catch { /* skip that one */ }
        }
        if (done.length) SP.relink(all);
        console.log(done.length ? `✓ ported your proven skills  ${done.join(' ')}` : '✓ skills: nothing new to port (see: anchor codex skills)');
      }
      require('../lib/kv').write('codex-skills-snapshot.json', {});
      console.log('\nLast step, inside Codex: run /hooks once and approve Anchor\'s hooks (Codex asks before running any plugin hook).');
      if (!s.loggedIn) console.log('Codex is not signed in yet: codex login');
      break;
    }
    case 'skills': {
      const cat = SP.catalog(claudeSkillList());
      if (a.json) { console.log(JSON.stringify(cat, null, 1)); break; }
      const label = { works: 'works as-is', adapted: 'adapted    ', 'claude-only': 'Claude-only' };
      for (const c of cat.sort((x, y) => x.verdict.localeCompare(y.verdict) || x.id.localeCompare(y.id))) {
        console.log(`${c.ported ? (c.ported.stale ? '↻' : '✓') : c.inCodex ? '•' : ' '} ${label[c.verdict]}  ${c.id.padEnd(42)} ${c.verdict === 'works' ? '' : c.why}`);
      }
      console.log('\n✓ ported   ↻ source changed (anchor codex sync)   • Codex has it natively\nPort with: anchor codex port <id> [<id>...] [--force for Claude-only]');
      break;
    }
    case 'port': {
      const all = claudeSkillList();
      if (!a._.length) { console.log('Which skills? anchor codex port <id> [<id>...]  (ids from: anchor codex skills)'); break; }
      for (const id of a._) {
        const s = all.find(x => x.id === id) || all.find(x => x.name === id);
        if (!s) { console.log(`· ${id}: no such Claude skill`); continue; }
        try { const r = SP.port(s, { known: all, force: !!a.force, name: a._.length === 1 ? a.name : undefined }); console.log(`✓ ${s.id} → ${r.call}  (${r.verdict}: ${r.why})`); }
        catch (e) { console.log(`· ${s.id}: ${e.message}`); }
      }
      if (a._.length > 1) SP.relink(all); // skills ported together now name each other as Codex calls them
      require('../lib/kv').write('codex-skills-snapshot.json', {});
      break;
    }
    case 'unport': case 'remove': {
      for (const n of a._) { try { SP.unport(n); console.log(`removed ${n} from Codex`); } catch (e) { console.log(`· ${e.message}`); } }
      require('../lib/kv').write('codex-skills-snapshot.json', {});
      break;
    }
    case 'sync': {
      const r = SP.sync(claudeSkillList());
      console.log(`${r.updated.length} updated${r.updated.length ? `: ${r.updated.join(', ')}` : ''} · ${r.same.length} unchanged${r.missing.length ? ` · source gone: ${r.missing.join(', ')}` : ''}`);
      require('../lib/kv').write('codex-skills-snapshot.json', {});
      break;
    }
    case 'usage': {
      const u = CX.usage(a.days || 7);
      if (a.json) { console.log(JSON.stringify(u, null, 1)); break; }
      if (!u.sessions) { console.log('No Codex sessions in the last 7 days.'); break; }
      const when = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      const lim = (n, w) => w ? `${n}: ${w.pct != null ? `${w.pct}% used` : 'unknown'}${w.resetAt ? `, resets ${when(w.resetAt)}` : ''}` : null;
      console.log(`Codex · last ${u.days} days: ${fmtTok(u.tokens)} tokens in ${u.sessions} session${u.sessions > 1 ? 's' : ''} (${u.cacheShare}% of input from cache) · last 5 h: ${fmtTok(u.last5h)}`);
      if (u.limits) console.log([lim(`Short window${u.limits.primary && u.limits.primary.minutes ? ` (${Math.round(u.limits.primary.minutes / 60)} h)` : ''}`, u.limits.primary), lim('Week', u.limits.secondary)].filter(Boolean).join(' · ') + `  (as Codex reported ${when(u.limits.at)})`);
      for (const s of u.recent.slice(0, 5)) console.log(`  ${s.project || '?'}  ${fmtTok(s.total)} tokens, context ${fmtTok(s.context)}${s.window ? `/${fmtTok(s.window)}` : ''}  ${s.firstPrompt ? `"${s.firstPrompt.slice(0, 60).replace(/\s+/g, ' ')}"` : ''}`);
      break;
    }
    case 'uninstall': {
      let md = ''; try { md = fs.readFileSync(CX.PATHS.AGENTS_MD, 'utf8'); } catch { /* none */ }
      const out = md.replace(new RegExp(`\\n*${MARK_START}[\\s\\S]*?${MARK_END}\\n?`), '\n');
      if (out !== md) { fs.writeFileSync(CX.PATHS.AGENTS_MD, out.replace(/\n{3,}/g, '\n\n')); console.log(`cleaned ${CX.PATHS.AGENTS_MD}`); }
      if (a.skills) for (const p of SP.ported()) { SP.unport(p.name); console.log(`removed ported skill ${p.name}`); }
      const r = codexRun(['plugin', 'remove', 'anchor@anchor']);
      console.log(r.ok ? 'removed the Anchor plugin from Codex' : `· ${r.out.split('\n').pop() || 'plugin not removed'}`);
      console.log(`Ported skills are kept unless you pass --skills. Remove the marketplace with: codex plugin marketplace remove anchor`);
      break;
    }
    default: console.log(`Unknown: anchor codex ${sub}. Try: status, setup, skills, port, unport, sync, usage, uninstall`); process.exitCode = 1;
  }
}

function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
function usage() {
  const u = require('../lib/usage').summary();
  const when = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const left = iso => { const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000)); return m >= 2880 ? `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h` : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  const a = u.account || {};
  console.log(`${a.displayName || 'Signed-in user'} · ${u.plan}${a.organizationName ? ` · ${a.organizationName}` : ''}`);
  const s = u.session;
  console.log(s.idle ? 'Session (5 h): no window open; your next message starts one.'
    : `Session (5 h): ${s.pct != null ? `about ${s.pct}% of your usual cap, ` : ''}${fmtTok(s.used)} tokens, ${s.msgs} replies. ${s.limited ? 'LIMIT REACHED. ' : ''}${s.exact ? 'Resets' : 'Window ends'} ${when(s.resetAt)} (in ${left(s.resetAt)}).`);
  const w = u.weekly;
  console.log(`Week: ${w.pct != null ? `about ${w.pct}% of your usual cap, ` : ''}${fmtTok(w.used)} tokens, ${w.msgs} replies.${w.nextReset ? ` Resets ${when(w.nextReset)} (in ${left(w.nextReset)}).` : ''}${w.limited ? ' LIMIT REACHED.' : ''}`);
  console.log('(From local files; percentages are estimates from your past limit hits. /usage in Claude Code is exact.)');
  try {
    const c = require('../lib/codex').usage(7);
    if (c.sessions) {
      const p = c.limits && c.limits.primary, w = c.limits && c.limits.secondary;
      console.log(`Codex (7 days): ${fmtTok(c.tokens)} tokens in ${c.sessions} sessions${p && p.pct != null ? ` · short window ${p.pct}% used${p.resetAt ? `, resets ${when(p.resetAt)}` : ''}` : ''}${w && w.pct != null ? ` · week ${w.pct}%${w.resetAt ? `, resets ${when(w.resetAt)}` : ''}` : ''}. Details: anchor codex usage`);
    }
  } catch { /* no Codex */ }
}

function fromClaude() { return process.env.CLAUDECODE === '1' || !!process.env.CLAUDE_CODE_ENTRYPOINT; }

function show(items) {
  if (!items.length) return console.log('The board is empty.');
  const label = { todo: 'planned', doing: 'in progress', blocked: 'waiting', done: 'done' };
  for (const i of items) {
    console.log(`${i.id}  [${label[i.status]}]${i.priority === 'high' ? ' !' : ''} ${i.title}${i.project ? `  (${i.project})` : ''}${i.source === 'claude' ? '  · Claude' : ''}`);
    if (i.notes) console.log(`        ${i.notes.split('\n').join('\n        ')}`);
  }
}

// ---------------------------------------------------------------- install
const appdata = process.env.APPDATA || '';
const STARTUP = path.join(appdata, 'Microsoft/Windows/Start Menu/Programs/Startup/Claude Anchor.vbs');
const SHORTCUT = path.join(P.HOME, 'Desktop/Anchor.lnk');
const SHIM = path.join(appdata, 'npm/anchor.cmd');
const SKILL_DIR = path.join(P.CLAUDE, 'skills/anchor');
const CLAUDE_MD = path.join(P.CLAUDE, 'CLAUDE.md');

function vbsQuote(s) { return s.replace(/"/g, '""'); }

function claudeNote(mc) {
  return `${MARK_START}
# Anchor (dashboard at http://127.0.0.1:${P.PORT})
The user follows all Claude Code work in a local dashboard. Keep it useful, without asking:
- When you plan multi-step work or leave work pending, record each item: \`${mc} add "short title" -p <project> [-n "notes"] [--doing]\`. Move items as you go (\`${mc} doing|done <id>\`); \`${mc} list -p <project>\` shows what is open.
- When you start a long download into a known folder or file, also run \`${mc} watch "<path>" --label "<name>" [--gb <expected size>]\` so its progress shows up.
- Background commands, conversations and GPU use are picked up automatically; don't announce these bookkeeping steps.
${MARK_END}`;
}

// Desktop shortcut: double-click starts the server (if it isn't running) and opens the app window.
function shortcut() {
  // a versioned copy of the icon, so Windows shows the current mark instead of a cached older one
  const ver = require('../package.json').version;
  const icon = path.join(ROOT, `public/icon-${ver}.ico`);
  try { fs.copyFileSync(path.join(ROOT, 'public/icon.ico'), icon); } catch { /* fall back to the plain icon below */ }
  const launcher = path.join(ROOT, 'launch.vbs');
  fs.writeFileSync(launcher, `' Opens Anchor as an app window, starting the server first if needed.\r\nCreateObject("WScript.Shell").Run """${vbsQuote(process.execPath)}"" ""${vbsQuote(path.join(ROOT, 'bin/anchor.js'))}"" open", 0, False\r\n`);
  const q = s => s.replace(/'/g, "''");
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(SHORTCUT)}');$s.TargetPath='wscript.exe';$s.Arguments='"${q(launcher)}"';$s.WorkingDirectory='${q(ROOT)}';$s.IconLocation='${q(fs.existsSync(icon) ? icon : path.join(ROOT, 'public/icon.ico'))},0';$s.Description='Anchor: every Claude session, one table';$s.Save()`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    for (const old of ['Mission Control.lnk', 'Axios.lnk']) try { fs.unlinkSync(path.join(P.HOME, 'Desktop', old)); } catch { /* older names, before the rename */ }
    console.log(`✓ desktop shortcut      ${SHORTCUT}`);
  } catch { console.log('· the desktop shortcut could not be created'); }
}

function install() {
  if (process.platform !== 'win32') console.log('Note: autostart and shortcuts are Windows-only; the skill and CLAUDE.md note are still installed.');
  const node = process.execPath;
  const server = path.join(ROOT, 'server.js');
  const mcjs = path.join(ROOT, 'bin/anchor.js');
  if (process.platform === 'win32') {
    fs.mkdirSync(path.dirname(STARTUP), { recursive: true });
    fs.writeFileSync(STARTUP, `' Starts Claude Anchor (http://127.0.0.1:${P.PORT}) hidden at login.\r\nCreateObject("WScript.Shell").Run """${vbsQuote(node)}"" ""${vbsQuote(server)}""", 0, False\r\n`);
    console.log(`✓ starts at login       ${STARTUP}`);
    shortcut();
    if (fs.existsSync(path.dirname(SHIM))) {
      fs.writeFileSync(SHIM, `@"${node}" "${mcjs}" %*\r\n`);
      console.log(`✓ 'anchor' command       ${SHIM}`);
    }
  }
  const mc = process.platform === 'win32' && fs.existsSync(SHIM) ? 'anchor' : `node "${mcjs}"`;
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  const skill = fs.readFileSync(path.join(ROOT, 'skill/SKILL.md'), 'utf8').replace(/\{\{MC\}\}/g, mc).replace(/\{\{URL\}\}/g, URL_).replace(/\{\{ROOT\}\}/g, ROOT);
  fs.writeFileSync(path.join(SKILL_DIR, 'SKILL.md'), skill);
  console.log(`✓ Claude skill          ${SKILL_DIR}`);
  let md = '';
  try { md = fs.readFileSync(CLAUDE_MD, 'utf8'); } catch { /* none yet */ }
  const note = claudeNote(mc);
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  md = re.test(md) ? md.replace(re, note) : `${md.replace(/\s*$/, '')}${md.trim() ? '\n\n' : ''}${note}\n`;
  fs.writeFileSync(CLAUDE_MD, md);
  console.log(`✓ note for every Claude session  ${CLAUDE_MD}`);
}

function uninstall() {
  for (const f of [STARTUP, SHORTCUT, SHIM, path.join(ROOT, 'launch.vbs')]) { try { fs.unlinkSync(f); console.log(`removed ${f}`); } catch { /* not there */ } }
  try { fs.rmSync(SKILL_DIR, { recursive: true, force: true }); console.log(`removed ${SKILL_DIR}`); } catch { /* not there */ }
  try {
    const md = fs.readFileSync(CLAUDE_MD, 'utf8');
    const out = md.replace(new RegExp(`\\n*${MARK_START}[\\s\\S]*?${MARK_END}\\n?`), '\n');
    if (out !== md) { fs.writeFileSync(CLAUDE_MD, out.replace(/\n{3,}/g, '\n\n')); console.log(`cleaned ${CLAUDE_MD}`); }
  } catch { /* none */ }
  console.log(`Your board is kept in ${P.DATA}.`);
}

// ---------------------------------------------------------------- main
(async () => {
  const a = args(process.argv.slice(2));
  const cmd = a._.shift() || 'start';
  try {
    switch (cmd) {
      case 'start': if (await ensureServer()) { console.log(`Anchor: ${URL_}`); if (!a['no-open']) openUi(a.browser); } break;
      case 'serve': require('../server.js'); break;
      case 'open': if (await ensureServer()) openUi(a.browser, a.page); break;
      case 'hook': await hook(a.agent); break;
      case 'codex': await codex(a); break;
      case 'guard': { // PreToolUse hook: read the tool call, answer allow (silence), ask or deny
        let raw = '';
        for await (const c of process.stdin) raw += c;
        let input = {};
        try { input = JSON.parse(raw); } catch { break; }
        const G = require('../lib/guard');
        const r = G.evaluate(input);
        if (r.decision === 'allow') break;
        G.log(input, r);
        const isCx = require('../lib/codex').isCodex(a.agent, input);
        if (r.decision === 'deny' && r.targets && r.targets.length) { try { const TR = require('../lib/trash'); for (const p of r.targets) TR.add(p, { from: 'guard', why: `${isCx ? 'Codex' : 'Claude'} tried to delete it; Guard ${r.decision === 'deny' ? 'blocked' : 'asked about'} it (${r.why}).`, cwd: input.cwd, session: input.session_id }); } catch { /* never break the hook */ } }
        // Codex has no "ask" answer yet: there a risky call is allowed through with Guard's note, a dangerous one denied
        if (isCx && r.decision === 'ask') { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: G.reason(r) } })); break; }
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: G.reason(r) } }));
        break;
      }
      case 'prompt': { // UserPromptSubmit hook: the token governor (may stop a cold big session once), then skill hints
        let raw = '';
        for await (const c of process.stdin) raw += c;
        let gov = {}, isCx = a.agent === 'codex';
        try { const input = JSON.parse(raw || '{}'); isCx = require('../lib/codex').isCodex(a.agent, input); gov = require('../lib/governor').decide(input, undefined, undefined, isCx); } catch { gov = {}; }
        if (gov.block) { process.stdout.write(JSON.stringify({ decision: 'block', reason: gov.reason })); break; }
        let hint = '';
        try { const out = require('../lib/skillmatch').hook(raw, isCx); if (out) hint = JSON.parse(out).hookSpecificOutput.additionalContext; } catch { /* never block a message */ }
        const ctx = [gov.note, hint].filter(Boolean).join('\n');
        if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
        break;
      }
      case 'governor': case 'cacheguard': {
        const kv = require('../lib/kv');
        const st = kv.read('settings.json', {});
        const v = a._[0];
        if (cmd === 'governor' && (v === 'on' || v === 'off')) { st.governor = v === 'on'; kv.write('settings.json', st); }
        if (cmd === 'cacheguard' && ['block', 'warn', 'off'].includes(v)) { st.cacheGuard = v; kv.write('settings.json', st); }
        console.log(`Token governor: ${st.governor !== false ? 'on' : 'off'} · cache guard: ${st.cacheGuard || 'block'}${v ? ' (takes effect on your next message)' : ''}`);
        break;
      }
      case 'statusline': {
        if (a._[0] === 'install') { console.log(require('../lib/statusline').install(!!a.apply)); break; }
        let raw = '';
        if (!process.stdin.isTTY) for await (const c of process.stdin) raw += c;
        try { process.stdout.write(require('../lib/statusline').line(JSON.parse(raw || '{}'))); } catch { process.stdout.write('Anchor'); }
        break;
      }
      case 'lean': { console.log(require('../lib/lean').run(!!a.apply)); break; }
      case 'catalog': {
        const CT = require('../lib/catalog');
        if (a._[0] === 'install') { console.log(CT.install(a._[1] || '')); break; }
        console.log(CT.text(CT.ranked()));
        break;
      }
      case 'providers': {
        const l = require('../lib/providers').list();
        if (!l.profiles.length) console.log('No provider profiles yet. Add one in Anchor: anchor open --page providers');
        for (const p of l.profiles) console.log(`${p.id}${l.fallback === p.id ? ' (fallback)' : ''}  ${p.name}  ·  ${p.kind === 'openai' ? 'via Anchor bridge' : 'direct'}  ·  ${p.models.main || 'no model set'}`);
        break;
      }
      case 'claude': {
        const PRV = require('../lib/providers');
        const prof = PRV.find(process.argv[3] || '');
        if (!prof) { console.error('Unknown profile. See: anchor providers'); process.exitCode = 1; break; }
        if (prof.kind === 'openai' && !(await ensureServer())) { console.error('The Anchor server is needed for the bridge and did not start.'); process.exitCode = 1; break; }
        const exe = require('../lib/runner').claudeExe();
        if (!exe) { console.error('Claude Code was not found on this computer.'); process.exitCode = 1; break; }
        console.log(`Claude Code on ${prof.name} (${prof.models.main}). Your normal sessions are unchanged.`);
        const child = spawn(exe, process.argv.slice(4), { stdio: 'inherit', env: { ...process.env, ...PRV.envFor(prof) } });
        await new Promise(r => child.on('exit', code => { process.exitCode = code || 0; r(); }));
        break;
      }
      case 'usage': usage(); break;
      case 'tokens': {
        const TK = require('../lib/tokens');
        const r = TK.audit({ days: a.days || 7 });
        console.log(a.json ? JSON.stringify(r, null, 1) : TK.text(r));
        break;
      }
      case 'runs': {
        const RN = require('../lib/runs');
        const r = RN.report({ session: a.session || a._[0] });
        console.log(a.json ? JSON.stringify(r, null, 1) : RN.text(r));
        break;
      }
      case 'trash': {
        const TR = require('../lib/trash');
        const [sub, ...rest] = a._;
        if (sub === 'add') {
          if (!rest.length) { console.log('usage: anchor trash add <path...> --why "what it is"'); break; }
          for (const p of rest) { const r = TR.add(p, { why: a.why, from: process.env.CLAUDECODE ? 'claude' : 'you', cwd: process.cwd(), project: a.project }); console.log(r.ok ? `in Trash: ${r.item.path} (${TR.fmtSize(r.item.size)})` : `${r.path}: ${r.error}`); }
        } else if (sub === 'rm' || sub === 'empty' || sub === 'delete') {
          if (process.env.CLAUDECODE) { console.log('Only the user empties the Trash. Tell them: Anchor → Trash, or run "anchor trash empty" in a terminal.'); process.exitCode = 1; break; }
          const r = TR.empty(sub === 'empty' ? [] : rest, { permanent: !!a.permanent });
          console.log(`deleted ${r.deleted}${a.permanent ? ' permanently' : ' (moved to the Recycle Bin)'}`); for (const f of r.failed) console.log(`  kept ${f.path}: ${f.error}`);
        } else if (sub === 'keep') console.log(`taken off the list: ${TR.keep(rest).kept}`);
        else {
          const items = TR.list();
          if (a.json) { console.log(JSON.stringify(items, null, 1)); break; }
          if (!items.length) { console.log('Trash is empty.'); break; }
          console.log(`Trash: ${items.length} item(s), ${TR.fmtSize(items.reduce((n, i) => n + i.size, 0))}. "anchor trash empty" moves them all to the Recycle Bin.`);
          for (const i of items) console.log(`  ${i.id}  ${TR.fmtSize(i.size).padStart(8)}  ${i.path}${i.why ? `\n            ${i.why}` : ''}`);
        }
        break;
      }
      case 'saver': {
        const kv = require('../lib/kv');
        const st = kv.read('settings.json', {});
        if (a._[0] === 'on' || a._[0] === 'off') { st.tokenSaver = a._[0] === 'on'; kv.write('settings.json', st); }
        console.log(`Token saver: ${st.tokenSaver !== false ? 'on' : 'off'}${a._[0] ? ' (new Claude Code sessions pick this up)' : ''}`);
        break;
      }
      case 'export-skills': {
        const Z = require('../lib/zip');
        const dest = path.resolve(a._[0] || path.join(P.HOME, 'Desktop'));
        fs.mkdirSync(dest, { recursive: true });
        for (const name of ['token-saver', 'lean-chat']) {
          const r = Z.zipFolder(path.join(ROOT, 'skills', name), path.join(dest, `${name}.zip`));
          console.log(`✓ ${r.out}`);
        }
        // the same skills as a Cowork plugin (skills + a /handoff command), uploaded as one zip
        const ver = require('../package.json').version;
        const entries = [
          { name: 'anchor-lean/.claude-plugin/plugin.json', data: JSON.stringify({ name: 'anchor-lean', version: ver, description: 'Anchor token habits for Claude Cowork: lean chats, handoffs, the token-saver playbook.', license: 'MIT' }, null, 2) },
          { name: 'anchor-lean/commands/handoff.md', data: '---\ndescription: Write a compact handoff to continue this work in a new chat or task (cheaper than a long one)\n---\n\nFollow the Handoff section of the lean-chat skill: Goal, State, Open, Constraints, under about 300 words, then tell the user to paste it into a new chat.\n' },
          ...['token-saver', 'lean-chat'].map(n => ({ name: `anchor-lean/skills/${n}/SKILL.md`, data: fs.readFileSync(path.join(ROOT, 'skills', n, 'SKILL.md')) })),
        ];
        fs.writeFileSync(path.join(dest, 'anchor-lean-cowork.zip'), Z.build(entries));
        console.log(`✓ ${path.join(dest, 'anchor-lean-cowork.zip')}`);
        console.log('Claude app: Settings > Capabilities > Skills > Upload skill (token-saver.zip, lean-chat.zip).');
        console.log('Cowork: Customize > Plugins > + > Upload, and choose anchor-lean-cowork.zip. (Claude Code already has these through Anchor.)');
        break;
      }
      case 'status': {
        const p = await ping();
        console.log(p ? `running (pid ${p.pid}, v${p.version}) at ${URL_}` : 'not running (start it with: anchor start)');
        console.log(`data: ${P.DATA}\nClaude data read from: ${P.CLAUDE}`);
        break;
      }
      case 'stop': {
        const p = await ping();
        if (!p) { console.log('not running'); break; }
        try { process.kill(p.pid); console.log('stopped'); } catch (e) { console.log(`could not stop pid ${p.pid}: ${e.message}`); }
        break;
      }
      case 'add': {
        const title = a._.join(' ').trim();
        const item = store.addItem({ title, notes: a.notes, project: a.project || path.basename(process.cwd()), status: a.doing ? 'doing' : 'todo',
          priority: a.high ? 'high' : a.low ? 'low' : 'normal', source: a.claude || fromClaude() ? 'claude' : 'you', sessionId: a.session });
        console.log(`added ${item.id}: ${item.title}`);
        break;
      }
      case 'list': case 'ls': {
        let items = store.getItems();
        if (!a.all) items = items.filter(i => i.status !== 'done');
        if (a.project) items = items.filter(i => i.project.toLowerCase() === a.project.toLowerCase());
        show(items);
        break;
      }
      case 'doing': case 'done': case 'todo': case 'wait': case 'block': {
        const status = { wait: 'blocked', block: 'blocked' }[cmd] || cmd;
        for (const id of a._) console.log(`${store.updateItem(id, { status }).title}: ${status === 'blocked' ? 'waiting' : status}`);
        break;
      }
      case 'note': { const [id, ...rest] = a._; console.log(`noted on ${store.updateItem(id, { notes: rest.join(' ') }).title}`); break; }
      case 'rm': case 'delete': for (const id of a._) { store.removeItem(id); console.log(`deleted ${id}`); } break;
      case 'watch': {
        const p = path.resolve(a._[0] || '');
        const w = store.addWatch({ path: p, label: a.label, target: a.gb ? a.gb * 1073741824 : null });
        console.log(`watching ${w.path}${w.target ? ` (expecting ${a.gb} GB)` : ''}`);
        break;
      }
      case 'job': {
        const j = store.addJob({ log: path.resolve(a._[0] || ''), label: a.label, project: a.project || path.basename(process.cwd()), pid: a.pid, progress: a.progress });
        console.log(`following ${j.label || j.log} (${j.id})`);
        break;
      }
      case 'unjob': store.removeJob(a._[0] || ''); console.log('stopped following'); break;
      case 'shortcut': shortcut(); break;
      case 'unwatch': store.removeWatch(a._[0]?.length === 6 ? a._[0] : path.resolve(a._[0] || '')); console.log('stopped watching'); break;
      case 'install': install(); await ensureServer(); console.log(`\nAnchor is running at ${URL_}`); break;
      case 'uninstall': uninstall(); break;
      case 'help': case '-h': case '--help': console.log(HELP); break;
      default: console.log(HELP); process.exitCode = 1;
    }
  } catch (e) { console.error(`mc: ${e.message}`); process.exitCode = 1; }
})();
