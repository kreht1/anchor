'use strict';
// Read-only code browsing, limited to the folders Claude Code has worked in (and folders you studied). Secrets-like
// files are never listed or read; text is masked by redact() before it leaves the server.
const fs = require('fs');
const path = require('path');
const T = require('./transcripts');
const kv = require('./kv');
const P = require('./paths');
const { redact } = require('./redact');

const DENY = /(^|[\\/])(\.env(\..*)?|\.ssh|\.aws|\.gnupg|\.credentials\.json|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx|kdbx)|secrets?\.(json|ya?ml|toml))$/i;
const HEAVY = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.venv-gpu', 'dist', 'build', '.next', '.cache', 'graphify-out']);
const LANG = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', py: 'py', json: 'json', css: 'css', html: 'html', htm: 'html', md: 'md',
  sh: 'sh', bash: 'sh', ps1: 'ps', yml: 'yaml', yaml: 'yaml', toml: 'toml', rs: 'rs', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'c', cs: 'cs', dart: 'dart',
  sql: 'sql', ipynb: 'json', txt: 'txt', vue: 'html', svelte: 'html', kt: 'java', swift: 'java', rb: 'py', php: 'js', xml: 'html' };

let rootsCache = null;
function roots() {
  if (rootsCache && Date.now() - rootsCache.at < 20000) return rootsCache.v;
  const set = new Map();
  for (const x of T.allStates()) if (x.st.cwd && fs.existsSync(x.st.cwd)) set.set(path.resolve(x.st.cwd).toLowerCase(), path.resolve(x.st.cwd));
  // folders where Claude edited files (the project folder directly under Desktop, Documents or Downloads)
  const home = P.HOME.toLowerCase();
  for (const x of T.allStates()) for (const f of Object.keys(x.st.files)) {
    const abs = path.resolve(f), low = abs.toLowerCase();
    if (!low.startsWith(home + path.sep) || low.startsWith(P.CLAUDE.toLowerCase()) || low.includes(`${path.sep}appdata${path.sep}`)) continue;
    const parts = abs.slice(P.HOME.length + 1).split(path.sep);
    if (!['desktop', 'documents', 'downloads'].includes(parts[0].toLowerCase()) || parts.length < 3) continue;
    const root = path.join(P.HOME, parts[0], parts[1]);
    if (fs.existsSync(root)) set.set(root.toLowerCase(), root);
  }
  for (const r of kv.read('roots.json', [])) if (fs.existsSync(r)) set.set(path.resolve(r).toLowerCase(), path.resolve(r));
  rootsCache = { at: Date.now(), v: [...set.values()] };
  return rootsCache.v;
}

function addRoot(dir) {
  const d = path.resolve(String(dir || ''));
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error('not a folder');
  const low = d.toLowerCase();
  if (path.parse(d).root.toLowerCase() === low || low === P.HOME.toLowerCase() || low.startsWith(P.CLAUDE.toLowerCase()) || low.startsWith(P.DATA.toLowerCase())) {
    throw new Error('pick a project folder, not a whole drive, your home folder or Claude\'s own data');
  }
  const list = kv.read('roots.json', []);
  if (!list.some(x => x.toLowerCase() === d.toLowerCase())) kv.write('roots.json', [...list, d].slice(-50));
  rootsCache = null;
  return d;
}

function allowed(p) {
  const abs = path.resolve(String(p || ''));
  const low = abs.toLowerCase();
  if (DENY.test(abs)) throw new Error('this file is hidden because it may hold secrets');
  const root = roots().find(r => low === r.toLowerCase() || low.startsWith(r.toLowerCase() + path.sep));
  if (!root) throw new Error('outside the folders Claude has worked in');
  return { abs, root };
}

function list(dir) {
  const { abs, root } = allowed(dir);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter(d => !DENY.test(path.join(abs, d.name)))
    .map(d => {
      const p = path.join(abs, d.name);
      let size = null, mtime = null;
      try { const s = fs.statSync(p); size = s.size; mtime = s.mtimeMs; } catch { /* gone */ }
      return { name: d.name, path: p, dir: d.isDirectory(), heavy: d.isDirectory() && HEAVY.has(d.name), size, mtime };
    })
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: abs, root, parent: abs.toLowerCase() === root.toLowerCase() ? null : path.dirname(abs), entries: entries.slice(0, 2000), more: Math.max(0, entries.length - 2000) };
}

function read(file) {
  const { abs, root } = allowed(file);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (st.size > 1.5e6) return { path: abs, root, size: st.size, tooLarge: true };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { path: abs, root, size: st.size, binary: true };
  let text = buf.toString('utf8');
  if (ext === 'ipynb') {
    try { text = JSON.parse(text).cells.map((c, i) => `# ── cell ${i + 1} (${c.cell_type}) ──\n${[].concat(c.source).join('')}`).join('\n\n'); } catch { /* raw json */ }
  }
  return { path: abs, root, size: st.size, mtime: st.mtimeMs, lang: ext === 'ipynb' ? 'py' : LANG[ext] || 'txt', text: redact(text) };
}

module.exports = { list, read, roots, addRoot, allowed };
