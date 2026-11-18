# Anchor for Codex: setup in 5 minutes

Anchor is a local dashboard and token saver for Codex (OpenAI's coding agent). It runs only on your computer
(http://127.0.0.1:4777); nothing is sent anywhere.

**What you get in every Codex session:**

- **Token saver:** working habits that cut wasted tokens. It also suggests `/compact` when a session gets big, and `/new`
  when you switch topics.
- **Guard:** blocks destructive commands before they run (wiping folders, deleting `.git`, overwriting model files, huge
  rewrites).
- **Skill hints:** names the right skill for each request.
- **Board:** a to-do board Codex fills in as it works.
- **Usage:** your limit percentages and when they reset.
- **Skill bridge:** many great skills were written for Claude. Anchor installs them into Codex, adapted to Codex's tools.

## 1. What you need

- **Node.js 18 or newer.** Check with `node --version`. If it's missing, install the LTS version from https://nodejs.org.
- **Codex**, signed in:

  ```
  npm i -g @openai/codex
  codex login
  ```

  > **Windows: if `codex` says "Missing optional dependency @openai/codex-win32-x64"**, the newest release doesn't
  > have a Windows build yet. Install the latest stable one that does:
  >
  > ```
  > npm uninstall -g @openai/codex
  > npm i -g @openai/codex@0.169.1
  > ```

## 2. Install Anchor (two commands)

In a terminal (not inside Codex):

```
codex plugin marketplace add kreht1/anchor
codex plugin add anchor@anchor
```

## 3. Approve its hooks (once)

Start Codex (`codex`), type **`/hooks`**, and approve Anchor's three hooks. Codex asks before running any plugin hook,
and they do nothing until you approve them:

| Hook | What it does |
|---|---|
| SessionStart | starts the dashboard, adds the token saver and skill rules |
| UserPromptSubmit | `/compact` and `/new` suggestions, skill hints |
| PreToolUse | Guard: checks shell commands and file patches before they run |

Then start a new session (`/new`). Done.

## 4. Use it

- **Dashboard:** open http://127.0.0.1:4777/#/codex in your browser. It starts on its own with your first Codex session.
- **From a terminal** (`anchor` below means `node ~/.anchor/anchor.js`; on Windows PowerShell:
  `node "$HOME\.anchor\anchor.js"`):

  ```
  anchor codex status      # is everything set up?
  anchor codex usage       # tokens, limits, reset times
  anchor list              # the board
  anchor open --page codex # open the dashboard
  ```

- **Get skills:** on the dashboard's Codex page, open **Find skills**. Search for something (`caveman`, `pdf`,
  `superpowers`, `science`...) or pick a well-known collection, then click **Inspect and install**. Anchor downloads it
  into quarantine and scans every file. You read the result, choose **Codex**, and it lands in `~/.agents/skills`,
  adapted for Codex. To use a skill, ask for the task, or type `$skill-name`.
- **If you also use Claude Code:** the Codex page lists your Claude skills with a verdict (works as-is, adapted,
  Claude-only). **Send to Codex** copies one across.

## Updating and removing

```
codex plugin marketplace upgrade anchor
codex plugin add anchor@anchor                                              # update
codex plugin remove anchor@anchor && codex plugin marketplace remove anchor # remove
```

**After every update, open Codex and approve Anchor's hooks again with `/hooks`.** Codex ties each approval to the
plugin's exact code, so an update switches the hooks off (you'll see `hook: SessionStart Failed`) until you
re-approve them. Until then, Guard and the token saver are off.

Skills Anchor installed stay in `~/.agents/skills`; delete their folders to remove them. Anchor's data is in `~/.anchor`.

## If something doesn't work

- **`hook: SessionStart Failed` (or no Anchor note) after an update:** that's Codex waiting for you to re-approve the
  changed hooks. Run `/hooks`, approve the three Anchor hooks, then `/new`.
- **No Anchor note at the start of a session:** run `/hooks` and check that the three Anchor hooks are approved, then
  `/new`.
- **The dashboard doesn't open:** run `node ~/.anchor/anchor.js start`. If that file doesn't exist yet, open one Codex
  session first; the first session creates it.
- **A skill doesn't show up in Codex:** run `anchor codex status`, then restart Codex. Skills are read when a session
  starts.
- Anything else: open an issue at https://github.com/kreht1/anchor/issues with the output of `anchor codex status`.
