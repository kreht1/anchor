'use strict';
// Codex support: rollout parsing (usage, context, limits), the governor and skill hints in Codex mode, Guard on
// apply_patch and argv shells, and the skill bridge (verdicts, port, Claude variables, BOM, sibling names, sync, unport).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-codex-'));
process.env.ANCHOR_DATA_DIR = path.join(tmp, 'data');
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.ANCHOR_AGENTS_SKILLS = path.join(tmp, 'agents-skills');

const CX = require('../lib/codex');
const SP = require('../lib/skillport');
const G = require('../lib/guard');
const GOV = require('../lib/governor');

// ---- a rollout like Codex writes
const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '18');
fs.mkdirSync(day, { recursive: true });
const file = path.join(day, 'rollout-2026-11-18T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl');
const t0 = Date.now() - 3 * 60000;
const ev = (dt, type, payload) => JSON.stringify({ timestamp: new Date(t0 + dt).toISOString(), type, payload });
fs.writeFileSync(file, [
  ev(0, 'session_meta', { id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', cwd: 'C:/work/shop', cli_version: '0.169.1' }),
  ev(1, 'turn_context', { model: 'gpt-5.5-codex', cwd: 'C:/work/shop' }),
  ev(2, 'event_msg', { type: 'user_message', message: '<environment_context>cwd</environment_context>' }),
  ev(3, 'event_msg', { type: 'user_message', message: 'add a checkout page to the shop with stripe payments and tests' }),
  ev(4, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 90000, cached_input_tokens: 60000, output_tokens: 4000, reasoning_output_tokens: 1000, total_tokens: 94000 }, last_token_usage: { input_tokens: 131000, cached_input_tokens: 120000, output_tokens: 900, total_tokens: 131900 }, model_context_window: 272000 },
    rate_limits: { primary: { used_percent: 42.4, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 } } }),
].join('\n') + '\n');

const s = CX.summarize(file);
assert.strictEqual(s.id, '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
assert.strictEqual(s.prompts, 1, 'environment context is not a prompt');
assert.strictEqual(s.total, 94000); assert.strictEqual(s.cached, 60000); assert.strictEqual(s.context, 131000); assert.strictEqual(s.window, 272000);
const u = CX.usage(7);
assert.strictEqual(u.sessions, 1); assert.strictEqual(u.cacheShare, 67);
assert.strictEqual(u.limits.primary.pct, 42); assert.strictEqual(u.limits.secondary.pct, 12);
assert.ok(Math.abs(Date.parse(u.limits.primary.resetAt) - (t0 + 4 + 3600000)) < 2000, 'reset from resets_in_seconds');
assert.ok(CX.isCodex(undefined, { transcript_path: file }) && CX.isCodex('codex', {}) && !CX.isCodex(undefined, { transcript_path: 'C:/x/.claude/projects/a/b.jsonl' }));

// ---- governor in Codex mode: tier note with /new, never a cache-cold block
const st = CX.sessionState(file);
assert.strictEqual(st.context, 131000); assert.deepStrictEqual(st.prompts, ['add a checkout page to the shop with stripe payments and tests']);
const g = GOV.decide({ transcript_path: file, session_id: 'cx1', prompt: 'now the order emails' }, {}, 'cli', true);
assert.ok(g.note && /120k|131k/.test(g.note) && !g.block, 'tier note');
const g2 = GOV.decide({ transcript_path: file, session_id: 'cx2', prompt: 'x' }, { cacheGuard: 'block' }, 'cli', true);
assert.ok(!g2.block, 'no cache-cold block in Codex');

// ---- Guard: argv shells and apply_patch
const ev2 = input => G.evaluate(input).decision;
assert.strictEqual(ev2({ tool_name: 'Bash', cwd: tmp, tool_input: { command: ['bash', '-lc', 'rm -rf ~/'] } }), 'deny');
assert.strictEqual(ev2({ tool_name: 'Bash', cwd: tmp, tool_input: { command: 'git status' } }), 'allow');
assert.strictEqual(ev2({ tool_name: 'apply_patch', cwd: tmp, tool_input: { command: '*** Begin Patch\n*** Delete File: .git/HEAD\n*** End Patch' } }), 'deny');
assert.strictEqual(ev2({ tool_name: 'apply_patch', cwd: tmp, tool_input: { command: '*** Begin Patch\n*** Update File: a.js\n@@\n-old\n+new\n*** End Patch' } }), 'allow');
assert.strictEqual(ev2({ tool_name: 'apply_patch', cwd: tmp, tool_input: { command: '*** Begin Patch\n*** Delete File: weights/model.safetensors\n*** End Patch' } }) !== 'allow', true);
const big = '-' + 'x'.repeat(8000);
assert.notStrictEqual(ev2({ tool_name: 'apply_patch', cwd: tmp, tool_input: { command: `*** Begin Patch\n*** Update File: big.js\n@@\n${big}\n+y\n*** End Patch` } }), 'allow');

// ---- skill bridge
const mk = (dir, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), text); return dir; };
const plug = path.join(tmp, 'plugins', 'superpowers', '7.0.0');
const a = { id: 'superpowers:planner', name: 'planner', source: 'plugin', plugin: 'superpowers@x', description: 'Plan work before coding',
  dir: mk(path.join(plug, 'skills', 'planner'), '\uFEFF---\nname: planner\ndescription: Plan work before coding\nlicense: MIT\n---\nUse TodoWrite for the checklist, then invoke superpowers:reviewer with the Skill tool.\nRun `${CLAUDE_PLUGIN_ROOT}/scripts/x.sh` and read ${CLAUDE_SKILL_DIR}/ref.md\n') };
const b = { id: 'superpowers:reviewer', name: 'reviewer', source: 'plugin', description: 'Review code',
  dir: mk(path.join(plug, 'skills', 'reviewer'), '---\nname: reviewer\ndescription: Review code\n---\nRead the diff and list problems.\n') };
const c = { id: 'morning', name: 'morning', source: 'user', description: 'Render the brief as a styled HTML artifact',
  dir: mk(path.join(tmp, 'u', 'morning'), '---\nname: morning\ndescription: Render the brief as a styled HTML artifact\n---\nPublish with the Artifact tool. The artifact updates daily. Share the artifact link.\n') };
const all = [a, b, c];
assert.strictEqual(SP.assess(b).verdict, 'works');
assert.strictEqual(SP.assess(a).verdict, 'adapted');
assert.deepStrictEqual(SP.assess(a).tools.sort(), ['Skill', 'TodoWrite']);
assert.strictEqual(SP.assess(c).verdict, 'claude-only');
assert.throws(() => SP.port(c, { known: all }), /Claude-only/);

const r = SP.port(a, { known: all });
assert.strictEqual(r.name, 'planner');
let out = fs.readFileSync(path.join(SP.DEST, 'planner', 'SKILL.md'), 'utf8');
assert.ok(out.startsWith('---\nname: planner\ndescription: "Plan work before coding"\nlicense: MIT\n---\n'), 'Codex frontmatter, no BOM, other keys kept');
assert.ok(out.includes(`${plug.split(path.sep).join('/')}/scripts/x.sh`), 'plugin root resolved');
assert.ok(out.includes(`${path.join(SP.DEST, 'planner').split(path.sep).join('/')}/ref.md`), 'skill dir resolved');
assert.ok(/Running in Codex/.test(out) && /update_plan/.test(out) && /Not in Codex yet: superpowers:reviewer/.test(out), 'note maps tools and names the missing sibling');

// porting the sibling and relinking names it as Codex calls it
SP.port(b, { known: all }); SP.relink(all);
out = fs.readFileSync(path.join(SP.DEST, 'planner', 'SKILL.md'), 'utf8');
assert.ok(/superpowers:reviewer → `\$reviewer`/.test(out), 'sibling named as $reviewer');
assert.strictEqual((out.match(/Running in Codex/g) || []).length, 1, 'the note is never doubled');

// Codex reads the port: it shows up in the Codex skills list, with its origin
const seen = CX.skills().find(x => x.name === 'planner');
assert.ok(seen && seen.port && seen.port.source.id === 'superpowers:planner' && !seen.bom);

// sync: unchanged, then changed source
assert.deepStrictEqual(SP.sync(all).updated, []);
fs.appendFileSync(path.join(a.dir, 'SKILL.md'), '\nAlso check the tests.\n');
assert.deepStrictEqual(SP.sync(all).updated, ['planner']);
assert.ok(fs.readFileSync(path.join(SP.DEST, 'planner', 'SKILL.md'), 'utf8').includes('Also check the tests.'));

// a folder Anchor didn't make is never overwritten or removed
mk(path.join(SP.DEST, 'mine'), '---\nname: mine\ndescription: x\n---\n');
assert.throws(() => SP.port({ ...b, id: 'other:mine', name: 'mine' }, { known: all }), /not made by Anchor/);
assert.throws(() => SP.unport('mine'), /not a skill Anchor ported/);
assert.deepStrictEqual(SP.unport('reviewer'), { ok: true, removed: 'reviewer' });

const cat = SP.catalog(all);
assert.ok(cat.find(x => x.id === 'superpowers:planner').ported && !cat.find(x => x.id === 'superpowers:reviewer').ported);
assert.strictEqual(SP.codexName('anthropic-skills:Some Skill_v2'), 'some-skill-v2');

// skill hints in Codex use Codex's own skills
const SM = require('../lib/skillmatch');
mk(path.join(process.env.CODEX_HOME, 'skills', 'pdf'), '---\nname: pdf\ndescription: Read, merge and split PDF files\n---\n');
mk(path.join(process.env.CODEX_HOME, 'skills', 'deploy'), '---\nname: deploy\ndescription: Ship the app to production servers\n---\n');
const hint = SM.hook(JSON.stringify({ session_id: 'h1', prompt: 'use the planner to plan the importer before coding it' }), true);
assert.ok(/Anchor skill hint: planner/.test(hint) && /SKILL\.md/.test(hint), 'Codex hint names the ported skill');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok: codex rollouts give usage, context and limit resets; governor and hints work in Codex; guard reads apply_patch and argv shells; skill bridge ports, resolves, links, syncs and never touches folders it did not make');
