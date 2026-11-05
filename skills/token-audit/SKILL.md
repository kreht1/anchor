---
name: token-audit
description: Use when the user asks where their tokens or usage go, why they hit limits so fast, or to slim their setup (CLAUDE.md, memory, skills, plugins). Measures with Anchor, then applies the fixes they approve.
---

# Token audit

Find what actually costs tokens on this computer, then fix the biggest items with the user. The numbers come from
Claude Code's own transcripts, read locally by Anchor. Nothing is sent anywhere.

## 1. Measure

```sh
node "$HOME/.anchor/anchor.js" tokens --days 7
```

(`--days 1` for today, up to 60; `--json` for the raw numbers.) The dashboard shows the same audit at
http://127.0.0.1:4777/#/tokens.

## 2. Explain, briefly

Give the user the top three or four items in plain words, each with its number and its fix. The usual ones:

| Finding | What it means | Fix |
|---|---|---|
| Sessions with 150k+ context | every reply re-reads the whole conversation | `/clear` between tasks, `/compact` within one |
| Cache rebuilt after an hour away | the cache expired; the whole conversation was paid in full again | `/compact` before a break, or `/clear` for a new topic |
| Large tool results | big file reads and command outputs stay in context | line ranges, capped output; the `token-saver` skill |
| PDFs or images read whole | a PDF can be 50k–200k tokens | pages a few at a time, or extract text first |
| Files read again and again | the same file re-read in one session | read once, edit; read ranges |
| Unused skills | each one's description is in every session | switch them off on the Anchor Skills page |
| Memory or CLAUDE.md long | read by every session | one line per fact, details in separate files |

## 3. Fix, with the user's approval

- **CLAUDE.md / MEMORY.md**: propose a shorter version (keep every fact; move details into linked files) and show the
  before and after size. Write it only after the user says yes.
- **Unused skills or plugins**: list them and let the user choose. Switch them off in Anchor (Skills page) or with
  `claude plugin disable <name>`. Never uninstall.
- **Habits** (clear, compact, breaks): these belong to the user. Say them once, clearly.
- Load the `token-saver` skill for the working habits that apply to Claude itself.

Re-run the audit after a few days to show the difference.
