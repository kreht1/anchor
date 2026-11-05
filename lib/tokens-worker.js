'use strict';
// Runs the token audit off the server's main thread: a cold audit reads every recent transcript (seconds), and the
// dashboard must stay responsive meanwhile. One long-lived worker keeps the per-file parse cache warm.
const { Worker, isMainThread, parentPort } = require('worker_threads');

if (!isMainThread) {
  const T = require('./tokens');
  parentPort.on('message', ({ id, days }) => {
    try { parentPort.postMessage({ id, v: T.audit({ days }) }); } catch (e) { parentPort.postMessage({ id, error: String(e.message || e) }); }
  });
} else {
  let worker = null, seq = 0;
  const waiting = new Map();
  const start = () => {
    worker = new Worker(__filename);
    worker.unref();
    worker.on('message', m => { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.v); });
    worker.on('error', e => { for (const w of waiting.values()) w.reject(e); waiting.clear(); worker = null; });
    worker.on('exit', () => { worker = null; });
  };
  const cache = new Map(); // days -> { at, v } or { at, p } while running
  module.exports = function audit(days) {
    const c = cache.get(days);
    if (c && (c.p || Date.now() - c.at < 60000)) return c.p || Promise.resolve(c.v);
    if (!worker) start();
    const id = ++seq;
    const p = new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ id, days }); })
      .then(v => { cache.set(days, { at: Date.now(), v }); return v; }, e => { cache.delete(days); throw e; });
    cache.set(days, { at: Date.now(), p });
    return p;
  };
}
