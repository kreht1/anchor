'use strict';
// Reads Claude Code's own session transcripts (~/.claude/projects/<project>/<session>.jsonl) incrementally:
// each refresh parses only the bytes appended since the last one, so huge transcripts stay cheap to follow.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { redact } = require('./redact');

const states = new Map(); // transcript file -> parse state
const DOWNLOAD_RE = /\b(pip|uv)\s+(pip\s+)?install|\bnpm\s+(i|install|ci)\b|\byarn\b|\bpnpm\s+(i|install|add)|\bcurl\b|\bwget\b|\bgit\s+clone|\bkaggle\s+(datasets|competitions)\s+download|urlretrieve|\bhuggingface-cli\s+download|\bhf\s+download|\baria2c\b|\bInvoke-WebRequest\b|\bStart-BitsTransfer\b|\bsnapshot_download\b|\bfrom_pretrained\b/i;
const MAX_SEARCH = 6000;

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

function stripNoise(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_(?:selection|opened_file)>[\s\S]*?<\/ide_(?:selection|opened_file)>/g, '')
    .replace(/<command-(?:message|args)>[\s\S]*?<\/command-(?:message|args)>/g, '')
    .replace(/<local-command-(?:stdout|stderr|caveat)>[\s\S]*?<\/local-command-(?:stdout|stderr|caveat)>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .trim();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

function isHuman(d, text) {
  if (d.isMeta || d.isCompactSummary || d.toolUseResult) return false;
  if (d.origin && d.origin.kind) return d.origin.kind === 'human';
  if (/^\s*<(task-notification|agent-message)/.test(text)) return false;
  return Array.isArray(d.message.content) ? d.message.content.some(b => b.type === 'text') : typeof d.message.content === 'string';
}

function toolSummary(name, input) {
  input = input || {};
  const pick = input.description || input.file_path || input.path || input.pattern || input.query || input.url ||
    input.prompt || input.skill || input.task_id || input.subject || input.command || '';
  let s = typeof pick === 'string' ? pick : JSON.stringify(pick);
  if (name === 'Bash' || name === 'PowerShell') s = input.description || input.command || '';
  return clip(redact(String(s).replace(/\s+/g, ' ')), 220);
}

function newState(file, slug) {
  return {
    file, slug, offset: 0, rest: Buffer.alloc(0), mtimeMs: 0,
    id: path.basename(file, '.jsonl'), cwd: null, entrypoint: null, version: null,
    aiTitle: null, firstPrompt: null, firstTs: null, lastTs: null,
    prompts: 0, lastPrompt: null, lastPromptTs: null, lastClaude: null, lastClaudeTs: null,
    model: null, cost: null, errors: 0, lastError: null, compactions: 0, toolCalls: 0, toolCounts: {},
    tasks: new Map(), pending: new Map(), todos: [], taskList: new Map(), plans: [], artifacts: new Map(),
    search: [], skills: {}, files: {}, days: {}, ts: null,
  };
}

function upsertTask(st, id, patch) {
  if (!id) return;
  const t = st.tasks.get(id) || { id, kind: 'shell', status: 'running', sessionId: st.id };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null) t[k] = v;
  if (!t.startedAt && st.ts) t.startedAt = st.ts; // first time the transcript mentions it
  if (!t.outputFile && t.kind === 'shell') t.outputFile = path.join(P.TEMP, st.slug, st.id, 'tasks', id + '.output');
  t.download = DOWNLOAD_RE.test((t.command || '') + ' ' + (t.description || ''));
  st.tasks.set(id, t);
}

function scanNotifications(st, text, ts) {
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const get = tag => { const x = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body); return x ? x[1].trim() : undefined; };
    const id = get('task-id');
    const summary = get('summary') || '';
    // monitor events carry no <status>; their last notice says the watch expired or its source ended
    let status = get('status');
    if (!status && /Monitor (expired|stopped|ended)|source (ended|exited|closed)|stream ended/i.test(get('event') || '')) status = 'completed';
    upsertTask(st, id, { status, summary: clip(redact(summary), 300), outputFile: get('output-file'),
      kind: /^Monitor\b/.test(summary) ? 'monitor' : undefined, endedAt: status && status !== 'running' ? ts : undefined });
  }
}

function pushSearch(st, ts, role, text) {
  if (!text) return;
  st.search.push({ ts, role, text: clip(text, 4000) });
  if (st.search.length > MAX_SEARCH) st.search.splice(0, st.search.length - MAX_SEARCH);
}

function handleAssistant(st, d) {
  const m = d.message;
  if (!m || !Array.isArray(m.content)) return;
  if (m.model && m.model !== '<synthetic>') st.model = m.model;
  if (d.isApiErrorMessage) { st.errors++; st.lastError = { ts: d.timestamp, text: clip(textOf(m.content), 300) }; return; }
  for (const b of m.content) {
    if (b.type === 'text' && b.text && b.text.trim()) {
      st.lastClaude = clip(redact(b.text.trim()), 1500);
      st.lastClaudeTs = d.timestamp;
      pushSearch(st, d.timestamp, 'claude', redact(b.text));
    } else if (b.type === 'tool_use') {
      const inp = b.input || {};
      st.toolCalls++;
      st.toolCounts[b.name] = (st.toolCounts[b.name] || 0) + 1;
      if ((b.name === 'Bash' || b.name === 'PowerShell' || b.name === 'Monitor') && (inp.run_in_background || b.name === 'Monitor')) {
        st.pending.set(b.id, { kind: b.name === 'Monitor' ? 'monitor' : 'shell', description: inp.description,
          command: clip(redact(inp.command || ''), 600), startedAt: d.timestamp });
      } else if (b.name === 'Bash' || b.name === 'PowerShell') {
        st.pending.set(b.id, { kind: 'shell', fg: true, description: inp.description,
          command: clip(redact(inp.command || ''), 600), startedAt: d.timestamp });
      } else if (b.name === 'Agent' || b.name === 'Task') {
        st.pending.set(b.id, { kind: 'agent', description: inp.description, agentType: inp.subagent_type, startedAt: d.timestamp });
      } else if (b.name === 'TodoWrite' && Array.isArray(inp.todos)) {
        st.todos = inp.todos.map(t => ({ content: redact(t.content), status: t.status, activeForm: t.activeForm }));
      } else if (b.name === 'TaskCreate') {
        st.pending.set(b.id, { kind: 'todo', subject: inp.subject, description: inp.description });
      } else if (b.name === 'TaskUpdate' && inp.taskId) {
        const t = st.taskList.get(String(inp.taskId)) || { id: String(inp.taskId), subject: inp.subject || `Task ${inp.taskId}` };
        if (inp.status) t.status = inp.status;
        if (inp.subject) t.subject = inp.subject;
        if (t.status === 'deleted') st.taskList.delete(t.id); else st.taskList.set(t.id, t);
      } else if (b.name === 'ExitPlanMode' && inp.plan) {
        st.plans.push({ ts: d.timestamp, plan: clip(redact(inp.plan), 20000) });
      } else if (b.name === 'Skill' && inp.skill) {
        st.pending.set(b.id, { kind: 'skill', skill: String(inp.skill), ts: d.timestamp });
      } else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && (inp.file_path || inp.notebook_path)) {
        const fp = String(inp.file_path || inp.notebook_path);
        const f = st.files[fp] || (st.files[fp] = { edits: 0, writes: 0, last: null });
        if (b.name === 'Write') f.writes++; else f.edits++;
        f.last = d.timestamp;
      } else if (b.name === 'TaskStop' || b.name === 'KillShell') {
        const id = inp.task_id || inp.shell_id;
        if (id && st.tasks.has(id)) upsertTask(st, id, { status: 'stopped', endedAt: d.timestamp });
      }
    }
  }
}

function handleUser(st, d) {
  const m = d.message;
  if (!m) return;
  const raw = textOf(m.content);
  if (raw.includes('<task-notification>')) scanNotifications(st, raw, d.timestamp);
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const p = st.pending.get(b.tool_use_id);
      if (!p) continue;
      st.pending.delete(b.tool_use_id);
      const r = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : {};
      if (p.kind === 'todo') {
        const id = (r.task && r.task.id) || (/#(\d+)/.exec(resultText(b)) || [])[1];
        if (id) st.taskList.set(String(id), { id: String(id), subject: redact(p.subject || ''), description: clip(redact(p.description || ''), 400), status: 'pending' });
      } else if (p.kind === 'agent') {
        const id = r.agentId;
        if (id) upsertTask(st, id, { kind: 'agent', description: p.description, agentType: p.agentType || r.agentType,
          startedAt: p.startedAt, status: r.isAsync ? 'running' : 'completed', endedAt: r.isAsync ? undefined : d.timestamp,
          outputFile: r.outputFile });
      } else if (p.kind === 'skill') {
        noteSkill(st, p.skill, !!b.is_error, p.ts);
      } else if (r.backgroundTaskId) {
        upsertTask(st, r.backgroundTaskId, { kind: p.kind, description: p.description, command: p.command, startedAt: p.startedAt,
          status: 'running', movedToBackground: !!(p.fg || r.timedOutAfterMs) });
      } else if (p.kind === 'monitor') {
        const id = r.taskId || (/\b(?:task|ID|id)[:\s]+([a-z0-9]{6,})/.exec(resultText(b)) || [])[1];
        const exp = r.timeoutMs && !r.persistent ? new Date(Date.parse(p.startedAt) + r.timeoutMs + 60e3).toISOString() : undefined;
        if (id) upsertTask(st, id, { kind: 'monitor', description: p.description, startedAt: p.startedAt, status: 'running', expiresAt: exp });
      }
      if (r.url && /claude\.ai\//.test(r.url)) st.artifacts.set(r.url, { url: r.url, title: r.title || r.url, ts: d.timestamp });
    }
  }
  const slash = /<command-name>\/?([\w:.-]+)<\/command-name>/.exec(raw);
  if (slash && isHuman(d, raw)) noteSkill(st, slash[1], false, d.timestamp, true);
  const text = stripNoise(raw);
  if (!text || !isHuman(d, raw)) return;
  st.prompts++;
  if (d.timestamp) { const day = String(d.timestamp).slice(0, 10); st.days[day] = (st.days[day] || 0) + 1; }
  if (!st.firstPrompt) st.firstPrompt = clip(redact(text.replace(/\s+/g, ' ')), 160);
  st.lastPrompt = clip(redact(text), 1200);
  st.lastPromptTs = d.timestamp;
  pushSearch(st, d.timestamp, 'you', redact(text));
}

function noteSkill(st, name, err, ts, byYou) {
  const k = st.skills[name] || (st.skills[name] = { uses: 0, errors: 0, byYou: 0, last: null, lastError: null, days: {} });
  k.uses++;
  const day = String(ts || '').slice(0, 10);
  if (day) k.days[day] = (k.days[day] || 0) + 1;  // the Skills ledger's activity strip
  if (err) { k.errors++; k.lastError = ts; }
  if (byYou) k.byYou++;
  if (!k.last || ts > k.last) k.last = ts;
}

function processRecord(st, d) {
  if (d.timestamp) st.ts = d.timestamp;
  if (d.timestamp) {
    if (!st.firstTs) st.firstTs = d.timestamp;
    if (!st.lastTs || d.timestamp > st.lastTs) st.lastTs = d.timestamp;
  }
  if (d.cwd) st.cwd = d.cwd;
  if (d.entrypoint) st.entrypoint = d.entrypoint;
  if (d.version) st.version = d.version;
  if (d.isSidechain) return;
  switch (d.type) {
    case 'ai-title': if (d.aiTitle) st.aiTitle = d.aiTitle; break;
    case 'summary': if (d.summary && !st.aiTitle) st.aiTitle = d.summary; break;
    case 'custom-title': if (d.customTitle) st.customTitle = d.customTitle; break;
    case 'cost-state': if (typeof d.totalCostUSD === 'number') st.cost = d.totalCostUSD; break;
    case 'frame-link':
      if (d.frameUrl) st.artifacts.set(d.frameUrl, { url: d.frameUrl, title: d.title || d.frameUrl, ts: d.timestamp });
      break;
    case 'system':
      if (d.subtype === 'api_error') {
        st.errors++;
        st.lastError = { ts: d.timestamp, text: clip((d.error && (d.error.formatted || d.error.message)) || 'API error', 300) };
      } else if (d.subtype === 'compact_boundary') st.compactions++;
      break;
    case 'queue-operation':
      if (d.operation === 'enqueue' && typeof d.content === 'string' && d.content.includes('<task-notification>')) scanNotifications(st, d.content, d.timestamp);
      break;
    case 'attachment': {
      const a = d.attachment;
      if (a && a.type === 'task_status' && a.taskId) {
        upsertTask(st, a.taskId, { kind: a.taskType === 'local_bash' ? 'shell' : a.taskType, description: a.description,
          status: a.status, outputFile: a.outputFilePath, command: a.shell && clip(redact(a.shell.command || ''), 600) });
      }
      break;
    }
    case 'user': handleUser(st, d); break;
    case 'assistant': handleAssistant(st, d); break;
  }
}

function forEachLine(buf, fn) {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(10, start);
    if (nl < 0) return buf.subarray(start);
    if (nl > start) fn(buf.subarray(start, nl));
    start = nl + 1;
  }
}

function update(st) {
  let stat;
  try { stat = fs.statSync(st.file); } catch { return false; }
  if (stat.size < st.offset) Object.assign(st, newState(st.file, st.slug)); // rewritten: start over
  if (stat.size === st.offset) return false;
  const fd = fs.openSync(st.file, 'r');
  try {
    const CHUNK = 8 << 20;
    while (st.offset < stat.size) {
      const n = Math.min(CHUNK, stat.size - st.offset);
      const buf = Buffer.allocUnsafe(n);
      const got = fs.readSync(fd, buf, 0, n, st.offset);
      st.offset += got;
      const joined = st.rest.length ? Buffer.concat([st.rest, buf.subarray(0, got)]) : buf.subarray(0, got);
      st.rest = Buffer.from(forEachLine(joined, line => {
        let d;
        try { d = JSON.parse(line.toString('utf8')); } catch { return; }
        try { processRecord(st, d); } catch { /* one odd record never stops the index */ }
      }));
      if (got === 0) break;
    }
  } finally { fs.closeSync(fd); }
  st.mtimeMs = stat.mtimeMs;
  return true;
}

function subagents(st) {
  const dir = path.join(path.dirname(st.file), st.id, 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.meta.json')); } catch { return; }
  for (const n of names) {
    const id = n.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const jsonl = path.join(dir, n.replace('.meta.json', '.jsonl'));
      const s = fs.statSync(jsonl);
      const prev = st.tasks.get(id) || {};
      upsertTask(st, id, { kind: 'agent', description: meta.description || prev.description, agentType: meta.agentType,
        status: meta.finished ? (prev.status === 'failed' ? 'failed' : 'completed') : (prev.status || 'running'),
        transcript: jsonl, lastActivity: new Date(s.mtimeMs).toISOString(), startedAt: prev.startedAt || new Date(s.birthtimeMs).toISOString() });
    } catch { /* agent still being written */ }
  }
}

function refreshAll() {
  let dirs = [];
  try { dirs = fs.readdirSync(P.PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(P.PROJECTS, d.name)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(P.PROJECTS, d.name, f);
      let st = states.get(file);
      if (!st) { st = newState(file, d.name); states.set(file, st); }
      if (update(st)) subagents(st);
    }
  }
}

function liveSessions() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(P.SESSIONS).filter(f => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(P.SESSIONS, f), 'utf8'));
      let alive = false;
      try { process.kill(s.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (!alive || !s.sessionId) continue;
      // only non-secret fields are kept
      out.set(s.sessionId, { pid: s.pid, name: s.name, status: s.status, kind: s.kind, entrypoint: s.entrypoint,
        cwd: s.cwd, startedAt: s.startedAt, updatedAt: s.updatedAt || s.statusUpdatedAt, version: s.version });
    } catch { /* session file mid-write */ }
  }
  return out;
}

function projectName(st) {
  if (st.cwd) return path.basename(st.cwd.replace(/[\\/]+$/, '')) || st.cwd;
  return st.slug.replace(/^[a-zA-Z]--Users-[^-]+(-\d+)?-(Desktop-|Downloads-)?/, '') || st.slug;
}

function readTail(file, bytes) {
  try {
    const s = fs.statSync(file);
    const n = Math.min(bytes, s.size);
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, s.size - n); } finally { fs.closeSync(fd); }
    return { size: s.size, mtime: new Date(s.mtimeMs).toISOString(), text: redact(buf.toString('utf8')), truncated: s.size > n };
  } catch { return null; }
}

function progressOf(text) {
  if (!text) return null;
  const lines = text.replace(/\r(?!\n)/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    const l = lines[i];
    const pct = [...l.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)].map(x => Number(x[1])).filter(x => x <= 100).pop();
    if (pct !== undefined) return { pct, line: clip(last, 200) };
    const frac = [...l.matchAll(/\b(\d{1,7})\s?\/\s?(\d{1,7})\b/g)].map(x => [Number(x[1]), Number(x[2])]).filter(([a, b]) => b > 0 && a <= b).pop();
    if (frac) return { pct: Math.round((frac[0] / frac[1]) * 1000) / 10, line: clip(last, 200) };
  }
  return last ? { pct: null, line: clip(last, 200) } : null;
}

// Background shells and agents die with the Claude process that started them, so a task still marked running is
// really running only if its session is live and it started after that process did.
function liveStatus(t, live) {
  if (t.status === 'ended?') return 'ended';
  if (t.status !== 'running') return t.status;
  if (t.expiresAt && Date.now() > Date.parse(t.expiresAt)) return 'completed'; // a monitor past its timeout
  if (!live) return 'ended';
  if (live.startedAt && !(Date.parse(t.startedAt) >= live.startedAt - 5000)) return 'ended'; // older than the Claude process
  return 'running';
}

function taskView(t, live) {
  const v = { ...t };
  delete v.transcript;
  if (t.outputFile && t.kind !== 'agent') {
    const tail = readTail(t.outputFile, 6000);
    if (tail) {
      v.output = { size: tail.size, mtime: tail.mtime };
      v.progress = progressOf(tail.text);
      v.tail = clip(tail.text.split('\n').slice(-6).join('\n'), 1200);
    }
  } else if (t.lastActivity) v.output = { mtime: t.lastActivity };
  v.status = liveStatus(t, live);
  return v;
}

function sessionSummary(st, live) {
  const tasks = [...st.tasks.values()];
  return {
    id: st.id, project: projectName(st), cwd: st.cwd, slug: st.slug,
    title: st.customTitle || st.aiTitle || st.firstPrompt || '(untitled)',
    firstTs: st.firstTs, lastTs: st.lastTs, prompts: st.prompts,
    lastPrompt: st.lastPrompt, lastPromptTs: st.lastPromptTs, lastClaude: st.lastClaude, lastClaudeTs: st.lastClaudeTs,
    model: st.model, cost: st.cost, errors: st.errors, lastError: st.lastError, compactions: st.compactions,
    toolCalls: st.toolCalls, toolCounts: st.toolCounts, entrypoint: st.entrypoint, version: st.version,
    sizeMB: Math.round((st.offset / 1048576) * 10) / 10,
    live: live || null,
    tasksRunning: tasks.filter(t => liveStatus(t, live) === 'running').length, tasksTotal: tasks.length,
    todos: st.todos, taskList: [...st.taskList.values()],
    plans: st.plans.map(p => ({ ts: p.ts, plan: p.plan })), artifacts: [...st.artifacts.values()],
  };
}

function overview() {
  refreshAll();
  const live = liveSessions();
  const sessions = [];
  const tasks = [];
  for (const st of states.values()) {
    if (!st.firstTs) continue;
    const l = live.get(st.id);
    const s = sessionSummary(st, l);
    sessions.push(s);
    for (const t of st.tasks.values()) {
      tasks.push({ t, live: l, project: s.project, sessionTitle: s.title, status: liveStatus(t, l) });
    }
  }
  sessions.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || String(b.lastTs).localeCompare(String(a.lastTs)));
  const rank = { running: 0 };
  const when = x => String(x.t.endedAt || x.t.lastActivity || x.t.startedAt || '');
  tasks.sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || when(b).localeCompare(when(a)));
  // output tails only for the tasks anyone will look at; the rest are listed without touching disk
  const views = tasks.map((x, i) => ({ ...(i < 60 ? taskView(x.t, x.live) : { ...x.t, status: x.status, transcript: undefined }),
    project: x.project, sessionTitle: x.sessionTitle }));
  return { sessions, tasks: views, live: [...live.values()] };
}

function findState(id) {
  for (const st of states.values()) if (st.id === id) return st;
  refreshAll();
  for (const st of states.values()) if (st.id === id) return st;
  return null;
}

// ---- full conversation (parsed on demand, then followed incrementally like the index) ----
const convCache = new Map();

function convBuilder() { return { offset: 0, rest: Buffer.alloc(0), items: [], tools: new Map() }; }

function extendConversation(c, file) {
  const size = fs.statSync(file).size;
  if (size < c.offset) Object.assign(c, convBuilder());
  if (size === c.offset) return c;
  const fd = fs.openSync(file, 'r');
  try {
    while (c.offset < size) {
      const n = Math.min(8 << 20, size - c.offset);
      const buf = Buffer.allocUnsafe(n);
      const got = fs.readSync(fd, buf, 0, n, c.offset);
      if (!got) break;
      c.offset += got;
      const joined = c.rest.length ? Buffer.concat([c.rest, buf.subarray(0, got)]) : buf.subarray(0, got);
      c.rest = Buffer.from(forEachLine(joined, line => convRecord(c, line)));
    }
  } finally { fs.closeSync(fd); }
  return c;
}

function buildConversation(file) {
  const c = extendConversation(convBuilder(), file);
  if (c.rest.length) convRecord(c, c.rest);
  return c.items;
}

function convRecord(c, line) {
  const items = c.items;
  const tools = c.tools;
  {
    let d;
    try { d = JSON.parse(line.toString('utf8')); } catch { return; }
    if (d.isSidechain) return;
    const ts = d.timestamp;
    if (d.type === 'system' && d.subtype === 'compact_boundary') { items.push({ k: 'divider', ts, text: 'Conversation compacted' }); return; }
    if (d.type === 'system' && d.subtype === 'api_error') { items.push({ k: 'error', ts, text: clip((d.error && (d.error.formatted || d.error.message)) || 'API error', 300) }); return; }
    if (d.type === 'queue-operation' && d.operation === 'enqueue' && typeof d.content === 'string' && d.content.includes('<task-notification>')) {
      const s = /<summary>([\s\S]*?)<\/summary>/.exec(d.content);
      const st = /<status>([\s\S]*?)<\/status>/.exec(d.content);
      items.push({ k: 'event', ts, status: st ? st[1] : '', text: redact(s ? s[1] : 'Task notification') });
      return;
    }
    if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
      for (const b of d.message.content) {
        if (b.type === 'text' && b.text && b.text.trim()) {
          const prev = items[items.length - 1];
          if (prev && prev.k === 'claude' && prev.mid === d.message.id) prev.text += '\n\n' + redact(b.text);
          else items.push({ k: 'claude', ts, mid: d.message.id, text: redact(b.text) });
        } else if (b.type === 'tool_use') {
          const it = { k: 'tool', ts, id: b.id, name: b.name, summary: toolSummary(b.name, b.input),
            input: clip(redact(JSON.stringify(b.input, null, 1)), 4000) };
          tools.set(b.id, it);
          items.push(it);
        }
      }
      return;
    }
    if (d.type === 'user' && d.message) {
      const c = d.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const it = tools.get(b.tool_use_id);
          if (!it) continue;
          it.result = clip(redact(resultText(b)), 4000);
          it.isError = !!b.is_error;
          const r = d.toolUseResult;
          if (r && typeof r === 'object' && r.backgroundTaskId) it.bg = r.backgroundTaskId;
        }
      }
      const raw = textOf(c);
      if (d.isCompactSummary) { items.push({ k: 'summary', ts, text: clip(redact(stripNoise(raw)), 30000) }); return; }
      if (raw.includes('<task-notification>')) {
        const s = /<summary>([\s\S]*?)<\/summary>/.exec(raw);
        items.push({ k: 'event', ts, text: redact(s ? s[1] : 'Task notification') });
        return;
      }
      const text = stripNoise(raw);
      if (text && isHuman(d, raw)) {
        const images = Array.isArray(c) ? c.filter(b => b.type === 'image').length : 0;
        items.push({ k: 'you', ts, text: redact(text), images });
      }
    }
  }
}

function conversation(id, before, limit) {
  const st = findState(id);
  if (!st) return null;
  update(st);
  let c = convCache.get(st.file);
  if (!c) {
    c = convBuilder();
    convCache.set(st.file, c);
    if (convCache.size > 4) convCache.delete(convCache.keys().next().value);
  }
  try { extendConversation(c, st.file); } catch { return null; }
  const end = before == null ? c.items.length : Math.max(0, Math.min(before, c.items.length));
  const start = Math.max(0, end - limit);
  return { session: sessionSummary(st, liveSessions().get(st.id)), total: c.items.length, start, end, items: c.items.slice(start, end) };
}

function search(q, limit = 120) {
  refreshAll();
  const needle = q.toLowerCase();
  const hits = [];
  for (const st of states.values()) {
    for (const e of st.search) {
      const i = e.text.toLowerCase().indexOf(needle);
      if (i < 0) continue;
      hits.push({ sessionId: st.id, project: projectName(st), title: st.customTitle || st.aiTitle || st.firstPrompt,
        ts: e.ts, role: e.role, snippet: (i > 80 ? '…' : '') + e.text.slice(Math.max(0, i - 80), i + needle.length + 160) });
    }
  }
  hits.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return hits.slice(0, limit);
}

function taskOutput(sessionId, taskId, bytes) {
  const st = findState(sessionId);
  const t = st && st.tasks.get(taskId);
  if (!t) return null;
  if (t.kind === 'agent' && t.transcript) {
    try {
      const items = buildConversation(t.transcript).filter(i => i.k !== 'tool' || i.summary).slice(-60);
      return { kind: 'agent', items };
    } catch { return null; }
  }
  const tail = t.outputFile && readTail(t.outputFile, bytes);
  return tail ? { kind: 'text', ...tail } : { kind: 'text', text: '(no output file found)', size: 0 };
}

function plansOnDisk() {
  try {
    return fs.readdirSync(P.PLANS).filter(f => f.endsWith('.md')).map(f => {
      const file = path.join(P.PLANS, f);
      const s = fs.statSync(file);
      const text = redact(fs.readFileSync(file, 'utf8'));
      const h = /^#\s+(.+)$/m.exec(text);
      return { name: f, title: h ? h[1] : f, mtime: new Date(s.mtimeMs).toISOString(), text: clip(text, 20000) };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch { return []; }
}

// every parsed session with its live state, for the project, skill and activity views
function allStates() {
  refreshAll();
  const live = liveSessions();
  return [...states.values()].filter(st => st.firstTs).map(st => ({ st, live: live.get(st.id) || null, project: projectName(st),
    summary: () => sessionSummary(st, live.get(st.id)) }));
}

module.exports = { overview, conversation, search, taskOutput, plansOnDisk, refreshAll, progressOf, allStates, liveSessions, liveStatus, projectName };
