# Changelog

## 4.0.0: Axios is now Anchor

- **New mark.** The star-and-anchor logo, painted in each theme's ink (gold on Obsidian, gradients on Synth, Sakura
  and Frost), plus a new favicon, app icon and desktop-shortcut icon.
- **New name.** The plugin, its skills (`anchor:token-saver`, `anchor:token-audit`), the command (`anchor`, was `mc`) and the
  data folder (`~/.anchor`, was `~/.claude-mission-control`) are renamed. The data folder moves by itself the first
  time Anchor starts, keeping your board, settings and parked skills. Install: `claude plugin marketplace add
  kreht1/anchor`, then `claude plugin install anchor@anchor`; uninstall the old `axios@axios`.
- **Skills page rebuilt as a ledger.** One row per skill: on/off, 30 days of use as a strip of days, total uses, last
  used, its size when loaded and what it costs every session just by being listed, and its health. Sort by most used,
  used lately or heaviest; a bar shows how much of every session's skill list goes to skills you never use. Message
  hints fold into a small panel.
- **The skill tree is gone.**
- `?theme=<id>` in the address previews a theme without saving it.
- Tokens page: the audit comes first; the governor and the token tools follow it.

## 3.0.0: the token governor

Measured on real use: for a heavy user, about 77% of the limit is long conversations re-read on every reply and about
21% is the prompt cache rebuilt after breaks. Tool output and file reads are under 1%. So Axios now governs the session
itself.
- **Cache-cold guard** (`mc cacheguard block|warn|off`, default: stop once): coming back to a big session (60k+
  tokens) after its prompt cache expired, Axios stops that one message and shows the cost, with the cheap choices:
  /compact, /clear, or send the same message again to go ahead. The cache lifetime (1 hour or 5 minutes) is read from
  the session itself. Scripted (SDK) sessions are never stopped.
- **Context governor** (`mc governor on|off`): past 120k, 200k and 300k tokens Claude is told, once per level, to
  suggest /compact at the next milestone; an unrelated request in a big session gets a /clear suggestion.
- **Status line** (`mc statusline install --apply`): context size, minutes the cache stays warm, 5-hour and weekly
  usage, e.g. `Axios · ctx 142k · cache 38m · 5h 41% · wk 23%`.
- **Lean start** (`mc lean [--apply]`, and a button on the Tokens page): switches off skills and whole plugins you have
  never used; skills synced from claude.ai are listed with where to turn them off.
- **Token tools from the web** (`mc catalog`, Tokens page): RTK, context-mode, Serena and Context7, vetted (source,
  licence, activity), ranked against your own last 7 days, installed only when you click. Install steps come from each
  tool's README; Serena and Context7 are set up by hand because they ask questions.
- **Claude app and Cowork:** a new `lean-chat` skill (one topic per chat, diffs not whole files, a /handoff summary to
  restart cheaply); `mc export-skills` now also writes `axios-lean-cowork.zip`, a Cowork plugin with both skills and a
  /handoff command.
- The token audit now totals every tool result by tool (it ranks the catalogue).

## 2.4.1

- Shorter descriptions for the token-saver and token-audit skills (about 120 fewer tokens in every session), short
  labels on the Tokens page, billions shown as B.

## 2.4.0

- **Token saver** (on by default; `mc saver off` or the switch on the Tokens page turns it off):
  - every session gets a short set of working habits that cut input tokens without hurting results: search before
    reading, read line ranges, cap command output, batch calls, no re-reading what was just edited, PDFs a few pages at
    a time, wide searches in an Explore subagent, smaller models for mechanical subagents, /compact and /clear at the
    right moments;
  - skill hints only on clear evidence (the skill's name, a trigger phrase, or strong shared words). Everyday words
    such as "send", "message", "check" or "call" no longer suggest a skill, and the same skill is never suggested twice
    in a session. A wrong hint used to cost a whole skill load (1k to 12k tokens) for the rest of the session;
  - a shorter session note, and skills used when they clearly fit the real task rather than "on a small chance".
- **Two skills ship with Axios**, so everyone who installs or updates it gets them: `token-saver` (the full playbook
  for heavy work) and `token-audit` (measures, explains and fixes the biggest items with you).
- **Tokens page and `mc tokens`**: where the last day, week or month went, from your own transcripts. It shows what
  every session reads before any work (instructions, memory, skill and tool lists, hook notes), the largest tool
  results, files read again and again, skills loaded, prompt-cache rebuilds after an hour away, and very long
  sessions. It turns them into fixes, biggest saving first. The audit runs off the main thread, so the dashboard stays
  responsive.
- **`mc export-skills`**: zips the token-saver skill for upload to claude.ai, so the Claude app gets it too.
- Matcher: "write" and "writing" share a stem (so "write the plan" finds writing-plans); loose synonyms such as
  "website" → frontend add a little score but are never enough on their own.

## 2.3.2

- **Guard reads heredocs correctly:** the body of a heredoc fed to a program (`python - <<EOF`, `cat > file <<EOF`) is
  that program's input, not shell, so a Python line such as `"format": ...` no longer looks like the `format` disk
  command. A heredoc fed to a shell (`bash <<EOF`, `pwsh`, `ssh`) is still checked line by line, and so is everything
  after the terminator.

## 2.3.1

- **Skill matching uses only your own words:** blocks a client attaches to a message (browser instructions, IDE
  selections, reminders) are ignored, so they no longer produce false skill suggestions.

## 2.3.0

- **Skills on every message:** a UserPromptSubmit hook matches each message against your installed skills (names,
  descriptions and trigger words; synonyms such as "excel" → xlsx) and names the best one to three to Claude. It is
  silent on vague messages, never names a skill you turned off or marked failing, and takes about 0.1 s.
- **Skills page:** a "try a message" box, and a report of how often a named skill was then used, and which ones were
  named but skipped.
- **No double rule:** when superpowers is installed, the session-start note carries only what Axios knows about you.
- **Model Lab:** full-width network, theme colours everywhere (negative weights pick a contrasting colour), no overflow.
- **Desktop shortcut:** uses a versioned copy of the current icon.

## 2.2.0

- **Guard:** a PreToolUse hook that blocks mass deletes, workspace wipes, destroyed git history, emptied bins, deleted
  models and datasets, disk tools and protected paths, and asks before risky git and delete commands; rules, protected
  paths, a tester and a log on the Guard page.
- **Model Lab:** a safe model loader (no code from the file runs) with a neuron-level view drawn from real weights.
- **Brand:** the new Axios mark everywhere, and the Axios White theme as the default.

## 2.1.0

- **Scholar studio:** slide decks, Word, Excel, LaTeX papers, posters, publication figures and motion-design videos, made by
  Claude with your skills in a sandboxed project folder, with previews and revisions; a toolbox that installs what is missing.
- **Failover chains:** several providers in order; rate-limited or exhausted ones are skipped and rested.
- **Claude Code Router:** install, start, stop, open its UI, launch its profiles, and use its gateway as a provider.
- **Google Gemini** preset (free AI Studio key).

## 2.0.0

- **Plugin:** install with `/plugin marketplace add OWNER/REPO` and `/plugin install axios@axios`. A session-start hook
  starts the dashboard; the `axios` skill and the `/axios` command use it.
- **Skill discipline:** every session checks and uses matching skills first, informed by your proven and failing skills.
- **Providers:** OpenRouter, GroqCloud, Ollama, LM Studio or any compatible endpoint, with a local bridge for
  OpenAI-style APIs, encrypted keys, a fallback offered when you hit a limit, and `mc claude <profile>`.
- **Account & usage:** plan, the 5-hour window and the week with reset countdowns, usage by day and model, limit notices.
- **New pages:** Live agents (steps and file diffs as they happen), Projects (with graphify graphs), Code, Study,
  Skills (switches, verdicts, a GitHub skill finder with quarantine and scan), Skill tree, Themes (11).
- **Fixed:** tasks wrongly shown as running (expired monitors, tasks without a start time).

## 1.0.0

- The dashboard: table, conversations, tasks, board, downloads, machine, plans and artifacts.
