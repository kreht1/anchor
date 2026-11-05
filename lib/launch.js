'use strict';
// Opens a new terminal running Claude Code on a provider profile (`anchor claude <profile>`), in a chosen folder,
// optionally resuming a conversation. The launcher script holds no secrets: `anchor claude` reads the key at start.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./paths');
const PR = require('./providers');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MC = path.join(__dirname, '..', 'bin', 'anchor.js');

function launch(id, cwd, resume) {
  const p = PR.find(id);
  if (!p) throw new Error('unknown profile');
  if (!p.models.main) throw new Error('pick a main model for this profile first');
  const dir = path.resolve(String(cwd || P.HOME));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('pick an existing folder');
  if (resume && !UUID.test(resume)) throw new Error('unknown conversation');
  const args = ['claude', p.id, ...(resume ? ['--resume', resume] : [])];
  fs.mkdirSync(path.join(P.DATA, 'launch'), { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(P.DATA, 'launch', `${p.id}.cmd`);
    fs.writeFileSync(file, `@echo off\r\ntitle Claude Code on ${p.name.replace(/[&|<>^%"]/g, '')}\r\ncd /d "${dir}"\r\n"${process.execPath}" "${MC}" ${args.join(' ')}\r\n`);
    spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: false }).unref();
  } else if (process.platform === 'darwin') {
    const file = path.join(P.DATA, 'launch', `${p.id}.command`);
    fs.writeFileSync(file, `#!/bin/sh\ncd ${JSON.stringify(dir)}\n${JSON.stringify(process.execPath)} ${JSON.stringify(MC)} ${args.join(' ')}\n`, { mode: 0o755 });
    spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const cmd = `cd ${JSON.stringify(dir)} && ${JSON.stringify(process.execPath)} ${JSON.stringify(MC)} ${args.join(' ')}; exec $SHELL`;
    spawn('x-terminal-emulator', ['-e', 'sh', '-c', cmd], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
  return { ok: true, command: `node "${MC}" ${args.join(' ')}`, cwd: dir };
}

module.exports = { launch };
