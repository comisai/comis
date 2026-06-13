---
phase: 180-search-normalize-trigram-routing-signal
plan: 03
subsystem: observability
tags: [obs-01, multilingual, fleet, trajectory, recall-attribution, de-anglicization]
requires:
  - "Phase 179 SCRIPT-01: ScriptClass / dominantScript in @comis/core (text/script-classes.ts)"
  - "v2.14 Glass Box: context:dag_degraded bridge+health_signal precedent (the dual-path template)"
  - "v2.15 Glass Box II: comis fleet buildFindings + KNOB-03 dedicated-finding precedent"
provides:
  - "context:script_zero_hit + context:summary_language_mismatch EventMap declarations (closed, content-free)"
  - "both events on BOTH paths: bridge->trajectory->comis explain AND obs-persistence->health_signal->comis fleet"
  - "fleet dedicated findings: per-(scriptClass,lane) script_zero_hit + a summary_language_mismatch rollup naming contextEngine.compaction.strongerSummarizerModel"
  - "Unicode-aware recall-attribution tokenizer (non-Latin attribution honest; ASCII byte-identical)"
affects:
  - "180-08 emit sites build against these exact event contracts (currently dark/unemitted)"
  - "comis explain timeline + comis fleet --since now surface the two multilingual signals once emitted"
tech-stack:
  added: []
  patterns:
    - "buildFtsQuery Latin-gating (\\p{L}\\p{N} split + ^[\\p{Script=Latin}\\p{N}]+$ stopword gate) ported into the pure recall-attribution tokenizer"
    - "dagDegradedEventToRow eventToRow shape (category health_signal, closed signal label in details JSON, counts/enums only) cloned for the two new mappers"
    - "KNOB-03 dedicated-finding precedent + generic-rollup exclusion (DEDICATED_SCRIPT_SIGNALS) to avoid double-report"
key-files:
  created:
    - "packages/daemon/src/api/obs-handlers/fleet-findings.ts (findings derivation extracted from fleet-health.ts for the 500-line obs-handlers cap)"
    - "packages/observability/src/trajectory/translate-payload.test.ts (direct translator-shape unit tests)"
  modified:
    - "packages/agent/src/rag/recall-attribution.ts (+ .test.ts)"
    - "packages/core/src/event-bus/events-messaging.ts"
    - "packages/observability/src/trajectory/event-bus-bridge.ts (+ .test.ts)"
    - "packages/observability/src/trajectory/translate-payload.ts"
    - "packages/observability/src/trajectory/types.ts"
    - "packages/daemon/src/observability/obs-persistence-wiring.ts (+ .test.ts)"
    - "packages/daemon/src/api/obs-handlers/fleet-health.ts (+ .test.ts)"
decisions:
  - "Recall-attribution stays PURE (no @comis/memory import): the buildFtsQuery Latin-gating pattern was inlined (LATIN_TOKEN + isStopword), not imported — the new core normalizer is not needed (attribution compares response<->memory, both un-normalized + symmetric)."
  - "Both new health_signal mappers use severity:'warning' unconditionally with NO benign allow-set (unlike dagDegraded's BENIGN_DAG_DEGRADED_REASONS): these are visibility-only signals, every occurrence is operator-relevant."
  - "Dedicated fleet findings EXCLUDE their labels from the generic health_signal:<label> rollup (DEDICATED_SCRIPT_SIGNALS) so the two new signals are not double-reported — the KNOB-03 interaction the plan called for."
  - "Findings derivation extracted to fleet-findings.ts: the plan's '<=800' file cap was wrong for the obs-handlers subdir (the arch file-size gate is 500); byte-identical relocation, NOT an allowlist bump (allowlists are shrink-only here)."
metrics:
  duration_min: 20
  tasks: 3
  files_changed: 13
  completed: 2026-06-13
---

# Phase 180 Plan 03: Search routing-signal — OBS-01 spine + recall de-Anglicization Summary

Declared the two multilingual OBS-01 event classes (`context:script_zero_hit`, `context:summary_language_mismatch`) and plumbed each on BOTH independent observability paths — bridge -> trajectory -> `comis explain`, and obs-persistence -> `health_signal` -> `comis fleet` (with dedicated, hint-carrying fleet findings) — and de-Anglicized the recall-attribution tokenizer so non-Latin attribution is honest while pure-ASCII stays byte-identical. The spine is fully wired but dark: nothing emits yet (the emit sites land in 180-08).

## What shipped

### Task 1 — recall-attribution de-Anglicization (RED 15ae0557 -> GREEN 0a8332c9)
`packages/agent/src/rag/recall-attribution.ts` `tokenize()` now splits on `/[^\p{L}\p{N}]+/u` (was an ASCII-only character class that stripped every non-ASCII letter, forcing non-Latin attribution permanently to 0). The English STOPWORDS set is now Latin-gated via a new `LATIN_TOKEN = /^[\p{Script=Latin}\p{N}]+$/u` test + an `isStopword()` helper applied in BOTH the unigram filter and `significantBigrams`. The file stays PURE (zero imports, no I/O) — the buildFtsQuery Latin-gating pattern was inlined, not imported. RED proved Hebrew/Arabic/Cyrillic overlap scores 0 pre-patch (4 cases + a two-word-Hebrew bigram case); GREEN flips them; an explicit pure-ASCII byte-identity case + the 8 prior tests are unchanged (I1). `grep -c "a-z0-9"` is now 0.

### Task 2 — the explain path (RED bb7a2dcd -> GREEN b2b0a935)
- `events-messaging.ts`: two content-free EventMap declarations (closed `ScriptClass` enum + closed `lane` union + ids only; I8 — never query text / summary bodies), importing `ScriptClass` as a type from `../text/script-classes.js`.
- `event-bus-bridge.ts`: two mapping entries -> `context.script_zero_hit` / `context.summary_language_mismatch` (mapping entries, NOT `EVENTS_NOT_TRAJECTORY_MAPPED` allowlist entries).
- `translate-payload.ts`: two translator cases stripping the `agentId`/`sessionKey` envelope, forwarding `conversationId` + the closed enums only (the `context:budget_computed` precedent).
- `types.ts`: two `context.*` `TrajectoryEventType` members.
- Tests: bridge end-to-end cases + a new `translate-payload.test.ts` pinning the exact translator output shape; the bridge entry-count guard moved 61 -> 63; `SAMPLE_PAYLOADS` fixtures added so the envelope-only correlation invariant covers the two new events. `pnpm test:architecture` 421/421 green (the trajectory-event-types-known gate passes via the mapping entries).

### Task 3 — the fleet path (RED b3c2b628 -> GREEN b0c504f5; extraction 4c29cd6c)
- `obs-persistence-wiring.ts`: `scriptZeroHitEventToRow` + `summaryLanguageMismatchEventToRow` (warning `health_signal` rows, closed enums + ids/depth only, no body, no benign allow-set) + their two `eventBus.on` subscriptions beside the existing block.
- `fleet-health.ts` / `fleet-findings.ts`: a dedicated `script_zero_hit` finding per `(scriptClass, lane)` group reading exactly `"N non-Latin zero-hit searches (script=X, lane=Y)"` with a `comis doctor --repair` hint, and a dedicated `summary_language_mismatch` rollup whose hint names `contextEngine.compaction.strongerSummarizerModel`. `DEDICATED_SCRIPT_SIGNALS` excludes both labels from the generic `health_signal:<label>` rollup so they are not double-reported (the KNOB-03 interaction). Counts/enums/hints only — the no-double-report test also asserts no `conversationId`/query text leaks into any finding detail.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] fleet-health.ts exceeded the obs-handlers 500-line file-size cap**
- **Found during:** Task 3 verification (`pnpm test:architecture` -> file-size.test.ts failure)
- **Issue:** The plan's acceptance note said "verify it stays <= 800", but the architecture file-size gate for `packages/daemon/src/api/obs-handlers/*` is **500 lines**. fleet-health.ts was 497 at base; the two dedicated findings pushed it to 565, tripping the gate.
- **Fix:** Extracted the findings-derivation unit (`buildFindings` + the `Finding` interface + the defensive details parsers `healthSignalLabel`/`servedBelowConfiguredFromRow`/`scriptZeroHitFromRow` + `DEDICATED_SCRIPT_SIGNALS`) byte-identically into a new `packages/daemon/src/api/obs-handlers/fleet-findings.ts` (194L); the assembler imports `buildFindings` + `Finding` back. fleet-health.ts is now 394L. NOT an allowlist bump — a genuine split (the project rule: allowlists are shrink-only). Removed the now-unused `DiagnosticRow` import from fleet-health.ts.
- **Files modified:** packages/daemon/src/api/obs-handlers/fleet-findings.ts (new), packages/daemon/src/api/obs-handlers/fleet-health.ts
- **Commit:** 4c29cd6c

**2. [Rule 1 - Test completeness] acceptance-criterion literal in a doc-comment**
- **Found during:** Task 1 acceptance check (`grep -c "a-z0-9"` returned 1, not 0)
- **Issue:** My GREEN doc-comment referenced the old `[^a-z0-9]+` class by name, which tripped the criterion that the ASCII-only class be gone from the file.
- **Fix:** Reworded the comment to "the prior ASCII-only character class" (no literal). `grep -c "a-z0-9"` is now 0. Comment-only; tests unaffected.
- **Commit:** folded into 0a8332c9 (GREEN)

**3. [Rule 3 - Blocking] test-naming arch heuristic rejected a colon-form description**
- **Found during:** Task 2 verification (test-naming.test.ts failure)
- **Issue:** `it("context:summary_language_mismatch -> exactly {...}")` failed the use-case-shape heuristic (no recognized verb/BDD/Subject form).
- **Fix:** Reworded both new translate-payload test descriptions to start with the verb "forwards". No allowlist add.
- **Commit:** folded into b2b0a935 (GREEN)

## Authentication gates
None.

## Verification

- `pnpm vitest run packages/agent/src/rag/ packages/observability/src/trajectory/ packages/daemon/src/observability/ packages/daemon/src/api/obs-handlers/fleet-health.test.ts` -> 820/820 green
- `pnpm build` (all 15 packages) -> clean (tsc; proves the `as const satisfies Record<string, TrajectoryEventType>` constraint + the exhaustive translator switch hold)
- `pnpm test:architecture` -> 421/421 green (trajectory-event-types-known via the mapping; file-size; test-naming; no-double-coverage disjointness)
- `pnpm lint:security` -> 0 errors (2099 pre-existing warnings, repo-wide, non-blocking; my changes add zero new errors)
- `pnpm cycles:refs` -> no TS6202 project-reference cycle
- TDD gates: each task's `test(180-03)` RED commit precedes its `feat(180-03)` GREEN commit (verified in git log)

## ROADMAP success criteria closed

- **Criterion 5 (recall de-Anglicization):** Hebrew x Hebrew attribution > 0 (RED proven scores 0 pre-patch via the ASCII-only tokenizer); Latin attribution byte-identical (explicit I1 case).
- **Criterion 4 (partial — the spine):** both new events registered on BOTH independent paths; deterministic fleet fixtures prove the dedicated findings. The live `comis fleet --since 1` / `comis explain` checks ride the operator harness (build-first; per the VALIDATION manual-only table) and the 180-08 emit sites. Signal-purity (no emit on `safeAll`-swallowed FTS5 errors) is enforced at the emit site, which is 180-08's scope — not this plan.

## Notes for downstream (180-08)

The two event contracts are frozen here exactly as the `<interfaces>` block specified. The emit sites in 180-08 build against:
- `context:script_zero_hit { conversationId, agentId, sessionKey, scriptClass: ScriptClass, lane: "word"|"tri"|"scan", timestamp }`
- `context:summary_language_mismatch { agentId, sessionKey, sourceScript: ScriptClass, summaryScript: ScriptClass, depth, timestamp }` (depth -1 = pipeline compaction)

Both are dark until emitted: subscriptions, mappers, translators, and fleet findings are all in place, gate-green, and content-free.

## Self-Check: PASSED

- All 7 commits present (3 RED/GREEN pairs + 1 extraction refactor): verified via `git log c006f557..HEAD`.
- New file `packages/daemon/src/api/obs-handlers/fleet-findings.ts` exists.
- All 7 modified/created production files carry their OBS-01 marker (verified by string scan).
- All verification gates green (tests 820/820, build clean, architecture 421/421, lint:security 0 errors).
