'use strict';
// Anchor Guard: checks every shell command and file write Claude Code is about to make (a PreToolUse hook) and stops
// the ones that destroy work: mass or recursive deletes, wiping a workspace or its git history, emptying the Recycle
// Bin, deleting or overwriting model checkpoints and datasets, formatting disks, rewriting most of a file at once,
// touching paths you protected. Critical rules block; high-risk ones ask you first. Rules and paths are set in Anchor.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { redact } = require('./redact');

const MODEL_EXT = /\.(pt|pth|ckpt|safetensors|onnx|gguf|ggml|h5|hdf5|keras|pb|tflite|mlmodel|pkl|joblib|npz|npy|bin|engine|plan|msgpack)$/i;
const DATA_DIR = /(^|[\\/])(models?|checkpoints?|ckpts?|weights|datasets?|data[\\/](raw|public|processed)|runs|wandb|mlruns|lightning_logs)([\\/]|$)/i;
const SAFE_DIR = /(^|[\\/])(node_modules|dist|build|out|\.next|\.nuxt|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|coverage|\.turbo|\.parcel-cache|tmp|temp|\.tmp|target[\\/]debug)([\\/]?\*?)?$/i;
const WIPE_TARGET = /^(\/|\/\*|~|~\/|~\/\*|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\*|\.\*|\.|\.\/|\.\/\*|\.\.|\.\.\/|[a-z]:[\\/]?\*?|\\\\?|\.git|\.git[\\/]?)$/i;

const RULES = [
  { id: 'wipe', severity: 'critical', title: 'Wiping a drive, home folder or the whole workspace', example: 'rm -rf ., Remove-Item -Recurse C:\\, rm -rf ~' },
  { id: 'git-history', severity: 'critical', title: 'Destroying git history', example: 'rm -rf .git, git filter-branch, git filter-repo' },
  { id: 'models', severity: 'critical', title: 'Deleting, moving away or overwriting model checkpoints and datasets', example: 'rm best.pt, del /s checkpoints, Write over model.safetensors' },
  { id: 'trash', severity: 'critical', title: 'Emptying the Recycle Bin or shredding files', example: 'Clear-RecycleBin, shred, cipher /w' },
  { id: 'disk', severity: 'critical', title: 'Formatting disks, partitions, shutdown', example: 'format D:, diskpart, mkfs, dd of=/dev/sda, shutdown' },
  { id: 'protected', severity: 'critical', title: 'Changing or deleting a path you protected', example: 'anything under a protected path' },
  { id: 'recursive', severity: 'high', title: 'Recursive delete of a folder', example: 'rm -rf src, rmdir /s docs, Remove-Item -Recurse lib' },
  { id: 'mass', severity: 'high', title: 'Deleting many files at once', example: 'rm *.py, find . -delete, xargs rm, del *.*' },
  { id: 'git-discard', severity: 'high', title: 'Discarding uncommitted work or rewriting the remote', example: 'git reset --hard, git clean -fd, git checkout -- ., git push --force' },
  { id: 'scaffold', severity: 'high', title: 'Scaffolding a new project over this one', example: 'npx create-next-app . , degit --force, cookiecutter -f' },
  { id: 'rewrite', severity: 'high', title: 'Replacing most of an existing file in one write', example: 'Write a 200-byte file over a 30 KB one; Edit removing a large block' },
  { id: 'code-delete', severity: 'high', title: 'Deleting files from inside a script', example: 'python -c "shutil.rmtree(...)", node -e "fs.rmSync(...)"' },
];

const DEFAULTS = { enabled: true, rules: {}, protected: [] };
function settings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(P.DATA, 'guard.json'), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  fs.mkdirSync(P.DATA, { recursive: true });
  const clean = { enabled: s.enabled !== false, rules: {}, protected: (s.protected || []).map(String).map(x => x.trim()).filter(Boolean).slice(0, 200) };
  for (const r of RULES) { const m = (s.rules || {})[r.id]; if (['block', 'ask', 'allow'].includes(m)) clean.rules[r.id] = m; }
  fs.writeFileSync(path.join(P.DATA, 'guard.json'), JSON.stringify(clean, null, 1));
  return clean;
}
const modeOf = (s, id) => s.rules[id] || (RULES.find(r => r.id === id).severity === 'critical' ? 'block' : 'ask');

// ---------------------------------------------------------------- helpers
function globRe(gl) {
  const g = gl.replace(/\\/g, '/').replace(/\/+$/, '');
  const re = g.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}(/.*)?$`, 'i');
}
const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
function isProtected(abs, s) {
  const a = norm(abs);
  return (s.protected || []).some(gl => { const n = norm(gl); return globRe(n).test(a) || a.toLowerCase() === n.toLowerCase(); });
}
function resolve(p, cwd) {
  let x = String(p || '').replace(/^["']|["']$/g, '');
  if (!x) return '';
  x = x.replace(/^~(?=$|[\\/])/, P.HOME).replace(/^\$HOME|^\$\{HOME\}|^%USERPROFILE%|^\$env:USERPROFILE/i, P.HOME);
  if (process.platform === 'win32' && /^\/[a-z]\//i.test(x)) x = x[1] + ':' + x.slice(2); // git-bash style /c/...
  return path.resolve(cwd || process.cwd(), x);
}
// split a shell line into simple commands (good enough for the patterns we care about)
// wrappers that run another command: judge the command they wrap
const WRAP = /^(?:(?:sudo|doas|nohup|time|nice|ionice|exec|command|builtin|env|&)(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+|[A-Za-z_][\w]*=\S*\s+)+/;
// heredoc bodies are input for the program reading them (python, cat > file …), not shell commands: drop them, unless
// that program is itself a shell, whose body is checked like any other command
const SHELLS = /(^|[\s|;&(])(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|wsl|ssh|sudo)(\.exe)?(\s|$)/i;
function stripHeredocs(s) {
  const lines = s.split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(lines[i]);
    if (!m || SHELLS.test(lines[i].slice(0, m.index))) continue;
    const end = m[1] ? new RegExp(`^\\t*${m[3]}\\s*$`) : new RegExp(`^${m[3]}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !end.test(lines[j])) j++;
    i = j;  // skip the body and the terminator
  }
  return out.join('\n');
}
// split on && || ; | and newlines, but not inside quotes
function split(cmd) {
  const s = stripHeredocs(String(cmd)).replace(/\\\r?\n/g, ' ');
  const parts = [];
  let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q && s[i - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '\r') { parts.push(cur); cur = ''; continue; }
    if ((ch === '&' && s[i + 1] === '&') || (ch === '|' && s[i + 1] === '|')) { parts.push(cur); cur = ''; i++; continue; }
    if (ch === '|') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim().replace(WRAP, '')).filter(Boolean);
}
function words(c) { return (c.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(w => w.replace(/^["']|["']$/g, '')); }

function hit(rule, why) { return { rule, why }; }

// ---------------------------------------------------------------- shell analysis
function analyseCommand(c, cwd, s) {
  const out = [];
  const w = words(c);
  const head = (w[0] || '').toLowerCase().replace(/\.exe$/, '');
  const low = c.toLowerCase();

  // disk, power and trash
  if (/^(format|diskpart|mkfs(\.\w+)?|fdisk|wipefs|vssadmin|wbadmin)$/.test(head) || /\bdd\b.*\bof=\/dev\//.test(low)) out.push(hit('disk', 'disk or partition tool'));
  if (/^(shutdown|reboot|poweroff|halt)$/.test(head) || /\b(restart|stop)-computer\b/.test(low)) out.push(hit('disk', 'shuts the machine down'));
  if (/\bclear-recyclebin\b/.test(low) || /^(shred|srm)$/.test(head) || /\bcipher\b.*\/w/.test(low) || /\$recycle\.bin/.test(low)) out.push(hit('trash', 'permanently destroys deleted files'));

  // git
  if (head === 'git') {
    const sub = (w[1] || '').toLowerCase();
    if (/^(filter-branch|filter-repo)$/.test(sub)) out.push(hit('git-history', `git ${sub} rewrites history`));
    if (sub === 'reset' && /--hard/.test(low)) out.push(hit('git-discard', 'git reset --hard discards uncommitted work'));
    if (sub === 'clean' && /\s-\w*f/.test(low)) out.push(hit('git-discard', 'git clean deletes untracked files'));
    if ((sub === 'checkout' || sub === 'restore') && /\s(--\s+)?\.(\s|$)/.test(c + ' ')) out.push(hit('git-discard', `git ${sub} . discards changes`));
    if (sub === 'push' && /\s(--force|-f|--force-with-lease|--mirror)\b|\s\+\w/.test(c)) out.push(hit('git-discard', 'force push rewrites the remote'));
    if (sub === 'branch' && /\s-D\b/.test(c)) out.push(hit('git-discard', 'git branch -D deletes an unmerged branch'));
    if (sub === 'stash' && /\b(clear|drop)\b/.test(low)) out.push(hit('git-discard', 'drops stashed work'));
    if ((sub === 'reflog' && /expire/.test(low)) || (sub === 'gc' && /--prune=now/.test(low))) out.push(hit('git-history', 'erases recovery points'));
    if (sub === 'rm' && /\s-\w*r/.test(low)) out.push(hit('recursive', 'git rm -r removes a folder'));
  }

  // scaffolding over an existing project
  if (/\b(create-[\w-]+|create\s+[\w-]+|degit|cookiecutter|rails\s+new|django-admin\s+startproject|cargo\s+init|flutter\s+create)\b/.test(low) && (/\s\.(\s|$)/.test(c + ' ') || /--force|\s-f\b|--overwrite/.test(low))) {
    out.push(hit('scaffold', 'creates a new project in the current folder'));
  }

  // deletes: rm, del, rmdir, Remove-Item, find -delete, xargs rm, mv to /dev/null
  const isRm = /^(rm|unlink|del|erase|rd|rmdir|remove-item|ri|rimraf|trash|trash-put)$/.test(head) || (head === 'npx' && /^(rimraf|del-cli|trash-cli)$/.test((w[1] || '').toLowerCase()));
  const recursive = isRm && (/\s-\w*[rR]\w*\b|\s--recursive\b|\s-recurse\b|\s\/s\b/i.test(c) || head === 'rimraf' || (head === 'npx'));
  const findDelete = head === 'find' && /\s(-delete\b|-exec\s+rm\b)/.test(low);
  const xargsRm = head === 'xargs' && /\brm\b|\bdel\b|remove-item/.test(low);
  const toNull = /^(mv|move|move-item)$/.test(head) && /\s(\/dev\/null|nul)\s*$/i.test(c);
  if (findDelete) {
    // the path is only where find starts; a filter makes it a targeted delete, no filter deletes everything below
    const filtered = /\s-(i?name|i?path|i?regex|newer|mtime|mmin|size|empty|type\s+f)\b/.test(low);
    if (MODEL_EXT.test(c) || DATA_DIR.test(c)) out.push(hit('models', 'find … -delete on models or data'));
    else out.push(filtered ? hit('mass', 'find … -delete removes every match') : hit('wipe', 'find … -delete with no filter removes everything below'));
  } else if (isRm || xargsRm || toNull) {
    const targets = w.slice(head === 'npx' ? 2 : 1).filter(x => x && !/^-/.test(x) && !/^\/[a-z]$/i.test(x) && !/^(-?recurse|-?force|-?confirm(:\$false)?|-literalpath|-path)$/i.test(x));
    for (const t of targets.length ? targets : ['.']) {
      const abs = resolve(t, cwd);
      if (WIPE_TARGET.test(t) || abs === path.parse(abs).root || abs.toLowerCase() === P.HOME.toLowerCase() || (cwd && abs.toLowerCase() === path.resolve(cwd).toLowerCase())) {
        if (recursive || /\*/.test(t) || findDelete) out.push(hit(/\.git/i.test(t) ? 'git-history' : 'wipe', `deletes ${t === '.' ? 'the whole workspace' : t}`));
        continue;
      }
      if (/(^|[\\/])\.git([\\/]|$)/i.test(t)) { out.push(hit('git-history', 'deletes the .git folder')); continue; }
      if (isProtected(abs, s)) { out.push(hit('protected', `${t} is protected`)); continue; }
      if (MODEL_EXT.test(t) || DATA_DIR.test(t) || DATA_DIR.test(norm(abs))) { out.push(hit('models', `${t} looks like a model or dataset`)); continue; }
      if (SAFE_DIR.test(t)) continue; // build output and caches are fine to delete
      if (recursive || findDelete) out.push(hit('recursive', `recursively deletes ${t}`));
      else if (/[*?]/.test(t) || xargsRm) out.push(hit('mass', `deletes everything matching ${t}`));
      else if (toNull) out.push(hit('mass', `moves ${t} into nothing`));
    }
    if (findDelete && !out.length) out.push(hit('mass', 'find … -delete removes every match'));
  }

  // moving models or protected paths away
  if (/^(mv|move|move-item|ren|rename|rename-item)$/.test(head)) {
    for (const t of w.slice(1, -1).filter(x => !/^-/.test(x))) {
      if (MODEL_EXT.test(t)) out.push(hit('models', `moves the model file ${t}`));
      else if (isProtected(resolve(t, cwd), s)) out.push(hit('protected', `${t} is protected`));
    }
  }

  // truncating an existing file with a redirect
  const redir = /(?:^|[^>2&])>\s*([^\s>|&;]+)\s*$/.exec(c) || /\bout-file\s+(?:-filepath\s+)?([^\s|;]+)/i.exec(c) || /\bset-content\s+(?:-path\s+)?([^\s|;]+)/i.exec(c);
  if (redir) {
    const abs = resolve(redir[1], cwd);
    if (MODEL_EXT.test(abs)) out.push(hit('models', `overwrites the model file ${redir[1]}`));
    else if (isProtected(abs, s)) out.push(hit('protected', `${redir[1]} is protected`));
  }

  // deleting from inside a script
  if (/^(python\d?|py|node|deno|bun|ruby|perl)$/.test(head) && /\s(-c|-e|--eval)\s/.test(c)) {
    if (/shutil\.rmtree|os\.(remove|unlink|rmdir|removedirs)\b|\.(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rmtree)\s*\(|send2trash|rimraf|FileUtils\.rm/i.test(c)) {
      const modelish = /\.(pt|pth|ckpt|safetensors|onnx|gguf|h5|keras|npz|pkl|bin)\b|\b(models?|checkpoints?|ckpts?|weights|datasets?)\b/i.test(c);
      out.push(hit(modelish ? 'models' : 'code-delete', 'deletes files from an inline script'));
    }
  }
  return out;
}

// ---------------------------------------------------------------- file tools
function analyseFileTool(tool, inp, cwd, s) {
  const out = [];
  const fp = inp.file_path || inp.notebook_path || inp.path;
  if (!fp) return out;
  const abs = resolve(fp, cwd);
  if (isProtected(abs, s)) out.push(hit('protected', `${fp} is protected`));
  if (MODEL_EXT.test(abs) && /\.(pt|pth|ckpt|safetensors|onnx|gguf|h5|keras|pb|tflite|bin|npz|npy)$/i.test(abs)) out.push(hit('models', `${tool} would overwrite the model file ${path.basename(abs)}`));
  if (tool === 'Write') {
    try {
      const st = fs.statSync(abs);
      const next = Buffer.byteLength(String(inp.content || ''));
      if (st.isFile() && st.size >= 4096 && next < st.size * 0.3) out.push(hit('rewrite', `replaces ${path.basename(abs)} (${Math.round(st.size / 1024)} KB) with ${Math.round(next / 1024 * 10) / 10} KB`));
    } catch { /* a new file */ }
  }
  if (tool === 'Edit' || tool === 'MultiEdit') {
    const edits = tool === 'MultiEdit' ? inp.edits || [] : [inp];
    const removed = edits.reduce((a, e) => a + Math.max(0, String(e.old_string || '').length - String(e.new_string || '').length), 0);
    if (removed > 6000) out.push(hit('rewrite', `removes about ${Math.round(removed / 1000)} KB of ${path.basename(abs)} in one edit`));
  }
  return out;
}

// ---------------------------------------------------------------- the decision
function evaluate(input, s = settings()) {
  if (!s.enabled) return { decision: 'allow' };
  const tool = input.tool_name || '';
  const inp = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  let hits = [];
  if (tool === 'Bash' || tool === 'PowerShell') for (const c of split(inp.command || '')) hits.push(...analyseCommand(c, cwd, s));
  else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) hits = analyseFileTool(tool, inp, cwd, s);
  if (!hits.length) return { decision: 'allow' };
  const rank = { block: 2, ask: 1, allow: 0 };
  let best = null;
  for (const h of hits) { const m = modeOf(s, h.rule); if (!best || rank[m] > rank[best.mode]) best = { ...h, mode: m }; }
  if (best.mode === 'allow') return { decision: 'allow', rule: best.rule };
  const rule = RULES.find(r => r.id === best.rule);
  return { decision: best.mode === 'block' ? 'deny' : 'ask', rule: best.rule, severity: rule.severity, title: rule.title, why: best.why };
}

function reason(r) {
  return r.decision === 'deny'
    ? `Anchor Guard blocked this: ${r.title.toLowerCase()} (${r.why}). Do not try to get around it with another command or tool. If the user really wants this, tell them exactly what you were going to run so they can do it themselves, or ask them to change the "${r.rule}" rule in Anchor → Guard.`
    : `Anchor Guard: ${r.title.toLowerCase()} (${r.why}). Confirm this is intended.`;
}

function log(input, r) {
  try {
    const line = { t: new Date().toISOString(), decision: r.decision, rule: r.rule, why: r.why, tool: input.tool_name, cwd: input.cwd, session: input.session_id,
      what: redact(String((input.tool_input || {}).command || (input.tool_input || {}).file_path || '').slice(0, 400)) };
    fs.mkdirSync(P.DATA, { recursive: true });
    fs.appendFileSync(path.join(P.DATA, 'guard-log.jsonl'), JSON.stringify(line) + '\n');
  } catch { /* logging must never break a session */ }
}

function recent(n = 200) {
  try {
    const lines = fs.readFileSync(path.join(P.DATA, 'guard-log.jsonl'), 'utf8').trim().split('\n').slice(-n);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

module.exports = { evaluate, reason, log, recent, settings, saveSettings, RULES };
