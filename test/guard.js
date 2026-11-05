'use strict';
// Anchor Guard decisions: what it must stop, what it must ask about, and everyday work it must leave alone.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.ANCHOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-guard-'));
const G = require('../lib/guard');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'));
fs.writeFileSync(path.join(cwd, 'big.js'), 'x'.repeat(20000));
const S = { enabled: true, rules: {}, protected: [path.join(cwd, 'frozen'), '**/*.lock.json'] };
const bash = command => G.evaluate({ tool_name: 'Bash', tool_input: { command }, cwd }, S).decision;
const ps = command => G.evaluate({ tool_name: 'PowerShell', tool_input: { command }, cwd }, S).decision;
const tool = (tool_name, tool_input) => G.evaluate({ tool_name, tool_input, cwd }, S).decision;

const deny = [
  'rm -rf /', 'rm -rf ~', 'rm -rf .', 'rm -rf *', 'rm -rf ./*', 'sudo rm -rf / --no-preserve-root', 'rm -rf .git', 'cd x && rm -rf .git',
  'git filter-branch --tree-filter "rm x" HEAD', 'rm best.pt', 'rm -f checkpoints/epoch3.ckpt', 'rm -rf models', 'rm -r data/raw',
  'del /s /q weights', 'mv model.safetensors /dev/null', 'shred secret.txt', 'format D:', 'diskpart', 'dd if=/dev/zero of=/dev/sda', 'shutdown -h now',
  'echo "" > model.pt', 'python -c "import shutil; shutil.rmtree(\'checkpoints\')"', 'rm frozen/run.py', 'git reflog expire --expire=now --all',
];
const denyPs = ['Remove-Item -Recurse -Force C:\\', 'Remove-Item -Recurse -Force $env:USERPROFILE', 'Clear-RecycleBin -Force', 'Remove-Item .\\runs\\best.pth', 'Restart-Computer'];
const ask = [
  'rm -rf src', 'rm -r docs', 'rmdir /s /q lib', 'rm *.py', 'find . -name "*.js" -delete', 'git reset --hard HEAD~3', 'git clean -fdx', 'git checkout -- .',
  'git push --force origin main', 'git branch -D feature', 'npx create-next-app@latest . --yes', 'ls | xargs rm', 'git rm -r old',
  'node -e "require(\'fs\').rmSync(\'src\', {recursive: true})"',
];
const allow = [
  'ls -la', 'npm test', 'git status', 'git commit -m "x"', 'git push origin main', 'rm notes.txt', 'rm -rf node_modules', 'rm -rf dist build .cache',
  'rm -rf __pycache__', 'python train.py --epochs 3', 'mkdir -p out && cp a b', 'git checkout main', 'git reset HEAD file.txt', 'git clean -n',
  'npx create-next-app@latest my-app', 'echo hi > out.txt', 'cat model.pt | head -c 10', 'python -c "print(1)"', 'mv a.txt b.txt', 'find . -name "*.py"',
];
for (const c of deny) assert.strictEqual(bash(c), 'deny', `should block: ${c}`);
for (const c of denyPs) assert.strictEqual(ps(c), 'deny', `should block: ${c}`);
for (const c of ask) assert.strictEqual(bash(c), 'ask', `should ask: ${c}`);

// heredoc bodies are data for the program reading them, not shell commands (a Python dict line "format": ... is not `format`)
const pyHeredoc = "python - <<'EOF'\nrec = {\n  \"format\": \"L-mode BMP\",\n  shutdown: 1}\nformat = 2\nEOF\necho done";
assert.strictEqual(bash(pyHeredoc), 'allow', 'a heredoc fed to python is not parsed as shell');
assert.strictEqual(bash('cat > notes.md <<EOF\nformat D:\nEOF'), 'allow', 'a heredoc written to a file is data');
// ... unless a shell reads it, and commands after the terminator are still checked
assert.strictEqual(bash("bash <<'EOF'\nformat D:\nEOF"), 'deny', 'a heredoc fed to a shell is still checked');
assert.strictEqual(bash("python - <<EOF\nprint(1)\nEOF\nrm -rf /"), 'deny', 'commands after the heredoc are still checked');
assert.strictEqual(bash("cat <<-EOF > a.txt\n\tdiskpart\n\tEOF\nshutdown -h now"), 'deny', '<<- terminators may be indented');
for (const c of allow) assert.strictEqual(bash(c), 'allow', `should allow: ${c}`);

assert.strictEqual(tool('Write', { file_path: path.join(cwd, 'big.js'), content: 'tiny' }), 'ask', 'rewriting most of a file asks');
assert.strictEqual(tool('Write', { file_path: path.join(cwd, 'new.js'), content: 'fine' }), 'allow', 'new files are fine');
assert.strictEqual(tool('Write', { file_path: path.join(cwd, 'w.safetensors'), content: 'x' }), 'deny', 'no writing over model files');
assert.strictEqual(tool('Edit', { file_path: path.join(cwd, 'frozen', 'a.py'), old_string: 'a', new_string: 'b' }), 'deny', 'protected paths');
assert.strictEqual(tool('Edit', { file_path: path.join(cwd, 'pkg', 'x.lock.json'), old_string: 'a', new_string: 'b' }), 'deny', 'protected globs');
assert.strictEqual(tool('Edit', { file_path: path.join(cwd, 'big.js'), old_string: 'x'.repeat(9000), new_string: '' }), 'ask', 'large removal asks');
assert.strictEqual(tool('Read', { file_path: path.join(cwd, 'w.safetensors') }), 'allow', 'reading is never stopped');

// switching a rule changes the outcome; turning the guard off allows everything
assert.strictEqual(G.evaluate({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, cwd }, { ...S, rules: { 'git-discard': 'allow' } }).decision, 'allow');
assert.strictEqual(G.evaluate({ tool_name: 'Bash', tool_input: { command: 'rm -rf src' }, cwd }, { ...S, rules: { recursive: 'block' } }).decision, 'deny');
assert.strictEqual(G.evaluate({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd }, { ...S, enabled: false }).decision, 'allow');

console.log(`ok: guard blocks ${deny.length + denyPs.length} destructive commands, asks about ${ask.length} risky ones, leaves ${allow.length} everyday ones alone; file-tool rules pass`);
fs.rmSync(cwd, { recursive: true, force: true });
