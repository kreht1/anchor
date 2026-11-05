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
  that. Images and screenshots cost about 1.5k tokens each: take one to check a render, not one per step. Prefer
  `get_page_text` or `find` over screenshots for reading a web page.
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
the last week's tokens went (the `token-audit` skill explains it and fixes it with the user).
