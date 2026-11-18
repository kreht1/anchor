'use strict';
// Known skills: a short, vetted list of popular Claude skill collections (checked on GitHub on 18 Nov 2026), plus a
// live GitHub search for anything else ("caveman", "pdf", "playwright"...). Picking one goes through the existing
// quarantine-and-scan flow (lib/skillhub.js): nothing runs, the user reads the scan, then installs to Claude, Codex or both.
const https = require('https');

const KNOWN = [
  { id: 'caveman', repo: 'JuliusBrussee/caveman', licence: 'Apache-2.0', tags: 'tokens terse short answers',
    what: 'Talks in short, plain sentences and trims tool output: far fewer output tokens for the same work.' },
  { id: 'superpowers', repo: 'obra/superpowers', licence: 'MIT', tags: 'process brainstorming planning tdd debugging review',
    what: 'A full working method: brainstorm, plan, test-first, debug systematically, review. Ships Codex notes of its own.' },
  { id: 'anthropic-skills', repo: 'anthropics/skills', licence: 'per skill (see each folder)', tags: 'pdf docx xlsx pptx frontend design skill-creator mcp',
    what: "Anthropic's public skills: PDF, Word, Excel, PowerPoint, front-end design, skill and MCP builders, and more." },
  { id: 'scientific', repo: 'K-Dense-AI/scientific-agent-skills', licence: 'MIT', tags: 'science biology chemistry papers data research',
    what: '170+ science skills (biology, chemistry, medicine, data analysis) with database helpers.' },
  { id: 'wshobson-agents', repo: 'wshobson/agents', licence: 'MIT', tags: 'agents plugins commands devops backend frontend',
    what: 'Large set of skills, agents and commands, already written for Claude Code and Codex.' },
  { id: 'awesome-composio', repo: 'ComposioHQ/awesome-claude-skills', licence: 'list', tags: 'list directory awesome',
    what: 'A curated list of Claude skills; some live in the repo, others are links to their own repositories.' },
];

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'anchor-dashboard', Accept: 'application/vnd.github+json' }, timeout: 15000 }, res => {
      let b = ''; res.on('data', c => (b += c));
      res.on('end', () => {
        if (res.statusCode === 403) return reject(new Error('GitHub search limit reached; try again in a minute'));
        if (res.statusCode !== 200) return reject(new Error(`GitHub answered ${res.statusCode}`));
        try { resolve(JSON.parse(b)); } catch { reject(new Error('unexpected answer from GitHub')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub did not answer')); });
  });
}

const cache = new Map();
async function search(q) {
  q = String(q || '').trim().slice(0, 80);
  const low = q.toLowerCase();
  const known = KNOWN.filter(k => !low || `${k.id} ${k.repo} ${k.tags} ${k.what}`.toLowerCase().includes(low))
    .map(k => ({ ...k, url: `https://github.com/${k.repo}`, known: true }));
  if (!q) return { known, found: [] };
  const key = low;
  const c = cache.get(key);
  if (c && Date.now() - c.at < 600000) return { known, found: c.v };
  const term = encodeURIComponent(`${q} skill in:name,description,readme`);
  const r = await get(`https://api.github.com/search/repositories?q=${term}&sort=stars&order=desc&per_page=15`);
  const seen = new Set(known.map(k => k.repo.toLowerCase()));
  const found = (r.items || []).filter(i => !seen.has(i.full_name.toLowerCase()) && !i.archived).map(i => ({
    repo: i.full_name, url: i.html_url, what: String(i.description || '').slice(0, 240), stars: i.stargazers_count,
    licence: (i.license && i.license.spdx_id) || '', updated: i.pushed_at }));
  cache.set(key, { at: Date.now(), v: found });
  return { known, found };
}

module.exports = { KNOWN, search };
