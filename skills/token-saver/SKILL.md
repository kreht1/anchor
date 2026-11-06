---
name: token-saver
description: Use for heavy Claude Code work (big codebases, many files, long logs, PDFs, long sessions, wide searches) or when the user mentions tokens, usage, limits or context running out. A playbook for the same result with far fewer tokens.
---

# Token saver

Everything that enters the conversation is paid for again, from cache, on every later reply until the session is
cleared or compacted. So the cheapest token is the one that never enters. Same quality, less input.

## Reading

- **Search, then read the part.** Grep or Glob for the symbol or string first. Then Read with `offset`/`limit` around
  the hit, not the whole file. Read a whole file only when you really need all of it.
- **Never re-read what you just wrote or edited.** The Edit and Write tools already confirm the change.
- **PDFs: a few pages at a time** (`pages: "1-3"`), or extract the text once (`pdftotext`, a short script) and grep
  that.
- **Images cost about 1.5k tokens each, and stay in the context.** Take one to check a render, not one per step. To
  review many screenshots, tile them into one contact sheet (a short `sharp`/PIL script, small tiles), or hand the
  review to a smaller-model subagent that returns only the problems it found.
- **Web pages: ask for fields, not the page.** A `javascript_tool` script that returns only the values you need (a
  short JSON) beats `get_page_text`, `read_page` or a screenshot, which bring the whole page in.
- **Large generated files** (lockfiles, minified bundles, data dumps, `.CT`/binary-ish files): don't open them. Ask what
  you need with grep or a one-line script.

## Commands

- **Cap the output before it reaches you:** `| tail -40`, `| head -60`, `--quiet`/`-q`, `--silent`, `git log --oneline -15`,
  `git diff --stat` before `git diff`. Count with `| wc -l` before printing.
- **Tests and builds: failures only.** Use `pytest -q`, `npm test --silent`, `| grep -E "FAIL|Error" -A5`.
- **Long jobs:** run in the background and read only the end of the log when they finish. Don't poll.
- **Batch independent calls** in one message. Each round trip re-sends the context.

## Delegating

- **Wide searches go to an Explore subagent** (many files, unknown naming). Only its summary comes back, not every file
  it read.
- **Mechanical subagent work runs on a smaller model**: pass `model: "haiku"` or `"sonnet"` in the Agent call.
  Spawn one agent where one will do. Every agent starts cold and rebuilds context.

## Long agent jobs (an hour or more, browser work, many screenshots)

Measured on real runs: once a context passes about 150k tokens, re-reading it on every step is half or more of the
whole cost, more than all the work itself. The fix is to keep each context small, not to work faster.

- **Split the job into phases that start fresh.** Research → build → check. Each phase writes its result to a file
  (facts.md, a seed file, a list of problems) and the next phase is a new subagent that reads only that file. An
  orchestrator that only launches phases and reads their short reports stays small.
- **Write as you go.** Put findings in the notes file the moment you have them, not at the end. Then a crash or a
  resumed run reads one file instead of redoing the research.
- **Checkpoint on the Anchor board** (`anchor add … --doing`, `anchor note <id> "where I am"`, `anchor done`) so a
  resume knows what is finished.
- **Tool calls are cheap, context is not.** Ten small calls that each return a line cost less than one that returns
  a page. Never dump a whole page, log or file "to have it".
- **One browser at a time.** Two agents sharing one Chrome stall each other for hours; run them one after another.
- **Screenshot scripts: scroll slowly** so reveal animations finish, or blank sections look like bugs and get
  "fixed" twice.

## Leftovers

Temporary files, build caches, scratch databases and logs you leave behind go in the user's Trash instead of a
"please delete" list in your report:
`node "$HOME/.anchor/anchor.js" trash add <path> --why "what it is and why it can go"`. The user deletes them in one
click in Anchor → Trash (to the Recycle Bin). Never empty the Trash yourself. Paths Anchor Guard stops you deleting
are added automatically: just tell the user they are there.

## Skills

- Load a skill when it clearly fits the real task. A loaded skill is 1k to 12k tokens that stay for the rest of the
  session. Don't load skills for quick questions, status checks or one-line changes, and never load the same skill
  twice in a session.

## Writing

- Edit, don't rewrite. A small `Edit` costs a fraction of re-sending a whole file with `Write`.
- Answers: lead with the result, skip restating the question, no recap of what the tools already showed. Long reports
  belong in a file or an artifact, with a short summary in chat.

## The session itself

- **Different topic: `/clear`.** A new task doesn't need the old conversation.
- **Same long task, getting heavy (100k+ tokens): `/compact`**, ideally at a milestone. Before a break of an hour or
  more, the prompt cache expires, and the whole conversation is paid in full on return. Compact first, or `/clear` and
  start fresh. Suggest this to the user when it applies; don't run it unasked.
- Switching model or effort mid-session also rebuilds the cache. Keep them steady within a task.
- Keep CLAUDE.md and MEMORY.md short (one line per fact). They are read by every session.

## How much is left

`node "$HOME/.anchor/anchor.js" usage` shows the 5-hour window and the week. `... anchor.js tokens` shows where
the last week's tokens went (the `token-audit` skill explains it and fixes it with the user). `... anchor.js runs`
shows what each subagent of the current session cost, measured the same way, to compare two approaches.
