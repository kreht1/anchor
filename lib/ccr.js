'use strict';
// Claude Code Router (CCR 3, @musistudio/claude-code-router) under Anchor's control: is it installed, is its service
// and gateway up, start/stop it, open its UI, list and launch its Agent Profiles. CCR keeps its own configuration
// (SQLite, edited through its UI); Anchor never edits it and never shows CCR's management token.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execSync } = require('child_process');
const P = require('./paths');
const { redact } = require('./redact');

const win = process.platform === 'win32';
const CONFIG = win ? path.join(process.env.APPDATA || path.join(P.HOME, 'AppData', 'Roaming'), 'claude-code-router') : path.join(P.HOME, '.claude-code-router');
const GATEWAY = 3456, MANAGER = 3458;
const NAME = /^[\w .:()-]{1,80}$/;
let rootCache = null;

const strip = s => redact(String(s)).replace(/(ccr_web_token|token|key)=[^&\s"']+/gi, '$1=***');

function npmRoot() {
  if (rootCache !== null) return rootCache;
  try { rootCache = execSync('npm root -g', { windowsHide: true, timeout: 8000 }).toString().trim(); } catch { rootCache = ''; }
  return rootCache;
}

function installed() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(npmRoot(), '@musistudio', 'claude-code-router', 'package.json'), 'utf8'));
    return { version: pkg.version };
  } catch { return null; }
}

function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 600 }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

function service() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CONFIG, 'service.json'), 'utf8'));
    // keep only harmless fields; the token never leaves this function
    const safe = {};
    for (const [k, v] of Object.entries(j)) if (!/token|secret|key|password|auth/i.test(k) && (typeof v !== 'string' || !/token=/i.test(v))) safe[k] = v;
    return safe;
  } catch { return null; }
}

function profiles() {
  const dir = path.join(CONFIG, 'profiles');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(d => d.name.replace(/\.json$/, '')).filter(n => NAME.test(n)).slice(0, 50);
  } catch { return []; }
}

async function status() {
  const node = Number(process.versions.node.split('.')[0]);
  const inst = installed();
  const [gw, mg] = await Promise.all([portOpen(GATEWAY), portOpen(MANAGER)]);
  return { installed: !!inst, version: inst && inst.version, nodeOk: node >= 22, node: process.versions.node, configDir: CONFIG, configExists: fs.existsSync(CONFIG),
    service: service(), gateway: { port: GATEWAY, up: gw, url: `http://127.0.0.1:${GATEWAY}` }, manager: { port: MANAGER, up: mg }, profiles: profiles() };
}

function run(args) {
  return new Promise((resolve, reject) => {
    if (!installed()) return reject(new Error('Claude Code Router is not installed'));
    const p = spawn('ccr', args, { shell: win, windowsHide: true, detached: false });
    let out = '';
    const t = setTimeout(() => { resolve(strip(out).slice(-2000)); }, 20000); // start/ui keep a child alive; answer once it is up
    p.stdout.on('data', c => (out += c)); p.stderr.on('data', c => (out += c));
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve(strip(out).slice(-2000)) : reject(new Error(strip(out).slice(-600) || `ccr exited with ${code}`)); });
  });
}

async function action(what) {
  if (what === 'start') return { out: await run(['start', '--no-open', '--host', '127.0.0.1']) };
  if (what === 'stop') return { out: await run(['stop']) };
  if (what === 'ui') { // CCR opens its own authenticated page in the browser; Anchor does not handle the token
    if (!installed()) throw new Error('Claude Code Router is not installed');
    spawn('ccr', ['ui'], { shell: win, windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    return { out: 'Opening the Claude Code Router UI in your browser.' };
  }
  throw new Error('unknown action');
}

// open a terminal running `ccr "<profile>" cli` in a folder
function launchProfile(name, cwd) {
  if (!NAME.test(String(name || ''))) throw new Error('bad profile name');
  if (!profiles().includes(name)) throw new Error('unknown CCR profile');
  const dir = path.resolve(String(cwd || P.HOME));
  if (!fs.existsSync(dir)) throw new Error('pick an existing folder');
  fs.mkdirSync(path.join(P.DATA, 'launch'), { recursive: true });
  if (win) {
    const file = path.join(P.DATA, 'launch', 'ccr-profile.cmd');
    fs.writeFileSync(file, `@echo off\r\ntitle CCR: ${name}\r\ncd /d "${dir}"\r\nccr "${name}" cli\r\n`);
    spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    const cmd = `cd ${JSON.stringify(dir)} && ccr ${JSON.stringify(name)} cli; exec $SHELL`;
    spawn(process.platform === 'darwin' ? 'osascript' : 'x-terminal-emulator', process.platform === 'darwin' ? ['-e', `tell app "Terminal" to do script ${JSON.stringify(cmd)}`] : ['-e', 'sh', '-c', cmd], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
  return { ok: true };
}

module.exports = { status, action, launchProfile, CONFIG };
