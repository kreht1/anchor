'use strict';
// Headless Claude runs started from Anchor: study a folder, explain a file, find skills on GitHub, build a graphify
// graph, or send a message into a conversation. Each run is `claude -p` with a fixed tool sandbox per kind
// (--tools limits what exists, --permission-mode dontAsk refuses anything not pre-approved). The prompt goes in on
// stdin; the stream-json output is parsed into a live event list and kept in the Anchor data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const P = require('./paths');
const { redact } = require('./redact');

const DIR = path.join(P.DATA, 'runs');
const runs = new Map();
const MAX_LIVE = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SANDBOX = {
  read: { tools: ['Read', 'Glob', 'Grep'], mode: 'dontAsk' },
  web: { tools: ['WebSearch', 'WebFetch', 'Read'], mode: 'dontAsk' },
  edit: { tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], mode: 'acceptEdits' },
  build: { tools: ['Read', 'Glob', 'Grep', 'Write', 'Bash', 'PowerShell', 'Skill'], mode: 'dontAsk' },
  // the Scholar studio: file tools stay inside the project folder; shell commands only for document tooling
  studio: { tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'PowerShell', 'Skill', 'TodoWrite', 'WebSearch', 'WebFetch'], mode: 'dontAsk',
    allow: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Skill', 'TodoWrite', 'WebSearch', 'WebFetch',
      ...['python', 'py', 'python3', 'pip', 'node', 'npx', 'npm', 'ffmpeg', 'ffprobe', 'pdflatex', 'xelatex', 'lualatex', 'latexmk', 'bibtex', 'biber', 'tectonic',
        'soffice', 'magick', 'manim', 'ls', 'dir', 'mkdir', 'cat', 'head', 'tail', 'cp', 'mv', 'echo', 'pwd', 'wc', 'unzip', 'zip']
        .flatMap(c => [`Bash(${c}:*)`, `PowerShell(${c}:*)`])] },
};

function claudeExe() {
  const cands = [];
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  cands.push(path.join(P.HOME, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) if (dir) cands.push(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  for (const c of cands) if (fs.existsSync(c)) return c;
  return process.platform === 'win32' ? null : 'claude';
}

const STUDY = {
  overview: 'Study this workspace and explain what it is about.',
  code: 'Teach me this codebase function by function.',
  architecture: 'Map the architecture of this codebase.',
  onboarding: 'Write an onboarding guide for a new contributor to this workspace.',
};

// What a project already says about itself: context files at its root (and its parent, for sub-folders) plus Claude's
// memory notes for it. Headless runs only see the one-line memory index, so they are told to read these first.
const CONTEXT_FILES = /^(CLAUDE|AGENTS|README|HANDOFF|STATUS|CONTRIBUTING|ARCHITECTURE)\.md$|_STATE\.md$|^STATE\.md$/i;
function projectContext(folder) {
  folder = path.resolve(folder);
  const files = [];
  let dir = folder;
  for (let up = 0; up < 2 && dir; up++) {
    try { for (const f of fs.readdirSync(dir)) if (CONTEXT_FILES.test(f)) files.push(path.join(dir, f)); } catch { /* unreadable */ }
    const parent = path.dirname(dir);
    dir = parent !== dir && parent.toLowerCase() !== P.HOME.toLowerCase() && path.basename(parent).toLowerCase() !== 'desktop' ? parent : null;
  }
  // Claude Code names a project's data folder after its path, with every non-alphanumeric character turned into '-'
  // (for a sub-folder, the memory belongs to the nearest parent that was a project)
  let memory = null;
  try {
    const dirs = fs.readdirSync(P.PROJECTS);
    for (let d = folder, up = 0; !memory && up < 3; up++, d = path.dirname(d)) {
      const slug = d.replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
      const hit = dirs.find(x => x.toLowerCase() === slug);
      if (hit && fs.existsSync(path.join(P.PROJECTS, hit, 'memory'))) memory = path.join(P.PROJECTS, hit, 'memory');
    }
  } catch { /* no projects folder */ }
  if (!files.length && !memory) return { text: '', dirs: [] };
  const list = [...files, ...(memory ? [path.join(memory, '*.md')] : [])].map(f => `- ${f}`).join('\n');
  return { dirs: memory ? [memory] : [], text: `Project context: before anything else, read these (skim long ones; they are the project's own notes
on its purpose, current state and rules, and the memory notes are what Claude has learned about this project). Let them shape
your answer, and say where the code and the notes disagree:\n${list}\n` };
}

function studyPrompt(mode, folder, question, ctx) {
  const common = `You are studying the folder ${folder} for the user. Use only Read, Glob and Grep; do not change anything.
${ctx ? ctx.text : ''}Start with a quick survey (Glob the tree, read README/manifest/config files), then read the files that matter. For a large
folder, prioritise: entry points, core modules, then the rest. ${CHUNK_HINT} Large notebooks (.ipynb): Grep them rather than reading them whole.
Write the final answer as one Markdown document, with
clear headings and short paragraphs, and cite files as \`path/to/file.ext:line\`. Do not invent anything you did not read.`;
  const asks = {
    overview: `Explain what this workspace is about: its purpose, the topic or domain, who it is for, what state it is in
(what works, what is unfinished), the main parts and how they fit, how to run it, and open questions. End with a
"Key terms" glossary of domain words a newcomer must know.`,
    code: `Teach the code so the user can learn it. For each important module: what it is for, then each significant
function, class or component: what it does, why it exists (the problem it solves), its inputs and outputs, what calls it
and what it calls, and any non-obvious decision. Then a section "How the code is structured and why": folder layout,
naming, patterns and conventions, data flow, and the reasons behind them. End with "Read in this order", a reading path
through the codebase for a beginner.`,
    architecture: `Map the architecture: components and their responsibilities, how data and control flow between them
(draw it as a Mermaid flowchart in a \`\`\`mermaid block), external services and dependencies, where state lives,
the build and run pipeline, and the risks or weak spots you noticed.`,
    onboarding: `Write an onboarding guide: setup steps, the 10 files to read first and why, how to make a typical change,
how to test it, the conventions to respect, and common pitfalls.`,
    custom: `Answer this question about the folder: ${question}`,
  };
  return `${common}\n\n${asks[mode] || asks.overview}`;
}

function skillFinderPrompt(task, ctx, folder) {
  return `${ctx && ctx.text ? `The user wants skills for their project in ${folder}. ${ctx.text}
Read those notes first so you understand what the project really does and what work it involves; if the request below is
vague, base the search on the project's actual work (say which needs you inferred).

` : ''}Find Claude Code skills on GitHub that would help with this task: "${task}".
A skill is a folder with a SKILL.md file (YAML frontmatter with name and description, then instructions), used by
Claude Code from ~/.claude/skills or from a plugin. Search the web (good starting points: github.com/anthropics/skills,
"awesome claude skills" lists, "SKILL.md" plus the task's keywords), open the candidate repositories and read their
SKILL.md and any scripts they ship.

Judge safety for each candidate, strictly:
- "safe": instructions only, or small readable scripts with no network calls, no credential or home-folder access,
  no obfuscation; from a known author or a repository with real use.
- "review": ships scripts or calls tools/networks in ways the user should read first.
- "avoid": obfuscated code, downloads and runs code (curl | sh, iex), touches credentials or SSH keys, or asks to
  disable safety settings.
Leave out anything you could not open and read.

Write a short Markdown summary, then end your answer with exactly one fenced \`\`\`json block: an array of up to 10
objects {"name", "repo": "https://github.com/owner/repo", "path": "folder inside the repo containing SKILL.md (\\"\\" for
the root)", "why": "how it helps with the task", "safety": "safe|review|avoid", "notes": "what you checked"}.`;
}

// Claude's Read tool stops at about 25k tokens and reads a notebook whole, so notebooks and files with huge lines get a
// lean copy (cells only, no outputs, long data lines trimmed) in the Anchor data folder; big files get chunk advice.
const LEAN = path.join(P.DATA, 'lean');
function leanCopy(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const isNb = /\.ipynb$/i.test(file);
  const trimLine = l => (l.length > 400 ? `${l.slice(0, 300)} … [${l.length - 300} more characters of data trimmed by Anchor]` : l);
  let text;
  if (isNb) {
    let cells = [];
    try { cells = JSON.parse(raw).cells || []; } catch { return null; }
    text = cells.map((c, i) => `# %% [cell ${i + 1}] ${c.cell_type}\n${[].concat(c.source || []).join('')}`).join('\n\n');
  } else if (raw.split('\n').some(l => l.length > 2000)) text = raw;
  else return null;
  text = text.split('\n').map(trimLine).join('\n');
  fs.mkdirSync(LEAN, { recursive: true });
  const out = path.join(LEAN, crypto.createHash('sha1').update(file).digest('hex').slice(0, 10) + '-' + path.basename(file) + (isNb ? '.py' : '.txt'));
  fs.writeFileSync(out, text);
  return { path: out, lines: text.split('\n').length, notebook: isNb };
}

const CHUNK_HINT = `If a file is too large to read at once, read it in chunks with Read's offset and limit (about 800 lines each),
and use Grep to find the parts that matter first. Never retry a read that already failed.`;

function filePrompt(file, lean, lines) {
  const target = lean ? lean.path : file;
  const about = lean
    ? `It is a large ${lean.notebook ? 'notebook' : 'file with very long lines'}. Read this lean copy made by Anchor instead: ${lean.path}
(${lean.lines} lines; ${lean.notebook ? 'cells are marked "# %% [cell N]", outputs removed, ' : ''}long data lines trimmed). Cite the copy's cells and lines.`
    : `It has ${lines} lines.`;
  return `Explain the file ${file} so the user can learn it. ${about}
${CHUNK_HINT}
Read ${target} (and the files it imports, if needed to explain it). Use only Read, Glob and Grep; change nothing.
In Markdown: what the file is for and where it sits in the project; then each function, class, cell or block: what it
does, why it is written that way, inputs and outputs, edge cases; then how to change it safely. Cite lines as \`L12\`.`;
}

function graphPrompt(folder) {
  return `Run the graphify skill on ${folder} (the /graphify pipeline, default options) so that ${folder}/graphify-out/graph.json
exists when you finish. Follow the skill's own steps. Do not modify any file outside ${folder}/graphify-out. At the end,
say how many nodes, links and communities the graph has.`;
}

function build(spec) {
  const kind = spec.kind;
  const folder = spec.cwd ? path.resolve(String(spec.cwd)) : null;
  if (['study', 'file', 'graph', 'chat', 'new-chat'].includes(kind)) {
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('pick an existing folder');
  }
  switch (kind) {
    case 'study': {
      const mode = (STUDY[spec.mode] || spec.mode === 'custom') ? spec.mode : 'overview';
      if (mode === 'custom' && !String(spec.question || '').trim()) throw new Error('type a question');
      return { kind, cwd: folder, sandbox: 'read', title: spec.mode === 'custom' ? `Question: ${String(spec.question).slice(0, 80)}` : `${STUDY[mode] || STUDY.overview}`,
        mode, prompt: studyPrompt(mode, folder, String(spec.question || '').slice(0, 2000), projectContext(folder)), addDirs: projectContext(folder).dirs, persist: false };
    }
    case 'file': {
      const file = path.resolve(String(spec.file || ''));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('file not found');
      if (fs.statSync(file).size > 20e6) throw new Error('file too large to explain');
      const lean = leanCopy(file);
      const lines = lean ? lean.lines : fs.readFileSync(file, 'utf8').split('\n').length;
      const ctx = projectContext(folder);
      return { kind, cwd: folder, sandbox: 'read', title: `Explain ${path.basename(file)}`, file, prompt: ctx.text + filePrompt(file, lean, lines), addDirs: [...(lean ? [LEAN] : []), ...ctx.dirs], persist: false };
    }
    case 'skills': {
      const task = String(spec.task || '').trim().slice(0, 600);
      if (task.length < 3) throw new Error('describe the task');
      // optional project: Claude reads its notes and memory first (read-only), so "skills for my work" means that work
      const proj = spec.cwd && fs.existsSync(String(spec.cwd)) ? path.resolve(String(spec.cwd)) : null;
      const ctx = proj ? projectContext(proj) : null;
      fs.mkdirSync(P.DATA, { recursive: true });
      return { kind, cwd: proj || P.DATA, sandbox: 'web', title: `Skills for: ${task.slice(0, 80)}${proj ? ` (${path.basename(proj)})` : ''}`, task, project: proj,
        prompt: skillFinderPrompt(task, ctx, proj), addDirs: ctx ? ctx.dirs : [], persist: false };
    }
    case 'graph':
      return { kind, cwd: folder, sandbox: 'build', title: `Build graphify graph of ${path.basename(folder)}`, prompt: graphPrompt(folder), persist: false };
    case 'chat': case 'new-chat': {
      const text = String(spec.text || '').trim().slice(0, 20000);
      if (!text) throw new Error('type a message');
      if (kind === 'chat' && !UUID.test(String(spec.sessionId || ''))) throw new Error('unknown session');
      return { kind, cwd: folder, sandbox: spec.allowEdits ? 'edit' : 'read', title: text.replace(/\s+/g, ' ').slice(0, 90), prompt: text,
        resume: kind === 'chat' ? spec.sessionId : null, persist: true };
    }
    default: throw new Error('unknown run kind');
  }
}

function summarize(name, input) {
  input = input || {};
  const v = input.file_path || input.path || input.pattern || input.query || input.url || input.description || input.command || input.skill || '';
  return redact(String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 200));
}

function onLine(run, line) {
  let d;
  try { d = JSON.parse(line); } catch { if (line.trim()) push(run, 'log', redact(line.slice(0, 400))); return; }
  if (d.type === 'system' && d.subtype === 'init') { run.sessionId = d.session_id; run.modelId = d.model; return; }
  if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
    for (const b of d.message.content) {
      if (b.type === 'text' && b.text.trim()) { push(run, 'text', redact(b.text)); run.text = (run.text ? run.text + '\n\n' : '') + redact(b.text); }
      else if (b.type === 'tool_use') push(run, 'tool', `${b.name} · ${summarize(b.name, b.input)}`, { id: b.id, name: b.name });
    }
    return;
  }
  if (d.type === 'user' && d.message && Array.isArray(d.message.content)) {
    for (const b of d.message.content) if (b.type === 'tool_result' && b.is_error) {
      const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x.text || '').join(' ') : '';
      push(run, 'error', redact(c.slice(0, 300)));
    }
    return;
  }
  if (d.type === 'result') {
    run.result = redact(String(d.result || ''));
    run.cost = d.total_cost_usd ?? null;
    run.turns = d.num_turns ?? null;
    run.isError = !!d.is_error;
  }
}

function push(run, type, text, extra) {
  run.events.push({ i: run.events.length, t: new Date().toISOString(), type, text: String(text).slice(0, 8000), ...(extra || {}) });
  if (run.events.length > 2000) run.events.splice(0, run.events.length - 2000);
  run.updatedAt = new Date().toISOString();
}

function save(run) {
  fs.mkdirSync(DIR, { recursive: true });
  const { proc, ...rest } = run;
  fs.writeFileSync(path.join(DIR, run.id + '.json'), JSON.stringify(rest));
}

function finalText(run) { return run.result || run.text || ''; }

function parseSkills(text) {
  const m = /```json\s*([\s\S]*?)```(?![\s\S]*```json)/.exec(text || '');
  if (!m) return null;
  try {
    const a = JSON.parse(m[1]);
    return Array.isArray(a) ? a.filter(x => x && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(String(x.repo || '').replace(/\.git$/, '')))
      .map(x => ({ name: String(x.name || '').slice(0, 80), repo: String(x.repo).replace(/\.git$|\/$/g, ''), path: String(x.path || '').replace(/^\/+|\/+$/g, ''),
        why: String(x.why || '').slice(0, 400), safety: ['safe', 'review', 'avoid'].includes(x.safety) ? x.safety : 'review', notes: String(x.notes || '').slice(0, 500) })) : null;
  } catch { return null; }
}

function start(spec) { return launch(build(spec), spec); }

// b: a built run (title, cwd, sandbox, prompt, resume, addDirs, persist, onDone); spec carries model and effort
function launch(b, spec) {
  const live = [...runs.values()].filter(r => r.status === 'running').length;
  if (live >= MAX_LIVE) throw new Error(`${MAX_LIVE} Claude runs are already going; wait for one to finish`);
  const exe = claudeExe();
  if (!exe) throw new Error('Claude Code CLI not found');
  const sb = SANDBOX[b.sandbox];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', sb.tools.join(','), '--allowedTools', (sb.allow || sb.tools).join(','),
    '--permission-mode', sb.mode];
  if (b.resume) args.push('--resume', b.resume);
  for (const d of b.addDirs || []) args.push('--add-dir', d);
  if (!b.persist) args.push('--no-session-persistence');
  // Anchor runs default to a lighter model and effort than an interactive session; the page lets you choose
  const model = ['sonnet', 'opus', 'haiku', 'fable'].includes(spec.model) ? spec.model : b.resume ? null : 'sonnet';
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(spec.effort) ? spec.effort : b.resume ? null : 'medium';
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  b.model = model; b.effort = effort;
  const run = { id: crypto.randomBytes(5).toString('hex'), kind: b.kind, project: b.project || null, title: b.title, mode: b.mode || null, cwd: b.cwd, file: b.file || null,
    task: b.task || null, sandbox: b.sandbox, tools: sb.tools, resume: b.resume || null, model: b.model, effort: b.effort, status: 'running', startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), events: [], text: '', result: null, cost: null, sessionId: null };
  const proc = spawn(exe, args, { cwd: b.cwd, windowsHide: true, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'anchor' } });
  run.proc = proc;
  runs.set(run.id, run);
  let buf = '';
  proc.stdout.on('data', c => {
    buf += c.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { onLine(run, buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  });
  let err = '';
  proc.stderr.on('data', c => { err = (err + c.toString('utf8')).slice(-4000); });
  proc.on('error', e => { run.status = 'failed'; push(run, 'error', e.message); save(run); });
  proc.on('close', code => {
    if (buf.trim()) onLine(run, buf);
    if (run.status === 'running') run.status = run.cancelled ? 'stopped' : code === 0 && !run.isError ? 'completed' : 'failed';
    if (code !== 0 && err.trim()) push(run, 'error', redact(err.trim().slice(-1200)));
    run.endedAt = new Date().toISOString();
    if (run.kind === 'skills') run.skills = parseSkills(finalText(run));
    delete run.proc;
    save(run);
    if (b.onDone) { try { b.onDone(run); } catch { /* the caller's bookkeeping */ } }
  });
  proc.stdin.end(b.prompt);
  push(run, 'start', `${b.title} · tools: ${sb.tools.join(', ')} · ${b.cwd}`);
  return view(run, 0);
}

function view(run, from = 0) {
  const { proc, events, ...rest } = run;
  return { ...rest, final: finalText(run), events: events.filter(e => e.i >= from), eventCount: events.length };
}

function loadDisk() {
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (runs.has(id)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        if (r.status === 'running') r.status = 'stopped'; // Anchor restarted while it ran
        runs.set(id, r);
      } catch { /* partial file */ }
    }
  } catch { /* no runs yet */ }
}
let loaded = false;

function list() {
  if (!loaded) { loadDisk(); loaded = true; }
  return [...runs.values()].map(r => { const { proc, events, text, result, ...rest } = r; return { ...rest, preview: finalText(r).slice(0, 300), eventCount: (events || []).length }; })
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function get(id, from) {
  if (!loaded) { loadDisk(); loaded = true; }
  const r = runs.get(id);
  return r ? view(r, Number(from) || 0) : null;
}

function stop(id) {
  const r = runs.get(id);
  if (!r) throw new Error('unknown run');
  if (r.status === 'running' && r.proc) {
    r.cancelled = true;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(r.proc.pid), '/t', '/f'], () => {});
    else r.proc.kill('SIGTERM');
    return { ok: true, stopped: true };
  }
  runs.delete(id);
  try { fs.unlinkSync(path.join(DIR, id + '.json')); } catch { /* never saved */ }
  return { ok: true, deleted: true };
}

module.exports = { start, launch, list, get, stop, parseSkills, claudeExe };
