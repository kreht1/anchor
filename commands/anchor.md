---
description: Open the Anchor dashboard (optionally one page), or show usage and limit resets
argument-hint: "[usage | tokens | live | projects | code | study | skills | tree | account | themes | board]"
allowed-tools: Bash(node:*)
---

The user ran `/anchor $ARGUMENTS`.

- If the argument is `usage` (or the user asked about usage, limits or resets), run
  `node "$HOME/.anchor/anchor.js" usage` and give the result in two or three plain lines.
- If the argument is `tokens` (or the user asked where their tokens go), run
  `node "$HOME/.anchor/anchor.js" tokens` and give the top three fixes with their numbers, in plain lines.
- Otherwise run `node "$HOME/.anchor/anchor.js" open` and add `--page <argument>` when an argument names a
  page. Then say in one line which page opened and that it runs only on this computer (http://127.0.0.1:4777).
