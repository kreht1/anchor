'use strict';
// Model Lab: finds model files in the folders Claude has worked in and reads them with tools/model_inspect.py
// (structure and weight samples, never running code from the file). Results are cached by file and modification time.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const FS = require('./fsview');

const EXT = /\.(pt|pth|ckpt|safetensors|onnx|gguf|h5|hdf5|keras|npz|npy|pkl|joblib|bin)$/i;
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.venv-gpu', 'site-packages', '.cache', 'dist', 'build', '.next']);
const SCRIPT = path.join(__dirname, '..', 'tools', 'model_inspect.py');
const PY = process.platform === 'win32' ? 'py' : 'python3';
const cache = new Map();
let found = null;

function scan() {
  if (found && Date.now() - found.at < 60000) return found.v;
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 7 || out.length > 3000) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(p, depth + 1); continue; }
      if (!EXT.test(e.name)) continue;
      try { const st = fs.statSync(p); if (st.size > 1024 && !(e.name.endsWith('.bin') && st.size < 1e6)) out.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs, root: null }); } catch { /* vanished */ }
    }
  };
  for (const r of FS.roots()) { const before = out.length; walk(r, 0); for (let i = before; i < out.length; i++) out[i].root = r; }
  // checkpoints first, then by size
  const rank = n => (/\.(pt|pth|ckpt|safetensors|onnx|gguf|h5|keras)$/i.test(n) ? 0 : 1);
  const v = out.sort((a, b) => rank(a.name) - rank(b.name) || b.size - a.size);
  found = { at: Date.now(), v };
  return v;
}

function py(args, input) {
  return new Promise((resolve, reject) => {
    const p = execFile(PY, ['-I', SCRIPT, ...args], { windowsHide: true, timeout: 180000, maxBuffer: 256 << 20 }, (e, out, err) => {
      if (e && !out) return reject(new Error((err || e.message).toString().split('\n').filter(Boolean).pop()));
      try { const j = JSON.parse(out); if (j.error) reject(new Error(j.error)); else resolve(j); } catch { reject(new Error('the inspector returned no result')); }
    });
    if (input != null) { p.stdin.end(input); }
  });
}

async function inspect(file) {
  const { abs } = FS.allowed(file);
  if (!EXT.test(abs)) throw new Error('not a model file Anchor can read');
  const st = fs.statSync(abs);
  const key = `${abs}|${st.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const info = await py([abs]);
  cache.set(key, info);
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  return info;
}

async function samples(file, names, cap) {
  const { abs } = FS.allowed(file);
  const list = (Array.isArray(names) ? names : []).map(String).slice(0, 400);
  return py([abs, '--samples', String(Math.max(4, Math.min(64, Number(cap) || 16)))], JSON.stringify(list));
}

module.exports = { scan, inspect, samples };
