'use strict';
// End-to-end check: starts a throwaway server on a spare port with a temp board, then exercises the API, the
// security guards and the redaction. Usage: npm test
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 4790 + Math.floor(Math.random() * 9);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
const env = { ...process.env, ANCHOR_PORT: String(PORT), ANCHOR_DATA_DIR: DATA };

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
}

(async () => {
  const { redact } = require('../lib/redact');
  assert.ok(!redact('see https://discord.com/api/webhooks/123456/abcDEF_ghi-jkl now').includes('abcDEF'));
  assert.ok(!redact('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz').includes('abcdefghijklmnop'));
  assert.strictEqual(redact('nothing secret here'), 'nothing secret here');

  const srv = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await req('GET', '/api/ping')).status === 200) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 150)); }
    const o = JSON.parse((await req('GET', '/api/overview')).body);
    assert.ok(Array.isArray(o.sessions) && Array.isArray(o.tasks) && Array.isArray(o.board), 'overview shape');
    assert.strictEqual((await req('GET', '/api/overview', { headers: { host: 'evil.example' } })).status, 421, 'DNS-rebinding guard');
    assert.strictEqual((await req('POST', '/api/board', { body: { title: 'x' } })).status, 403, 'header guard');
    assert.strictEqual((await req('POST', '/api/board', { body: { title: 'x' }, headers: { 'x-anchor': '1', origin: 'http://evil.example' } })).status, 403, 'origin guard');
    const add = await req('POST', '/api/board', { body: { title: 'smoke item', project: 'test' }, headers: { 'x-anchor': '1', 'content-type': 'application/json' } });
    assert.strictEqual(add.status, 201);
    const id = JSON.parse(add.body).id;
    assert.strictEqual(JSON.parse((await req('PATCH', `/api/board/${id}`, { body: { status: 'done' }, headers: { 'x-anchor': '1' } })).body).status, 'done');
    assert.strictEqual((await req('DELETE', `/api/board/${id}`, { headers: { 'x-anchor': '1' } })).status, 200);
    assert.strictEqual((await req('GET', '/..%2F..%2Fpackage.json')).status, 403, 'path traversal');
    if (o.sessions[0]) {
      const c = JSON.parse((await req('GET', `/api/session/${o.sessions[0].id}?limit=5`)).body);
      assert.ok(c.items.length <= 5 && c.total >= c.items.length, 'conversation paging');
    }
    const sk = JSON.parse((await req('GET', '/api/skills')).body);
    assert.ok(Array.isArray(sk.skills) && Array.isArray(sk.plugins), 'skills shape');
    assert.ok(Array.isArray(JSON.parse((await req('GET', '/api/projects')).body)), 'projects list');
    assert.strictEqual((await req('GET', '/api/fs/read?path=' + encodeURIComponent(path.join(os.homedir(), '.ssh', 'id_rsa')))).status, 400, 'secret files hidden');
    assert.strictEqual((await req('GET', '/api/fs/read?path=' + encodeURIComponent('C:\\Windows\\win.ini'))).status, 400, 'outside roots refused');
    assert.strictEqual((await req('POST', '/api/runs', { body: { kind: 'study', cwd: os.tmpdir() } })).status, 403, 'runs need the header');
    assert.strictEqual((await req('POST', '/api/skills/toggle', { body: { id: 'x', source: 'user', enabled: false } })).status, 403, 'toggle needs the header');
    assert.strictEqual((await req('POST', '/api/runs', { body: { kind: 'study', cwd: path.parse(os.homedir()).root }, headers: { 'x-anchor': '1', 'content-type': 'application/json' } })).status, 400, 'no whole-drive study');
    assert.strictEqual((await req('POST', '/api/hub/inspect', { body: { repo: 'https://evil.example/x' }, headers: { 'x-anchor': '1', 'content-type': 'application/json' } })).status, 400, 'GitHub URLs only');
    assert.strictEqual((await req('GET', '/api/graph?root=' + encodeURIComponent(os.tmpdir()))).status, 400, 'graphs only for known projects');
    assert.strictEqual((await req('POST', '/api/studio', { body: { type: 'slides', title: 'x', brief: 'y' } })).status, 403, 'studio needs the header');
    assert.strictEqual((await req('POST', '/api/installs/ccr', { body: {} })).status, 403, 'installs need the header');
    assert.strictEqual((await req('POST', '/api/installs/rm-rf', { body: {}, headers: { 'x-anchor': '1', 'content-type': 'application/json' } })).status, 400, 'only listed installs');
    assert.strictEqual((await req('POST', '/api/studio', { body: { type: 'slides', title: 'x', brief: 'y', sources: [path.join(os.homedir(), '.ssh', 'id_rsa')] }, headers: { 'x-anchor': '1', 'content-type': 'application/json' } })).status, 400, 'no secret sources');
    const ccr = JSON.parse((await req('GET', '/api/ccr')).body);
    assert.ok(!/token/i.test(JSON.stringify(ccr.service || {})), 'CCR token never exposed');
    const use = (await req('GET', '/api/usage')).body;
    assert.ok(!/accessToken|refreshToken|sk-ant-|oauthToken/i.test(use), 'usage never exposes login tokens');
    assert.ok('session' in JSON.parse(use) && 'weekly' in JSON.parse(use), 'usage shape');
    const act = JSON.parse((await req('GET', '/api/activity?hours=1')).body);
    assert.ok(Array.isArray(act.events) && Array.isArray(act.agents), 'activity shape');
    console.log(`ok: ${o.sessions.length} sessions, ${o.tasks.length} tasks indexed, ${sk.skills.length} skills; guards, board, skills, code, runs and graph APIs pass`);
  } finally {
    srv.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
