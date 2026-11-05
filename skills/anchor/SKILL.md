---
name: anchor
description: Use whenever the user mentions their dashboard, Anchor or "Anchor"; asks what is running, how a task, agent or download is doing, or what is planned or pending; asks about their Claude usage, limits, quota or when a limit resets; or wants a folder studied, code explained or skills found. Also use, without being asked, to record planned multi-step work and long downloads so they appear in the user's live dashboard.
---

# Anchor: the user's local Anchor

Anchor is a dashboard at http://127.0.0.1:4777 that runs only on this computer. It reads Claude Code's own files, so
conversations, background tasks, agents and their file edits show up by themselves. The plugin starts it at the
beginning of every session. What you feed it: the **board** (planned work) and **watched downloads**.

Command (works in bash and PowerShell): `node "$HOME/.anchor/anchor.js" <command>`. Below, `anchor` means
that whole command.

## Open it
- `anchor open`: opens the app window. `anchor open --page <page>` opens one page: `live` (agents and their diffs as they
  work), `projects`, `code`, `study`, `skills`, `tree` (skill tree), `account` (usage and limits), `themes`, `board`,
  `tasks`, `chats`, `providers`, `scholar`, `tokens` (where tokens went, and the token saver switch).
- Use it when the user asks to see the dashboard or one of these things. Don't open it otherwise.

## Usage, limits and resets
- `anchor usage` prints the current 5-hour session window, the week, and when each resets, from local files. Give the user
  the numbers plainly. The percentages are estimates calibrated on the user's own past limit hits; Claude Code's
  `/usage` is the exact figure, so say so if they need precision.
- You cannot reset a limit. You can say when it resets.
- `anchor tokens [--days N]` shows where the tokens of the last days went and what to change; the `token-audit` skill
  walks the user through it. `anchor saver on|off` switches the token saver (on by default).
- **When a limit is reached** and the user wants to keep working: `anchor providers` lists the alternative providers they set
  up in Anchor (OpenRouter, Ollama, GroqCloud, LM Studio...). Tell them to run `anchor claude <profile>` in a terminal (it
  starts a separate Claude Code on that provider; `--resume <session id>` continues a conversation), or open
  `anchor open --page providers` to set one up. You cannot switch the running session's provider.

## Board: planned and pending work
Statuses: planned (`todo`), in progress (`doing`), waiting (`blocked`), done.
- Add: `anchor add "Short imperative title" -p <project> [-n "context the user needs"] [--doing] [--high]`. Titles are a
  few words a person can scan; put the detail in `-n`. The project defaults to the current folder's name.
- Move: `anchor doing <id>`, `anchor done <id>`, `anchor wait <id>` (blocked on the user or on something outside), `anchor todo <id>`.
- Before adding, look, so nothing is duplicated: `anchor list -p <project>`. Notes: `anchor note <id> "text"`. Delete: `anchor rm <id>`.

Record work when the user gives a multi-step goal, when you leave something pending at the end of a turn, or when the
user asks you to plan. Keep the board honest: mark items done when they are done, and move blocked items to `wait`
with a note saying what they are waiting for. Don't announce this bookkeeping.

## Downloads and long runs
- Background commands are tracked automatically. For a download that lands in a known place, also run
  `anchor watch "<absolute path>" --label "<name>" [--gb <expected size>]`; `anchor unwatch "<path>"` when it is done.
- A long run started outside Claude (a training job, a script): `anchor job "<log file>" --label "<name>" [--pid <pid>]`.
  A `progress.json` next to the log ({stage, done, total, eta_min}) adds a progress bar.

## Pages worth suggesting
- **Scholar studio** (`--page scholar`): when the user wants a slide deck, Word document, Excel workbook, LaTeX paper,
  poster, publication figures or a motion-design video, and would like to set options, preview and revise visually.
- **Study** (`anchor open --page study`): Claude reads a folder, read-only, and writes a guide: what the workspace is
  about, the code function by function, the architecture, or onboarding.
- **Skills** (`--page skills`): switch skills on and off, see which ones work, and find new ones on GitHub. Found
  skills are quarantined and scanned before the user installs them.
- **Live** (`--page live`): every step and file diff of running agents.

## Guard
Anchor Guard checks your commands and file writes. If it blocks one, do not try another way to get the same effect.
Tell the user exactly what you wanted to run and why, so they can run it themselves or change the rule in Anchor → Guard.
If it asks, the user decides.

## Model Lab
To show the user a model's architecture or weights, open `anchor open --page models`. Do not load untrusted pickles with
torch.load yourself; Model Lab reads them without running code from them.

## Privacy
Anchor listens on 127.0.0.1 only and masks keys, tokens and webhook URLs before showing text. It never reads
`.credentials.json`. Never put secrets in board titles or notes.
