---
phase: 180-search-normalize-trigram-routing-signal
plan: 04
subsystem: database
tags: [sqlite, fts5, trigram, multilingual, lcd, g10, forget, normalization, privacy]

# Dependency graph
requires:
  - phase: 180-01 (normalizeForSearch)
    provides: "the ONE per-script search fold — the I7 index-side symbol the twin inserts call"
  - phase: 180-02 (trigram twin DDL)
    provides: "lcd_messages_fts_tri / lcd_summaries_fts_tri (R4 UNINDEXED scope cols) + the base-table AFTER DELETE mirror triggers"
  - phase: 127 (LCD lossless store)
    provides: "appendTxn FTS-populate block + deleteConversationLcdTxn + the leaf/condensed summary write sites"
provides:
  - "createFtsPopulator(db) — prepares the word-lane + trigram-twin statements ONCE; populateMessageFts (byte-identical relocation) + populateMessageTri / insertSummaryTri (normalized twin inserts, guarded prep → null-handle no-op on a trigram-less host)"
  - "Normalized LCD twin rows at every LCD write site: message append + leaf summary + condensed summary all index normalizeForSearch(content) at the base rowid"
  - "G10 CLOSE: deleteConversationLcdTxn step 7 wipes the THREE self-contained FTS objects (word lane lcd_messages_fts + both LCD twins, two-column scoped) — sessions reset now leaves nothing matchable in ANY FTS object (the v2.17 complete-forget spec)"
affects:
  - 180-05 (LCD routing/query reads these twin rows via routeSearchQuery + the scan floor)
  - 180-08 (doctor twin backfill repopulates these same normalized twin rows)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Normalization lives ONLY in the populator (the I7 single call site) — call sites in lcd-store.ts / lcd-store-writes.ts cannot forget the fold (grep normalizeForSearch in both = 0)"
    - "Guarded prep for the trigram-twin statements: prepare() throws on a trigram-less host (twin tables absent) → null handles → every twin method a clean no-op (no second runtime probe needed; if the statements compiled, the tables exist)"
    - "G10 belt-and-braces forget: explicit scoped DELETE on all three FTS objects PLUS the 180-02 base-table AFTER DELETE triggers firing per-row during the lcd_messages/lcd_summaries deletes (the word lane has NO trigger and NEEDS the explicit wipe)"

key-files:
  created:
    - packages/memory/src/lcd-store-fts-populate.ts
    - packages/memory/src/lcd-store-fts-populate.test.ts
  modified:
    - packages/memory/src/lcd-store.ts
    - packages/memory/src/lcd-store.test.ts
    - packages/memory/src/lcd-store-writes.ts

key-decisions:
  - "Word-lane populate extracted byte-identically FIRST (its own refactor commit) to free headroom under the 800-line walker cap — NO allowlist additions; lcd-store.ts held at exactly 800 walker lines (799 wc -l)"
  - "Twin lane gated INDEPENDENTLY of the word lane (its own guarded prep), NOT on isFtsAvailable — so on a host with FTS5 but a forced-false word-lane probe the twin still indexes; the WR-03 word-lane gate test was tightened to anchor on the word-lane open paren so it no longer mis-counts the twin insert"
  - "G10 wipe is two-column (conversation_id, agent_id) scoped: the FTS tables carry no tenant_id — conversation_id encodes the tenant boundary (lcd-fts.ts:24)"
  - "normalizeForSearch('הספרים') = 'הספרימ' (final mem folds, leading he kept) — verified live against the bundled SQLite 3.53.1 before any test; the discriminating assertion is that the RAW final-mem token does NOT match the normalized store"

patterns-established:
  - "FTS-01 index side: every LCD write site folds search text through the one shared symbol at the populator boundary (the symmetry the query side, 180-05, relies on)"
  - "G10 complete-forget: a self-contained FTS object with UNINDEXED scope columns is only forgotten by an explicit scoped DELETE (or a base-table delete-mirror trigger) — orphaned rows otherwise stay matchable"

requirements-completed: [FTS-01]

# Metrics
duration: ~55min
completed: 2026-06-13
---

# Phase 180 Plan 04: G10 forget close + normalized LCD twin populate Summary

**Closed the G10 forget hole (`sessions reset` now wipes the word lane + both LCD trigram twins, so nothing stays `ctx_search`-matchable post-reset — the v2.17 complete-forget spec) and populated the normalized LCD twins at every write site via an extracted `createFtsPopulator(db)` that folds search text through the single I7 symbol; `lcd-store.ts` held at the 800-line cap by a byte-identical extraction commit, no allowlist additions.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3 (RED → refactor/extraction → GREEN; TDD)
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- **G10 closed, RED-first on today's code.** The Task-1 word-lane case proved the live defect: after `deleteConversationLcd`, a scoped `lcd_messages_fts` MATCH still returned the orphaned self-contained row (`expected length 0, got 1`). Step 7 of `deleteConversationLcdTxn` now wipes all three self-contained FTS objects (word lane + both LCD twins), and the post-reset MATCH returns zero from every object.
- **Normalized twin index side live (the FTS-01 symmetry).** Message appends and BOTH summary write sites (leaf + condensed) now write `normalizeForSearch(content)` into the trigram twins at the base rowid. The discriminating assertion holds: a folded query token (`"ספרימ"`) matches the stored normalized row while the RAW final-mem token (`"ספרים"`) does not — proving the fold ran at write time, not at read.
- **800-line gate honored by genuine extraction.** `lcd-store.ts` was at 799/800. The word-lane populate (its two prepared statements + the `isFtsAvailable`-gated block) was relocated byte-identically into `lcd-store-fts-populate.ts` in its own `refactor` commit (every pre-existing test green, incl. the WR-03 gate test exercising the relocated block), THEN the wipe + twin wiring added — final file at exactly 800 walker lines (799 `wc -l`), no `fileSizeAllowlist` additions.
- **Normalization lives ONLY in the populator.** `grep normalizeForSearch` returns 0 in both `lcd-store.ts` and `lcd-store-writes.ts` and 6 in the populator — the I7 single call site, so a write site cannot forget the fold.
- **Trigram-less hosts unaffected.** The twin statements are prepared in a guarded try/catch (`prepare()` throws when the twin tables are absent) → null handles → every twin method is a clean no-op; appends succeed with the twin lane silently off. A twin-insert failure on a healthy host is swallowed by the narrow catch (the base write is authoritative; fail-safe = de-indexed).

## Task Commits

Each task committed atomically (TDD gate: test → refactor → feat):

1. **Task 1: RED — G10 forget hole + twin-populate expectations** — `ff4116bb` (test)
2. **Task 2: extraction — relocate the FTS-populate block byte-identically (800-line gate)** — `0dda546a` (refactor)
3. **Task 3: GREEN — twin inserts (message + both summaries) + G10 wipe list** — `843eca12` (feat)

_Plan metadata not committed to product history: this project sets `commit_docs: false`; `.planning/` is `.gitignore`d. This SUMMARY is force-committed (`git add -f`) into the worktree branch ONLY so the orchestrator can extract it before force-removing the worktree (#2070); it is not intended for `main`._

## Files Created/Modified

- `packages/memory/src/lcd-store-fts-populate.ts` (created, 199 lines) — `createFtsPopulator(db)`: word-lane `populateMessageFts` (byte-identical relocation) + the normalized twin helpers `populateMessageTri` / `insertSummaryTri` (guarded prep, normalize-internally, narrow-catch populate discipline). Module header names the byte-identical relocation + the I7 single-call-site contract.
- `packages/memory/src/lcd-store-fts-populate.test.ts` (created) — 7 co-located unit tests: normalization-applied (folded MATCH hits / raw token does not) for message + summary twins, R4-columns-from-scope, base-rowid joinability, and the null-handle no-op + no-throw on a trigram-less host.
- `packages/memory/src/lcd-store.ts` (modified) — dropped the two FTS prepared statements + the inline populate block (moved to the populator); `createFtsPopulator(db)` once at factory top; `populateMessageTri` wired into `appendTxn`; `insertSummaryTri` passed into the summary write deps; G10 step-7 wipe (three guarded scoped deletes) in `deleteConversationLcdTxn`; the `:312-314` deliberate-orphan comment rewritten to document the wipe.
- `packages/memory/src/lcd-store.test.ts` (modified) — the Phase-180 RED suite (G10 word lane + twins, message/summary twin populate, R4, trigram-less degrade, base-write authority); the WR-03 word-lane gate test's INSERT spy tightened to anchor on `lcd_messages_fts(` so it no longer also counts the twin insert.
- `packages/memory/src/lcd-store-writes.ts` (modified) — `LcdSummaryWriteDeps` gains `insertSummaryTri`; both summary builders call it immediately after the base summary write (leaf + condensed).

## Decisions Made

- **Twin lane is gated independently of the word lane.** The word lane gates on `isFtsAvailable`; the twin lane on its own guarded prep. This is the correct separation (the two probes can disagree — e.g. FTS5 present but trigram absent) and it is why the WR-03 word-lane gate test had to be tightened (its loose `INSERT INTO lcd_messages_fts` regex also caught the twin insert).
- **Byte-identical extraction precedes new logic.** The relocation is its own `refactor` commit so word-lane behavior is provably unchanged (the WR-03 gate test passes through the new module) before any twin/wipe logic lands — the lcd-store-writes.ts split precedent.
- **G10 wipe order is free + belt-and-braces.** FTS vtables have no FK, so the wipe can sit after step 5. The 180-02 base-table AFTER DELETE triggers also mirror the twin deletes per-row during the `lcd_messages`/`lcd_summaries` deletes — but the word lane has NO trigger, so its explicit scoped DELETE is the only thing that forgets it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Tightened the WR-03 word-lane gate test's INSERT spy regex**
- **Found during:** Task 3 (GREEN verification — one pre-existing test flipped red)
- **Issue:** The WR-03 FTS-populate-guard test wraps the db in a Proxy whose `prepare` spy counts `INSERT INTO lcd_messages_fts` attempts and asserts 0 when `isFtsAvailable` is forced false. Its regex `/INSERT\s+INTO\s+lcd_messages_fts/i` ALSO matched the new twin insert `INSERT INTO lcd_messages_fts_tri(...)`. The twin lane is gated independently (its own guarded prep, not `isFtsAvailable`) and the twins genuinely exist on that test db, so `populateMessageTri` correctly fired → the spy counted 1, failing the word-lane-only assertion.
- **Fix:** Anchored the spy regex on the word-lane column-list open paren — `/INSERT\s+INTO\s+lcd_messages_fts\s*\(/i` — so it matches `lcd_messages_fts(` but NOT `lcd_messages_fts_tri(`. Updated the test's doc-comment to state the word-lane/twin-lane gate independence and where the twin gate is covered (the co-located populator test + the Phase-180 trigram-less / base-write-authority cases). No product change; the word-lane gate assertion is unchanged in intent.
- **Files modified:** packages/memory/src/lcd-store.test.ts
- **Verification:** lcd-store + populator suites 85/85; full memory suite 1208 passed / 11 skipped.
- **Committed in:** `843eca12` (Task 3 commit)

**2. [Rule 3 - Blocking] Fixed the trigram-less-host test's hand-rolled `is_error` DDL (RED-phase test bug)**
- **Found during:** Task 1 (RED run — the trigram-less case failed with `NOT NULL constraint failed: lcd_message_parts.is_error` instead of the intended assertion)
- **Issue:** The test's `ensureLcdTablesWithoutTwins` helper declared `is_error INTEGER NOT NULL DEFAULT 0`, but the real `schema-lcd.ts:103` makes `is_error` a nullable `INTEGER` and the store's `boolToInt(undefined)` binds NULL for a non-tool_result part. The hand-rolled DDL diverged from the real schema, so the append threw on the constraint rather than exercising the degrade path.
- **Fix:** Matched the real schema — `is_error INTEGER` (nullable) + `metadata TEXT NOT NULL DEFAULT '{}'`. After the fix the trigram-less case passes on today's code (the expected degrade — append succeeds, no twin table), which is correct: it is a guard that stays green through GREEN, not a RED case.
- **Files modified:** packages/memory/src/lcd-store.test.ts
- **Verification:** RED run then showed exactly the 5 intended failures (G10 word lane + the four twin-populate cases) and 2 green guards.
- **Committed in:** `ff4116bb` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 bug — test-precision regex; 1 blocking — RED-phase test DDL fidelity)
**Impact on plan:** Both are test-fidelity fixes on this plan's own test surface — no product-behavior change, no scope creep. The plan's algorithm, interfaces, and the G10/twin/wipe contract shipped exactly as specified.

## Issues Encountered

- **File-size walker counts `split(/\r?\n/).length`, not `wc -l`.** A file with 800 `\n`-terminated lines is 800 by `wc -l` but 801 by the walker (the trailing newline yields an empty final array element). The G10 wipe + comments pushed `lcd-store.ts` to 801 walker lines; trimmed verbose comments to 800 walker lines (799 `wc -l`) — at the cap, passing, no allowlist add. Verified the count via the walker's own `split` semantics, not `wc -l`.

## Known Stubs

None. The index side (twin populate) and the G10 wipe are complete and wired at every LCD write/reset site. The LCD query side that READS these twin rows (script routing + scan floor) is plan 180-05; the doctor twin backfill is plan 180-08 — both documented as downstream consumers in the `affects` graph, not stubs in this plan's surface.

## Verification Summary

- `lcd-store.test.ts` + `lcd-store-fts-populate.test.ts`: 85/85 green (the 5 Task-1 RED cases flipped; 6 new populator unit tests pass).
- Full `@comis/memory` suite: 1208 passed / 11 pre-existing skips (was 1195 at the 180-02 baseline).
- `pnpm build` (all 15 packages): 0 errors. `pnpm test:architecture`: 421/421 (file-size gate green, NO `fileSizeAllowlist` additions). `lint:security` on touched src: 0 errors. `cycles:refs`: clean (no TS6202).
- ACs: `DELETE FROM lcd_messages_fts ` = 1, `fts_tri WHERE conversation_id` = 2, `normalizeForSearch` in populator = 6 / in lcd-store.ts + lcd-store-writes.ts = 0, deliberate-orphan claim removed, `wc -l lcd-store.ts` = 799 (800 walker).
- TDD gate order: `test(180-04)` `ff4116bb` → `refactor(180-04)` `0dda546a` → `feat(180-04)` `843eca12`.

## Self-Check: PASSED

- Created files exist: `lcd-store-fts-populate.ts`, `lcd-store-fts-populate.test.ts` — FOUND.
- Modified files exist: `lcd-store.ts`, `lcd-store.test.ts`, `lcd-store-writes.ts` — FOUND.
- Commits exist: `ff4116bb` (RED), `0dda546a` (refactor), `843eca12` (feat) — all FOUND in the worktree branch.

## Next Phase Readiness

- The normalized twin rows are live at every LCD write site and the G10 wipe forgets all three FTS objects on reset. Plan 180-05 (LCD routing) can `routeSearchQuery` against `lcd_messages_fts_tri` / `lcd_summaries_fts_tri` knowing the stored content is folded by the same `normalizeForSearch` symbol it imports (the I7 symmetry is now closed on the index side).
- Plan 180-08 (doctor backfill) must feed the SAME `normalizeForSearch(renderMessageFtsText(parts))` / `normalizeForSearch(content)` into the twins so a rebuild matches the populate path exactly.
- No blockers. STATE.md / ROADMAP.md left untouched (the orchestrator owns those writes after the wave completes).

---
*Phase: 180-search-normalize-trigram-routing-signal*
*Completed: 2026-06-13*
