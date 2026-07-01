---
name: claude-code
type: prompt
version: "1.1.5"
description: Drive the Claude Code CLI interactively in a terminal session to build, fix, or extend software — launch it in a NAMED project folder, give it the task, handle its interactive prompts via keystrokes, detect completion, and verify the result. Use whenever the user wants to write, build, debug, refactor, or test code or work on a software project, or asks to "use Claude" / "Claude Code" — even if they don't name the tool. This is for INTERACTIVE sessions only; never the headless one-shot mode.
---

# Driving Claude Code (interactive)

Claude Code is itself a capable coding agent. You operate it like a developer at a terminal: launch the interactive TUI, give it the task, let it work, answer its prompts, and verify. You drive it through the `terminal_session_*` tools — `create`, `send_text` (type), `send_key` (a keystroke), `read` (the screen), `wait`, `status`, `kill`.

Use this for any non-trivial coding work (build a project, add a feature, fix a bug, write+run tests). Prefer it over running raw shell commands yourself.

> **You already have this guide — do NOT go hunting for it.** This SKILL.md is injected into your context;
> the numbered steps below are everything you need. Do **not** `find` / `read` / `exec` / `grep` for a
> "claude-code" or "SKILL.md" file, nor for the project folder or "how to drive claude" — that hunt FAILS
> (the file is outside your exec sandbox, and a guessed path like `~claude-code/SKILL.md` trips the
> path-traversal guard), and flailing on those tool errors is what derails a drive into wrongly reporting
> *"the message came through empty."* **Your task is in THIS conversation.** If you're unsure what to build,
> re-read the request you were given — never claim the message was empty/missing when a task was provided.
> Go straight to §1 below (create the session) and drive; your first tool call should be
> `terminal_session_create`, not a filesystem search.

## 1. Launch — always in a named project

Call `terminal_session_create` with:
- `allowId: "claude"`, `command: "claude"`
- **`project: "<short-kebab-name>"`** — this is mandatory for coding work. It opens a dedicated, persistent folder `<workspace>/projects/<name>/` you can come back to. New project → a new name. To **fix or extend an existing project**, pass the **same** `project` name (the folder and its code are reused). Do NOT use `cwd`, and do NOT rely on the display `name` — only `project` creates a retrievable folder.
- pick a clear `project` name from the task ("todo-app", "rate-limiter", "snake-game").

To discover existing projects to continue, have a quick session list `<workspace>/projects/`.

## 2. Handle the first screen

After launch, `read` the screen:
- **Trust gate** — text like `Accessing workspace:` / `Is this a project you ... trust?` with `1. Yes, I trust this folder` and `Enter to confirm`. Option 1 is pre-selected → `send_key` **Enter**.
- **Login / auth error** (a sign-in screen, or `Invalid authentication` / a 401) → STOP and tell the user Claude Code needs re-authentication on the host. Do not loop or retry.

Permission prompts are pre-disabled by the operator's launch config, so you normally go straight to a ready prompt.

## 3. Give it the task

Submit a prompt only when the session is **idle** (a bare `❯` input line, no spinner). Then:
- `send_text` a clear, complete task. Be specific about the deliverable and the acceptance bar — e.g. *"Build a CLI todo app in Python with add/list/done/clear commands, persist to todos.json, write unit tests, and run them until they pass."*
- `send_key` **Enter** to submit.

Claude works autonomously with its own tools (edit, bash, tests, git). Give it the goal, not step-by-step micro-instructions.

> **Deliver the task BEFORE you wait — the order is fixed.** The most common driving mistake is to
> clear the first screen and then `wait`/poll *without ever sending the task* — the session then sits
> idle forever with nothing to do (a long `wait` on a fresh session gets backgrounded, and the drive
> strands at "idle, waiting for input"). Sequence: clear the first screen → **`send_text` the full task
> + Enter** → only THEN `wait`/poll. Never `wait` on a session you have not yet given a task.

## 3b. Unattended drives (webhook / cron — no human in the loop)

When this drive was triggered by a webhook or a schedule (not a live chat), **there is no human to
"reply with the next step"** — so you must carry the whole job to completion in this drive, not hand
control back:
- Give Claude the **COMPLETE** task in one prompt (§3) so it can run end-to-end on its own — don't
  split it into steps that need someone to continue.
- Then poll to completion (§4 + §6): `wait`/`read` through the minutes of work until the build is done
  and the tests are green. If the long build gets backgrounded and you are later notified it has
  settled, **resume and finish the job** — verify the result (§6) and report the outcome. Do **not**
  end at "the session is idle, waiting for input"; that hand-back only makes sense in an interactive chat.
- If you genuinely cannot finish (auth needed, repeated failure), report the failure honestly — never
  claim a success you did not verify.

## 4. While it works

`read` on an interval; do not type while it is working.
- **Working** — a spinner line: a glyph (`✶ ✳ ✻ ✽ ·`) + a gerund (`Brewing…`, `Calculating…`) often with `(esc to interrupt)` or a tool line ending `⎿ Waiting…`. Keep waiting (`wait`, then `read` again). Claude is slow — a real task is minutes of spinner, that is normal.
- To **steer** without stopping, `send_text` a correction + Enter; Claude reads it after the current step. To **interrupt**, `send_key` Esc.
- **Context filling on a long build?** Free it and keep going with `/compact` (see *Slash commands* below) — don't let a long task stall on a full context window.

## 5. If a permission prompt appears

It should not (operator config skips it), but if you see `Do you want to proceed?` with `1. Yes / 2. Yes, and always allow… / 3. No`:
- Routine action → `send_text` **`2`** then Enter ("allow and remember", so it stops re-asking).
- A destructive or irreversible action you are not sure about → surface it to the user instead of approving.

## 6. Detect completion, then verify

Done when **all** hold on a `read`: no spinner line, a turn-end line is visible (e.g. `✻ Cooked for 3s` or `⏺ Done — …`), and a bare `❯` input box. Read it twice a moment apart to be sure (the screen can blank for one frame mid-render — never trust a single read). The idle box may show DIM ghost-text (a suggested next prompt like `add more test cases`) — that is autocomplete, NOT queued input; ignore it (see Gotchas) and keep going with your own plan.

Then **verify the work** — do not assume success:
- `read` the transcript for the test result (`Ran N tests … OK`, or pass/fail counts).
- If unclear, `send_text` "run the tests and show me the exact result" + Enter and read it.
- Confirm the expected files exist under `projects/<name>/`.

Report what was built, where (`projects/<name>/`), and whether tests passed.

## 7. Revisit a project later

For "fix the bug in <name>" / "add a feature to <name>": `terminal_session_create` again with the **same** `project: "<name>"`. The folder and prior code are still there; Claude sees them. Give it the new task as in step 3.

## 8. Finish

Leave the session running if more follow-ups are likely; otherwise `terminal_session_kill` it when the user is done.

## Slash commands (in-session)

Type these into Claude's `❯` composer (`send_text` then Enter, like any prompt) to manage the session — the same ones a developer uses. They run **inside Claude**, not the shell. Issue them mid-session whenever the user asks — including **after a build is done**; if a request bundles building *and* a session command (e.g. "build it, then switch to Opus"), do BOTH before reporting back — don't end the turn at "build complete".

**Context — the ones that matter on a long build:**
- **`/compact [focus]`** — summarize the conversation to free context and KEEP working. This is the recovery move when a long build slows, warns about context, or you want headroom before a big step. Optionally steer what to keep: `/compact keep the API design and the failing test`. (Claude also auto-compacts, but issue it yourself when a long task is dragging.)
- `/context` — show what's filling the window (a usage grid); read it to decide whether to `/compact`.
- `/clear` — ⚠️ **WIPES the conversation** (fresh start). Only between UNRELATED tasks in the same session — **never mid-task** (you lose all the build context). Prefer `/compact`.

**Model / cost / status:**
- `/model` — switch model. Opens a **picker** → the session is now awaiting input: `send_key` ↑/↓ (or type a number) to choose. ⚠️ **Enter saves it as the DEFAULT for ALL future sessions** — press **`s`** instead to switch for THIS session only. Only set a new default if the user explicitly wants a permanent change; otherwise use `s`. Then `read` to confirm.
- `/usage` (alias `/cost`) — token spend + plan limits this session.
- `/status` — model, account, connectivity (use it when something seems off).

**Project / work:**
- `/init` — scaffold a `CLAUDE.md` for the project (a good first step in a fresh repo).
- `/diff` — view the working-tree changes.
- `/plan [description]` — enter plan mode (Claude plans before editing). Usually unneeded here (the operator runs bypass mode to just do the work), but available for an explicit "plan it first" request.
- `/resume` — resume Claude's OWN prior conversation (a picker). Usually NOT needed: to continue a project you relaunch in the same `project` folder (§7) — that's the durable path. Use `/resume` only when you specifically want Claude's earlier chat back.

**Never type these — they need a human:** `/login`, `/logout`, `/config`, `/upgrade`. If the session needs one (e.g. an auth screen), STOP and tell the user; don't try to drive it.

**Picker rule:** any command that opens a menu (`/model`, `/resume`) leaves the session **awaiting input** — navigate with arrows or a number + Enter and `read` back to confirm BEFORE doing anything else; a single Enter won't dismiss it.

## Gotchas

- **Composer text you didn't type is ALWAYS ghost-text — never ask about it.** You are the SOLE driver of this session; the user CANNOT type into it. So any text sitting in the `❯` composer that you did not send yourself (e.g. `add more test cases`, `commit this`, a `/gsd-…` hint) is DEFINITIVELY Claude's dim autocomplete suggestion — there is no ambiguity and nothing to confirm. The plain-text screen can't show the dim styling, but you don't need it: **if you didn't type it, it's ghost-text.** Never run it, never treat it as a queued/pending instruction, and **never pause to ask the user "did this come from you?" or "should I run it?"** — just continue your own plan (your next keystroke overwrites it). And do **not** end the turn with a "want me to…?" question while the user's request still has unfinished steps — finish the requested work first.
- **One read can lie** — poll and require a stable screen before deciding "done"; match the structural cues above, not the exact spinner word (it rotates).
- **A 401 means re-auth** — never retry-loop a failed login; tell the user.
- **Long tasks are normal** — give generous `wait`s; don't kill a session just because it's been working a while.
- **Mode cycling** (rarely needed) is the raw escape sequence `ESC [ Z`, not a symbolic Shift+Tab; read the mode banner back to confirm if you use it.
