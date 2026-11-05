'use strict';
// The Anchor bridge: lets Claude Code use OpenAI-compatible providers (Groq, LM Studio, OpenRouter's any-model API...).
// Claude Code sends Anthropic Messages requests to http://127.0.0.1:<port>/bridge/<profile>/v1/messages; the bridge
// translates them to /chat/completions (text, images, tools, tool results), calls the provider with the key held by
// Anchor, and translates the answer back, streaming included. Only callers holding the local bridge token get in.
const crypto = require('crypto');
const PR = require('./providers');

function text(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function toOpenAI(body, p) {
  const msgs = [];
  const sys = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map(b => b.text || '').join('\n\n') : '';
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const t = text(m.content);
      msgs.push({ role: 'assistant', content: t || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become "tool" messages (they must follow the assistant's calls), the rest one user message
    for (const b of m.content.filter(x => x.type === 'tool_result')) {
      const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : '')).join('\n') : '';
      msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ERROR: ' : '') + c });
    }
    const parts = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.source && b.source.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    if (parts.length) msgs.push({ role: 'user', content: parts.every(x => x.type === 'text') ? parts.map(x => x.text).join('\n') : parts });
  }
  const out = { model: body.model, messages: msgs, max_tokens: Math.min(body.max_tokens || 4096, p.maxOutput || Infinity), stream: !!body.stream };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences.slice(0, 4);
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.filter(t => t.name && t.input_schema).map(t => ({ type: 'function', function: { name: t.name, description: (t.description || '').slice(0, 4000), parameters: t.input_schema } }));
    const tc = body.tool_choice;
    if (tc) out.tool_choice = tc.type === 'any' ? 'required' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : tc.type === 'none' ? 'none' : 'auto';
  }
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
const newId = () => 'msg_anchor_' + crypto.randomBytes(10).toString('hex');
const parseArgs = s => { try { return JSON.parse(s || '{}'); } catch { return { _raw: s }; } };

function fromOpenAI(j, model) {
  const c = (j.choices && j.choices[0]) || {};
  const m = c.message || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const t of m.tool_calls || []) content.push({ type: 'tool_use', id: t.id || 'toolu_' + crypto.randomBytes(8).toString('hex'), name: t.function.name, input: parseArgs(t.function.arguments) });
  return { id: newId(), type: 'message', role: 'assistant', model, content, stop_reason: STOP[c.finish_reason] || 'end_turn', stop_sequence: null,
    usage: { input_tokens: (j.usage && j.usage.prompt_tokens) || 0, output_tokens: (j.usage && j.usage.completion_tokens) || 0 } };
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); }

async function stream(up, res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, 'message_start', { message: { id: newId(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let idx = -1, open = null; // open: 'text' or 'tool:<n>'
  const tools = new Map();     // openai tool index -> our block index
  let stop = 'end_turn', usage = { input_tokens: 0, output_tokens: 0 };
  const close = () => { if (open !== null) { sse(res, 'content_block_stop', { index: idx }); open = null; } };
  const reader = up.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = { input_tokens: j.usage.prompt_tokens || 0, output_tokens: j.usage.completion_tokens || 0 };
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (d.content) {
        if (open !== 'text') { close(); idx++; open = 'text'; sse(res, 'content_block_start', { index: idx, content_block: { type: 'text', text: '' } }); }
        sse(res, 'content_block_delta', { index: idx, delta: { type: 'text_delta', text: d.content } });
      }
      for (const t of d.tool_calls || []) {
        const k = t.index ?? 0;
        if (!tools.has(k)) {
          close(); idx++; tools.set(k, idx); open = 'tool:' + k;
          sse(res, 'content_block_start', { index: idx, content_block: { type: 'tool_use', id: t.id || 'toolu_' + crypto.randomBytes(8).toString('hex'), name: (t.function && t.function.name) || '', input: {} } });
        }
        if (t.function && t.function.arguments) sse(res, 'content_block_delta', { index: tools.get(k), delta: { type: 'input_json_delta', partial_json: t.function.arguments } });
      }
      if (ch.finish_reason) stop = STOP[ch.finish_reason] || 'end_turn';
    }
  }
  close();
  sse(res, 'message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  sse(res, 'message_stop', {});
  res.end();
}

function anthropicError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'api_error', message } }));
}

// path: /bridge/<id>/v1/messages[/count_tokens]
async function handle(req, res, parts, body) {
  const id = parts[1];
  const p = PR.find(id);
  if (!p || (p.kind !== 'openai' && p.kind !== 'chain')) return anthropicError(res, 404, 'unknown Anchor bridge profile');
  const tok = String(req.headers['x-api-key'] || '').trim() || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const want = PR.bridgeToken();
  if (!tok || tok.length !== want.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want))) return anthropicError(res, 401, 'the Anchor bridge token is missing or wrong');
  const rest = parts.slice(2).join('/');
  if (req.method === 'GET' && rest === 'v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [p.models.main, p.models.fast].filter(Boolean).map(m => ({ id: m, type: 'model', display_name: m })) })); }
  if (rest === 'v1/messages/count_tokens') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body).length / 3.6) })); }
  if (rest !== 'v1/messages' || req.method !== 'POST') return anthropicError(res, 404, 'not found');
  if (p.kind !== 'chain') {
    const r = await call(p, body, req);
    if (r.error) return anthropicError(res, r.status === 401 || r.status === 403 ? 401 : r.status === 429 ? 429 : 502, `${p.name}: ${r.error}`);
    return reply(p, r.up, res, body);
  }
  // failover chain: members cooling down after a failure are tried last; the first that answers wins
  const now = Date.now();
  const members = p.members.map(PR.find).filter(Boolean);
  const order = [...members.filter(m => !(cool.get(m.id) > now)), ...members.filter(m => cool.get(m.id) > now)];
  const tried = [];
  for (const m of order) {
    const model = body.model === 'anchor-fast' ? (m.models.fast || m.models.main) : m.models.main;
    const r = await call(m, { ...body, model }, req);
    if (!r.error) { note(p, m, 'used', tried); return reply(m, r.up, res, { ...body, model }); }
    tried.push(`${m.name}: ${r.error.slice(0, 160)}`);
    if (!RETRY.test(String(r.status)) && !/quota|rate|limit|credit|exhaust|overload|capacity|not found|unavailable/i.test(r.error)) {
      note(p, m, 'failed', tried);
      return anthropicError(res, r.status === 401 ? 401 : 400, `${m.name}: ${r.error}`); // a request problem, not a provider one
    }
    cool.set(m.id, Date.now() + (r.retryAfter || p.cooldown || 120) * 1000);
  }
  note(p, null, 'exhausted', tried);
  return anthropicError(res, 429, `every provider in ${p.name} is unavailable right now: ${tried.join(' | ')}`);
}

// statuses worth moving to the next provider for: auth/quota, missing model, timeouts, rate limits, server errors
const RETRY = /^(0|401|402|403|404|408|409|413|429|5\d\d)$/;
const cool = new Map();     // member id -> time it may be tried first again
const events = [];          // recent chain decisions, shown on the Providers page

function note(chain, member, what, tried) {
  events.push({ t: new Date().toISOString(), chain: chain.name, member: member ? member.name : null, what, skipped: tried.slice() });
  if (events.length > 60) events.shift();
}

async function call(p, body, req) {
  const key = PR.keyFor(p);
  let up;
  try {
    if (p.kind === 'openai') {
      up = await fetch(`${p.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(toOpenAI(body, p)) });
    } else {
      // an Anthropic-compatible member (OpenRouter Claude, Ollama, Claude Code Router...): pass the request through
      const h = { 'content-type': 'application/json', 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' };
      if (req.headers['anthropic-beta']) h['anthropic-beta'] = req.headers['anthropic-beta'];
      const k = key || (p.preset === 'ollama' ? 'ollama' : '');
      if (k) { h['x-api-key'] = k; h.authorization = `Bearer ${k}`; }
      up = await fetch(`${p.baseUrl}/v1/messages`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    }
  } catch (e) { return { status: 0, error: `could not reach it (${e.cause ? e.cause.code || e.cause.message : e.message})` }; }
  if (up.ok) return { up };
  const t = await up.text().catch(() => '');
  let msg = t.slice(0, 600) || `HTTP ${up.status}`;
  try { const j = JSON.parse(t); msg = (j.error && (j.error.message || JSON.stringify(j.error))) || msg; } catch { /* plain text */ }
  return { status: up.status, error: msg, retryAfter: Number(up.headers.get('retry-after')) || null };
}

async function reply(p, up, res, body) {
  if (p.kind === 'openai') {
    if (body.stream) return stream(up, res, body.model);
    const j = await up.json();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(fromOpenAI(j, body.model)));
  }
  res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
  const reader = up.body.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
  res.end();
}

module.exports = { handle, toOpenAI, fromOpenAI, events: () => events.slice().reverse() };
