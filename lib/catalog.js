'use strict';
// Token tools from the web, vetted (source, licence, activity checked on 5 Nov 2026) and ranked for this user's own
// usage: what each one would act on in the last 7 days, against what it costs every session. Nothing is installed
// unless the user clicks (Anchor > Tokens) or runs `anchor catalog install <id>`; the commands come from each README.
const INST = require('./installs');

const TOOLS = [
  { id: 'rtk', name: 'RTK', repo: 'rtk-ai/rtk', licence: 'Apache-2.0', kind: 'command-line proxy + hook',
    what: 'Rewrites Bash commands to go through a filter that shortens their output (tests, git, builds, logs).',
    acts: ['Bash'], claim: [0.6, 0.9], upfront: 150, install: 'rtk',
    note: 'Only the Bash tool: PowerShell output is not filtered. Vendor claim of 60-90% on common commands.' },
  { id: 'context-mode', name: 'context-mode', repo: 'mksglu/context-mode', licence: 'Elastic-2.0 (free to use, not open source)', kind: 'Claude Code plugin (MCP + hooks)',
    what: 'Runs heavy tool work in a sandbox and returns a short, searchable summary instead of the raw output.',
    acts: ['Bash', 'WebFetch', 'mcp__*'], claim: [0.5, 0.9], upfront: 1500, install: 'context-mode',
    note: 'Adds its own tools and hooks; takes effect after Claude Code restarts. Vendor claim of 50-90% where tools are active.' },
  { id: 'serena', name: 'Serena', repo: 'oraios/serena', licence: 'MIT + GPL-3.0', kind: 'MCP server',
    what: 'Symbol-level code search and editing (find a function, its references), so Claude reads less of each file.',
    acts: ['Read', 'Grep', 'Glob'], claim: [0.3, 0.6], upfront: 2500, install: null,
    guide: 'uv tool install -p 3.13 serena-agent, then follow https://github.com/oraios/serena (Claude Code setup). Its README warns against marketplace installs.',
    note: 'Pays off on big code bases; needs Python 3.13 and uv. Our estimate, not a vendor figure.' },
  { id: 'context7', name: 'Context7', repo: 'upstash/context7', licence: 'MIT', kind: 'docs service + CLI/MCP',
    what: 'Fetches current, version-specific library docs in a compact form instead of whole web pages.',
    acts: ['WebFetch', 'WebSearch'], claim: [0.3, 0.7], upfront: 800, install: null,
    guide: 'npx ctx7 setup (interactive; run it in a terminal). Remove later with: npx ctx7 remove',
    note: 'Helps when you look up library docs a lot. Our estimate, not a vendor figure.' },
];

const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));

function exposure(totals, acts) {
  let n = 0;
  for (const [tool, v] of Object.entries(totals || {})) if (acts.some(a => a.endsWith('*') ? tool.startsWith(a.slice(0, -1)) : tool === a)) n += v;
  return n;
}

// audit: the result of tokens.audit() (toolTotals, sessions); without it the list is unranked
function ranked(audit) {
  if (!audit) { try { audit = require('./tokens').audit({ days: 7 }); } catch { audit = {}; } }
  const sessions = Math.max(1, audit.sessions || 1), weighted = (audit.totals && audit.totals.weighted) || 0;
  return TOOLS.map(t => {
    const exp = exposure(audit.toolTotals, t.acts);
    const saves = exp * t.claim[0], costs = t.upfront * sessions;
    const net = saves - costs;
    // judged against everything you used, not in absolute tokens: 700k sounds big next to a 300M week
    const rel = weighted ? net / weighted : 0;
    const verdict = rel >= 0.02 ? 'worth it' : rel >= 0.002 ? 'small gain' : net > 0 ? 'marginal for you now' : 'not worth it for you now';
    return { ...t, exposure: exp, saves: Math.round(saves), costs, net: Math.round(net), verdict,
      share: weighted ? exp / weighted : 0, installable: !!t.install, job: t.install ? INST.view(t.install) : null };
  }).sort((a, b) => b.net - a.net);
}

function text(list) {
  const L = ['Token tools from the web, ranked for your last 7 days (results they would act on, at the low end of each claim):'];
  for (const t of list) {
    L.push(`\n${t.id.padEnd(13)} ${t.name} (${t.kind}; ${t.licence}) — ${t.verdict}`);
    L.push(`  ${t.what}`);
    L.push(`  acts on ${fmt(t.exposure)} of your tool output (${(t.share * 100).toFixed(2)}% of your usage); saves about ${fmt(t.saves)} directly (more as later replies re-read less), costs about ${fmt(t.costs)} at session start`);
    L.push(`  ${t.note}`);
    L.push(t.install ? `  install: anchor catalog install ${t.id}   (source: github.com/${t.repo})` : `  set up: ${t.guide}`);
  }
  L.push('\nMost of a heavy user\'s usage is long sessions and cache rebuilds, which these tools do not touch: the Anchor governor and /compact, /clear do.');
  return L.join('\n');
}

function install(id) {
  const t = TOOLS.find(x => x.id === id);
  if (!t) return `Unknown tool. One of: ${TOOLS.map(x => x.id).join(', ')}`;
  if (!t.install) return `${t.name} is set up by hand: ${t.guide}`;
  const j = INST.start(t.install);
  return `Installing ${t.name} (${j.status}). Follow it in Anchor > Tokens, or run anchor catalog again later.`;
}

module.exports = { TOOLS, ranked, text, install };
