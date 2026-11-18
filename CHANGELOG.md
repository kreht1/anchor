# Changelog

## 4.2.0: Anchor in Codex, and a skill bridge

- **Codex support.** Codex installs Anchor from the same marketplace (`codex plugin marketplace add kreht1/anchor`,
  `codex plugin add anchor@anchor`, then approve its hooks with `/hooks`). A Codex manifest and hooks file give it the
  session note, token saver, governor tiers, topic-switch prompt, Guard and skill hints, all in Codex's own terms
  (shell, `apply_patch`, `$skill`, `/new`). `anchor codex setup` does it for you and adds a board note to
  `~/.codex/AGENTS.md`.
- **Skill bridge.** A new **Codex** page and `anchor codex skills|port|unport|sync`: every Claude skill with a
  verdict (works as-is, adapted, Claude-only), ported into `~/.agents/skills` with a Codex frontmatter, Claude path
  variables resolved, a "Running in Codex" note mapping the Claude tools it uses, and sibling skills named as Codex
  calls them. Sync re-ports a skill when its source changes; folders Anchor did not make are never touched.
- **Find skills.** Well-known collections (caveman, superpowers, Anthropic's skills, science skills…) plus a GitHub
  search; installs go through the existing quarantine scan and can target Claude, Codex or both. The Skills page's
  installer gained the same choice.
- **Codex usage.** `anchor codex usage`, a Codex line in `anchor usage`, and the Codex page read Codex's session logs:
  tokens, cache share, context per session, and Codex's own limit windows with reset times.
- **Guard** understands Codex's `apply_patch` edits and argv-style shell commands.
- **Fix found on the way:** a SKILL.md saved with a byte-order mark is silently skipped by Codex; ports never have one.

## 4.1.0: Trash, per-agent costs, and a playbook for long jobs

Built from three measured head-to-head runs (the same task done by one agent with Anchor and one without).

- **Trash.** A new page for the files your sessions leave behind: temp bundles, build caches, scratch databases,
  logs. Claude adds them with `anchor trash add <path> --why "…"` instead of ending its report with a "please delete"
  list; you delete each one, or all at once, in one click. Deleting moves to the Recycle Bin (or the system trash),
  so it can be undone. **Keep** takes an item off the list and leaves the file alone, **Show** opens its folder. The
  menu shows how many are waiting. Paths that look like a drive, your home folder, a top-level home folder, a git
  repository or Claude/Anchor settings are never accepted, and are checked again at delete time. Only you empty the
  Trash: the command refuses inside a Claude session. Also `anchor trash`, `anchor trash keep <id>`,
  `anchor trash rm <id>`, `anchor trash empty [--permanent]`.
- **Guard hands blocked deletes to the Trash.** When Guard blocks Claude from deleting a file (a `.bin` temp bundle
  that looked like a model, say), the path goes to the Trash with the reason, and Claude is told to point you
  there, so a false alarm costs one click instead of a hunt through Downloads.
- **`anchor runs`: what each subagent cost.** Every subagent of a session, measured the same way from its own
  transcript: weighted tokens, replies, tool calls, output, cache written and read, peak context, the share of cost
  spent re-reading a context over 150k, images, working minutes with stalls removed, model, most used tools. A run
  that crashed and was resumed counts as one agent. Made for comparing two approaches to the same job.
- **Token saver: long agent jobs.** The measurements showed that past ~150k tokens of context, re-reading it is half
  to two thirds of an agent's whole cost. The token-saver skill now says how to avoid it: split long jobs into
  phases that start fresh and hand off through files, write notes as you go so a resume is cheap, checkpoint on the
  board, tile screenshots into contact sheets or hand the review to a smaller model, read web pages with a script
  that returns only the fields needed, run one browser agent at a time, scroll slowly in screenshot scripts.
  The session note gained one line about phases and the Trash.
- **Fix:** `anchor open --page <name>` dropped every letter but "w" from the page name.

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
