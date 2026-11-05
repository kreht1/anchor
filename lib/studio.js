'use strict';
// The Scholar studio: Claude makes slide decks, Word documents, Excel workbooks, LaTeX papers, posters, publication
// figures and motion-design videos, each in its own project folder, using the user's skills (pptx, docx, xlsx, pdf...)
// and the tools on this computer. File tools stay inside the project folder (sources are copied in); shell commands
// are limited to document tooling (runner.js SANDBOX.studio). Revisions continue the same Claude conversation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const P = require('./paths');
const kv = require('./kv');
const RUN = require('./runner');

const win = process.platform === 'win32';
const DOCS = path.join(P.HOME, 'Documents');
const ROOT = path.join(fs.existsSync(DOCS) ? DOCS : P.HOME, 'Anchor Studio');
const DB = 'studio.json';
const MAX_SOURCE_BYTES = 40e6;

// ---------------------------------------------------------------- what this computer can do
let toolsCache = null;
function which(cmd) {
  try { return execFileSync(win ? 'where' : 'which', [cmd], { windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim() || null; } catch { return null; }
}
function pyModules(mods) {
  const py = win ? 'py' : 'python3';
  try {
    const out = execFileSync(py, ['-c', `import importlib.util as u;print(",".join(m for m in ${JSON.stringify(mods)} if u.find_spec(m)))`], { windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return new Set(out.split(',').filter(Boolean));
  } catch { return new Set(); }
}
function tools(fresh) {
  if (toolsCache && !fresh && Date.now() - toolsCache.at < 120000) return toolsCache.v;
  const py = pyModules(['pptx', 'docx', 'openpyxl', 'matplotlib', 'PIL', 'numpy', 'pandas', 'manim']);
  const soffice = which('soffice') || [path.join(process.env.ProgramFiles || '', 'LibreOffice', 'program', 'soffice.exe')].find(p => p && fs.existsSync(p)) || null;
  const latex = ['tectonic', 'latexmk', 'xelatex', 'pdflatex'].map(c => [c, which(c)]).find(([, p]) => p) || null;
  const v = {
    python: !!(which(win ? 'py' : 'python3') || which('python')), pptx: py.has('pptx'), docx: py.has('docx'), openpyxl: py.has('openpyxl'),
    matplotlib: py.has('matplotlib'), pillow: py.has('PIL'), numpy: py.has('numpy'), pandas: py.has('pandas'), manim: py.has('manim'),
    ffmpeg: !!which('ffmpeg'), node: !!which('node'), npx: !!which('npx'), latex: latex ? latex[0] : null, soffice,
  };
  toolsCache = { at: Date.now(), v };
  return v;
}

// ---------------------------------------------------------------- formats
const FORMATS = {
  slides: { label: 'Slide deck', ext: 'pptx', skill: 'pptx', needs: ['pptx'] },
  word: { label: 'Word document', ext: 'docx', skill: 'docx', needs: ['docx'] },
  excel: { label: 'Excel workbook', ext: 'xlsx', skill: 'xlsx', needs: ['openpyxl'] },
  latex: { label: 'LaTeX paper', ext: 'tex', skill: null, needs: [] },
  poster: { label: 'Academic poster', ext: 'pptx', skill: 'pptx', needs: ['pptx'] },
  figures: { label: 'Publication figures', ext: 'pdf', skill: null, needs: ['matplotlib'] },
  video: { label: 'Motion-design video', ext: 'mp4', skill: null, needs: ['ffmpeg'] },
};
const S = (v, n = 600) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function formatBrief(type, o, t) {
  const pal = o.palette ? `Colour palette: ${S(o.palette, 120)}.` : '';
  const font = o.fonts ? `Fonts: ${S(o.fonts, 120)}.` : '';
  switch (type) {
    case 'slides': return `A ${S(o.slides || 12, 4)}-slide ${S(o.aspect || '16:9', 8)} PowerPoint deck (.pptx). Visual style: ${S(o.style || 'clean, modern, high contrast', 200)}. ${pal} ${font}
Density: ${S(o.density || 'one idea per slide, few words, strong visuals', 160)}. ${o.notes !== false ? 'Write speaker notes for every slide.' : 'No speaker notes.'}
${o.charts ? 'Build real charts (native PowerPoint charts or matplotlib images) from the data in sources/.' : ''} ${o.template ? 'Use the template or deck in sources/ as the visual base.' : ''}
Every slide needs a deliberate layout (title, visual hierarchy, aligned grid, consistent margins); no wall-of-text slides, no default-looking slides.`;
    case 'poster': return `An academic poster as a single-slide .pptx sized ${S(o.size || 'A0 portrait (841 x 1189 mm)', 60)}: title band with authors and affiliations, then
${S(o.sections || 'Background, Methods, Results (largest), Conclusions, References', 300)}. Visual style: ${S(o.style || 'clean scientific', 160)}. ${pal} ${font}
Readable from 2 metres (body text at least 24 pt equivalent). Figures from sources/ or made with matplotlib. Also export a PDF if LibreOffice is available.`;
    case 'word': return `A Word document (.docx): ${S(o.kind || 'research report', 80)}, about ${S(o.pages || 8, 6)} pages, ${S(o.page || 'A4', 10)}, ${S(o.fonts || 'a serif body font', 80)}.
Structure: ${S(o.sections || 'title page, abstract, introduction, methods, results, discussion, conclusion, references', 400)}.
Citations: ${S(o.citations || 'APA 7', 40)} with a proper reference list${o.toc !== false ? '; a table of contents built from real heading styles' : ''}. Use real Word styles (Heading 1-3, Caption), numbered figure and table captions,
${o.figures ? 'figures made with matplotlib from the data in sources/,' : ''} page numbers in the footer.`;
    case 'excel': return `An Excel workbook (.xlsx) for: ${S(o.purpose || 'analysing the data in sources/', 300)}.
Sheets: ${S(o.sheets || 'Data (clean table), Analysis (formulas), Dashboard (charts and key numbers), Notes', 300)}.
Use real formulas (not pasted values) so it recalculates, named tables, number formats, frozen header rows, data validation where useful,
${o.charts !== false ? 'native Excel charts on the dashboard, ' : ''}conditional formatting for outliers, and a consistent ${S(o.style || 'professional', 60)} look.`;
    case 'latex': return `A LaTeX paper: document class ${S(o.cls || 'article', 60)}, ${S(o.pages || 8, 6)} pages, bibliography in ${S(o.bib || 'BibTeX with a numeric style', 60)} (references.bib).
Structure: ${S(o.sections || 'abstract, introduction, related work, method, experiments, results, discussion, conclusion', 400)}.
Figures made with matplotlib as vector PDF in figures/; tables with booktabs; equations numbered; cross-references with \\label/\\ref.
${t.latex ? `Compile it to PDF with ${t.latex} (run it as many times as needed for references) and fix every error and overfull box.` : 'No LaTeX engine is installed: make the project compile cleanly on Overleaf (main.tex, references.bib, figures/), and say so in README.md.'}`;
    case 'figures': return `A set of publication-quality figures with matplotlib: ${S(o.figs || 'the key results in the data in sources/', 400)}.
Style: ${S(o.style || 'journal style, colour-blind-safe palette, no chart junk', 200)}; size for a ${S(o.width || 'single-column (3.5 in)', 60)} layout; fonts embedded.
Save each as vector PDF and SVG plus a 300-dpi PNG in output/, with the script that made it (figures.py) so they can be regenerated, and a captions.md.`;
    case 'video': {
      const engine = o.engine || 'python';
      return `A motion-design video: ${S(o.seconds || 30, 4)} seconds, ${S(o.resolution || '1920x1080', 12)}, ${S(o.fps || 30, 3)} fps, MP4 (H.264, yuv420p).
Style: ${S(o.style || 'clean kinetic typography with smooth easing', 200)}. ${pal} ${font}
Storyboard / script: ${S(o.script || 'derive 4-6 scenes from the brief', 1500)}.
Engine: ${engine === 'remotion' ? 'Remotion (React). Scaffold a minimal Remotion project in this folder with npx, write the composition, and render with npx remotion render. This downloads packages.'
        : engine === 'manim' ? 'Manim (Python). Write scenes.py and render with manim at the requested quality.'
          : 'Python: draw every frame with Pillow (and matplotlib for charts) using proper easing curves (ease-in-out cubic), then encode with ffmpeg. Keep text crisp (render at full resolution, anti-aliased).'}
Plan the scenes and timing first (storyboard.md), then build, render, and check the result with ffprobe (duration, resolution). Also save a poster frame as output/poster.png.`;
    }
    default: return '';
  }
}

function prompt(p, t) {
  const f = FORMATS[p.type];
  const avail = Object.entries(t).filter(([, v]) => v).map(([k, v]) => (typeof v === 'string' && k !== 'soffice' ? `${k} (${v})` : k)).join(', ');
  return `You are producing a deliverable in the Anchor Scholar studio. Work only inside this folder: ${p.folder}

WHAT TO MAKE: ${f.label}.
TITLE: ${S(p.title, 200)}
BRIEF: ${S(p.brief, 4000)}
AUDIENCE: ${S(p.options.audience || 'general academic', 200)} · LANGUAGE: ${S(p.options.language || 'English', 40)} · TONE: ${S(p.options.tone || 'clear and precise', 80)}
${formatBrief(p.type, p.options, t)}
${p.sources.length ? `SOURCES (copied into sources/; read them and base the content on them, cite them where it matters): ${p.sources.join(', ')}` : 'No source files were given.'}
${p.options.research ? 'You may search the web for facts and references; cite every source you use, and never invent a reference.' : 'Do not use the web. Never invent references, data or quotes: if something is missing, leave a clearly marked placeholder and list it in README.md.'}

HOW:
1. ${f.skill ? `Invoke the "${f.skill}" skill first (Skill tool) and follow it; use its scripts. ` : ''}Use any other installed skill that fits (check your skills list).
2. Tools available on this computer: ${avail || 'python'}. ${f.needs.filter(n => !t[n]).length ? `Missing: ${f.needs.filter(n => !t[n]).join(', ')}; if you cannot do without it, stop and say exactly what to install.` : ''}
   Shell commands are limited to document tools (python, node/npx, ffmpeg, LaTeX, LibreOffice, basic file commands), and each
   Bash call must be ONE plain command, e.g. \`python make_deck.py\` or \`ffmpeg -y -framerate 30 -i frames/%04d.png out.mp4\`:
   no && or ; chains, no pipes, no heredocs or > redirection, no cd (you are already in the project folder). Create and edit
   files with the Write and Edit tools, then run them. If one command is refused, adjust that command; the shell still works.
3. Put the deliverables in output/ (create it). Keep working files (scripts, figures, storyboard) in this folder too, so the user can rebuild.
4. Check your work: reopen the file with code (count slides/pages/sheets, look for empty placeholders, overflowing text, broken formulas)${t.soffice ? ', and render previews with LibreOffice (soffice --headless --convert-to pdf, or png) into output/previews/ and look at them' : ''}. Fix what you find.
5. Write README.md: what you made, the files, how to rebuild or change it, and any placeholders left.
Finish with a short summary of the deliverables.`;
}

// ---------------------------------------------------------------- projects
const all = () => kv.read(DB, { projects: [] }).projects || [];
function saveProject(p) {
  const d = kv.read(DB, { projects: [] });
  d.projects = (d.projects || []).filter(x => x.id !== p.id);
  d.projects.unshift(p);
  kv.write(DB, d);
}

function copySources(paths, folder) {
  const dest = path.join(folder, 'sources');
  const names = [];
  let total = 0;
  for (const raw of (paths || []).slice(0, 30)) {
    const src = path.resolve(String(raw).trim().replace(/^"|"$/g, ''));
    if (!src || !fs.existsSync(src)) throw new Error(`source not found: ${raw}`);
    if (/[\\/](\.ssh|\.aws|\.gnupg)([\\/]|$)|\.env$|\.pem$|\.key$|credentials/i.test(src)) throw new Error(`refusing to copy a secrets-like file: ${raw}`);
    const st = fs.statSync(src);
    const size = st.isDirectory() ? dirSize(src) : st.size;
    total += size;
    if (total > MAX_SOURCE_BYTES) throw new Error('sources are larger than 40 MB in total; pick the files that matter');
    fs.mkdirSync(dest, { recursive: true });
    const name = path.basename(src);
    fs.cpSync(src, path.join(dest, name), { recursive: true, filter: s => !/[\\/](node_modules|\.git|__pycache__|\.venv[^\\/]*)([\\/]|$)/.test(s) });
    names.push(st.isDirectory() ? name + '/' : name);
  }
  return names;
}
function dirSize(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (/^(node_modules|\.git|__pycache__)$/.test(e.name)) continue;
    const p = path.join(d, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    if (n > MAX_SOURCE_BYTES) return n;
  }
  return n;
}

function create(spec) {
  const type = String(spec.type || '');
  if (!FORMATS[type]) throw new Error('pick what to make');
  const title = S(spec.title, 120);
  if (!title) throw new Error('give it a title');
  if (!S(spec.brief)) throw new Error('describe what you want in the brief');
  const id = crypto.randomBytes(4).toString('hex');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || type;
  const folder = path.join(ROOT, `${new Date().toISOString().slice(0, 10)} ${slug} ${id}`);
  fs.mkdirSync(path.join(folder, 'output'), { recursive: true });
  const p = { id, type, title, brief: String(spec.brief).slice(0, 8000), options: spec.options && typeof spec.options === 'object' ? spec.options : {}, folder,
    sources: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runs: [], sessionId: null, model: spec.model || 'sonnet', effort: spec.effort || 'medium' };
  try { p.sources = copySources(spec.sources, folder); } catch (e) { fs.rmSync(folder, { recursive: true, force: true }); throw e; }
  fs.writeFileSync(path.join(folder, 'BRIEF.md'), `# ${title}\n\n${FORMATS[type].label}\n\n${p.brief}\n\nOptions: ${JSON.stringify(p.options, null, 1)}\n`);
  saveProject(p);
  return go(p, prompt(p, tools(true)), false);
}

function go(p, text, revise) {
  const run = RUN.launch({ kind: 'studio', title: `${FORMATS[p.type].label}: ${p.title}${revise ? ' (revision)' : ''}`, cwd: p.folder, sandbox: 'studio', prompt: text, persist: true,
    resume: revise ? p.sessionId : null, project: p.id,
    onDone: r => { const cur = all().find(x => x.id === p.id); if (cur) { if (r.sessionId) cur.sessionId = r.sessionId; cur.updatedAt = new Date().toISOString(); cur.lastStatus = r.status; saveProject(cur); } } },
    { model: p.model, effort: p.effort });
  p.runs.unshift(run.id); p.updatedAt = new Date().toISOString(); p.lastStatus = 'running';
  saveProject(p);
  return { project: p, run };
}

function revise(id, text, opts = {}) {
  const p = all().find(x => x.id === id);
  if (!p) throw new Error('unknown studio project');
  if (!S(text)) throw new Error('say what to change');
  if (!p.sessionId) throw new Error('the first version has not finished yet');
  if (opts.model) p.model = opts.model;
  return go(p, `Revise the deliverable: ${String(text).slice(0, 6000)}\nKeep everything else as it is, update output/ and README.md, check the result again, and summarise what changed.
(Reminder: one plain command per Bash call, no chains, heredocs or redirection; write files with the Write and Edit tools.)`, true);
}

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm',
  svg: 'image/svg+xml', md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', tex: 'text/plain; charset=utf-8', bib: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function files(p) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (/^(node_modules|\.git|__pycache__|\.cache)$/.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { if (out.length < 400) walk(abs, r); continue; }
      const st = fs.statSync(abs);
      const ext = path.extname(e.name).slice(1).toLowerCase();
      out.push({ rel: r, size: st.size, mtime: st.mtimeMs, ext, output: r.startsWith('output/'), source: r.startsWith('sources/') });
    }
  };
  try { walk(p.folder, ''); } catch { /* folder removed */ }
  return out.sort((a, b) => (b.output - a.output) || b.mtime - a.mtime);
}

function get(id) {
  const p = all().find(x => x.id === id);
  if (!p) return null;
  return { ...p, files: files(p), runsInfo: p.runs.slice(0, 10).map(r => RUN.get(r, 1e9)).filter(Boolean).map(r => ({ id: r.id, title: r.title, status: r.status, startedAt: r.startedAt, cost: r.cost })) };
}

function resolveIn(p, rel) {
  const abs = path.resolve(p.folder, String(rel || ''));
  if (!abs.startsWith(path.resolve(p.folder) + path.sep)) throw new Error('outside the project');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('file not found');
  return abs;
}

function fileInfo(id, rel) {
  const p = all().find(x => x.id === id);
  if (!p) throw new Error('unknown studio project');
  const abs = resolveIn(p, rel);
  const ext = path.extname(abs).slice(1).toLowerCase();
  // html and anything unknown is sent as a download, never rendered on the Anchor origin
  return { abs, type: MIME[ext] || 'application/octet-stream', download: !MIME[ext] || /officedocument/.test(MIME[ext] || ''), name: path.basename(abs) };
}

function openFile(id, rel) {
  const p = all().find(x => x.id === id);
  if (!p) throw new Error('unknown studio project');
  const abs = rel ? resolveIn(p, rel) : p.folder;
  if (win) spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

function preview(id, rel) {
  const p = all().find(x => x.id === id);
  if (!p) throw new Error('unknown studio project');
  const abs = resolveIn(p, rel);
  const so = tools().soffice;
  if (!so) throw new Error('previews of Office files need LibreOffice (install it from the toolbox)');
  const outDir = path.join(p.folder, 'output', 'previews');
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(so, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, abs], { windowsHide: true, timeout: 120000, stdio: 'ignore' });
  return { rel: `output/previews/${path.basename(abs).replace(/\.[^.]+$/, '')}.pdf` };
}

function remove(id) {
  const d = kv.read(DB, { projects: [] });
  d.projects = (d.projects || []).filter(x => x.id !== id);
  kv.write(DB, d);
  return { ok: true, note: 'Removed from the list; the folder and its files are kept.' };
}

function list() { return { root: ROOT, formats: Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, { label: v.label, needs: v.needs }])), tools: tools(), projects: all().slice(0, 100) }; }

module.exports = { list, create, revise, get, fileInfo, openFile, preview, remove, tools, ROOT };
