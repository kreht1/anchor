'use strict';
// Anchor token governor: the cache-cold guard, the context tiers and the topic-switch hint.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.ANCHOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gov-'));
const G = require('../lib/governor');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gov-tr-'));
const MIN = 60000;

function transcript(name, { ctx, agoMin, ttl = '1h', prompts = ['fix the retina segmentation pipeline and its tests'] }) {
  const f = path.join(dir, name + '.jsonl');
  const t = new Date(Date.now() - agoMin * MIN).toISOString();
  const usage = { input_tokens: 2, cache_read_input_tokens: ctx - 1000, cache_creation_input_tokens: 998, output_tokens: 500,
    cache_creation: ttl === '1h' ? { ephemeral_1h_input_tokens: 998, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 998 } };
  const lines = [];
  for (const p of prompts) lines.push({ type: 'user', timestamp: t, message: { role: 'user', content: p } });
  lines.push({ type: 'user', timestamp: t, message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
  lines.push({ type: 'assistant', timestamp: t, isSidechain: true, message: { usage: { input_tokens: 9, cache_read_input_tokens: 999999 } } });
  lines.push({ type: 'assistant', timestamp: t, message: { usage } });
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const S = { governor: true, cacheGuard: 'block' };
const run = (f, prompt, sid = path.basename(f), env = 'cli', st = S) => G.decide({ transcript_path: f, session_id: sid, prompt }, st, env);

// reading the session
const st = G.sessionState(transcript('read', { ctx: 180000, agoMin: 5 }));
assert.strictEqual(st.context, 180000, 'context = input + cache read + cache written of the last main-thread reply');
assert.strictEqual(st.ttlMin, 60, 'a 1-hour cache tier is read from the transcript');
assert.strictEqual(st.prompts.length, 1, 'tool results and sidechains are not prompts');
assert.strictEqual(G.sessionState(transcript('ttl5', { ctx: 90000, agoMin: 1, ttl: '5m' })).ttlMin, 5);

// cache-cold guard: big session, cache expired -> block once; the same message again goes through
const cold = transcript('cold', { ctx: 180000, agoMin: 75 });
let d = run(cold, 'continue with the retina tests');
assert.strictEqual(d.block, true, 'blocks a big session whose cache expired');
assert.match(d.reason, /180k/); assert.match(d.reason, /\/compact/); assert.match(d.reason, /\/clear/);
assert.strictEqual(run(cold, 'continue with the retina tests').block, undefined, 'sending the same message again goes through');
assert.strictEqual(run(cold, 'something else entirely').block, undefined, 'the guard fires once per cold return');
assert.strictEqual(run(transcript('warm', { ctx: 180000, agoMin: 20 }), 'go on').block, undefined, 'a warm cache is never blocked');
assert.strictEqual(run(transcript('small', { ctx: 30000, agoMin: 300 }), 'go on').block, undefined, 'a small session is never blocked');
assert.strictEqual(run(transcript('cold5', { ctx: 120000, agoMin: 8, ttl: '5m' }), 'go on').block, true, 'a 5-minute cache expires after 5 minutes');
assert.strictEqual(run(transcript('sdk', { ctx: 180000, agoMin: 90 }), 'go on', 'sdk1', 'sdk-ts').block, undefined, 'scripted (SDK) sessions are never blocked');
d = run(transcript('warnmode', { ctx: 180000, agoMin: 90 }), 'go on', 'w1', 'cli', { governor: true, cacheGuard: 'warn' });
assert.strictEqual(d.block, undefined); assert.match(d.note, /cache/i, 'warn mode tells Claude instead of blocking');
assert.deepStrictEqual(run(transcript('off', { ctx: 180000, agoMin: 90 }), 'go on', 'o1', 'cli', { governor: false }), {}, 'governor off does nothing');

// context tiers: one note per tier per session
const big = transcript('big', { ctx: 130000, agoMin: 2 });
d = run(big, 'fix the retina segmentation tests');
assert.match(d.note || '', /\/compact/, 'past 120k Claude is told to suggest /compact at the next milestone');
assert.strictEqual(run(big, 'fix the retina segmentation tests again').note, undefined, 'the same tier is noted once');

// topic switch in a big session
const topic = transcript('topic', { ctx: 150000, agoMin: 2, prompts: ['train the retina segmentation model on kaggle', 'score the retina segmentation results'] });
run(topic, 'score the retina results');  // uses up the tier note
d = run(topic, 'build me a roblox obby with lava jumps, checkpoints and a coin shop');
assert.match(d.note || '', /\/clear/, 'an unrelated request in a big session suggests /clear');

console.log('ok: governor reads context and cache tier, blocks a cold big session once, warns, notes tiers once, spots topic switches');
