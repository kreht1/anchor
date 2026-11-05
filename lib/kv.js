'use strict';
// Small JSON documents in the Anchor data folder (skill verdicts, study runs...). Atomic writes, cached by mtime.
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const cache = new Map();

function read(name, fallback) {
  const file = path.join(P.DATA, name);
  let m = -1;
  try { m = fs.statSync(file).mtimeMs; } catch { return structuredClone(fallback); }
  const c = cache.get(file);
  if (c && c.m === m) return c.v;
  let v;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { v = structuredClone(fallback); }
  cache.set(file, { m, v });
  return v;
}

function write(name, value) {
  const file = path.join(P.DATA, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
  try { cache.set(file, { m: fs.statSync(file).mtimeMs, v: value }); } catch { cache.delete(file); }
  return value;
}

module.exports = { read, write };
