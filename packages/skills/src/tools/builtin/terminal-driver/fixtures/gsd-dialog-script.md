# The scripted GSD-like dialog

This fixture defines the **deterministic scripted dialog sequence** that
`terminal-attention-loop.linux.test.ts` drives end-to-end against a real driven
CLI on the Linux+bwrap CI/VPS host. It is the "scripted GSD-like dialog
script across turns → completes, answering each" contract: an ordered list of
steps, each `{ prompt the driven CLI receives, the structural awaiting-input
signal the classifier must reach, the keystroke/answer to send, the expected
post-answer signal }`.

It mirrors the classifier corpus discipline (`README.md` → "The classifier
corpus"): the byte/keystroke patterns are explicit + reviewable, and the file is
**version-noted** so a `claude` bump that shifts a dialog's shape surfaces here.

## `claude` version

Pinned against **`claude --version` 2.1.161 (Claude Code)** — the same pin as the
classifier corpus.

> **REFRESH this script on each `claude` version bump.** A new
> `claude` release can rename a dialog, change a keystroke affordance, or shift
> where the cursor parks. A drift surfaces as a failing live step in
> `terminal-attention-loop.linux.test.ts` on the CI/VPS host (it SKIPS on the
> macOS author box — `bwrap` absent). Re-record/re-author the affected step,
> re-verify, and bump the version above.

## Why a scripted bash stand-in is the default driven program

The live test drives a **scripted `bash` dialog stand-in** (a `read`-prompt
sequence), NOT a live `claude`, as its DEFAULT driven program. Rationale — the
same three reasons the classifier corpus is hand-authored:

1. **Determinism.** A live `claude` milestone is non-deterministic (model output
   varies run-to-run), so it cannot deterministically pin a scripted step
   sequence. A `bash read` dialog parks the cursor at a prompt and advances on a
   keystroke EXACTLY like a CLI dialog — the classifier→fd3→answer→read loop is
   identical, but reproducible.
2. **Auth.** A live `claude` needs an authenticated Max session; a `bash` dialog
   needs nothing. The CI host has no Max credentials.
3. **Cost + duration.** A bash dialog completes in <1s; a `claude` milestone is a
   long, costed run — that is the OPT-IN soak (`terminal-gsd-soak.linux.test.ts`,
   `COMIS_RUN_SOAK=1`), not this fast E2E.

The driven program is the only difference between this E2E and the soak: the
**live attention-loop composition under test is identical** (create → classifier
reaches `awaiting-input` → fd3 `terminal:input_needed` → a woken turn answers by
keystroke → read advances). The soak swaps the bash stand-in for a real `claude`
on Max and runs it long; this E2E pins the loop fast + deterministically.

## The scripted steps

The stand-in is a `bash -c` program that emits three sequential `read` prompts,
echoing a marker after each answer, then exits. Each row is one woken turn.

| # | Prompt the driven program parks on | awaiting-input signal | `decideAutoAnswer` (safe-only) verdict | Answer sent (keystroke) | Post-answer signal |
|---|------------------------------------|-----------------------|----------------------------------------|-------------------------|--------------------|
| 1 | `Trust the files in this folder? (y/n)` | classifier `awaiting-input`, cursor parked after the `(y/n)` | `answer` (operator hint `Trust the files`) | `y` + Enter | the program echoes `TRUST_OK` and parks on prompt 2 |
| 2 | `Which option? (1/2)` (an AskUserQuestion-like choice) | `awaiting-input`, cursor parked after the `(1/2)` | `answer` (operator hint `Which option`) | `1` + Enter | echoes `OPTION_1_OK` and parks on prompt 3 |
| 3 | `Proceed with the plan? (y/n)` | `awaiting-input`, cursor parked after the `(y/n)` | **`escalate(approval)`** — the structural `proceed with` APPROVAL cue WINS over the matching hint pattern | `y` + Enter, sent by the **woken AGENT** (the escalation consumer) | echoes `PLAN_DONE` then the program EXITS (the dialog COMPLETES) |

**Step 3 is the escalate-always gate, live.** `terminal-auto-answer.ts`
checks the structural auth/destructive/approval cues BEFORE the operator
safe-pattern match, so a prompt containing `proceed with` escalates even though
the operator hint `Proceed with the plan` matches the same screen — auto-answer
never guesses an approval. In production the escalation raises
`terminal:escalated` and the AGENT decides + sends the keystroke; the live test
plays that agent role deterministically (it sends the scripted `y` + Enter after
asserting the escalate verdict).

**Completion** = every prompt answered and the program exits cleanly after
`PLAN_DONE` (the classifier reaches `exited`). The test asserts each step's
awaiting-input is reached (NO poll — the fd3 `terminal:input_needed` fires), the
step's `decideAutoAnswer` verdict matches the table, the keystroke is sent +
audited, and the sequence completes.

## The bash stand-in program

The literal program string lives in the test (`SCRIPTED_DIALOG`), so it is
regenerable + reviewable in the commit diff (the corpus discipline — never
hand-type opaque bytes into a fixture). For reference it is shaped:

```bash
read -p 'Trust the files in this folder? (y/n) ' a; echo "TRUST_OK[$a]";
read -p 'Which option? (1/2) ' b; echo "OPTION_1_OK[$b]";
read -p 'Proceed with the plan? (y/n) ' c; echo "PLAN_DONE[$c]";
```

A real `claude`-driven GSD interaction parks on the same shape (a trust dialog,
an AskUserQuestion, a final confirm); this stand-in is the deterministic,
auth-free, fast analog the E2E pins. The soak exercises the real CLI.
