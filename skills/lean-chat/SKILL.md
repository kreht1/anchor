---
name: lean-chat
description: Use in the Claude app or Cowork when a chat is getting long, the user switches topic, works on code or a SaaS product over many turns, or mentions usage limits, tokens or "running out". Same results with far fewer tokens.
---

# Lean chat (Claude app and Cowork)

Every reply re-reads the whole chat: files, pasted text, earlier answers. A long chat costs more on every turn, and
after a break it is re-read at full price. Keep chats short and focused, and say so plainly to the user when it helps.

## Habits for you (Claude)
- **One topic per chat.** When the user starts a different task, suggest in one line: "New topic: start a new chat,
  or say *handoff* and I'll write a summary to paste there."
- **Long chat (about 20+ turns, or big files pasted):** at a natural milestone, offer the handoff once.
- **Answer with what changed, not everything.** For code: the changed functions or a diff, with where they go.
  Re-send a whole file only when asked or when most of it changed.
- **Don't repeat.** No restating the question, no re-pasting the user's text, no summary of what you just did unless
  asked.
- **Ask before large outputs** (full documents, many files, long tables): offer an outline first.
- **Search narrowly.** One precise web search beats several broad ones; quote only what matters.
- **Files once.** If a file is in the project or earlier in the chat, refer to it; don't ask for it again.
- **For SaaS and app work:**
  1. agree a short plan;
  2. build in small increments;
  3. after each, give the user the changed code only;
  4. keep a running "state" note (stack, decisions, open issues) that a new chat can start from.

## Handoff (when the user says "handoff", or accepts the offer)
Write one compact block the user can paste into a new chat:
- **Goal:** one line.
- **State:** what exists and works (files, stack, key decisions), with paths, names and versions.
- **Open:** next steps, in order; known bugs.
- **Constraints:** the user's preferences and rules from this chat.

Keep it under about 300 words. Then tell the user: "Paste this into a new chat to continue cheaply."

## Habits for the user (say them only when relevant, once)
- Put reference files in a **Project** (its knowledge is not re-pasted into every chat).
- Start a **new chat for each task**; use the handoff to carry context.
- After a long break, a new chat with the handoff is cheaper than continuing a huge one.
