---
phase: 181-language-preserving-generation
plan: 02
subsystem: context-engine (agent prompt-assembly)
tags: [GEN-01, multilingual, summarization, i7-single-source, tdd]
requires:
  - "Phase 180 OBS-01 summary_language_mismatch signal (already wired; GEN-01 relies on it as build-first visibility, does NOT rebuild it)"
provides:
  - "LANGUAGE_PRESERVATION_INSTRUCTION — one exported sentence (I7) shared by the dag depth templates and the pipeline compaction instructions"
  - "Dag leaf/condense summaries (all 4 depths × both aggressive modes) instruct the model to summarize in the source language, never translate"
  - "Pipeline buildComisCompactionInstructions carries the same sentence + a headings-verbatim clause pinning the nine ## Section headings English"
affects:
  - "lcd-leaf-summarizer.ts (consumes buildDepthAwareInstructions — now passes the language sentence through unchanged)"
  - "compactWithFallback pipeline (the customInstructions the SDK receives now carry the sentence + clause)"
  - "Distilled memories derived from these summaries inherit the source language for free (single content flow — no second generation pass)"
tech-stack:
  added: []
  patterns:
    - "Pattern D — append-to-base prompt sentence (mirror the existing `aggressive ? base + ... : base` ternary; append onto base before the ternary)"
    - "I7 single-source: one exported constant imported by both summary sites; the two cannot silently drift"
    - "PRIVATE builder asserted via the existing indirect mock-SDK capture (mockGenerateSummary.mock.calls[0][6]) — no test-only export"
key-files:
  created: []
  modified:
    - "packages/agent/src/context-engine/summarize-prompt-style.ts (+exported constant, +4 depth-branch appends; 60→77L)"
    - "packages/agent/src/context-engine/summarize-prompt-style.test.ts (+GEN-01 describe: 8 depth×mode cases + structural-token guards)"
    - "packages/agent/src/context-engine/llm-compaction.ts (+import, +pipeline clause at end of buildComisCompactionInstructions; 771→774L)"
    - "packages/agent/src/context-engine/llm-compaction.test.ts (+GEN-01 describe: captured-instructions assertions + 9-heading regression)"
decisions:
  - "Hosted the shared constant in summarize-prompt-style.ts (60→77L, ample) and imported into llm-compaction.ts (774L, ≤800) — the A1 new-leaf fallback was NOT needed (the append was 3 lines, well under the 29L headroom)."
  - "buildComisCompactionInstructions kept PRIVATE; Task 2 asserts on the captured customInstructions via the existing mockGenerateSummary path (arg index 6), exactly as the plan's <interfaces> directed — no dead export added."
  - "The nine ## Section headings + the dag Files:/Expand for:/[SUPERSEDED] tokens stay verbatim-English; the pipeline clause explicitly pins them so validateCompactionSummary still matches (a localized heading would demote to the fallback ladder and invert GEN-01's goal)."
metrics:
  duration: ~18m
  tasks: 2
  files_changed: 4
  tests_added: 17
  completed: 2026-06-13
---

# Phase 181 Plan 02: Language-preserving generation (GEN-01) Summary

One exported language-preservation sentence (I7) now rides every dag depth template (4 depths × both aggressive modes) and the pipeline compaction instructions, so summaries — and the distilled memories derived from them — follow the conversation's language instead of defaulting to English, while the machine-parsed scaffolding (nine `## Section` headings, dag `Files:`/`[SUPERSEDED]` tokens) stays verbatim-English so `validateCompactionSummary` still passes.

## What was built

- **`LANGUAGE_PRESERVATION_INSTRUCTION`** (new exported constant in `summarize-prompt-style.ts`): _"Write the summary in the dominant language of the source content — if the conversation is in Hebrew, summarize in Hebrew; never translate. Keep code identifiers, file paths, tool names, and error strings verbatim."_ Defined ONCE (I7).
- **Dag (Task 1):** appended onto `base` in all four `buildDepthAwareInstructions` branches (d0/d1/d2/d3) **before** the `aggressive` ternary — one append per branch covers both aggressive modes (8 effective cases). The `Files:`/`Expand for:`/`[SUPERSEDED]` tokens were left untouched.
- **Pipeline (Task 2):** `llm-compaction.ts` imports the constant (same dir — agent↛memory cut not crossed) and appends it plus a headings-verbatim clause at the end of `buildComisCompactionInstructions`'s returned template: _"…However, keep the section headings (the "## ..." lines) exactly as given above, in English — only the section CONTENT follows the source language."_ The builder stays PRIVATE.

## How it works

`buildDepthAwareInstructions` feeds `lcd-leaf-summarizer.ts` (the dag leaf/condense passes); `buildComisCompactionInstructions` rides into the SDK `generateSummary` call as the 7th positional `customInstructions` arg in `compactWithFallback`. Both now carry the same sentence, so a weak/strong summarizer is told to follow the source language. The signal that a weak model ignored it (`summary_language_mismatch`) was already wired in Phase 180 — GEN-01 relies on it and does not touch it. Distillation inherits the language for free because there is a single content flow (no second generation pass) — no change needed in `lcd-distillation-runner`.

## TDD Gate Compliance

Both tasks followed RED → GREEN with separate commits; the test commit precedes the implementation for each task (project Tests-First).

| Task | RED commit | GREEN commit |
|------|-----------|--------------|
| 1 (dag, 4 depths) | `00a1e709` test(181-02): RED — sentence at 4 depths × both modes | `9b0573be` feat(181-02): dag depth templates |
| 2 (pipeline) | `947d6985` test(181-02): RED — captured customInstructions | `d5d0fc5a` feat(181-02): pipeline customInstructions |

RED was reproduced on pre-patch for the sentence-present and clause-present assertions (the constant was `undefined` / the captured instructions lacked the sentence); the 9-heading + `validateCompactionSummary` regression assertions were green before AND after.

## Verification

- `pnpm vitest run summarize-prompt-style.test.ts llm-compaction.test.ts` → **101 passed** (28 + 73).
- Single-source: `grep "Write the summary in the dominant language" packages/agent/src/context-engine/*.ts` (excluding tests) → **exactly one** production definition; `llm-compaction.ts` imports it.
- File sizes: `summarize-prompt-style.ts` = 77L, `llm-compaction.ts` = 774L (both ≤ 800).
- `pnpm lint:security` → **0 errors** (pre-existing repo-wide warnings only; none in changed files).
- `pnpm test:architecture` → **421 passed** (file-size + public-surface gates; the new export is not a dead export and is not on the package barrel, so no public-surface/policy change).
- `pnpm --filter @comis/agent build` → clean (`tsc`, after the dependency `dist/` was built).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Worktree base hash typo + missing dependency builds**
- **Found during:** Setup (before Task 1).
- **Issue (a):** The `<worktree_branch_check>` base hash `26f2ee69` did not exist; it was a one-character typo for the real Phase-180-merged HEAD `26f2ea69` (`ee` vs `ea`). The worktree was created off the stale tip `541abaf9`, which is an ancestor of the intended base and lacks all Phase 180 work (including the OBS-01 `summary_language_mismatch` wiring this plan depends on).
- **Fix (a):** Reset the per-agent branch to the correct `26f2ea69` (HEAD was confirmed on a `worktree-agent-*` branch, so the reset is exactly what the check block intended). Verified the `summary_language_mismatch` commit `b3e0e8e5` is present in history.
- **Issue (b):** Fresh worktree had absent/stale `node_modules` + `dist`; `pnpm --filter @comis/agent build` failed with `Cannot find module '@comis/observability'/'@comis/shared'` (dependency `dist/` not built).
- **Fix (b):** `pnpm install` then full `pnpm build` to build all workspace packages in dependency order (per the worktree-environment-setup instructions). After that, `@comis/agent` compiles cleanly. These errors were pre-existing environment state, not caused by the plan's changes.
- **Files modified:** None (environment/git only).
- **Commit:** N/A (no code impact).

The A1 new-leaf fallback (`language-preservation.ts`) was offered in the plan but NOT needed — `llm-compaction.ts` stayed at 774L (≤ 800) with the in-place import, exactly as the plan preferred.

## Known Stubs

None. Both sites carry the real sentence; no placeholder/empty-data path was introduced.

## Self-Check: PASSED

- Created files exist:
  - FOUND: `.planning/phases/181-language-preserving-generation/181-02-SUMMARY.md` (this file)
- Modified files exist (all 4):
  - FOUND: `packages/agent/src/context-engine/summarize-prompt-style.ts`
  - FOUND: `packages/agent/src/context-engine/summarize-prompt-style.test.ts`
  - FOUND: `packages/agent/src/context-engine/llm-compaction.ts`
  - FOUND: `packages/agent/src/context-engine/llm-compaction.test.ts`
- Commits exist:
  - FOUND: `00a1e709` (Task 1 RED)
  - FOUND: `9b0573be` (Task 1 GREEN)
  - FOUND: `947d6985` (Task 2 RED)
  - FOUND: `d5d0fc5a` (Task 2 GREEN)
