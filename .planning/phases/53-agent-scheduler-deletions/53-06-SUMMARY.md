---
plan: "53-06"
phase: "53-agent-scheduler-deletions"
status: complete
requirements:
  - DUP-CONS-06
tasks_completed: 2
tasks_total: 2
commits:
  - 38a2e859  # refactor(53-06): collapse oauth-token-manager withTimeout onto @comis/shared canonical
  - 5b6f4356  # refactor(53-06): rename skills withTimeout to combineSignalWithTimeout
created: 2026-05-22
---

# Plan 53-06: withTimeout Consolidation — SUMMARY

## Objective Achieved

Resolved the 3-way `withTimeout` name collision (DUP-CONS-06) by collapsing the
genuinely-duplicate agent variant and renaming the semantically-distinct skills
variant. Three signatures previously named `withTimeout` are now down to two
unambiguous names, each named for its actual primitive.

## What Changed

### Task 1 — Collapse `oauth-token-manager` private `withTimeout` onto `@comis/shared` (commit `38a2e859`)

Pre-state: `packages/agent/src/model/oauth-token-manager.ts:252-269` declared
its own `withTimeout` (promise-racing). Functionally equivalent to
`@comis/shared`'s canonical, but a duplicate definition. Removed the private
declaration and imported the shared helper. Local `{ ok, value }` Result-style
wrapping at the 2 call sites stays — shared's `withTimeout` throws on timeout,
the wrapping converts the throw to a tagged Result before the upstream callers
see it. No upstream caller change needed (per PATTERNS.md cross-reference to
`sub-agent-result-processor.ts:25,497-508`).

### Task 2 — Rename skills `withTimeout` → `combineSignalWithTimeout` (commit `5b6f4356`)

Pre-state: `packages/skills/src/tools/builtin/web-shared.ts:59` exported a
function named `withTimeout` that takes an optional AbortSignal + a timeout
and returns an AbortSignal that fires when either condition is met (an
`AbortSignal.any`-like primitive). This is NOT the same primitive as shared's
`withTimeout` (which races a Promise against a deadline). The name collision
was misleading.

Renamed to `combineSignalWithTimeout` to reflect intent. All 7 web-search
provider callers (brave, exa, grok, jina, perplexity, searxng, tavily) updated
in lockstep. JSDoc on the function now explains the naming distinction.

## Verification

- `pnpm build`, `pnpm test`, `pnpm lint:security`, `pnpm cycles` GREEN at HEAD
  (verified on main repo post-merge — see orchestrator gate).
- `grep -rn '\bwithTimeout\b' packages/agent/src/model/oauth-token-manager.ts`
  returns ONLY the import line from `@comis/shared` (no private declaration).
- `grep -rn '\bwithTimeout\b' packages/skills/src/tools/builtin/` returns
  ONLY JSDoc references (no production callers; the helper itself is now
  named `combineSignalWithTimeout`).
- `grep -q 'export function combineSignalWithTimeout' packages/skills/src/tools/builtin/web-shared.ts`
  finds the renamed export.

## Cross-phase Coordination

Phase 54 also touches `packages/skills/` (different files — verified disjoint
by RESEARCH §11). The `web-shared.ts` rename here is the only skills touch
in Phase 53. Post-Wave-B rebase should be conflict-free.

## must_haves

- `withTimeout` collisions resolved: zero ambiguity remains in the codebase
- Skills helper renamed to match its actual primitive (signal-combine, not
  promise-race)
- All 7 production callers updated
- `pnpm validate` green at HEAD (post-merge)

## Files Touched (this plan)

| File | Change |
|------|--------|
| `packages/agent/src/model/oauth-token-manager.ts` | Remove private `withTimeout`, import from `@comis/shared` |
| `packages/skills/src/tools/builtin/web-shared.ts` | Rename `withTimeout` → `combineSignalWithTimeout` + JSDoc |
| `packages/skills/src/tools/builtin/web-search-brave.ts` | Update import + 1 call site |
| `packages/skills/src/tools/builtin/web-search-exa.ts` | Update import + 1 call site |
| `packages/skills/src/tools/builtin/web-search-grok.ts` | Update import + 1 call site |
| `packages/skills/src/tools/builtin/web-search-jina.ts` | Update import + 1 call site |
| `packages/skills/src/tools/builtin/web-search-perplexity.ts` | Update import + 1 call site |
| `packages/skills/src/tools/builtin/web-search-searxng.ts` | Update import + 1 call site |
| `packages/skills/src/tools/builtin/web-search-tavily.ts` | Update import + 1 call site |

## Process Notes

This SUMMARY was written by the orchestrator after the executor agent hit an
authentication failure between Task 2's edits and the SUMMARY-commit step.
The Task 2 changes were inspected, verified clean (all 7 callers + the helper
itself match the rename contract), then manually committed by the
orchestrator. `pnpm validate` was run post-merge on main rather than in the
worktree (which lacked an installed `node_modules`).
