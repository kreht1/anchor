'use strict';
// The board (planned / in-progress / done work) and the watch list, kept in one JSON file that the server, the
// `anchor` command and every Claude session can all write to. Writes are atomic; readers pick up changes by mtime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');

const FILE = path.join(P.DATA, 'board.json');
const STATUSES = ['todo', 'doing', 'blocked', 'done'];
let cache = null;
let cacheMtime = -1;

function load() {
  let m = -2;
  try { m = fs.statSync(FILE).mtimeMs; } catch { /* first run */ }
  if (cache && m === cacheMtime) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = null; }
  if (!cache || typeof cache !== 'object') cache = {};
  cache.items = Array.isArray(cache.items) ? cache.items : [];
  cache.watch = Array.isArray(cache.watch) ? cache.watch : [];
  cache.jobs = Array.isArray(cache.jobs) ? cache.jobs : [];
  cacheMtime = m;
  return cache;
}

function save(data) {
  fs.mkdirSync(P.DATA, { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, FILE);
  cache = data;
  try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = -1; }
}

const newId = () => crypto.randomBytes(3).toString('hex');
const now = () => new Date().toISOString();
const str = (v, n) => (v == null ? undefined : String(v).slice(0, n));

function addItem(input) {
  const title = str(input.title, 300);
  if (!title || !title.trim()) throw new Error('title is required');
  const data = load();
  const item = { id: newId(), title: title.trim(), notes: str(input.notes, 4000) || '', project: str(input.project, 120) || '',
    status: STATUSES.includes(input.status) ? input.status : 'todo', priority: ['high', 'normal', 'low'].includes(input.priority) ? input.priority : 'normal',
    source: input.source === 'claude' ? 'claude' : 'you', sessionId: str(input.sessionId, 80) || '', createdAt: now(), updatedAt: now() };
  data.items.push(item);
  save(data);
  return item;
}

function updateItem(id, patch) {
  const data = load();
  const item = data.items.find(i => i.id === id || i.id.startsWith(id));
  if (!item) throw new Error('no such item: ' + id);
  if (patch.title != null) item.title = str(patch.title, 300);
  if (patch.notes != null) item.notes = str(patch.notes, 4000);
  if (patch.project != null) item.project = str(patch.project, 120);
  if (patch.priority && ['high', 'normal', 'low'].includes(patch.priority)) item.priority = patch.priority;
  if (patch.status && STATUSES.includes(patch.status)) {
    item.status = patch.status;
    item.doneAt = patch.status === 'done' ? now() : undefined;
  }
  item.updatedAt = now();
  save(data);
  return item;
}

function removeItem(id) {
  const data = load();
  const n = data.items.length;
  data.items = data.items.filter(i => !(i.id === id || i.id.startsWith(id)));
  if (data.items.length === n) throw new Error('no such item: ' + id);
  save(data);
}

function addWatch(input) {
  const p = str(input.path, 1000);
  if (!p || !path.isAbsolute(p)) throw new Error('an absolute path is required');
  const data = load();
  data.watch = data.watch.filter(w => path.resolve(w.path) !== path.resolve(p));
  const w = { id: newId(), path: path.resolve(p), label: str(input.label, 120) || '', target: Number(input.target) > 0 ? Number(input.target) : null, addedAt: now() };
  data.watch.push(w);
  save(data);
  return w;
}

function removeWatch(idOrPath) {
  const data = load();
  data.watch = data.watch.filter(w => w.id !== idOrPath && path.resolve(w.path) !== path.resolve(String(idOrPath)));
  save(data);
}

function addJob(input) {
  const log = str(input.log, 1000);
  if (!log || !path.isAbsolute(log)) throw new Error('an absolute log path is required');
  const data = load();
  data.jobs = data.jobs.filter(j => path.resolve(j.log) !== path.resolve(log));
  const j = { id: newId(), log: path.resolve(log), label: str(input.label, 120) || '', project: str(input.project, 120) || '',
    pid: Number(input.pid) > 0 ? Number(input.pid) : null, progress: input.progress ? path.resolve(String(input.progress)) : null, addedAt: now() };
  data.jobs.push(j);
  save(data);
  return j;
}

function removeJob(idOrLog) {
  const data = load();
  const key = String(idOrLog).replace(/^job-/, '');
  data.jobs = data.jobs.filter(j => j.id !== key && path.resolve(j.log) !== path.resolve(String(idOrLog)));
  save(data);
}

module.exports = { getJobs: () => load().jobs, addJob, removeJob, getItems: () => load().items, getWatch: () => load().watch, addItem, updateItem, removeItem, addWatch, removeWatch, FILE, STATUSES };
