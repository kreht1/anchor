'use strict';
// Model providers for when a Claude plan runs out: Claude Code can talk to any Anthropic-compatible endpoint
// (OpenRouter, Ollama 0.14+, gateways), and through Anchor's bridge (lib/bridge.js) to OpenAI-compatible ones (Groq,
// LM Studio, OpenRouter's any-model API...). A profile never changes your normal sessions: Anchor launches a separate
// Claude Code with the profile's environment.
//
// Keys: either the name of an environment variable (Anchor never stores the key), or saved by Anchor: on Windows
// encrypted with your Windows account (DPAPI), elsewhere in a file only you can read. Keys are never sent to the page.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const P = require('./paths');
const kv = require('./kv');

const FILE = 'providers.json';
const SECRETS = path.join(P.DATA, 'secrets.json');
const ID = /^[a-z0-9-]{2,40}$/;
const keyCache = new Map(); // id -> plaintext, in memory only (the bridge needs it per request)

const PRESETS = [
  { preset: 'openrouter-claude', name: 'OpenRouter (Claude models)', kind: 'anthropic', baseUrl: 'https://openrouter.ai/api', needsKey: true, keyEnv: 'OPENROUTER_API_KEY',
    note: "Direct, no bridge. OpenRouter guarantees this route only for Anthropic's own models; pay-as-you-go on your OpenRouter credit.", models: { main: 'anthropic/claude-sonnet-4.5', fast: 'anthropic/claude-haiku-4.5' } },
  { preset: 'openrouter-any', name: 'OpenRouter (any model, incl. free ones)', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyEnv: 'OPENROUTER_API_KEY',
    note: 'Through the Anchor bridge, so non-Claude models work. Pick a model that supports tool calling; models ending in :free cost nothing but are rate-limited.', models: { main: '', fast: '' } },
  { preset: 'groq', name: 'GroqCloud', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, keyEnv: 'GROQ_API_KEY',
    note: 'Very fast, with a free tier. Through the Anchor bridge. Pick a model with tool calling; free-tier rate limits are tight for long agent sessions.', models: { main: '', fast: '' }, maxOutput: 8192 },
  { preset: 'gemini', name: 'Google Gemini (AI Studio key)', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, keyEnv: 'GEMINI_API_KEY',
    note: 'A free AI Studio key (aistudio.google.com) works without a card: Flash models, tight daily limits; outside the EU/UK free-tier prompts may be used by Google. A Gemini app subscription does not include API access.', models: { main: 'gemini-2.5-flash', fast: 'gemini-2.5-flash-lite' } },
  { preset: 'ccr', name: 'Claude Code Router (on this computer)', kind: 'anthropic', baseUrl: 'http://127.0.0.1:3456', needsKey: true, keyEnv: 'CCR_API_KEY',
    note: 'Use your Claude Code Router gateway as one provider: CCR does its own multi-provider routing. Create a client key in the CCR UI (API Keys) and paste it here. Anchor can install, start and stop CCR below.', models: { main: 'default', fast: 'default' } },
  { preset: 'ollama', name: 'Ollama (on this computer)', kind: 'anthropic', baseUrl: 'http://localhost:11434', needsKey: false,
    note: 'Fully local and free. Needs Ollama 0.14 or newer running, and a model with tool calling (for example a qwen3-coder or gpt-oss model).', models: { main: '', fast: '' } },
  { preset: 'lmstudio', name: 'LM Studio (on this computer)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', needsKey: false,
    note: "Fully local and free. Start LM Studio's server and load a model with tool calling.", models: { main: '', fast: '' } },
  { preset: 'custom-anthropic', name: 'Custom: Anthropic-compatible', kind: 'anthropic', baseUrl: '', needsKey: true, note: 'Any gateway that speaks the Anthropic Messages API (the base URL without /v1).', models: { main: '', fast: '' } },
  { preset: 'custom-openai', name: 'Custom: OpenAI-compatible', kind: 'openai', baseUrl: '', needsKey: true, note: 'Any endpoint with /chat/completions, through the Anchor bridge (the base URL up to and including /v1).', models: { main: '', fast: '' } },
];

// ---------------------------------------------------------------- secrets
function readSecrets() { try { return JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { return {}; } }
function writeSecrets(s) {
  fs.mkdirSync(P.DATA, { recursive: true });
  fs.writeFileSync(SECRETS, JSON.stringify(s), { mode: 0o600 });
  try { fs.chmodSync(SECRETS, 0o600); } catch { /* Windows: DPAPI protects the value */ }
}
function ps(script, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, windowsHide: true, timeout: 15000 }).toString().trim();
}
function seal(plain) {
  if (process.platform === 'win32') return { dpapi: ps('$s=[Console]::In.ReadToEnd(); ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString', plain) };
  return { plain: Buffer.from(plain).toString('base64') };
}
function unseal(v) {
  if (!v) return null;
  if (v.dpapi) return ps('$e=[Console]::In.ReadToEnd().Trim(); $ss=ConvertTo-SecureString $e; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))', v.dpapi);
  if (v.plain) return Buffer.from(v.plain, 'base64').toString();
  return null;
}

// ---------------------------------------------------------------- profiles
function all() { return kv.read(FILE, { profiles: [] }).profiles || []; }
function find(id) { return all().find(p => p.id === id) || null; }

function publicView(p) {
  if (p.kind === 'chain') return { ...p, key: { source: 'chain' } };
  const s = readSecrets()[p.id];
  return { ...p, key: p.keyEnv ? { source: 'env', name: p.keyEnv, set: !!process.env[p.keyEnv] } : s ? { source: 'saved', how: s.dpapi ? 'encrypted with your Windows account' : 'in a file only you can read' } : { source: 'none' } };
}

function list() { return { profiles: all().map(publicView), presets: PRESETS, fallback: kv.read(FILE, {}).fallback || null }; }

function clean(s, n) { return String(s ?? '').trim().slice(0, n); }

function save(input) {
  const data = kv.read(FILE, { profiles: [] });
  data.profiles = data.profiles || [];
  if (input.kind === 'chain') return saveChain(input, data);
  const kind = input.kind === 'openai' ? 'openai' : 'anthropic';
  let id = clean(input.id, 40).toLowerCase();
  if (!id) id = (clean(input.name, 30).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider') + '-' + crypto.randomBytes(2).toString('hex');
  if (!ID.test(id)) throw new Error('bad profile id');
  const baseUrl = clean(input.baseUrl, 300).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new Error('the base URL must start with http:// or https://');
  if (/^http:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl)) throw new Error('use https:// for anything that is not on this computer');
  if (kind === 'anthropic' && /\/v1$/.test(baseUrl)) throw new Error('for an Anthropic-compatible endpoint, leave /v1 off the base URL (Claude Code adds it)');
  const keyEnv = clean(input.keyEnv, 80);
  if (keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error('environment variable names use letters, digits and _');
  const models = { main: clean(input.models && input.models.main, 120), fast: clean(input.models && input.models.fast, 120) };
  const prof = { id, name: clean(input.name, 60) || id, kind, preset: clean(input.preset, 40), baseUrl, keyEnv: keyEnv || null, models,
    maxOutput: Number(input.maxOutput) > 0 ? Math.min(200000, Number(input.maxOutput)) : null, updatedAt: new Date().toISOString() };
  const i = data.profiles.findIndex(p => p.id === id);
  if (i >= 0) data.profiles[i] = prof; else data.profiles.push(prof);
  if (input.key) { // write-only: the page can set a key, never read one back
    const s = readSecrets(); s[id] = seal(String(input.key).trim()); writeSecrets(s); keyCache.delete(id);
    prof.keyEnv = null; data.profiles[i >= 0 ? i : data.profiles.length - 1] = prof;
  }
  if (keyEnv) { const s = readSecrets(); if (s[id]) { delete s[id]; writeSecrets(s); keyCache.delete(id); } }
  kv.write(FILE, data);
  return publicView(prof);
}

// a failover chain: an ordered list of other profiles; the bridge tries them in turn
function saveChain(input, data) {
  let id = clean(input.id, 40).toLowerCase() || 'chain-' + crypto.randomBytes(2).toString('hex');
  if (!ID.test(id)) throw new Error('bad profile id');
  const members = (Array.isArray(input.members) ? input.members : []).map(String).filter(m => m !== id);
  const known = new Map(data.profiles.map(p => [p.id, p]));
  if (members.length < 2) throw new Error('a chain needs at least two providers');
  for (const m of members) { const p = known.get(m); if (!p) throw new Error(`unknown provider ${m}`); if (p.kind === 'chain') throw new Error('a chain cannot contain another chain'); if (!p.models.main) throw new Error(`${p.name} has no main model`); }
  const prof = { id, name: clean(input.name, 60) || 'Failover chain', kind: 'chain', preset: 'chain', baseUrl: '', keyEnv: null, members, models: { main: 'anchor-main', fast: 'anchor-fast' },
    cooldown: Math.max(15, Math.min(3600, Number(input.cooldown) || 120)), updatedAt: new Date().toISOString() };
  const i = data.profiles.findIndex(p => p.id === id);
  if (i >= 0) data.profiles[i] = prof; else data.profiles.push(prof);
  kv.write(FILE, data);
  return publicView(prof);
}

function remove(id) {
  const data = kv.read(FILE, { profiles: [] });
  data.profiles = (data.profiles || []).filter(p => p.id !== id);
  if (data.fallback === id) data.fallback = null;
  kv.write(FILE, data);
  const s = readSecrets(); if (s[id]) { delete s[id]; writeSecrets(s); }
  keyCache.delete(id);
  return { ok: true };
}

function setFallback(id) {
  const data = kv.read(FILE, { profiles: [] });
  if (id && !find(id)) throw new Error('unknown profile');
  data.fallback = id || null;
  kv.write(FILE, data);
  return { ok: true };
}

function keyFor(p) {
  if (p.keyEnv) return process.env[p.keyEnv] || null;
  if (keyCache.has(p.id)) return keyCache.get(p.id);
  const k = unseal(readSecrets()[p.id]);
  if (k) keyCache.set(p.id, k);
  return k;
}

function bridgeToken() {
  const s = kv.read('settings.json', {});
  if (s.bridgeToken) return s.bridgeToken;
  s.bridgeToken = crypto.randomBytes(24).toString('hex');
  kv.write('settings.json', s);
  return s.bridgeToken;
}

// the environment a Claude Code launched with this profile gets
function envFor(p) {
  const key = keyFor(p);
  const main = p.models.main || undefined, fast = p.models.fast || p.models.main || undefined;
  const bridged = p.kind === 'openai' || p.kind === 'chain';
  const env = {
    ANTHROPIC_BASE_URL: bridged ? `http://127.0.0.1:${P.PORT}/bridge/${p.id}` : p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: bridged ? bridgeToken() : key || (p.preset === 'ollama' ? 'ollama' : 'none'),
    ANTHROPIC_API_KEY: '', // a non-empty key would win over the token and skip the provider
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANCHOR_PROVIDER: p.id,
  };
  if (main) Object.assign(env, { ANTHROPIC_MODEL: main, ANTHROPIC_DEFAULT_OPUS_MODEL: main, ANTHROPIC_DEFAULT_SONNET_MODEL: main, CLAUDE_CODE_SUBAGENT_MODEL: main });
  if (fast) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast;
  return env;
}

// ---------------------------------------------------------------- talking to a provider (only when you click)
async function http(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

function authHeaders(p) {
  const key = keyFor(p);
  if (p.kind === 'openai') return key ? { authorization: `Bearer ${key}` } : {};
  return key ? { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' } : { 'anthropic-version': '2023-06-01' };
}

async function models(id) {
  const p = find(id); if (!p) throw new Error('unknown profile');
  if (p.kind === 'chain') return [];
  let url;
  if (p.preset === 'ollama' || /:11434/.test(p.baseUrl)) url = `${p.baseUrl}/api/tags`;
  else if (/openrouter\.ai/.test(p.baseUrl)) url = 'https://openrouter.ai/api/v1/models';
  else url = p.kind === 'openai' ? `${p.baseUrl}/models` : `${p.baseUrl}/v1/models`;
  const r = await http(url, { headers: authHeaders(p) });
  if (!r.ok) throw new Error(`${r.status} from the provider`);
  const j = await r.json();
  const arr = j.models || j.data || [];
  return arr.map(m => ({ id: m.id || m.name || m.model, name: m.name || m.id, tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null,
    free: /:free$/.test(m.id || '') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0) || undefined, context: m.context_length || null }))
    .filter(m => m.id).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 800);
}

async function test(id) {
  const p = find(id); if (!p) throw new Error('unknown profile');
  if (p.kind === 'chain') {
    const out = [];
    for (const m of p.members) { try { const r = await test(m); out.push(`${find(m).name}: OK (${r.ms} ms)`); } catch (e) { out.push(`${(find(m) || { name: m }).name}: ${e.message}`); } }
    return { ok: true, ms: 0, reply: out.join(' · ') };
  }
  if (!p.models.main) throw new Error('pick a main model first');
  if (!['ollama', 'lmstudio'].includes(p.preset) && !keyFor(p)) throw new Error(p.keyEnv ? `the environment variable ${p.keyEnv} is not set for Anchor` : 'no key saved');
  const t0 = Date.now();
  let r, text;
  if (p.kind === 'openai') {
    r = await http(`${p.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(p) },
      body: JSON.stringify({ model: p.models.main, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }) }, 60000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || `${r.status} from the provider`);
    text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  } else {
    r = await http(`${p.baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(p) },
      body: JSON.stringify({ model: p.models.main, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }) }, 60000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || `${r.status} from the provider`);
    text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  return { ok: true, ms: Date.now() - t0, reply: String(text || '').slice(0, 200) };
}

module.exports = { list, save, remove, setFallback, find, keyFor, envFor, bridgeToken, models, test, PRESETS };
