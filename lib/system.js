'use strict';
// Machine telemetry: GPU (nvidia-smi), CPU, RAM, disks, network throughput, notable processes, partial downloads and
// user-watched paths. Sampled only while someone is looking at the dashboard.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./paths');
const { redact } = require('./redact');
const store = require('./store');
const { progressOf } = require('./transcripts');

const HIST = 180; // samples kept for sparklines
const state = { gpu: null, cpu: null, mem: null, net: null, disks: [], procs: [], partials: [], watch: [], history: { cpu: [], gpu: [], net: [], ram: [], vram: [] }, sampledAt: null };
let prevCpu = null;
let prevNet = null;
let prevProc = new Map();
let prevSizes = new Map();
let busy = false;
let lastWanted = 0;

const PROC_RE = '^(python|pythonw|node|uv|pip|curl|wget|git|aria2c|7z|ffmpeg|conda|npm|java|kaggle|torchrun|claude|docker|ollama|code|chrome|msedge|firefox|wsl|bash|powershell|pwsh)\\.exe$';

function run(cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function push(arr, v) { arr.push(v); if (arr.length > HIST) arr.shift(); }

function cpuSample() {
  const cpus = os.cpus();
  const tot = cpus.reduce((a, c) => { for (const k in c.times) a[k === 'idle' ? 'idle' : 'busy'] += c.times[k]; return a; }, { idle: 0, busy: 0 });
  let pct = null;
  if (prevCpu) {
    const di = tot.idle - prevCpu.idle; const db = tot.busy - prevCpu.busy;
    pct = di + db > 0 ? Math.round((db / (di + db)) * 1000) / 10 : 0;
  }
  prevCpu = tot;
  return { pct, cores: cpus.length, model: cpus[0] && cpus[0].model.trim() };
}

async function gpuSample() {
  const out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const gpus = out.trim().split('\n').map(l => {
    const [name, util, used, total, temp, power, plimit] = l.split(',').map(s => s.trim());
    const num = s => (isNaN(Number(s)) ? null : Number(s));
    return { name, util: num(util), memUsedMB: num(used), memTotalMB: num(total), temp: num(temp), powerW: num(power), powerLimitW: num(plimit) };
  });
  const apps = await run('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']);
  const procs = (apps || '').trim().split('\n').filter(Boolean).map(l => {
    const [pid, name, mem] = l.split(',').map(s => s.trim());
    return { pid: Number(pid), name: path.basename(name || ''), memMB: Number(mem) || null };
  });
  return { gpus, procs };
}

const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$n = Get-NetAdapterStatistics | Measure-Object ReceivedBytes,SentBytes -Sum
$re = '${PROC_RE}'
$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -match $re } | ForEach-Object {
  [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; cpu=([double]$_.KernelModeTime + [double]$_.UserModeTime)/1e7; ws=[double]$_.WorkingSetSize; started=$(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }) } }
$d = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { [pscustomobject]@{ name=$_.Name; used=[double]$_.Used; free=[double]$_.Free } }
[pscustomobject]@{ rx=[double]$n[0].Sum; tx=[double]$n[1].Sum; procs=@($p); disks=@($d) } | ConvertTo-Json -Depth 4 -Compress
`;

async function windowsSample() {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], 15000);
  if (!out) return null;
  try { return JSON.parse(out.trim()); } catch { return null; }
}

function partialDownloads(now) {
  const out = [];
  const dirs = [P.DOWNLOADS, path.join(P.HOME, 'Desktop')];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/\.(crdownload|part|partial|download|opdownload|tmp)$/i.test(n)) continue;
      try {
        const file = path.join(dir, n);
        const s = fs.statSync(file);
        if (!s.isFile() || now - s.mtimeMs > 10 * 60e3) continue; // abandoned partials are noise
        out.push(sizeEntry(file, n.replace(/\.(crdownload|part|partial|download|opdownload|tmp)$/i, ''), s.size, now));
      } catch { /* finished meanwhile */ }
    }
  }
  return out;
}

function dirSize(dir, budget) {
  let total = 0; let files = 0; let newest = 0;
  const stack = [dir];
  while (stack.length && files < budget) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) stack.push(f);
      else { try { const s = fs.statSync(f); total += s.size; files++; if (s.mtimeMs > newest) newest = s.mtimeMs; } catch { /* gone */ } }
    }
  }
  return { size: total, files, newest, partial: files >= budget };
}

function tailText(file, n) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    return redact(buf.toString('utf8'));
  } catch { return ''; }
}

function sizeEntry(file, label, size, now, extra = {}) {
  const prev = prevSizes.get(file);
  let rate = null;
  if (prev && now > prev.t) rate = Math.max(0, (size - prev.size) / ((now - prev.t) / 1000));
  if (prev && rate === 0 && prev.rate) rate = prev.rate * 0.5; // smooth single quiet samples
  prevSizes.set(file, { size, t: now, rate });
  const target = extra.target || null;
  return { path: file, label, size, rate, target, pct: target ? Math.min(100, (size / target) * 100) : null,
    eta: target && rate > 0 ? Math.max(0, (target - size) / rate) : null, ...extra };
}

function watched(now) {
  return store.getWatch().map(w => {
    try {
      const s = fs.statSync(w.path);
      if (s.isDirectory()) {
        const d = dirSize(w.path, 20000);
        return sizeEntry(w.path, w.label || path.basename(w.path), d.size, now, { dir: true, files: d.files, target: w.target || null, id: w.id, mtime: d.newest ? new Date(d.newest).toISOString() : null });
      }
      const e = sizeEntry(w.path, w.label || path.basename(w.path), s.size, now, { target: w.target || null, id: w.id, mtime: new Date(s.mtimeMs).toISOString() });
      if (/\.(log|txt|out|output)$/i.test(w.path)) { // a log: show its latest line and any progress it reports
        const p = progressOf(tailText(w.path, 4096));
        if (p) { e.line = p.line; if (!w.target && p.pct != null) e.pct = p.pct; }
        e.log = true;
      }
      return e;
    } catch { return { path: w.path, label: w.label || path.basename(w.path), id: w.id, missing: true }; }
  });
}

async function sample() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const cpu = cpuSample();
    const mem = { total: os.totalmem(), free: os.freemem() };
    const [gpu, win] = await Promise.all([gpuSample(), process.platform === 'win32' ? windowsSample() : null]);
    let net = null; let procs = []; let disks = [];
    if (win) {
      if (prevNet && now > prevNet.t) {
        const dt = (now - prevNet.t) / 1000;
        net = { rx: Math.max(0, (win.rx - prevNet.rx) / dt), tx: Math.max(0, (win.tx - prevNet.tx) / dt) };
      }
      prevNet = { rx: win.rx, tx: win.tx, t: now };
      const cores = cpu.cores || 1;
      const next = new Map();
      procs = (win.procs || []).map(p => {
        const prev = prevProc.get(p.pid);
        const pct = prev && now > prev.t ? Math.max(0, ((p.cpu - prev.cpu) / ((now - prev.t) / 1000) / cores) * 100) : null;
        next.set(p.pid, { cpu: p.cpu, t: now });
        const g = gpu && gpu.procs.find(x => x.pid === p.pid);
        return { pid: p.pid, ppid: p.ppid, name: p.name, cmd: redact((p.cmd || '').slice(0, 400)), cpuPct: pct == null ? null : Math.round(pct * 10) / 10,
          memMB: Math.round(p.ws / 1048576), started: p.started, gpuMemMB: g ? g.memMB : null };
      });
      prevProc = next;
      disks = (win.disks || []).map(d => ({ name: d.name + ':', used: d.used, free: d.free }));
      // browsers and editors run dozens of helpers; keep only the busy or GPU-using ones
      procs = procs.filter(p => !/^(chrome|msedge|firefox|code)\.exe$/i.test(p.name) || (p.cpuPct || 0) > 5 || p.gpuMemMB);
      procs.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0) || b.memMB - a.memMB);
    }
    Object.assign(state, { cpu, mem, gpu, net, procs: procs.slice(0, 60), disks, partials: partialDownloads(now), watch: watched(now), sampledAt: new Date(now).toISOString() });
    const g0 = gpu && gpu.gpus[0];
    push(state.history.cpu, cpu.pct);
    push(state.history.ram, Math.round(((mem.total - mem.free) / mem.total) * 1000) / 10);
    push(state.history.gpu, g0 ? g0.util : null);
    push(state.history.vram, g0 && g0.memTotalMB ? Math.round((g0.memUsedMB / g0.memTotalMB) * 1000) / 10 : null);
    push(state.history.net, net ? net.rx : null);
  } finally { busy = false; }
}

function want() { lastWanted = Date.now(); }

function start(intervalMs = 3000) {
  sample();
  setInterval(() => { if (Date.now() - lastWanted < 60e3) sample(); }, intervalMs).unref();
}

module.exports = { start, want, get: () => state, sample };
