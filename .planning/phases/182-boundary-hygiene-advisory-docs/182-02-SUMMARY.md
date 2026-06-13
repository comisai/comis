---
phase: 182-boundary-hygiene-advisory-docs
plan: 02
subsystem: observability
tags: [embedding, reranker, multilingual, fleet-health, model-health, zod, advisory, EMB-01]

# Dependency graph
requires:
  - phase: 180-search-obs
    provides: "OBS-01 fleet surfaces (buildFindings dedicated-finding pattern; recordModelHealth -> fleet) + the FTS trigram floor that carries recall"
  - phase: 182-01-safe-01
    provides: "the @comis/core text barrel (exports/text.ts) already exporting adjustSliceBoundary — EMB-01 appends its exports after it"
provides:
  - "Optional embedding.multilingual config boolean on EmbeddingConfigSchema (z.strictObject)"
  - "Pure resolveMultilingual(declared, modelId, re) heuristic + EMBED_MULTILINGUAL / RERANK_MULTILINGUAL regexes in @comis/core/text"
  - "ModelHealthSignals + the model_health boot diagnostic gain embeddingMultilingual + rerankerMultilingual (content-free, I8)"
  - "resolveModelHealthMultilingual provider-aware boot helper (wiring/main-helpers.ts)"
  - "Two dedicated standing-state fleet advisories: model_health:embedder_not_multilingual / :reranker_not_multilingual (read the LATEST model_health row)"
affects: [182-03-doc-01, multilingual, fleet-health, config-yaml]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure advisory name heuristic in @comis/core/text (sibling to normalize-search / slice-boundary)"
    - "Latest-row standing-state fleet finding (mirror config_posture:served_below_configured, NOT a reboot count)"
    - "Boolean/\"unknown\"-only content-free boot diagnostic (I8)"
    - "Provider-aware model-id resolution extracted to a unit-testable wiring helper to stay under the daemon.ts line cap"

key-files:
  created:
    - packages/core/src/text/multilingual-heuristic.ts
    - packages/core/src/text/multilingual-heuristic.test.ts
    - packages/core/src/config/schema-embedding.test.ts
    - packages/daemon/src/api/obs-handlers/fleet-findings.test.ts
    - packages/daemon/src/wiring/main-helpers.test.ts
  modified:
    - packages/core/src/config/schema-embedding.ts
    - packages/core/src/exports/text.ts
    - packages/daemon/src/observability/record-model-health.ts
    - packages/daemon/src/observability/record-model-health.test.ts
    - packages/daemon/src/daemon.ts
    - packages/daemon/src/api/obs-handlers/fleet-findings.ts
    - packages/daemon/src/wiring/main-helpers.ts
    - packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap

key-decisions:
  - "RERANK_MULTILINGUAL is reranker-specific (/multilingual|bge-reranker-v2-m3|reranker.*m3|bge-m3/i) so the shipped default bge-reranker-v2-m3 classifies true — the design's literal embedder regex false-negatives it (Pitfall 2)"
  - "No-hit + no declaration -> \"unknown\" (honest), reserving false for an explicit embedding.multilingual:false (A2 / Open Question 3)"
  - "Embedder id resolved PROVIDER-AWARE (embedding.openai.model / embedding.local.modelUri), never the legacy memory.embeddingModel (Pitfall 3)"
  - "The fleet advisory reads the LATEST model_health row (max-timestamp scan), so N reboots show count 1 not N (Pitfall 4)"
  - "Advisory ONLY — no recall/search code path gates on the flags (I4); the diff touches no recall/search file"
  - "Extracted resolveModelHealthMultilingual into wiring/main-helpers.ts to keep daemon.ts under the 3000-line architecture cap (the cap test's own prescribed remediation)"

patterns-established:
  - "Pure advisory heuristic: declared boolean wins -> regex hit -> true -> else \"unknown\""
  - "Latest-row standing-state finding beside the generic category rollup (KNOB-03 precedent)"

requirements-completed: [EMB-01]

# Metrics
duration: 64min
completed: 2026-06-13
---

# Phase 182 Plan 02: EMB-01 Embedding-Multilingual Advisory Summary

**`comis fleet` now names an English-leaning embedder/reranker stack (`embeddingMultilingual` + `rerankerMultilingual` beside `embeddingAvailable`) via a pure name heuristic that correctly classifies the shipped default `bge-reranker-v2-m3` as multilingual — advisory only, with no recall behavior gated (I4).**

## Performance

- **Duration:** ~64 min
- **Started:** 2026-06-13T08:54:45Z (first RED commit)
- **Completed:** 2026-06-13T09:08:14Z
- **Tasks:** 3 (plus 1 snapshot regen + 1 line-cap refactor deviation)
- **Files modified:** 13 (5 created, 8 modified)

## Accomplishments
- Optional `embedding.multilingual` boolean on `EmbeddingConfigSchema` (z.strictObject; no default — undeclared falls to the heuristic).
- Pure `resolveMultilingual` heuristic + `EMBED_MULTILINGUAL` / `RERANK_MULTILINGUAL` regexes in `@comis/core/text`, with the Pitfall-2 reranker fix (the shipped default `bge-reranker-v2-m3` classifies multilingual=true).
- `recordModelHealth` boot diagnostic gains `embeddingMultilingual` + `rerankerMultilingual` (each `true|false|"unknown"`, content-free per I8); severity stays driven by `embeddingAvailable` only.
- Daemon resolves both model ids PROVIDER-AWARE (via the extracted `resolveModelHealthMultilingual` helper) — never the legacy `memory.embeddingModel`.
- Two dedicated standing-state fleet advisories read the LATEST `model_health` row (count 1, not a reboot count); `buildFindings` is pure rows→findings, so no recall path is touched (I4).

## Task Commits

Each task was committed atomically (TDD test → feat):

1. **Task 1: config key + pure heuristic (core)** — `7063c81d` (test) → `f6420685` (feat)
2. **Task 2: thread the 2 booleans into the boot record + daemon** — `a444db78` (test) → `516b5b59` (feat)
3. **Task 3: dedicated standing-state fleet advisory** — `0f192953` (test) → `2b10798d` (feat)
4. **Snapshot regen (deviation):** `f1f766a3` (test — section-registry parity for the new key)
5. **Line-cap refactor (deviation):** `ce2960b2` (refactor — extract `resolveModelHealthMultilingual`)

_Plan metadata (SUMMARY) committed separately._

## Files Created/Modified
- `packages/core/src/text/multilingual-heuristic.ts` — pure `resolveMultilingual` + the two regexes (Pitfall-2 reranker fix).
- `packages/core/src/text/multilingual-heuristic.test.ts` — truth table (declared wins; bge-reranker-v2-m3 → true; nomic → "unknown").
- `packages/core/src/config/schema-embedding.ts` — optional `multilingual: z.boolean().optional()`.
- `packages/core/src/config/schema-embedding.test.ts` — parses true/false/omitted; strictObject rejects a typo'd key.
- `packages/core/src/exports/text.ts` — appended the heuristic barrel exports after `adjustSliceBoundary`.
- `packages/daemon/src/observability/record-model-health.ts` — two new `ModelHealthSignals` fields + two `details` JSON keys (I8).
- `packages/daemon/src/observability/record-model-health.test.ts` — 5-key `details`, "unknown" round-trip, I8 keys-only, severity-unchanged.
- `packages/daemon/src/daemon.ts` — boot call site now spreads `resolveModelHealthMultilingual(container.config)` (kept under the 3000-line cap).
- `packages/daemon/src/wiring/main-helpers.ts` — new `resolveModelHealthMultilingual` provider-aware boot helper.
- `packages/daemon/src/wiring/main-helpers.test.ts` — default install (nomic → unknown, bge-reranker-v2-m3 → true), provider-aware local/openai id selection, explicit override.
- `packages/daemon/src/api/obs-handlers/fleet-findings.ts` — `multilingualFromRow` defensive parser + the two latest-row advisories.
- `packages/daemon/src/api/obs-handlers/fleet-findings.test.ts` — latest-row advisory; 5-reboots → count 1 (Pitfall 4); no-false-fire; defensive parse; digest-only.
- `packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap` — regenerated for the new config-surface field.

## Decisions Made
- **Reranker-specific regex (Pitfall 2):** `RERANK_MULTILINGUAL` matches `bge-reranker-v2-m3` (and `bge-reranker…m3`); the design's literal `/…|bge-m3|…/` would false-negative the shipped multilingual reranker default. The RED test pins `bge-reranker-v2-m3 → true`.
- **false-vs-unknown (A2/Open Q3):** no declaration + no name hit → `"unknown"` (honest); `false` is reserved for an explicit `multilingual: false`. Matches the design success criterion `false|unknown`.
- **Provider-aware id (Pitfall 3):** OpenAI → `embedding.openai.model`; local/auto → `embedding.local.modelUri`. The legacy `memory.embeddingModel` is NOT fed to the heuristic (referenced only in a Pitfall-3 doc comment).
- **Latest-row standing state (Pitfall 4):** the fleet advisory scans `model_health` for max timestamp and emits one finding per lane (count 1), mirroring `config_posture:served_below_configured` — NOT the generic count-based `model_health` finding.
- **A3 (no contract churn):** EMB-01 adds a finding to the existing `buildFindings` path; `fleet-health.ts` and `ObsFleetHealthContract` are untouched, and the admin gate is unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] daemon.ts exceeded the 3000-line architecture cap after the EMB-01 boot wiring**
- **Found during:** Task 2 (daemon wiring) — surfaced by the full `@comis/daemon` suite (`architecture.test.ts > daemon.ts total line count enforced (hard cap ≤ 3000)`).
- **Issue:** Inlining the provider-aware id resolution + heuristic call at `daemon.ts:1581` pushed the file from 2994 to 3010 lines, tripping the hard-cap architecture invariant.
- **Fix:** Extracted the logic into a pure, unit-testable `resolveModelHealthMultilingual(config)` helper in `wiring/main-helpers.ts` (the cap test's own prescribed remediation — "Split a helper into wiring/main-helpers.ts to fit"). daemon.ts dropped to 2999; the boot call site now spreads the helper's result. Added `main-helpers.test.ts` covering the default-install Pitfall-2 case, provider-aware local/openai id selection, and the explicit override.
- **Files modified:** packages/daemon/src/daemon.ts, packages/daemon/src/wiring/main-helpers.ts, packages/daemon/src/wiring/main-helpers.test.ts
- **Verification:** `architecture.test.ts` passes (daemon.ts = 2999 ≤ 3000); the new helper test (6 cases) is green; full daemon suite green.
- **Committed in:** `ce2960b2`
- **Note on Task-2 acceptance grep:** the AC `grep -q "resolveMultilingual" packages/daemon/src/daemon.ts` now matches in `wiring/main-helpers.ts` instead (the heuristic moved there); the AC's INTENT — provider-aware heuristic wired at boot, legacy field avoided — is fully satisfied by the extracted helper that daemon.ts calls.

**2. [Rule 3 - Blocking] section-registry parity snapshots failed on the new config key**
- **Found during:** Task 1 (config key) — surfaced by the full `@comis/core` suite (`section-registry-parity.test.ts`, 3 snapshots).
- **Issue:** The config-metadata derived views (`getConfigSchema` / `getFieldMetadata`) lock byte-identical output; the new `embedding.multilingual` field is correctly added, so the snapshots drifted.
- **Fix:** Regenerated the 3 snapshots (`vitest -u`). The diff is exactly the single new boolean field — no other drift. This is desirable: the configure wizard + RPC config surface SHOULD now render `embedding.multilingual`.
- **Files modified:** packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap
- **Verification:** `section-registry-parity.test.ts` green (48 tests); diff confirmed single-field.
- **Committed in:** `f1f766a3`

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking issues directly caused by this plan's changes).
**Impact on plan:** Both were mechanical gate-satisfaction (line cap + derived-view snapshot). The line-cap fix is a strict improvement — the resolution logic is now a unit-testable helper. No scope creep; no behavior change to the advisory.

## Issues Encountered
- `.planning/` is gitignored in this repo (`.gitignore:35`) per the project's GSD convention, so the SUMMARY/test docs live in the main checkout's `.planning` (where the orchestrator reads them) rather than as tracked files. A force-added copy is committed in the worktree to satisfy the SUMMARY-committed requirement (#2070).
- `fleet-findings.test.ts` did not pre-exist (the plan called it "existing"); created it new under the sibling `<module>.test.ts` convention.

## Self-Check: PASSED

- All 5 created files verified present on disk (multilingual-heuristic.ts/.test.ts, schema-embedding.test.ts, fleet-findings.test.ts, main-helpers.test.ts).
- All 8 commit hashes verified in git log (7063c81d, f6420685, a444db78, 516b5b59, 0f192953, 2b10798d, f1f766a3, ce2960b2).
- Full `@comis/core` (4975), `@comis/daemon` (3797), and `test:architecture` (421) suites GREEN; `build:clean` GREEN; `lint:security` 0 errors (baseline 2098 warnings, unchanged).
- STATE.md / ROADMAP.md NOT modified; no recall/search file touched (I4).

## Next Phase Readiness
- **182-03 (DOC-01)** can now document `embedding.multilingual` in `config-yaml.mdx` (the embedding accordion) and the three fleet checks (`summary_language_mismatch`, `script_zero_hit`, and the new `model_health:embedder_not_multilingual` / `:reranker_not_multilingual`) in the new `docs/operations/multilingual.mdx`.
- **Operator live check (deferred to milestone close):** start a daemon on the default English-leaning GGUF and confirm `comis fleet` surfaces `embedder_not_multilingual` (embedder id-inferred unknown) while the reranker line stays clean (the default `bge-reranker-v2-m3` is multilingual).
- No blockers. STATE.md / ROADMAP.md intentionally NOT modified (orchestrator owns those after the wave).

---
*Phase: 182-boundary-hygiene-advisory-docs*
*Completed: 2026-06-13*
