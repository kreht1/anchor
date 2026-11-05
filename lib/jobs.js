'use strict';
// Detached jobs: long runs started outside Claude's background tasks (a training run, a script launched with
// Start-Process...). Registered with `anchor job <log>`; shown alongside Claude's tasks with live log, stage and progress.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { redact } = require('./redact');

const DONE_RE = /\bDONE\b|\bcompleted successfully\b|\bfinished\b/;
const FAIL_RE = /\bERROR in stage\b|^Traceback \(most recent call last\)|\bFAILED\b/m;

function tail(file, bytes) {
  try {
    const s = fs.statSync(file);
    const n = Math.min(bytes, s.size);
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, s.size - n); } finally { fs.closeSync(fd); }
    return { size: s.size, mtime: s.mtimeMs, birth: s.birthtimeMs, text: redact(buf.toString('utf8')), truncated: s.size > n };
  } catch { return null; }
}

function alive(pid) {
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readProgress(j) {
  const p = j.progress || path.join(path.dirname(j.log), 'progress.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function view(j) {
  const t = tail(j.log, 8000);
  const prog = readProgress(j);
  const isAlive = alive(j.pid);
  const text = t ? t.text : '';
  let status;
  if (prog && prog.status === 'FAILED') status = 'failed';
  else if (FAIL_RE.test(text.split('\n').slice(-40).join('\n'))) status = isAlive ? 'running' : 'failed';
  else if (DONE_RE.test(text.split('\n').slice(-5).join('\n'))) status = 'completed';
  else if (isAlive === true) status = 'running';
  else if (isAlive === false) status = 'ended';
  else status = t && Date.now() - t.mtime < 10 * 60e3 ? 'running' : 'ended';
  const lines = text.replace(/\r(?!\n)/g, '\n').split('\n').filter(l => l.trim());
  let progress = null;
  if (prog && prog.total) {
    const pct = Math.round((prog.done / prog.total) * 1000) / 10;
    progress = { pct, line: `${prog.stage}: ${prog.done}/${prog.total}${prog.eta_min != null ? ` · about ${Math.round(prog.eta_min)} min left in this stage` : ''}` };
  }
  return {
    id: 'job-' + j.id, jobId: j.id, sessionId: '_jobs', kind: 'job', description: j.label || path.basename(path.dirname(j.log)),
    project: j.project || '', command: j.log, outputFile: j.log, pid: j.pid || null,
    startedAt: new Date(j.startedAt || (t ? t.birth : Date.parse(j.addedAt))).toISOString(),
    endedAt: status === 'running' ? undefined : t ? new Date(t.mtime).toISOString() : undefined,
    status, stage: prog ? prog.stage : null, note: prog && prog.note ? redact(prog.note) : null,
    progress: progress || (lines.length ? { pct: null, line: lines[lines.length - 1].slice(0, 200) } : null),
    output: t ? { size: t.size, mtime: new Date(t.mtime).toISOString() } : null,
    tail: lines.slice(-6).join('\n').slice(-1200),
    summary: status !== 'running' && lines.length ? lines[lines.length - 1].slice(0, 300) : undefined,
  };
}

function list() { return store.getJobs().map(view); }

function output(id, bytes) {
  const j = store.getJobs().find(x => 'job-' + x.id === id || x.id === id);
  if (!j) return null;
  const t = tail(j.log, bytes);
  return t ? { kind: 'text', size: t.size, mtime: new Date(t.mtime).toISOString(), text: t.text, truncated: t.truncated } : { kind: 'text', text: '(log file not found yet)', size: 0 };
}

module.exports = { list, output };
