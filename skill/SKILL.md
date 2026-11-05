---
name: anchor
description: Use when the user asks about their dashboard, "Anchor", what is running, task or download progress, pending or planned work, or wants something added to / moved on their board. Also use to record planned multi-step work and long downloads so they show up in the user's live dashboard at {{URL}}.
---

# Anchor

A local dashboard (at {{URL}}) that shows every Claude Code session on this computer: conversations, background
tasks with live output and progress, downloads and network speed, GPU/CPU, a planning board, plans and artifacts.
It reads Claude Code's own files, so conversations and background tasks appear on their own. The board and
watched downloads are the two things you feed it.

Command: `{{MC}}` (source in `{{ROOT}}`).

## Open or check it
- `{{MC}} start`: starts the server if needed and opens the app window. Use this when the user asks to see the dashboard.
- `{{MC}} status`: is it running?

## Board: planned and pending work
Statuses: planned (`todo`), in progress (`doing`), waiting (`blocked`), done.
- Add: `{{MC}} add "Short imperative title" -p <project> [-n "context the user needs"] [--doing] [--high]`.
  Titles are a few words a person can scan; put detail in `-n`. The project defaults to the current folder name.
- Move: `{{MC}} doing <id>`, `{{MC}} done <id>`, `{{MC}} wait <id>` (blocked on the user or on something external),
  `{{MC}} todo <id>`. Ids can be shortened to their first characters.
- Look before adding, so nothing is duplicated: `{{MC}} list -p <project>`.
- Notes: `{{MC}} note <id> "text"`. Delete: `{{MC}} rm <id>`.

Record work when the user gives a multi-step goal, when you leave something pending at the end of a turn, or when
the user asks you to plan. Keep the board honest: mark items done when they are done and move blocked items to
`wait` with a note saying what they wait for.

## Downloads and growing folders
Background commands are tracked automatically. For a download that lands in a known place, also run
`{{MC}} watch "<absolute path>" --label "<name>" [--gb <expected size in GB>]` so the dashboard shows size, speed,
progress and time left. Run `{{MC}} unwatch "<path>"` when it is finished and no longer interesting.

## Privacy
The server listens on 127.0.0.1 only and masks keys, tokens and webhook URLs before showing any text. It never reads
`.credentials.json`. Never write secrets into board titles or notes.
