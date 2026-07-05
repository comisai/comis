---
name: codex
description: Drive the OpenAI Codex CLI interactively in a terminal session to build, fix, or extend software — launch it in a NAMED project folder, give it the task, detect completion, and verify. Use this when the user explicitly wants to use Codex (the OpenAI coding CLI) for a software task. For general coding without a named tool, prefer the claude-code skill. This is for INTERACTIVE sessions only; never the headless exec mode.
metadata:
  version: "1.1.1"
---

# Driving Codex CLI (interactive)

Codex is OpenAI's terminal coding agent. You operate it like a developer: launch the interactive TUI, give it the task, let it work, and verify. Drive it through the `terminal_session_*` tools — `create`, `send_text` (type), `send_key` (a keystroke), `read` (the screen), `wait`, `status`, `kill`.

Use this only when the user asks for Codex specifically; otherwise use claude-code.

## 1. Launch — always in a named project

Call `terminal_session_create` with:
- `allowId: "codex"`, `command: "codex"`
- **`project: "<short-kebab-name>"`** — mandatory for coding work. Opens a persistent `<workspace>/projects/<name>/` folder you can return to. Same name → continue an existing project; new name → a new one. Do NOT use `cwd` or rely on the display `name`.

The operator's launch config runs Codex with its approvals and its own sandbox disabled (it already runs inside Comis's jail — Codex must not start a second sandbox layer). So you should land directly on a ready prompt with no approval prompts.

## 2. Handle the first screen

`read` the screen after launch:
- **Auth** — if you see a sign-in / device-code flow, or an authentication error, STOP and tell the user Codex needs authentication on the host (it has not been logged in). Do not loop.
- **Ready** — an empty input composer at the bottom.

## 3. Give it the task

Submit only when **idle** (empty composer, no working line). Then `send_text` a clear, complete task with the acceptance bar (e.g. write tests and run them), and `send_key` **Enter**.

IMPORTANT — Enter is contextual: it submits only from idle. **Mid-turn, Enter "steers" (injects into the running turn) and Tab "queues" for the next turn.** So never press Enter while it is working unless you intend to steer.

## 4. While it works

`read` on an interval; do not type while working.
- **Working** — a line like `• Working (1s • esc to interrupt)` with an **incrementing seconds counter**. Keep waiting.
- To interrupt, `send_key` Esc.
- **Context filling on a long build?** Free it with `/compact` (see §8) and keep going.

## 5. Detect completion, then verify

Done when the working line is **gone** AND the empty composer is back AND the screen is **stable** across two reads a moment apart. Two important traps:
- **Do not** treat a single "spinner gone" frame as done — the indicator can pause while work continues. Require a stable composer.
- **Do not** stop just because Codex printed a question like "do you want me to…?" in prose — it often asks rhetorically and proceeds. Decide state from the working-line/composer, not from prose punctuation.

Then **verify** (don't assume success): `read` the transcript for the test result, or `send_text` "run the tests and show the exact result" + Enter. Confirm files exist under `projects/<name>/`. Report what was built, where, and whether tests passed.

## 6. If an approval overlay appears

It should not (operator config bypasses approvals). If a `Would you like to run…?` overlay appears, the launch config is missing the bypass flag — report that to the user. If you must answer, `send_text` **`y`** to approve.

## 7. Hard failures to report (do not retry)

If a `read` shows either of these, Codex tried to start its own sandbox inside Comis's jail and the launch config is wrong (missing the bypass flag) — report it, don't retry:
- `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`
- `seccomp/landlock ... is not supported in this environment`

## 8. Slash commands (in-session)

Type these into Codex's composer (`send_text` then Enter) — they run **inside Codex**, not the shell. Issue them mid-session whenever the user asks, including **after a build is done** — don't end the turn at "build complete" if the user also asked for a session command.
- **`/compact`** — summarize the conversation to free context and keep working; use it on a long build before you hit the limit (Codex also auto-compacts).
- `/status` — session config + token usage. Codex has **no `/context`** — `/status` is how you check context/usage.
- `/diff` — show the git diff (including untracked files).
- `/usage` — account usage activity.
- `/init` — scaffold an `AGENTS.md` for the project.
- `/review` — have Codex review its current changes for issues before you finish.
- `/plan [description]` — switch to Plan mode (plans before editing).
- `/model` and `/permissions` open a **picker** → the session is awaiting input: navigate with arrows or a number + Enter, then `read` to confirm (a single Enter won't do it). The command is `/permissions`, **not** `/approvals` (which no longer exists).
- ⚠️ `/new` and `/clear` **WIPE the conversation** (fresh chat) — only between unrelated tasks, never mid-build; prefer `/compact`.
- Codex does NOT have `/undo`, `/help`, or `/context` — do not type those.

## 9. Revisit / finish

Continue a project with the same `project` name. Exit by `send_text` **`/quit`** (or `/exit`) + Enter — the reliable way; don't depend on a Ctrl+C-twice confirmation (not a guaranteed contract). `terminal_session_kill` when done.

## Gotchas

- **One read can lie** — poll, require a stable screen, ignore prose questions.
- **Auth errors mean login is needed on the host** — tell the user; never retry-loop.
- **Codex changes fast** (frequent releases) — rely on the structural cues above (working line, composer), not exact version strings.
