'use strict';
// Anchor: a local dashboard over every Claude Code session on this machine.
// Zero dependencies. Binds to 127.0.0.1 only. Start: `node server.js` (or `anchor start`).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./lib/paths');
const T = require('./lib/transcripts');
const S = require('./lib/system');
const store = require('./lib/store');
const J = require('./lib/jobs');
const SK = require('./lib/skills');
const HUB = require('./lib/skillhub');
const RUN = require('./lib/runner');
const PJ = require('./lib/projects');
const G = require('./lib/graph');
const FS = require('./lib/fsview');
const ACT = require('./lib/activity');
const USE = require('./lib/usage');
const PR = require('./lib/providers');
const BR = require('./lib/bridge');
const LAUNCH = require('./lib/launch');
const kv = require('./lib/kv');
const STUDIO = require('./lib/studio');
const CCR = require('./lib/ccr');
const INST = require('./lib/installs');
const GUARD = require('./lib/guard');
const TRASH = require('./lib/trash');
const CX = require('./lib/codex');
const SP = require('./lib/skillport');
const SDIR = require('./lib/skilldir');
const MODELS = require('./lib/models');
const tokenAudit = require('./lib/tokens-worker'); // the token audit, off the main thread

// a graph is served only for the graphify root of a known project
function graphRoot(root) {
  const want = path.resolve(String(root || '')).toLowerCase();
  const p = PJ.list().find(x => x.graph && x.graph.root.toLowerCase() === want);
  if (!p) throw new Error('no graphify graph for that folder');
  return p.graph.root;
}

const VERSION = require('./package.json').version;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const ALLOWED_HOSTS = new Set([`127.0.0.1:${P.PORT}`, `localhost:${P.PORT}`, `[::1]:${P.PORT}`]);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'" });
  res.end(data);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => (e2 ? send(res, 404, { error: 'not found' }) : send(res, 200, html, TYPES['.html'])));
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

function openInEditor(target) {
  const ok = typeof target === 'string' && path.isAbsolute(target) && fs.existsSync(target) && !/["&|<>^%!`$\r\n]/.test(target);
  if (!ok) throw new Error('not an openable path');
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `code "${target}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    : spawn('code', [target], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const q = url.searchParams;
  const m = req.method;
  if (m === 'GET' && parts[0] === 'ping') return send(res, 200, { ok: true, app: 'anchor', version: VERSION, pid: process.pid });
  if (m === 'GET' && parts[0] === 'overview') {
    S.want();
    const o = T.overview();
    const jobs = J.list();
    o.tasks = [...jobs.filter(j => j.status === 'running'), ...o.tasks.filter(t => t.status === 'running'),
      ...jobs.filter(j => j.status !== 'running'), ...o.tasks.filter(t => t.status !== 'running')];
    return send(res, 200, { ...o, board: store.getItems(), system: S.get(), trash: TRASH.count(), version: VERSION, now: new Date().toISOString() });
  }
  if (m === 'GET' && parts[0] === 'system') { S.want(); return send(res, 200, S.get()); }
  if (m === 'GET' && parts[0] === 'session' && parts[1]) {
    const before = q.has('before') ? Number(q.get('before')) : null;
    const c = T.conversation(parts[1], before, Math.min(Number(q.get('limit')) || 250, 1000));
    return c ? send(res, 200, c) : send(res, 404, { error: 'unknown session' });
  }
  if (m === 'GET' && parts[0] === 'search') {
    const s = (q.get('q') || '').trim();
    return send(res, 200, s.length < 2 ? [] : T.search(s));
  }
  if (m === 'GET' && parts[0] === 'task' && parts[2]) {
    const bytes = Math.min(Number(q.get('bytes')) || 60000, 2e6);
    const o = parts[1] === '_jobs' ? J.output(parts[2], bytes) : T.taskOutput(parts[1], parts[2], bytes);
    return o ? send(res, 200, o) : send(res, 404, { error: 'unknown task' });
  }
  if (m === 'GET' && parts[0] === 'plans') return send(res, 200, T.plansOnDisk());
  if (m === 'GET' && parts[0] === 'board') return send(res, 200, store.getItems());
  if (m === 'GET' && parts[0] === 'skills' && parts[1] === 'match') return send(res, 200, require('./lib/skillmatch').match(q.get('q') || '', require('./lib/kv').read('skills-snapshot.json', {})));
  if (m === 'GET' && parts[0] === 'skills' && parts[1] === 'matches') return send(res, 200, require('./lib/skillmatch').report(T.allStates()));
  if (m === 'GET' && parts[0] === 'skills') return send(res, 200, SK.list(q.has('fresh')));
  if (m === 'GET' && parts[0] === 'projects') return send(res, 200, PJ.list());
  if (m === 'GET' && parts[0] === 'usage') return send(res, 200, USE.summary());
  if (m === 'GET' && parts[0] === 'providers' && !parts[1]) return send(res, 200, PR.list());
  if (m === 'GET' && parts[0] === 'bridge-events') return send(res, 200, BR.events());
  if (m === 'GET' && parts[0] === 'models' && parts[1] === 'scan') return send(res, 200, MODELS.scan());
  if (m === 'GET' && parts[0] === 'models' && parts[1] === 'inspect') return send(res, 200, await MODELS.inspect(q.get('path')));
  if (m === 'GET' && parts[0] === 'trash') return send(res, 200, TRASH.list());
  if (m === 'GET' && parts[0] === 'guard') return send(res, 200, { settings: GUARD.settings(), rules: GUARD.RULES, recent: GUARD.recent(300) });
  if (m === 'GET' && parts[0] === 'ccr') return send(res, 200, await CCR.status());
  if (m === 'GET' && parts[0] === 'installs') return send(res, 200, INST.catalog());
  if (m === 'GET' && parts[0] === 'studio' && !parts[1]) return send(res, 200, STUDIO.list());
  if (m === 'GET' && parts[0] === 'studio' && parts[1] && parts[2] === 'file') {
    const fi = STUDIO.fileInfo(parts[1], q.get('rel'));
    res.writeHead(200, { 'Content-Type': fi.type, 'Content-Length': fs.statSync(fi.abs).size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      // text is sandboxed outright; PDFs, images and video need the browser's own viewers, which a sandbox would block
      'Content-Security-Policy': /^text\//.test(fi.type) ? "default-src 'none'; sandbox" : "default-src 'none'; img-src 'self'; media-src 'self'; object-src 'self'; style-src 'unsafe-inline'",
      ...(fi.download || q.has('download') ? { 'Content-Disposition': 'attachment; filename="' + fi.name.replace(/[^\w.\- ]/g, '_') + '"' } : {}) });
    return fs.createReadStream(fi.abs).pipe(res);
  }
  if (m === 'GET' && parts[0] === 'studio' && parts[1]) { const sp = STUDIO.get(parts[1]); return sp ? send(res, 200, sp) : send(res, 404, { error: 'unknown studio project' }); }
  if (m === 'GET' && parts[0] === 'tokens') return send(res, 200, await tokenAudit(Math.max(1, Math.min(Number(q.get('days')) || 7, 60))));
  if (m === 'GET' && parts[0] === 'catalog') return send(res, 200, require('./lib/catalog').ranked(await tokenAudit(7)));
  if (m === 'GET' && parts[0] === 'lean') { const L = require('./lib/lean').plan(); return send(res, 200, { idle: L.idle.length, movable: L.movable.map(x => x.id), plugins: L.plugins, elsewhere: L.elsewhere.map(x => x.id), inUsedPlugin: L.inUsedPlugin.length }); }
  if (m === 'GET' && parts[0] === 'settings') { const st = kv.read('settings.json', {}); return send(res, 200, { skillDiscipline: st.skillDiscipline !== false, tokenSaver: st.tokenSaver !== false, governor: st.governor !== false, cacheGuard: st.cacheGuard || 'block' }); }
  if (m === 'GET' && parts[0] === 'project') {
    const d = await PJ.detail(q.get('key') || '');
    return d ? send(res, 200, d) : send(res, 404, { error: 'unknown project' });
  }
  if (m === 'GET' && parts[0] === 'graph') {
    const root = graphRoot(q.get('root'));
    return send(res, 200, q.has('c') ? G.community(root, q.get('c')) : G.overview(root));
  }
  if (m === 'GET' && parts[0] === 'fs' && parts[1] === 'roots') return send(res, 200, FS.roots());
  if (m === 'GET' && parts[0] === 'fs' && parts[1] === 'list') return send(res, 200, FS.list(q.get('path')));
  if (m === 'GET' && parts[0] === 'fs' && parts[1] === 'read') return send(res, 200, FS.read(q.get('path')));
  if (m === 'GET' && parts[0] === 'activity') return send(res, 200, ACT.feed({ hours: Math.min(Number(q.get('hours')) || 6, 72), limit: Math.min(Number(q.get('limit')) || 300, 1500), session: q.get('session') }));
  if (m === 'GET' && parts[0] === 'runs' && !parts[1]) return send(res, 200, RUN.list());
  if (m === 'GET' && parts[0] === 'runs' && parts[1]) {
    const r = RUN.get(parts[1], q.get('from'));
    return r ? send(res, 200, r) : send(res, 404, { error: 'unknown run' });
  }
  if (m === 'GET' && parts[0] === 'hub' && parts[1] && parts[2] === 'file') return send(res, 200, HUB.readFileIn(parts[1], q.get('rel')));
  // Codex: install state, usage and limits from its own logs, and the skill bridge
  if (m === 'GET' && parts[0] === 'codex' && !parts[1]) {
    const all = SK.list().skills;
    return send(res, 200, { status: CX.status(), usage: CX.usage(Math.min(Number(q.get('days')) || 7, 30)), bridge: SP.catalog(all),
      ported: SP.ported(), native: CX.skills().filter(s => !s.port).map(s => ({ name: s.name, plugin: s.plugin || null, source: s.source, description: s.description, bom: s.bom })) });
  }
  if (m === 'GET' && parts[0] === 'skilldir') return send(res, 200, await SDIR.search(q.get('q')));

  // state-changing calls: same-origin page only (custom header forces a CORS preflight that is never granted)
  if (req.headers['x-anchor'] !== '1') return send(res, 403, { error: 'missing x-anchor header' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'cross-origin request refused' });
  const body = m === 'POST' || m === 'PATCH' ? await readBody(req) : {};
  if (m === 'POST' && parts[0] === 'board') return send(res, 201, store.addItem({ ...body, source: body.source || 'you' }));
  if (m === 'PATCH' && parts[0] === 'board' && parts[1]) return send(res, 200, store.updateItem(parts[1], body));
  if (m === 'DELETE' && parts[0] === 'board' && parts[1]) { store.removeItem(parts[1]); return send(res, 200, { ok: true }); }
  if (m === 'POST' && parts[0] === 'watch') return send(res, 201, store.addWatch(body));
  if (m === 'DELETE' && parts[0] === 'watch' && parts[1]) { store.removeWatch(decodeURIComponent(parts[1])); return send(res, 200, { ok: true }); }
  if (m === 'POST' && parts[0] === 'open') { openInEditor(body.path); return send(res, 200, { ok: true }); }
  if (m === 'POST' && parts[0] === 'skills' && parts[1] === 'toggle') return send(res, 200, SK.toggle(body.id, body.source, !!body.enabled));
  if (m === 'POST' && parts[0] === 'skills' && parts[1] === 'verdict') return send(res, 200, SK.setVerdict(body.id, body.verdict, body.note));
  if (m === 'POST' && parts[0] === 'hub' && parts[1] === 'inspect') return send(res, 200, await HUB.inspect(body.repo, body.path));
  if (m === 'POST' && parts[0] === 'hub' && parts[1] === 'install') return send(res, 200, HUB.install(body.id, body.rel, body.name, body.target || 'claude'));
  if (m === 'POST' && parts[0] === 'codex' && parts[1] === 'port') {
    const all = SK.list(true).skills, ids = [].concat(body.ids || []).map(String).slice(0, 200), done = [], failed = [];
    for (const id of ids) {
      const s = all.find(x => x.id === id);
      try { if (!s) throw new Error('no such skill'); done.push(SP.port(s, { known: all, force: body.force === true })); } catch (e) { failed.push({ id, error: e.message }); }
    }
    if (done.length > 1) SP.relink(all);
    kv.write('codex-skills-snapshot.json', {});
    return send(res, 200, { done, failed });
  }
  if (m === 'POST' && parts[0] === 'codex' && parts[1] === 'unport') { const r = SP.unport(String(body.name || '')); kv.write('codex-skills-snapshot.json', {}); return send(res, 200, r); }
  if (m === 'POST' && parts[0] === 'codex' && parts[1] === 'sync') { const r = SP.sync(SK.list(true).skills); kv.write('codex-skills-snapshot.json', {}); return send(res, 200, r); }
  if (m === 'POST' && parts[0] === 'codex' && parts[1] === 'setup') {
    // the same steps as `anchor codex setup`, run as a child so its output can be shown as is
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'bin', 'anchor.js'), 'codex', 'setup', ...(body.skills === false ? ['--no-skills'] : [])], { encoding: 'utf8', timeout: 300000, windowsHide: true });
    return send(res, 200, { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() });
  }
  if (m === 'DELETE' && parts[0] === 'hub' && parts[1]) return send(res, 200, HUB.discard(parts[1]));
  if (m === 'POST' && parts[0] === 'runs') {
    if (body.cwd && ['study', 'file', 'graph'].includes(body.kind)) FS.addRoot(body.cwd);
    return send(res, 201, RUN.start(body));
  }
  if (m === 'DELETE' && parts[0] === 'runs' && parts[1]) return send(res, 200, RUN.stop(parts[1]));
  if (m === 'POST' && parts[0] === 'fs' && parts[1] === 'roots') return send(res, 200, { root: FS.addRoot(body.path) });
  if (m === 'POST' && parts[0] === 'providers' && !parts[1]) return send(res, 200, PR.save(body));
  if (m === 'POST' && parts[0] === 'ccr' && parts[1] === 'launch') return send(res, 200, CCR.launchProfile(body.name, body.cwd));
  if (m === 'POST' && parts[0] === 'ccr' && parts[1]) return send(res, 200, await CCR.action(parts[1]));
  if (m === 'POST' && parts[0] === 'installs' && parts[1]) return send(res, 200, INST.start(parts[1]));
  if (m === 'POST' && parts[0] === 'catalog' && parts[1] === 'install') return send(res, 200, { message: require('./lib/catalog').install(String(body.id || '')) });
  if (m === 'POST' && parts[0] === 'lean' && parts[1] === 'apply') return send(res, 200, { message: require('./lib/lean').run(true) });
  if (m === 'POST' && parts[0] === 'models' && parts[1] === 'samples') return send(res, 200, await MODELS.samples(body.path, body.names, body.cap));
  if (m === 'POST' && parts[0] === 'guard' && parts[1] === 'test') return send(res, 200, GUARD.evaluate({ tool_name: body.tool || 'Bash', tool_input: body.tool_input || { command: String(body.command || '') }, cwd: body.cwd }));
  if (m === 'POST' && parts[0] === 'guard' && !parts[1]) return send(res, 200, GUARD.saveSettings(body));
  if (m === 'POST' && parts[0] === 'trash' && parts[1] === 'add') return send(res, 200, TRASH.add(String(body.path || ''), { from: 'you', why: body.why }));
  if (m === 'POST' && parts[0] === 'trash' && parts[1] === 'keep') return send(res, 200, TRASH.keep((body.ids || []).map(String)));
  if (m === 'POST' && parts[0] === 'trash' && parts[1] === 'empty') return send(res, 200, TRASH.empty((body.ids || []).map(String), { permanent: body.permanent === true }));
  if (m === 'POST' && parts[0] === 'trash' && parts[1] === 'show') {
    const it = TRASH.list().find(i => i.id === String(body.id || ''));
    if (!it) return send(res, 404, { error: 'not in the Trash' });
    const { spawn } = require('child_process');
    const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [`/select,${it.path}`]] : process.platform === 'darwin' ? ['open', ['-R', it.path]] : ['xdg-open', [require('path').dirname(it.path)]];
    try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* no file manager */ }
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && parts[0] === 'studio' && !parts[1]) return send(res, 201, STUDIO.create(body));
  if (m === 'POST' && parts[0] === 'studio' && parts[2] === 'revise') return send(res, 201, STUDIO.revise(parts[1], body.text, { model: body.model }));
  if (m === 'POST' && parts[0] === 'studio' && parts[2] === 'open') return send(res, 200, STUDIO.openFile(parts[1], body.rel));
  if (m === 'POST' && parts[0] === 'studio' && parts[2] === 'preview') return send(res, 200, STUDIO.preview(parts[1], body.rel));
  if (m === 'DELETE' && parts[0] === 'studio' && parts[1]) return send(res, 200, STUDIO.remove(parts[1]));
  if (m === 'DELETE' && parts[0] === 'providers' && parts[1]) return send(res, 200, PR.remove(parts[1]));
  if (m === 'POST' && parts[0] === 'providers' && parts[2] === 'test') return send(res, 200, await PR.test(parts[1]));
  if (m === 'POST' && parts[0] === 'providers' && parts[2] === 'models') return send(res, 200, await PR.models(parts[1]));
  if (m === 'POST' && parts[0] === 'providers' && parts[2] === 'launch') return send(res, 200, LAUNCH.launch(parts[1], body.cwd, body.resume));
  if (m === 'POST' && parts[0] === 'providers' && parts[1] === 'fallback') return send(res, 200, PR.setFallback(body.id));
  if (m === 'POST' && parts[0] === 'settings') {
    const st = kv.read('settings.json', {});
    if ('skillDiscipline' in body) st.skillDiscipline = !!body.skillDiscipline;
    if ('tokenSaver' in body) st.tokenSaver = !!body.tokenSaver;
    if ('governor' in body) st.governor = !!body.governor;
    if (['block', 'warn', 'off'].includes(body.cacheGuard)) st.cacheGuard = body.cacheGuard;
    kv.write('settings.json', st);
    return send(res, 200, { skillDiscipline: st.skillDiscipline !== false, tokenSaver: st.tokenSaver !== false, governor: st.governor !== false, cacheGuard: st.cacheGuard || 'block' });
  }
  return send(res, 404, { error: 'no such endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, { error: 'unexpected host' }); // blocks DNS rebinding
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    // the provider bridge: Claude Code calls it with the local bridge token (no browser involved, so no origin checks)
    if (url.pathname.startsWith('/bridge/')) {
      const body = req.method === 'POST' ? await readBody(req, 60e6) : {};
      return await BR.handle(req, res, url.pathname.split('/').filter(Boolean), body);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Anchor is already running on http://127.0.0.1:${P.PORT}`);
    process.exit(0);
  }
  throw e;
});

server.listen(P.PORT, '127.0.0.1', () => {
  fs.mkdirSync(P.DATA, { recursive: true });
  fs.writeFileSync(path.join(P.DATA, 'server.pid'), String(process.pid));
  console.log(`Anchor ${VERSION}: http://127.0.0.1:${P.PORT}`);
  S.start();
  setTimeout(() => { try { STUDIO.tools(true); } catch { /* checked again on demand */ } }, 2000); // the studio's tool check is slow; warm it
  setTimeout(() => T.refreshAll(), 10); // warm the transcript index in the background of the first request
  // keep the skills snapshot (used by the per-message matcher) current as skills are installed or toggled
  const snap = () => { try { SK.list(true); } catch { /* next time */ } };
  setTimeout(snap, 3000); setInterval(snap, 10 * 60 * 1000).unref();
});
