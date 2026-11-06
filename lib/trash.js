'use strict';
// Trash: leftovers a session made that you should delete afterwards (temp bundles, build caches, scratch databases,
// a file Anchor Guard would not let Claude delete). Claude adds them with `anchor trash add <path> --why "..."`, the
// guard adds the ones it stopped, and you clear them in one click in Anchor → Trash. Deleting goes to the Recycle Bin
// (or the system trash), so a mistake can be undone. Paths that look like a home folder, a drive or a git repo are
// never accepted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./paths');

const FILE = () => path.join(P.DATA, 'trash.json');
const norm = p => path.resolve(p).replace(/[\\/]+$/, '');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function read() { try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
function write(items) { fs.mkdirSync(P.DATA, { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(items, null, 1)); }

// Git Bash paths (/c/Users/...) and ~ resolve to real paths.
function resolvePath(p, cwd) {
  let s = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(P.HOME, s.slice(1));
  if (process.platform === 'win32' && /^\/[a-z]\//i.test(s)) s = `${s[1]}:\\${s.slice(3)}`;
  return norm(path.isAbsolute(s) ? s : path.resolve(cwd || process.cwd(), s));
}

// Why a path may not go in the trash, or '' when it may.
function refuse(abs) {
  if (!abs) return 'no path';
  if (same(abs, path.parse(abs).root.replace(/[\\/]+$/, '')) || same(abs + path.sep, path.parse(abs).root)) return 'a whole drive';
  const home = norm(P.HOME);
  if (same(abs, home)) return 'your home folder';
  if (same(path.dirname(abs), home) && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return 'a top-level folder of your home (Desktop, Documents, …)';
  for (const keep of [P.CLAUDE, P.DATA, path.join(home, '.ssh'), path.join(home, '.config')]) {
    const k = norm(keep);
    if (same(abs, k) || (process.platform === 'win32' ? abs.toLowerCase().startsWith(k.toLowerCase() + path.sep) : abs.startsWith(k + path.sep))) return 'part of Claude Code or Anchor settings';
  }
  try { if (fs.existsSync(path.join(abs, '.git'))) return 'a git repository'; } catch { /* unreadable */ }
  if (path.basename(abs).toLowerCase() === '.git') return 'git history';
  return '';
}

// Size in bytes; folders are counted up to 50k entries so a huge cache never stalls the dashboard.
function sizeOf(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return { size: st.size, dir: false };
    let size = 0, seen = 0; const stack = [abs];
    while (stack.length && seen < 50000) {
      const d = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        seen++;
        const f = path.join(d, e.name);
        if (e.isDirectory()) stack.push(f);
        else { try { size += fs.statSync(f).size; } catch { /* gone */ } }
      }
    }
    return { size, dir: true, partial: seen >= 50000 };
  } catch { return null; }
}

function add(p, o = {}) {
  const abs = resolvePath(p, o.cwd);
  const why = refuse(abs);
  if (why) return { ok: false, path: abs || String(p), error: `not added: ${why}` };
  if (!fs.existsSync(abs)) return { ok: false, path: abs, error: 'not added: it does not exist' };
  const items = read();
  const old = items.find(i => same(i.path, abs));
  if (old) { if (o.why) old.why = o.why; write(items); return { ok: true, item: old, existed: true }; }
  const s = sizeOf(abs) || {};
  const item = { id: Math.random().toString(36).slice(2, 8), path: abs, why: String(o.why || '').slice(0, 300), from: o.from || 'claude',
    project: o.project || (o.cwd ? path.basename(o.cwd) : ''), session: o.session || '', added: new Date().toISOString(), size: s.size || 0, dir: !!s.dir };
  items.push(item);
  write(items);
  return { ok: true, item };
}

// The list, minus anything already gone, with fresh sizes.
function list() {
  const items = read();
  const live = items.filter(i => fs.existsSync(i.path));
  for (const i of live) { const s = sizeOf(i.path); if (s) { i.size = s.size; i.dir = s.dir; i.partial = !!s.partial; } }
  if (live.length !== items.length) write(live.map(({ partial, ...i }) => i));
  return live;
}

// Recycle Bin on Windows, Finder's trash on macOS, gio/trash-put on Linux; a permanent delete only when asked.
function toBin(abs, dir) {
  if (process.platform === 'win32') {
    const lit = abs.replace(/'/g, "''");
    const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${dir ? 'DeleteDirectory' : 'DeleteFile'}('${lit}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return r.status === 0 && !fs.existsSync(abs) ? '' : (r.stderr || r.stdout || 'the Recycle Bin refused it').trim().split('\n')[0];
  }
  if (process.platform === 'darwin') {
    const r = spawnSync('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(abs)}`], { encoding: 'utf8', timeout: 120000 });
    return r.status === 0 ? '' : (r.stderr || 'Finder refused it').trim();
  }
  for (const [cmd, args] of [['gio', ['trash', abs]], ['trash-put', [abs]]]) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000 });
    if (r.status === 0) return '';
  }
  return 'no system trash found (install gio or trash-cli), or use permanent delete';
}

// Deletes the listed items (all when ids is empty). The path is checked again, so a file edited by hand cannot point
// the trash at something it should never touch.
function empty(ids = [], o = {}) {
  const items = read();
  const pick = ids.length ? items.filter(i => ids.includes(i.id)) : items;
  const done = [], failed = [];
  for (const i of pick) {
    if (!fs.existsSync(i.path)) { done.push(i.id); continue; }
    const why = refuse(i.path);
    if (why) { failed.push({ id: i.id, path: i.path, error: why }); continue; }
    let err = '';
    if (o.permanent) { try { fs.rmSync(i.path, { recursive: true, force: true }); } catch (e) { err = e.message; } }
    else err = toBin(i.path, fs.statSync(i.path).isDirectory());
    if (err) failed.push({ id: i.id, path: i.path, error: err }); else done.push(i.id);
  }
  write(read().filter(i => !done.includes(i.id)));
  return { deleted: done.length, failed };
}

// Takes items off the list without deleting them.
function keep(ids = []) {
  const items = read();
  write(items.filter(i => !ids.includes(i.id)));
  return { kept: items.length - read().length };
}

function fmtSize(n) { return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`; }

// How many listed items still exist; cheap enough for the dashboard's regular poll (no folder sizes).
function count() { return read().filter(i => fs.existsSync(i.path)).length; }

module.exports = { add, list, count, empty, keep, refuse, resolvePath, fmtSize, FILE };
