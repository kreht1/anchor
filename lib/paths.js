'use strict';
// Where Claude Code keeps its state, and where Anchor keeps its own.
const os = require('os');
const path = require('path');

const fs = require('fs');

const HOME = os.homedir();
// Anchor's own folder. Before the rename (Axios, Mission Control) it was ~/.claude-mission-control: it is moved once,
// and if it cannot be moved (a file still open), the old folder keeps being used until the next try.
function dataDir() {
  if (process.env.ANCHOR_DATA_DIR) return process.env.ANCHOR_DATA_DIR;
  const now = path.join(HOME, '.anchor'), old = path.join(HOME, '.claude-mission-control');
  if (fs.existsSync(now) || !fs.existsSync(old)) return now;
  try { fs.renameSync(old, now); return now; } catch { return old; }
}
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

module.exports = {
  HOME,
  CLAUDE,
  PROJECTS: path.join(CLAUDE, 'projects'),
  SESSIONS: path.join(CLAUDE, 'sessions'),
  PLANS: path.join(CLAUDE, 'plans'),
  TEMP: path.join(os.tmpdir(), 'claude'),
  DATA: dataDir(),
  DOWNLOADS: path.join(HOME, 'Downloads'),
  PORT: Number(process.env.ANCHOR_PORT || 4777),
};
