'use strict';
// The token audit, on a made-up transcript with known waste: a huge PDF read, one file read four times, a skill loaded,
// the cache rebuilt after two idle hours, a hook note. Each must be found and turned into a fix.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-tokens-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.ANCHOR_DATA_DIR = path.join(home, 'data');
const cwd = path.join(home, 'proj');
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'x'.repeat(9000)); // ~2.5k tokens of project instructions
const pdir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(pdir, { recursive: true });

const t0 = Date.now() - 3 * 3600e3;
const at = min => new Date(t0 + min * 60000).toISOString();
const lines = [];
let n = 0;
const reply = (min, usage, content = []) => lines.push({ type: 'assistant', sessionId: 's1', cwd, timestamp: at(min), message: { id: `m${++n}`, model: 'claude-opus-5-5', usage, content } });
const result = (min, id, text, meta) => lines.push({ type: 'user', sessionId: 's1', cwd, timestamp: at(min), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...meta });
lines.push({ type: 'attachment', sessionId: 's1', timestamp: at(0), attachment: { type: 'hook_additional_context', hookName: 'SessionStart:startup', content: ['y'.repeat(3600)] } });
lines.push({ type: 'attachment', sessionId: 's1', timestamp: at(0), attachment: { type: 'skill_listing', content: 'z'.repeat(18000) } });
reply(1, { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0 },
  [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: path.join(cwd, 'manual.pdf') } }]);
result(1, 'r1', 'p'.repeat(360000)); // ~100k tokens
for (let i = 0; i < 4; i++) {
  reply(2 + i, { input_tokens: 5, output_tokens: 40, cache_creation_input_tokens: 3000, cache_read_input_tokens: 120000 },
    [{ type: 'tool_use', id: `a${i}`, name: 'Read', input: { file_path: i % 2 ? path.join(cwd, 'app.js') : path.join(cwd, 'app.js').replace(/\\/g, '/') } }]);
  result(2 + i, `a${i}`, 'c'.repeat(36000)); // ~10k tokens each, the same file four times
}
reply(10, { input_tokens: 5, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 160000 },
  [{ type: 'tool_use', id: 'sk', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }]);
result(10, 'sk', 'Launching skill: superpowers:brainstorming');
lines.push({ type: 'user', sessionId: 's1', cwd, timestamp: at(10), isMeta: true, sourceToolUseID: 'sk', message: { content: [{ type: 'text', text: 'Base directory for this skill: C:\\x\\brainstorming\n\n' + 'b'.repeat(14000) }] } });
reply(140, { input_tokens: 5, output_tokens: 40, cache_creation_input_tokens: 170000, cache_read_input_tokens: 0 }); // two hours away: rebuilt
for (let i = 0; i < 10; i++) reply(141 + i, { input_tokens: 5, output_tokens: 40, cache_creation_input_tokens: 500, cache_read_input_tokens: 170000 });
reply(151, { input_tokens: 5, output_tokens: 40, cache_creation_input_tokens: 500, cache_read_input_tokens: 170000 }); // duplicate id below must not count twice
lines.push({ ...lines[lines.length - 1] });
fs.writeFileSync(path.join(pdir, 's1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

const T = require('../lib/tokens');
const a = T.audit({ days: 1 });
assert.strictEqual(a.sessions, 1);
assert.strictEqual(a.totals.replies, 18, 'a reply logged twice is counted once');
assert.ok(a.outputs[0].tool === 'Read' && /manual\.pdf$/.test(a.outputs[0].what) && a.outputs[0].tokens > 90000, 'the big PDF read is the largest output');
assert.strictEqual(a.rereads.length, 1, 'the same file under two spellings is one file');
assert.strictEqual(a.rereads[0].times, 4);
assert.ok(a.skills[0].name === 'superpowers:brainstorming' && a.skills[0].tokens > 3500, 'the loaded skill is named after its Skill call');
assert.strictEqual(a.rebuilds.count, 1);
assert.strictEqual(a.rebuilds.idle, 1, 'the rebuild after two hours away is an idle one');
assert.strictEqual(a.longSessions.length, 1, 'eleven replies over 150k context make a long session');
assert.ok(a.hooks.find(h => h.hook === 'SessionStart').tokens >= 900);
const ids = a.tips.map(x => x.id);
for (const id of ['documents', 'rereads', 'skills', 'cache', 'long', 'standing', 'outputs']) assert.ok(ids.includes(id), `a fix is offered for ${id}`);
for (let i = 1; i < a.tips.length; i++) assert.ok(a.tips[i - 1].saves >= a.tips[i].saves, 'fixes come biggest saving first');
assert.ok(a.upfront.items.some(x => x.what === 'CLAUDE.md (project)' && x.tokens > 2000), 'project CLAUDE.md counts as read up front');
assert.ok(a.upfront.items.some(x => /Skill list/.test(x.what)), 'the skill listing counts as read up front');
const txt = T.text(a);
assert.ok(/What to change/.test(txt) && /manual\.pdf/.test(txt));
assert.strictEqual(T.audit({ days: 1 }).totals.replies, 18, 'a second audit (from cache) gives the same answer');

fs.rmSync(home, { recursive: true, force: true });
console.log('ok: token audit finds the PDF read, the re-reads, the skill load, the idle cache rebuild, the long session and the standing instructions');
