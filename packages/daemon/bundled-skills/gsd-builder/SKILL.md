---
name: gsd-builder
description: Implement a design document end-to-end in a target repo by driving Claude Code through the GSD workflow — define a GSD milestone from the doc, then run /gsd-autonomous (TDD, skip-discuss) to build all phases unattended. Use when the operator hands you a design/spec document and asks to autonomously build, implement, or "ship" it as a milestone in a specific repository. This is a LONG, durable drive (often hours) — not a quick task.
metadata:
  version: "0.3.1"
---

# Driving a GSD autonomous build from a design doc

You implement a whole milestone from a design document by **driving Claude Code** (your `claude-code`
skill + the `terminal_session_*` tools) through the **GSD workflow** in the target repo:

> stage the repo + doc → `/gsd-new-milestone` (define the milestone from the doc) → confirm the scope → `/gsd-autonomous` (build every phase, TDD) → verify → report.

You are the **orchestrator**: GSD itself (`/gsd-*`) runs inside the driven Claude Code, not in you.
Your job is to set it up, drive it through the gates, keep the long run healthy, and verify the
result honestly. This is a **multi-hour, durable** drive — treat it as one from the start (durable
session, per-phase engagement, honest verification).

## 0. Prerequisites (check first; STOP and tell the operator if missing)

- A `claude` allow-entry is configured (see the terminal-driver docs) and Claude Code is authenticated on the host.
- **GSD is reached purely through the driven Claude's `/gsd-*` slash-commands** (`/gsd-new-project`, `/gsd-autonomous`, …). Issue them directly in your build session — there is **nothing to verify or check beforehand**, and no shell command to run to "confirm GSD" (its tooling is internal and not on `PATH`). Run the **entire build in that one session, in your target project only** — never open a second session and never switch to a different project. If GSD genuinely isn't installed, the slash-command itself says so; only then stop and tell the operator to install it (GSD ships from `github.com/open-gsd/gsd-core`).
- You have the **target repo** (a git URL or an existing path) and the **design document** (the operator usually sends it in the chat).
- A well-structured design doc is the linchpin: it should contain a clear **scope / requirements / phases** section (GSD turns this into the roadmap). A vague doc → a wrong milestone built unattended. If the doc is thin, say so before starting.

## 1. Stage the work

Do all staging **through the driven Claude session** (launched in §2), not your own exec/bash tool: that tool runs in a **narrow sandbox** and often cannot see host paths outside the agent workspace, so `cat`-ing the operator's doc path with it returns a false *"no such file"*. The driven Claude has `filesystem:home` and reads/writes anywhere under the home dir — use it for every file step below. Only conclude the doc is genuinely missing if the **driven Claude** (not your own tool) also can't find it.

1. Pick a short kebab `project` name from the repo/doc (e.g. `verified-learning`).
2. Put the repo in the project folder `<workspace>/projects/<name>`: an existing checkout → use it; a remote → clone it; a brand-new app → `git init` an empty repo there. One repo per project folder.
3. Bring the design document into the repo at `.planning/design/new/<name>.md` (create the dir) — copy it from the operator-given host path (the driven Claude can read it even when your own tool can't) or write the pasted content verbatim. This is the brief GSD consumes.
4. **Decide the GSD entry** (drives step 3): if `.planning/PROJECT.md` is absent (a new/empty repo), this is **greenfield** → `/gsd-new-project`. If a `PROJECT.md` + prior milestones exist, it's **brownfield** → `/gsd-new-milestone`.

## 2. Launch Claude Code as a DURABLE drive

`terminal_session_create({ allowId: "claude", command: "claude", project: "<name>", drive: { durable: true, heartbeatNotifyMs: 3600000 } })`.

Durable is mandatory — a milestone build crosses the daemon's lifetime; the durable tmux drive
survives a restart and resumes. Handle the trust gate per the `claude-code` skill, then proceed.

## 3. Define the milestone

Use the entry you chose in step 1.4.

**Greenfield — `/gsd-new-project --auto @<doc>`** (preferred for a new app). The `--auto` flag
extracts the scope from the referenced doc and runs research → requirements → roadmap **with no
further interaction** (it auto-approves requirements + the roadmap). It still asks a few **initial
config gates** via the picker — granularity, git, agents, and the verify-plans / verify-work
toggles. Drive those with sensible defaults (standard granularity, git on, default agents,
verifiers on), then let it auto-build the roadmap. Some gates are **optional add-ons with no
recommended default** (e.g. PR-body sections) — for those, pick the minimal / `none` option and
move on; do **not** pause to ask the operator. Only escalate a config gate if the choice materially
changes *what gets built* and the design doc doesn't cover it. The `@<doc>` is the in-repo path of
the design doc you wrote in step 1.3.

**Brownfield — `/gsd-new-milestone @<doc>`** (a new milestone on an existing GSD project). This one
is **interactive** across its gates — drive them from the doc:
- **Version / milestone summary** → approve (the doc + the next version are the source of truth).
- **Requirements scoping** (a per-category picker) → select what the doc's scope calls for (defer only what the doc marks out-of-scope).
- **Roadmap approval** → approve once the phases + coverage match the doc.

Any gate is a menu/picker — read the screen, answer it (arrows/number + Enter), and `read` back to
confirm, exactly like driving any picker.

**The one checkpoint to keep even under "no questions":** once the milestone is scoped (you can see
the roadmap — phases + requirements), send the operator a single short summary —
*"Scoped milestone vX: N phases, M requirements (list). Building autonomously now."* — and proceed.
This is the highest-leverage human gate (the doc→milestone translation); it's one message, not a
conversation. Only wait for a reply if the operator asked you to gate on it.

## 4. Build the milestone — one phase at a time, resetting context each phase

A multi-phase GSD build will **not** fit in a single Claude context: the research / plan / execute
work fills the window *within one phase*, and `/gsd-new-project --auto` auto-chains straight into
phase 1 on top of the already-large new-project context — so a plain `/gsd-autonomous` runs the
window to auto-compact and strands the build (observed live: 95% context, **zero code written**,
drive abandoned at the context dialog). GSD persists all state in `.planning/`, so a **fresh context
resumes cleanly** — drive the build one phase at a time, resetting Claude's context before each:

1. Confirm `workflow.skip_discuss: true` (standard no-discuss; set via `/gsd-settings` if not).
2. Read `.planning/ROADMAP.md` for the phase count **N**.
3. For each phase `i = 1..N`:
   - **Reset context as SEPARATE inputs, one per send, `wait`ing for each to take effect:**
     **(a) Press `Escape` FIRST to stop Claude.** Claude shows its "context critical" summary *while it
     is still busy/churning*, and **input is ignored while it is busy** — so you must press `Escape`
     to interrupt it and bring it to an idle `❯` prompt before anything else. Skipping this is the #1
     way the build freezes (your command sits typed-but-unprocessed at the prompt).
     **(b) Send `/clear` alone** → wait for the fresh prompt (confirm any "clear history?" prompt).
     **(c) Send `/gsd-autonomous --only <i>` alone.**
     **Never combine these on one line** (`/clear then /gsd-autonomous …` is wrong — `/clear` ignores
     trailing text). On phase 1, if the auto-chain already pushed Claude toward its limit, do this
     (Escape → clear → resume) rather than letting it `continue`.
   - **`/gsd-autonomous --only <i>`** executes exactly that one phase (plan → execute, TDD) in the
     fresh context, resuming from the persisted `.planning/` state.
   - `wait` for the phase to finish and commit (its work shows in git + `STATE.md`), then go to `i+1`.
   - **Drive each phase in an ACTIVE turn — do not background and rely on being woken.** A backgrounded
     drive is not reliably re-woken at GSD's context dialogs, so it strands. Keep `wait`ing through
     the phase; if your own turn must end, leave the session at a resumable point (state persisted) so
     the next turn/operator nudge picks it up cleanly — never leave a half-typed command at the prompt.
4. **At any "context nearly full / auto-compact" dialog, ALWAYS choose pause + `/clear` — never
   `continue`.** "Continue" runs the window into auto-compact and abandons the build; the pause/clear
   path *is* the per-phase reset above.
5. **Stay engaged per phase.** Each `--only <i>` is a bounded operation you actively `wait` on — do
   **not** background the whole multi-phase build as one long drive: a backgrounded drive won't be
   woken to perform the per-phase resets, and it strands at the first context dialog.

Within a phase, answer routine grey-area pauses with the sensible default (the doc + the phase's
success criteria are the spec). Escalate only a GENUINE block — auth failure, a destructive action,
a hard error the build can't pass, or a decision the doc doesn't cover — with the exact screen
context; never silently abandon or fabricate progress.

## 5. Verify, then report (never a blind "done")

When all N phases are complete (the ROADMAP shows every phase done + the milestone audit ran),
**verify before claiming success** — the worst outcome is a false "done":
- Read the final `.planning/ROADMAP.md` / `STATE.md` — all phases complete, the milestone audit's
  blocker count is zero.
- Confirm the project's own gate passed (e.g. its `validate`/test command green) — `/gsd-autonomous`
  runs per-phase validation, but confirm the final state, don't assume it.

Report to the operator: the milestone built, the phase + requirement count, the test/validate
result, where the branch is, and any deferred/escalated items. If anything failed or is unverifiable,
say so plainly with the evidence — a partial or failed build reported honestly beats a false success.

## Gotchas

- **GSD lives in the driven Claude Code, not in you** — you never run `/gsd-*` yourself; you type
  them into the Claude Code session and drive its gates.
- **`/gsd-autonomous` needs the milestone defined first** — it errors out otherwise. Always do step 3 before step 4.
- **One repo per project folder** — a fresh `project` name for a new build; the same name to resume one.
- **Honest completion** — confirm the final state + the project's gate before reporting success; escalate a real block instead of pushing past it.
- **Operator-deferred steps** — some repos intentionally defer `/gsd-complete-milestone` + `/gsd-cleanup` (the operator ships the PR). Don't force them unless the operator asks.
