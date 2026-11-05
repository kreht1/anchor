'use strict';
// Optional tools Anchor can install for you, only when you click: a fixed list of commands (no free-form input), each
// with its download size, run in the background with a live log.
const { spawn } = require('child_process');
const { redact } = require('./redact');

const win = process.platform === 'win32';
const ITEMS = {
  'ccr': { title: 'Claude Code Router', size: 'about 25 MB download (80 MB on disk)', cmd: 'npm', args: ['install', '-g', '@musistudio/claude-code-router'], needs: 'Node.js 22+' },
  'ccr-update': { title: 'Update Claude Code Router', size: 'about 25 MB', cmd: 'npm', args: ['install', '-g', '@musistudio/claude-code-router@latest'] },
  'py-office': { title: 'Python Office libraries (python-pptx, python-docx, openpyxl)', size: 'about 5 MB', cmd: win ? 'py' : 'python3', args: ['-m', 'pip', 'install', '--user', '--upgrade', 'python-pptx', 'python-docx', 'openpyxl'] },
  'py-charts': { title: 'Python charts and data (matplotlib, pandas)', size: 'about 40 MB', cmd: win ? 'py' : 'python3', args: ['-m', 'pip', 'install', '--user', '--upgrade', 'matplotlib', 'pandas'] },
  'latex': win ? { title: 'LaTeX (MiKTeX, installs packages on demand)', size: 'about 150 MB, more as papers need packages', cmd: 'winget', args: ['install', '--id', 'MiKTeX.MiKTeX', '-e', '--accept-source-agreements', '--silent'] }
    : { title: 'LaTeX (Tectonic)', size: 'about 30 MB', cmd: 'sh', args: ['-c', 'curl --proto =https --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh'] },
  'libreoffice': win ? { title: 'LibreOffice (slide and page previews, PDF export)', size: 'about 350 MB', cmd: 'winget', args: ['install', '--id', 'TheDocumentFoundation.LibreOffice', '-e', '--accept-source-agreements', '--silent'] } : null,
  // token tools from the Anchor catalogue (lib/catalog.js); every step comes from the tool's own README
  'rtk': { title: 'RTK (compresses command output for Claude Code)', size: 'about 10 MB', steps: win
    ? [['winget', ['install', '--id', 'rtk-ai.rtk', '-e', '--accept-source-agreements', '--accept-package-agreements']], ['rtk', ['init', '-g']]]
    : [['brew', ['install', 'rtk']], ['rtk', ['init', '-g']]] },
  'context-mode': { title: 'context-mode (keeps big tool output out of the context)', size: 'a few MB',
    steps: [['claude', ['plugin', 'marketplace', 'add', 'mksglu/context-mode']], ['claude', ['plugin', 'install', 'context-mode@context-mode']]] },
};

const jobs = new Map();

function start(id) {
  const it = ITEMS[id];
  if (!it) throw new Error('unknown install');
  const cur = jobs.get(id);
  if (cur && cur.status === 'running') return view(id);
  const job = { id, title: it.title, status: 'running', startedAt: new Date().toISOString(), log: [] };
  jobs.set(id, job);
  // npm, py and winget are command shims on Windows; the arguments are fixed above, never user text
  const steps = it.steps || [[it.cmd, it.args]];
  const add = c => { for (const l of redact(c.toString()).split(/\r?\n/)) if (l.trim()) job.log.push(l.slice(0, 400)); if (job.log.length > 400) job.log.splice(0, job.log.length - 400); };
  const next = i => {
    if (i >= steps.length) { job.status = 'completed'; job.endedAt = new Date().toISOString(); return; }
    const [cmd, args] = steps[i];
    if (steps.length > 1) job.log.push(`> ${cmd} ${args.join(' ')}`);
    // a tool winget just installed is not on this process's PATH yet: its Links folder is added for the next step
    const env = win && process.env.LOCALAPPDATA ? { ...process.env, PATH: `${require('path').join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')};${process.env.PATH || ''}` } : process.env;
    const proc = spawn(cmd, args, { shell: win, windowsHide: true, env });
    proc.stdout.on('data', add); proc.stderr.on('data', add);
    proc.on('error', e => { job.status = 'failed'; job.log.push(e.message); });
    proc.on('close', code => {
      job.log.push(`exit code ${code}`);
      if (code === 0) next(i + 1); else { job.status = 'failed'; job.endedAt = new Date().toISOString(); }
    });
  };
  next(0);
  return view(id);
}

function view(id) { const j = jobs.get(id); return j ? { ...j, log: j.log.slice(-80) } : null; }
function catalog() { return Object.entries(ITEMS).filter(([, v]) => v).map(([id, v]) => ({ id, title: v.title, size: v.size, needs: v.needs || null, job: view(id) })); }

module.exports = { start, view, catalog };
