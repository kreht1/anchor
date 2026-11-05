'use strict';
// The provider bridge end to end: a fake OpenAI-compatible provider, a throwaway Anchor with a temp data folder, a
// profile with a saved key, then Anthropic-style requests (plain and streamed, with tools) through the bridge.
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 4800 + Math.floor(Math.random() * 50), MOCK = PORT + 60;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bridge-'));
let last = null; // what the fake provider received

const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
    last = { auth: req.headers.authorization, body: JSON.parse(b || '{}'), url: req.url };
    if (last.body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] });
      send({ choices: [{ index: 0, delta: { content: 'lo' } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file' } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"a.txt"}' } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      send({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } });
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Sure.', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    }
  });
});

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', ...headers } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

const anthropicBody = stream => ({
  model: 'm1', max_tokens: 50000, stream, system: [{ type: 'text', text: 'You are Claude Code.' }],
  tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  messages: [
    { role: 'user', content: 'read a.txt' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }] }, { type: 'text', text: 'and now?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  ],
});

(async () => {
  await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));
  const srv = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, ANCHOR_PORT: String(PORT), ANCHOR_DATA_DIR: DATA }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await req('GET', '/api/ping')).status === 200) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 150)); }
    const prof = JSON.parse((await req('POST', '/api/providers', { headers: { 'x-anchor': '1' }, body: { name: 'Mock', kind: 'openai', baseUrl: `http://127.0.0.1:${MOCK}/v1`, key: 'sk-test-123', models: { main: 'm1' }, maxOutput: 8192 } })).body);
    assert.ok(prof.id && prof.key.source === 'saved', 'profile saved with a stored key');
    assert.ok(!JSON.stringify(JSON.parse((await req('GET', '/api/providers')).body)).includes('sk-test-123'), 'the key is never sent back');
    assert.ok(!fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8').includes('sk-test-123') || process.platform !== 'win32', 'the key is encrypted at rest on Windows');
    assert.strictEqual((await req('POST', `/bridge/${prof.id}/v1/messages`, { body: anthropicBody(false) })).status, 401, 'no token, no bridge');
    const token = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).bridgeToken;
    assert.strictEqual((await req('POST', `/bridge/${prof.id}/v1/messages`, { body: anthropicBody(false), headers: { 'x-api-key': 'wrong'.padEnd(token.length, 'x') } })).status, 401, 'wrong token refused');

    const plain = await req('POST', `/bridge/${prof.id}/v1/messages`, { body: anthropicBody(false), headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(plain.status, 200, plain.body);
    assert.strictEqual(last.auth, 'Bearer sk-test-123', 'provider got the decrypted key');
    const m = last.body.messages;
    assert.strictEqual(m[0].role, 'system');
    assert.strictEqual(m[2].role, 'assistant'); assert.strictEqual(m[2].tool_calls[0].function.name, 'Read'); assert.strictEqual(m[2].content, 'Reading.');
    assert.strictEqual(m[3].role, 'tool'); assert.strictEqual(m[3].tool_call_id, 'toolu_1'); assert.strictEqual(m[3].content, 'hello');
    assert.strictEqual(m[4].role, 'user'); assert.ok(Array.isArray(m[4].content) && m[4].content[1].type === 'image_url', 'text + image user turn');
    assert.strictEqual(last.body.tools[0].function.name, 'Read'); assert.strictEqual(last.body.max_tokens, 8192, 'max output capped');
    const pr = JSON.parse(plain.body);
    assert.strictEqual(pr.stop_reason, 'tool_use'); assert.strictEqual(pr.content[1].type, 'tool_use'); assert.deepStrictEqual(pr.content[1].input, { pattern: 'x' });

    const st = await req('POST', `/bridge/${prof.id}/v1/messages`, { body: anthropicBody(true), headers: { 'x-api-key': token } });
    const events = st.body.split('\n\n').filter(Boolean).map(b => JSON.parse(b.split('\n').find(l => l.startsWith('data:')).slice(5)));
    assert.deepStrictEqual(events.map(e => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'], 'stream event order');
    assert.strictEqual(events[5].content_block.name, 'Read');
    assert.strictEqual(events[6].delta.partial_json + events[7].delta.partial_json, '{"file_path":"a.txt"}');
    assert.strictEqual(events[9].delta.stop_reason, 'tool_use'); assert.strictEqual(events[9].usage.output_tokens, 7);
    // failover chain: a rate-limited OpenAI-style provider, then an Anthropic-style one that answers
    let limitedHits = 0, anthHits = 0;
    const limited = http.createServer((q, s) => { limitedHits++; q.resume(); q.on('end', () => { s.writeHead(429, { 'content-type': 'application/json', 'retry-after': '600' }); s.end(JSON.stringify({ error: { message: 'Rate limit reached for requests' } })); }); });
    const anth = http.createServer((q, s) => { let b = ''; q.on('data', c => (b += c)); q.on('end', () => { anthHits++; const j = JSON.parse(b); s.writeHead(200, { 'content-type': 'application/json' });
      s.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: `anthropic member saw ${j.model}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); }); });
    await new Promise(r => limited.listen(MOCK + 1, '127.0.0.1', r));
    await new Promise(r => anth.listen(MOCK + 2, '127.0.0.1', r));
    const pa = JSON.parse((await req('POST', '/api/providers', { headers: { 'x-anchor': '1' }, body: { name: 'Limited', kind: 'openai', baseUrl: `http://127.0.0.1:${MOCK + 1}/v1`, key: 'k1', models: { main: 'a-main' } } })).body);
    const pc = JSON.parse((await req('POST', '/api/providers', { headers: { 'x-anchor': '1' }, body: { name: 'Anth', kind: 'anthropic', baseUrl: `http://127.0.0.1:${MOCK + 2}`, key: 'k2', models: { main: 'c-main', fast: 'c-fast' } } })).body);
    const ch = JSON.parse((await req('POST', '/api/providers', { headers: { 'x-anchor': '1' }, body: { name: 'My chain', kind: 'chain', members: [pa.id, pc.id] } })).body);
    assert.strictEqual(ch.kind, 'chain');
    const r1 = JSON.parse((await req('POST', `/bridge/${ch.id}/v1/messages`, { body: { ...anthropicBody(false), model: 'anchor-fast' }, headers: { 'x-api-key': token } })).body);
    assert.strictEqual(r1.content[0].text, 'anthropic member saw c-fast', 'fell through to the next provider with its fast model');
    assert.strictEqual(limitedHits, 1);
    await req('POST', `/bridge/${ch.id}/v1/messages`, { body: { ...anthropicBody(false), model: 'anchor-main' }, headers: { 'x-api-key': token } });
    assert.strictEqual(limitedHits, 1, 'the rate-limited provider cools down instead of being retried first');
    assert.strictEqual(anthHits, 2);
    limited.close(); anth.close();
    console.log('ok: bridge translates requests, plain and streamed replies, tool calls; failover chain skips a rate-limited provider; keys stay encrypted and are never returned');
  } finally { srv.kill(); mock.close(); fs.rmSync(DATA, { recursive: true, force: true }); }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
