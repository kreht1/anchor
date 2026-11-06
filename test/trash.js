'use strict';
// Trash: add/refuse/list/keep/empty, guard → trash targets, and per-agent run measurement.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-trash-'));
process.env.ANCHOR_DATA_DIR = path.join(tmp, 'data');
const TR = require('../lib/trash');
const G = require('../lib/guard');
const RN = require('../lib/runs');

// adding
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const bundle = path.join(work, 'bundle.bin'); fs.writeFileSync(bundle, Buffer.alloc(2048));
const cache = path.join(work, '.next-b8a'); fs.mkdirSync(path.join(cache, 'a'), { recursive: true }); fs.writeFileSync(path.join(cache, 'a', 'x.js'), 'x'.repeat(500));
let r = TR.add(bundle, { why: 'temp bundle', from: 'claude' });
assert.ok(r.ok && r.item.size === 2048, 'adds a file with its size');
assert.ok(TR.add(bundle, { why: 'again' }).existed, 'no duplicates');
assert.ok(TR.add('.next-b8a', { cwd: work }).ok, 'relative paths resolve against cwd');
assert.strictEqual(TR.list().length, 2);
assert.strictEqual(TR.count(), 2);
assert.strictEqual(TR.list().find(i => i.dir).size, 500, 'folder size is counted');

// refusing
assert.ok(!TR.add(os.homedir()).ok, 'refuses the home folder');
assert.ok(!TR.add(path.parse(process.cwd()).root).ok, 'refuses a drive root');
assert.ok(!TR.add(path.join(tmp, 'nope')).ok, 'refuses a missing path');
const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
assert.ok(!TR.add(repo).ok, 'refuses a git repository');
assert.ok(!TR.add(path.join(repo, '.git')).ok, 'refuses git history');
assert.ok(!TR.add(process.env.ANCHOR_DATA_DIR).ok || !fs.existsSync(process.env.ANCHOR_DATA_DIR), 'refuses Anchor data');
if (process.platform === 'win32') assert.strictEqual(TR.resolvePath('/c/Users/x'), 'c:\\Users\\x', 'git-bash paths become Windows paths');

// keep and empty
const id = TR.list().find(i => i.dir).id;
assert.strictEqual(TR.keep([id]).kept, 1); assert.ok(fs.existsSync(cache), 'keep leaves the file');
r = TR.empty([], { permanent: true });
assert.strictEqual(r.deleted, 1); assert.ok(!fs.existsSync(bundle), 'empty deletes'); assert.strictEqual(TR.count(), 0);
// a hand-edited list cannot point the trash at a repo
fs.writeFileSync(TR.FILE(), JSON.stringify([{ id: 'evil01', path: repo }]));
r = TR.empty([], { permanent: true });
assert.ok(r.failed.length === 1 && fs.existsSync(repo), 'empty re-checks paths');

// guard reports the targets it stopped
const g = G.evaluate({ tool_name: 'Bash', tool_input: { command: `rm "${bundle.replace(/\\/g, '/')}" && rm -rf ${cache.replace(/\\/g, '/')}x` }, cwd: work }, { enabled: true, rules: {}, protected: [] });
assert.ok(g.decision === 'deny' && g.targets.length === 2, 'guard returns the stopped delete targets');
assert.ok(/Trash/.test(G.reason(g)), 'the block message points at the Trash');

// per-agent measurement
const tr = path.join(tmp, 'agent.jsonl');
const t0 = Date.parse('2026-11-06T10:00:00Z');
const line = (min, o) => JSON.stringify({ timestamp: new Date(t0 + min * 60e3).toISOString(), ...o });
const asst = (id, ctx, tools) => ({ type: 'assistant', message: { id, model: 'claude-x', usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: ctx }, content: tools.map(n => ({ type: 'tool_use', name: n })) } });
fs.writeFileSync(tr, [line(0, asst('a', 1000, ['Bash'])), line(1, asst('a', 1000, ['Bash'])), line(2, asst('b', 200000, ['Read', 'Read'])), line(60, asst('c', 1000, []))].join('\n'));
const m = RN.measure(tr);
assert.strictEqual(m.replies, 3, 'a reply split over several lines counts once');
assert.strictEqual(m.tools, 4);
assert.strictEqual(m.activeMin, 2, 'stalls are removed from working time'); assert.strictEqual(m.wallMin, 60);
assert.strictEqual(m.weighted, 30 + 300 + 3000 + Math.round(202000 * 0.1));
assert.ok(m.bigShare > 0 && m.peak === 201010, 'peak context and big-context share');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok: trash adds, refuses homes/drives/repos, keeps, empties and re-checks; guard hands stopped deletes to the trash; runs measure each agent');
