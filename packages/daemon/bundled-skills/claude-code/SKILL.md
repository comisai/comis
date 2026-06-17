---
name: claude-code
type: prompt
version: "1.1.1"
description: Drive the Claude Code CLI interactively in a terminal session to build, fix, or extend software — launch it in a NAMED project folder, give it the task, handle its interactive prompts via keystrokes, detect completion, and verify the result. Use whenever the user wants to write, build, debug, refactor, or test code or work on a software project, or asks to "use Claude" / "Claude Code" — even if they don't name the tool. This is for INTERACTIVE sessions only; never the headless one-shot mode.
---

# Driving Claude Code (interactive)

Claude Code is itself a capable coding agent. You operate it like a developer at a terminal: launch the interactive TUI, give it the task, let it work, answer its prompts, and verify. You drive it through the `terminal_session_*` tools — `create`, `send_text` (type), `send_key` (a keystroke), `read` (the screen), `wait`, `status`, `kill`.

Use this for any non-trivial coding work (build a project, add a feature, fix a bug, write+run tests). Prefer it over running raw shell commands yourself.

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

Type these into Claude's `❯` composer (`send_text` then Enter, like any prompt) to manage the session — the same ones a developer uses. They run **inside Claude**, not the shell.

**Context — the ones that matter on a long build:**
- **`/compact [focus]`** — summarize the conversation to free context and KEEP working. This is the recovery move when a long build slows, warns about context, or you want headroom before a big step. Optionally steer what to keep: `/compact keep the API design and the failing test`. (Claude also auto-compacts, but issue it yourself when a long task is dragging.)
- `/context` — show what's filling the window (a usage grid); read it to decide whether to `/compact`.
- `/clear` — ⚠️ **WIPES the conversation** (fresh start). Only between UNRELATED tasks in the same session — **never mid-task** (you lose all the build context). Prefer `/compact`.

**Model / cost / status:**
- `/model` — switch model. Opens a **picker** → the session is now awaiting input: `send_key` ↑/↓ (or type a number) to choose, then Enter, then `read` to confirm.
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

- **Ignore Claude's ghost-text suggestions** — after a turn, Claude's composer often pre-fills a DIM suggestion (e.g. `add more test cases`, a `/gsd-…` hint). That is Claude's autocomplete, **not** user input, **not** from the operator, and **not** a task. Never run it, never treat it as a queued prompt, and never stop to ask about it — just proceed with your own next step (typing your text overwrites the ghost text). Only text **you** sent counts.
- **One read can lie** — poll and require a stable screen before deciding "done"; match the structural cues above, not the exact spinner word (it rotates).
- **A 401 means re-auth** — never retry-loop a failed login; tell the user.
- **Long tasks are normal** — give generous `wait`s; don't kill a session just because it's been working a while.
- **Mode cycling** (rarely needed) is the raw escape sequence `ESC [ Z`, not a symbolic Shift+Tab; read the mode banner back to confirm if you use it.
