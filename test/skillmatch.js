'use strict';
// The per-message skill matcher: names the right skill for clear requests, nothing for vague ones, never an off one.
const assert = require('assert');
const M = require('../lib/skillmatch');
const snap = { index: [
  { id: 'pptx', name: 'pptx', description: 'Use for slide decks, pitch decks or presentations; trigger on "deck", "slides", "presentation".' },
  { id: 'anthropic-skills:docx', name: 'docx', description: 'Create Word documents (.docx). Triggers: "Word doc", "word document".' },
  { id: 'anthropic-skills:xlsx', name: 'xlsx', description: 'Spreadsheet files: .xlsx, .csv; formulas, charts in spreadsheets.' },
  { id: 'superpowers:systematic-debugging', name: 'systematic-debugging', description: 'Use when encountering any bug, test failure, or unexpected behavior.' },
  { id: 'dataviz', name: 'dataviz', description: 'Built into Claude Code.' },
  { id: 'old-skill', name: 'old-skill', description: 'Make slide decks the old way: "deck" "slides".' },
], off: ['old-skill'], failing: [] };
const top = p => (M.match(p, snap)[0] || {}).id;
assert.strictEqual(top('make me a slide deck for the lab meeting'), 'pptx');
assert.strictEqual(top('turn this into a word document please'), 'anthropic-skills:docx');
assert.strictEqual(top('write an excel sheet with the results'), 'anthropic-skills:xlsx');
assert.strictEqual(top('fix this bug, the server crashes on start'), 'superpowers:systematic-debugging');
assert.strictEqual(top('make a chart of the scores per host'), 'dataviz');
assert.deepStrictEqual(M.match('so is it good or bad', snap), []);
assert.deepStrictEqual(M.match('/compact now please ok', snap), []);
assert.ok(!M.match('make slides and a deck', snap).some(x => x.id === 'old-skill'), 'a skill turned off is never named');
assert.deepStrictEqual(M.match('<browser_instruction># Claude in Chrome browser automation, load deck slides presentation tools</browser_instruction>just uploaded the results zip to you', snap), [], 'attached blocks are not the words of the user');
assert.strictEqual(top('<ide_selection>some code</ide_selection> make me a slide deck for the lab'), 'pptx');
assert.strictEqual(M.hook('not json'), '');

// the token saver's strict mode: everyday chat words never name a skill (each wrong hint costs a whole skill load)
const big = { index: [...snap.index,
  { id: 'anthropic-skills:setup-writing-style', name: 'setup-writing-style', description: 'Learns how the user writes from their own sent messages and docs. Use when drafts sound generic.' },
  { id: 'anthropic-skills:docs', name: 'docs', description: 'Editable docs people share: a document, report, letter to send, submit, print or sign; check with docs tools first.' },
  { id: 'frontend-design:frontend-design', name: 'frontend-design', description: 'Distinctive frontend design for new UI.' },
  { id: 'superpowers:writing-plans', name: 'writing-plans', description: 'Use when you have a spec or requirements for a multi-step task, before touching code.' },
], off: [], failing: [] };
const strict = p => M.match(p, big, 3, true).map(x => x.id);
assert.deepStrictEqual(strict('first you have to sent all messages with the bot to my telegram so i can check them'), [], 'chat words name nothing');
assert.deepStrictEqual(strict('i will instead cold call the rest tomorrow before sending the website probably'), [], 'a loose synonym (website) is not evidence');
assert.deepStrictEqual(strict('perfect now proceed with sending, double check which number is which'), []);
assert.strictEqual(strict('write the plan for the booking feature')[0], 'superpowers:writing-plans', 'write/writing share a stem');
assert.strictEqual(strict('make me a slide deck for the lab meeting')[0], 'pptx', 'clear requests still get their skill');
assert.strictEqual(strict('write an excel sheet with the results')[0], 'anthropic-skills:xlsx', 'an exact synonym (excel) still counts');
assert.ok(M.match('make slides, a deck and a presentation', big, 3, true).length <= 2, 'strict names at most two');

// the hook: lean note, and never the same skill twice in one session
const os = require('os'), fs = require('fs'), path = require('path');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-sm-'));
process.env.ANCHOR_DATA_DIR = data;
for (const m of ['../lib/paths', '../lib/kv', '../lib/skillmatch']) delete require.cache[require.resolve(m)];
const M2 = require('../lib/skillmatch');
fs.writeFileSync(path.join(data, 'skills-snapshot.json'), JSON.stringify(big));
const first = M2.hook(JSON.stringify({ prompt: 'make me a slide deck for the lab meeting', session_id: 'S1' }));
assert.ok(/Anchor skill hint: pptx/.test(first) && first.length < 260, 'token saver note is short');
assert.strictEqual(M2.hook(JSON.stringify({ prompt: 'and another slide deck for the board meeting', session_id: 'S1' })), '', 'not named twice in a session');
assert.ok(/pptx/.test(M2.hook(JSON.stringify({ prompt: 'make me a slide deck for the lab meeting', session_id: 'S2' }))), 'another session gets it');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ tokenSaver: false }));
assert.ok(/Anchor skill match for this message/.test(M2.hook(JSON.stringify({ prompt: 'make me a slide deck for the lab meeting', session_id: 'S1' }))), 'with the saver off, the full note returns');
fs.rmSync(data, { recursive: true, force: true });
console.log('ok: skill matcher names the right skill for clear requests, stays quiet on vague ones and chat words, never names a skill that is off, and never twice in a session');
