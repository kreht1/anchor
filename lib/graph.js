'use strict';
// A graphify graph (graphify-out/graph.json) reduced to something a browser can draw: the community map (one node
// per community, sized by members, linked by cross-community edges), and on demand one community's own nodes.
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

const cache = new Map(); // file -> {mtime, g}

function load(cwd) {
  const file = path.join(path.resolve(cwd), 'graphify-out', 'graph.json');
  const st = fs.statSync(file);
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.g;
  if (st.size > 300e6) throw new Error('graph.json is too large to load');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = raw.nodes || [];
  const links = raw.links || raw.edges || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const deg = new Map();
  for (const l of links) { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); }
  const comms = new Map();
  for (const n of nodes) {
    const k = n.community ?? -1;
    if (!comms.has(k)) comms.set(k, { id: k, name: n.community_name || (k === -1 ? 'Unclustered' : `Community ${k}`), size: 0, members: [], types: {} });
    const c2 = comms.get(k);
    c2.size++; c2.members.push(n.id);
    c2.types[n.file_type || 'other'] = (c2.types[n.file_type || 'other'] || 0) + 1;
  }
  const cross = new Map();
  for (const l of links) {
    const a = byId.get(l.source), b = byId.get(l.target);
    if (!a || !b) continue;
    const ca = a.community ?? -1, cb = b.community ?? -1;
    if (ca === cb) continue;
    const k = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
    cross.set(k, (cross.get(k) || 0) + 1);
  }
  const g = { file, mtime: st.mtimeMs, nodes, links, byId, deg, comms, cross, hyperedges: raw.hyperedges || (raw.graph && raw.graph.hyperedges) || [] };
  cache.clear(); // keep one graph in memory
  cache.set(file, { mtime: st.mtimeMs, g });
  return g;
}

function overview(cwd) {
  const g = load(cwd);
  const comms = [...g.comms.values()].sort((a, b) => b.size - a.size);
  const top = comms.slice(0, 160);
  const keep = new Set(top.map(c => c.id));
  let report = null;
  try { report = redact(fs.readFileSync(path.join(path.resolve(cwd), 'graphify-out', 'GRAPH_REPORT.md'), 'utf8').slice(0, 60000)); } catch { /* no report */ }
  return {
    nodes: g.nodes.length, links: g.links.length, communities: comms.length, mtime: new Date(g.mtime).toISOString(),
    map: top.map(c => ({ id: c.id, name: c.name, size: c.size, types: c.types,
      hubs: c.members.map(id => g.byId.get(id)).sort((a, b) => (g.deg.get(b.id) || 0) - (g.deg.get(a.id) || 0)).slice(0, 6).map(n => n.label || n.id) })),
    edges: [...g.cross].map(([k, w]) => { const [a, b] = k.split('|').map(Number); return { a, b, w }; }).filter(e => keep.has(e.a) && keep.has(e.b))
      .sort((x, y) => y.w - x.w).slice(0, 600),
    hyperedges: g.hyperedges.slice(0, 30).map(h => ({ id: h.id, label: h.label, n: (h.nodes || []).length })),
    report,
  };
}

function community(cwd, id, limit = 260) {
  const g = load(cwd);
  const c = g.comms.get(Number(id));
  if (!c) throw new Error('unknown community');
  const members = c.members.map(i => g.byId.get(i)).sort((a, b) => (g.deg.get(b.id) || 0) - (g.deg.get(a.id) || 0)).slice(0, limit);
  const ids = new Set(members.map(n => n.id));
  const links = g.links.filter(l => ids.has(l.source) && ids.has(l.target)).slice(0, 2500)
    .map(l => ({ s: l.source, t: l.target, r: l.relation || '', c: l.confidence || '' }));
  const outside = new Map();
  for (const l of g.links) {
    const inA = ids.has(l.source), inB = ids.has(l.target);
    if (inA === inB) continue;
    const other = g.byId.get(inA ? l.target : l.source);
    if (!other) continue;
    const k = other.community ?? -1;
    outside.set(k, (outside.get(k) || 0) + 1);
  }
  return {
    id: c.id, name: c.name, size: c.size,
    nodes: members.map(n => ({ id: n.id, label: n.label || n.id, type: n.file_type || '', file: n.source_file || '', loc: n.source_location || '', deg: g.deg.get(n.id) || 0 })),
    links, neighbours: [...outside].map(([k, w]) => ({ id: k, name: (g.comms.get(k) || {}).name || String(k), w })).sort((a, b) => b.w - a.w).slice(0, 12),
  };
}

module.exports = { overview, community };
