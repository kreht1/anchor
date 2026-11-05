'use strict';
// Lean start: every skill is described to every session, used or not. This lists the ones never used and switches off
// the ones Claude Code lets Anchor switch (your own and project skills; whole plugins when none of their skills is used).
// Skills synced from claude.ai or built into Claude Code are listed with where to turn them off.
const S = require('./skills');

function plan() {
  const skills = (S.list(true).skills || []).filter(s => s.enabled && !/^anchor:/.test(s.id));
  const idle = skills.filter(s => s.health === 'untested');
  const byPlugin = {};
  for (const s of skills) if (s.plugin) (byPlugin[s.plugin] = byPlugin[s.plugin] || []).push(s);
  const plugins = Object.entries(byPlugin).filter(([, l]) => l.every(s => idle.includes(s))).map(([p]) => p);
  const movable = idle.filter(s => s.toggle === 'move');
  // skills of a plugin you do use cannot be switched one by one: they stay, and are only counted
  const inUsedPlugin = idle.filter(s => s.toggle !== 'move' && s.plugin && !plugins.includes(s.plugin));
  const elsewhere = idle.filter(s => s.toggle !== 'move' && !s.plugin);
  return { idle, plugins, movable, elsewhere, inUsedPlugin };
}

function run(apply) {
  const p = plan();
  if (!p.idle.length) return 'Every skill described to your sessions has been used. Nothing to switch off.';
  const out = [`${p.idle.length} skills have never been used and are described to every session.`];
  if (p.movable.length) out.push(`Anchor can switch off: ${p.movable.map(s => s.id).join(', ')}`);
  if (p.plugins.length) out.push(`Plugins with no used skill (switch off whole): ${p.plugins.join(', ')}`);
  if (p.elsewhere.length) out.push(`Turn these off where they come from (claude.ai: Settings > Capabilities > Skills; built-in ones cannot be removed): ${p.elsewhere.map(s => s.id).join(', ')}`);
  if (p.inUsedPlugin.length) out.push(`${p.inUsedPlugin.length} more belong to plugins you use (${[...new Set(p.inUsedPlugin.map(s => s.plugin))].join(', ')}) and stay.`);
  if (!apply) { out.push('Run anchor lean --apply to switch off the first two groups (each can be switched back on in Anchor > Skills).'); return out.join('\n'); }
  const done = [];
  for (const s of p.movable) { try { S.toggle(s.id, s.source, false); done.push(s.id); } catch { /* skip */ } }
  for (const pl of p.plugins) {
    const s = p.idle.find(x => x.plugin === pl);
    try { S.toggle(s.id, s.source, false); done.push(`plugin ${pl}`); } catch { /* skip */ }
  }
  out.push(done.length ? `Switched off: ${done.join(', ')}. New sessions pick it up.` : 'Nothing could be switched off here.');
  return out.join('\n');
}

module.exports = { plan, run };
