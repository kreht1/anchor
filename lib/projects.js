'use strict';
// Projects = the folders Claude Code sessions ran in. Everything Anchor knows about one: sessions, cost, activity by
// day, tools and skills used, files Claude changed, tasks, board items, memory, CLAUDE.md, git and a graphify graph.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./paths');
const T = require('./transcripts');
const store = require('./store');
const { redact } = require('./redact');

const norm = p => path.resolve(p).toLowerCase();
const gitCache = new Map();

function groups() {
  const g = new Map();
  for (const x of T.allStates()) {
    const cwd = x.st.cwd || null;
    const key = cwd ? norm(cwd) : 'slug:' + x.st.slug;
    if (!g.has(key)) g.set(key, { key, cwd, name: x.project, slug: x.st.slug, states: [] });
    const e = g.get(key);
    e.states.push(x);
    if (!e.cwd && cwd) e.cwd = cwd;
  }
  return [...g.values()];
}

// graphify writes <root>/graphify-out/graph.json; the root may be the project folder or one or two levels above it
function graphInfo(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (let up = 0; up < 3; up++) {
    const f = path.join(dir, 'graphify-out', 'graph.json');
    try {
      const s = fs.statSync(f);
      return { root: dir, file: f, sizeMB: Math.round(s.size / 1e5) / 10, mtime: new Date(s.mtimeMs).toISOString(), report: fs.existsSync(path.join(dir, 'graphify-out', 'GRAPH_REPORT.md')) };
    } catch { /* try the parent */ }
    const parent = path.dirname(dir);
    if (parent === dir || parent.toLowerCase() === P.HOME.toLowerCase() || parent.toLowerCase() === path.join(P.HOME, 'Desktop').toLowerCase()) break;
    dir = parent;
  }
  return null;
}

function summary(g) {
  const sts = g.states.map(x => x.st);
  const live = g.states.filter(x => x.live);
  const last = sts.reduce((a, s) => (s.lastTs > a ? s.lastTs : a), '');
  const first = sts.reduce((a, s) => (!a || (s.firstTs && s.firstTs < a) ? s.firstTs : a), '');
  return {
    key: g.key, name: g.name, cwd: g.cwd, exists: !!(g.cwd && fs.existsSync(g.cwd)), sessions: sts.length, live: live.length,
    busy: live.filter(x => x.live.status === 'busy').length, prompts: sts.reduce((a, s) => a + s.prompts, 0),
    cost: Math.round(sts.reduce((a, s) => a + (s.cost || 0), 0) * 100) / 100, toolCalls: sts.reduce((a, s) => a + s.toolCalls, 0),
    first, last, graph: graphInfo(g.cwd), sizeMB: Math.round(sts.reduce((a, s) => a + s.offset, 0) / 1e5) / 10,
    days: merge(sts.map(s => s.days)),
  };
}

function merge(objs) {
  const out = {};
  for (const o of objs) for (const [k, v] of Object.entries(o || {})) out[k] = (out[k] || 0) + (typeof v === 'number' ? v : 0);
  return out;
}

function list() {
  return groups().map(summary).sort((a, b) => b.live - a.live || String(b.last).localeCompare(String(a.last)));
}

function find(key) { return groups().find(g => g.key === String(key).toLowerCase() || (g.cwd && norm(g.cwd) === norm(String(key)))); }

function readMaybe(file, n = 40000) { try { return redact(fs.readFileSync(file, 'utf8').slice(0, n)); } catch { return null; } }

function gitInfo(cwd) {
  const c = gitCache.get(cwd);
  if (c && Date.now() - c.at < 60000) return Promise.resolve(c.v);
  const run = args => new Promise(res => execFile('git', ['-C', cwd, ...args], { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 }, (e, out) => res(e ? null : out.toString())));
  return Promise.all([run(['rev-parse', '--abbrev-ref', 'HEAD']), run(['log', '-12', '--pretty=format:%h\t%ad\t%s', '--date=iso-strict']), run(['status', '--porcelain'])])
    .then(([branch, log, status]) => {
      const v = branch == null ? null : { branch: branch.trim(), log: (log || '').split('\n').filter(Boolean).map(l => { const [h, d, ...s] = l.split('\t'); return { h, d, s: redact(s.join('\t')) }; }),
        changed: (status || '').split('\n').filter(Boolean).length };
      gitCache.set(cwd, { at: Date.now(), v });
      return v;
    });
}

async function detail(key) {
  const g = find(key);
  if (!g) return null;
  const s = summary(g);
  const sts = g.states.map(x => x.st);
  const tools = merge(sts.map(x => x.toolCounts));
  const skills = {};
  for (const st of sts) for (const [k, v] of Object.entries(st.skills)) {
    const e = skills[k] || (skills[k] = { uses: 0, errors: 0, last: null });
    e.uses += v.uses; e.errors += v.errors; if (!e.last || v.last > e.last) e.last = v.last;
  }
  const files = {};
  for (const st of sts) for (const [f, v] of Object.entries(st.files)) {
    const e = files[f] || (files[f] = { edits: 0, writes: 0, last: null });
    e.edits += v.edits; e.writes += v.writes; if (!e.last || v.last > e.last) e.last = v.last;
  }
  const tasks = [];
  for (const x of g.states) for (const t of x.st.tasks.values()) tasks.push({ id: t.id, sessionId: x.st.id, kind: t.kind, description: t.description, status: T.liveStatus(t, x.live), startedAt: t.startedAt, endedAt: t.endedAt });
  tasks.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const memDir = path.join(P.PROJECTS, g.slug, 'memory');
  let memory = [];
  try { memory = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).map(f => ({ name: f, text: readMaybe(path.join(memDir, f), 12000) })); } catch { /* none */ }
  const board = store.getItems().filter(i => i.project && (i.project.toLowerCase() === String(g.name).toLowerCase()));
  return {
    ...s,
    sessionsList: g.states.map(x => x.summary()).sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || String(b.lastTs).localeCompare(String(a.lastTs)))
      .map(({ todos, taskList, plans, artifacts, ...r }) => ({ ...r, plans: plans.length, artifacts: artifacts.length })),
    tools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 24),
    skills: Object.entries(skills).sort((a, b) => b[1].uses - a[1].uses),
    files: Object.entries(files).map(([f, v]) => ({ file: f, ...v, inside: g.cwd ? norm(f).startsWith(norm(g.cwd)) : false }))
      .sort((a, b) => String(b.last).localeCompare(String(a.last))).slice(0, 80),
    tasks: tasks.slice(0, 60), taskTotals: tasks.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {}),
    memory, board,
    claudeMd: g.cwd ? readMaybe(path.join(g.cwd, 'CLAUDE.md')) : null,
    readme: g.cwd ? readMaybe(path.join(g.cwd, 'README.md'), 20000) : null,
    git: g.cwd && fs.existsSync(path.join(g.cwd, '.git')) ? await gitInfo(g.cwd) : null,
    models: merge(sts.map(st => (st.model ? { [st.model]: 1 } : {}))),
    plans: sts.flatMap(st => st.plans.map(p => ({ ts: p.ts, title: (/^#\s+(.+)$/m.exec(p.plan) || [])[1] || 'Plan', sessionId: st.id }))).slice(-20),
    artifacts: sts.flatMap(st => [...st.artifacts.values()]).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 30),
  };
}

module.exports = { list, detail, find, graphInfo };
