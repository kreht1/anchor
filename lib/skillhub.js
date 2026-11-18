'use strict';
// Installing a skill from GitHub, in two steps. inspect(): a shallow, sparse clone into a quarantine folder in the
// Anchor data folder (nothing is run), then a static scan of every file for risky patterns. install(): only after the
// user has read it, the chosen folder is copied into ~/.claude/skills. git runs without a shell; URLs are validated.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const P = require('./paths');
const { frontmatter, SAFE_NAME } = require('./skills');

const Q = path.join(P.DATA, 'quarantine');
const REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const SUB = /^[\w.@+ -]+(\/[\w.@+ -]+)*$/;

const RULES = [
  ['danger', 'downloads and runs code', /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(ba|z)?sh\b|\biex\b|Invoke-Expression/i],
  ['danger', 'decodes hidden payloads', /FromBase64String|base64\s+(-d|--decode)|atob\(|\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i],
  ['danger', 'touches credentials or keys', /\.ssh\b|id_rsa|\.aws\/credentials|\.credentials\.json|api[_-]?key\s*=\s*['"][^'"]{12,}|keychain|\bDPAPI\b/i],
  ['danger', 'tries to loosen Claude safety settings', /bypassPermissions|dangerously-?skip-?permissions|--dangerously|disable.{0,20}(sandbox|permission)/i],
  ['danger', 'deletes broadly', /\brm\s+-rf\s+(\/|~|\$HOME|\*)|Remove-Item\s+[^\n]*-Recurse[^\n]*(C:\\|\$env:USERPROFILE|~)/i],
  ['review', 'runs programs', /child_process|subprocess|os\.system|Popen|execSync|spawn\(|Start-Process/],
  ['review', 'talks to the network', /https?:\/\/(?!github\.com|raw\.githubusercontent\.com|docs\.|www\.w3\.org|example\.com)[\w.-]+\.[a-z]{2,}/i],
  ['review', 'uses eval', /\beval\s*\(|new Function\(/],
];
const EXEC_EXT = /\.(exe|dll|so|dylib|bin|msi|scr|bat|cmd|ps1|vbs|jar|pyc)$/i;

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120000, windowsHide: true, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (e, out, err) => (e ? reject(new Error((err || e.message).toString().trim().split('\n').pop())) : resolve(out)));
  });
}

function walk(dir, base = dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '.git') continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, base, out);
    else out.push({ rel: path.relative(base, p).split(path.sep).join('/'), size: fs.statSync(p).size, abs: p });
  }
  return out;
}

function scan(files) {
  const flags = [];
  for (const f of files) {
    if (EXEC_EXT.test(f.rel)) { flags.push({ level: /\.(ps1|bat|cmd|vbs)$/i.test(f.rel) ? 'review' : 'danger', why: 'ships an executable or script file', file: f.rel }); }
    if (f.size > 2e6) { flags.push({ level: 'review', why: 'very large file', file: f.rel }); continue; }
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) { flags.push({ level: 'review', why: 'binary file', file: f.rel }); continue; }
    for (const [level, why, re] of RULES) {
      const m = re.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        flags.push({ level, why, file: f.rel, line, match: text.split('\n')[line - 1].trim().slice(0, 160) });
      }
    }
  }
  return flags;
}

async function inspect(repo, sub) {
  repo = String(repo || '').trim().replace(/\.git$|\/$/g, '');
  sub = String(sub || '').trim().replace(/^\/+|\/+$/g, '');
  if (!REPO.test(repo)) throw new Error('give a GitHub repository URL like https://github.com/owner/repo');
  if (sub && (!SUB.test(sub) || sub.split('/').includes('..'))) throw new Error('unexpected folder path');
  const id = crypto.randomBytes(5).toString('hex');
  const dir = path.join(Q, id);
  fs.mkdirSync(Q, { recursive: true });
  await git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--no-tags', '--', repo + '.git', dir], Q);
  if (sub) await git(['sparse-checkout', 'set', '--no-cone', `/${sub}/`], dir);
  else await git(['sparse-checkout', 'disable'], dir);
  const head = (await git(['rev-parse', 'HEAD'], dir)).trim();
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  const root = sub ? path.join(dir, ...sub.split('/')) : dir;
  if (!fs.existsSync(root)) throw new Error('that folder is not in the repository');
  const files = walk(root);
  const skillDirs = files.filter(f => /(^|\/)SKILL\.md$/.test(f.rel)).slice(0, 30).map(f => {
    const rel = path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel);
    const text = fs.readFileSync(f.abs, 'utf8');
    const fm = frontmatter(text);
    return { rel, name: fm.name || path.posix.basename(rel || sub || repo), description: fm.description || '', skillMd: text.slice(0, 30000) };
  });
  const meta = { id, repo, sub, commit: head, at: new Date().toISOString(), files: files.map(f => ({ rel: f.rel, size: f.size })).slice(0, 500),
    fileCount: files.length, skills: skillDirs, flags: scan(files) };
  fs.writeFileSync(path.join(Q, id + '.json'), JSON.stringify(meta));
  return meta;
}

function readFileIn(id, rel) {
  if (!/^[0-9a-f]{10}$/.test(id)) throw new Error('unknown inspection');
  const meta = JSON.parse(fs.readFileSync(path.join(Q, id + '.json'), 'utf8'));
  const root = path.resolve(Q, id, ...(meta.sub ? meta.sub.split('/') : []));
  const file = path.resolve(root, String(rel || ''));
  if (!file.startsWith(root + path.sep)) throw new Error('outside the inspected folder');
  const st = fs.statSync(file);
  if (st.size > 1e6) throw new Error('file too large to show');
  return { rel, text: fs.readFileSync(file, 'utf8') };
}

// target: 'claude' (default, ~/.claude/skills), 'codex' (ported into ~/.agents/skills) or 'both' (Claude copy, then
// its Codex port, so Anchor's sync keeps the two in step)
function install(id, rel, name, target = 'claude') {
  if (!/^[0-9a-f]{10}$/.test(id)) throw new Error('unknown inspection');
  if (!['claude', 'codex', 'both'].includes(target)) throw new Error('target is claude, codex or both');
  const meta = JSON.parse(fs.readFileSync(path.join(Q, id + '.json'), 'utf8'));
  const sk = meta.skills.find(s => s.rel === String(rel || ''));
  if (!sk) throw new Error('pick one of the skills found in the inspection');
  const folder = String(name || sk.name).trim().replace(/\s+/g, '-');
  if (!SAFE_NAME.test(folder)) throw new Error('skill folder name may use letters, digits, dot, dash and underscore');
  const src = path.resolve(Q, id, ...(meta.sub ? meta.sub.split('/') : []), ...(sk.rel ? sk.rel.split('/') : []));
  const origin = { repo: meta.repo, path: [meta.sub, sk.rel].filter(Boolean).join('/'), commit: meta.commit, installedAt: new Date().toISOString() };
  const out = { ok: true };
  if (target !== 'codex') {
    const dest = path.join(P.CLAUDE, 'skills', folder);
    if (fs.existsSync(dest)) throw new Error(`~/.claude/skills/${folder} already exists`);
    fs.cpSync(src, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, '.anchor-source.json'), JSON.stringify(origin, null, 1));
    out.dest = dest;
  }
  if (target !== 'claude') {
    const skill = { id: folder, name: sk.name, description: sk.description, dir: out.dest || src, source: out.dest ? 'user' : 'github', origin };
    out.codex = require('./skillport').port(skill, { force: true, name: folder });
  }
  return out;
}

function discard(id) {
  if (!/^[0-9a-f]{10}$/.test(id)) throw new Error('unknown inspection');
  fs.rmSync(path.join(Q, id), { recursive: true, force: true });
  fs.rmSync(path.join(Q, id + '.json'), { force: true });
  return { ok: true };
}

module.exports = { inspect, install, discard, readFileIn, scan };
