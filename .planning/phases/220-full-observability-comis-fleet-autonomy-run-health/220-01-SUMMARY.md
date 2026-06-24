---
phase: 220-full-observability-comis-fleet-autonomy-run-health
plan: 01
subsystem: observability
tags: [fleet-health, durable-runs, autonomy, event-bus, health_signal, content-free, sqlite, durable-run-port]

# Dependency graph
requires:
  - phase: 216-durability-resume-engine
    provides: durable-resume-engine (orphan/resume emits), DurableRunPort + createSqliteDurableRunStore (durable_runs table)
  - phase: 213-bounded-autonomy
    provides: lease.revoke / run.kill autonomy handlers (the INFO-only revoke/kill sites), rpc-dispatch deny-by-origin chokepoint
provides:
  - "Typed durable:orphaned / durable:resumed / autonomy:revoked / autonomy:killed events on OrchestrationEvents (in EventMap) — closed-enum/count/id payloads"
  - "orphanReasonToEnum: a TOTAL string→closed-enum map so the engine free-text orphan reason never crosses onto the event/row (T-220-01 at source)"
  - "PRODUCTION-wired autonomy:revoked/killed emit (rpc-dispatch.ts threads deps.container.eventBus + systemNowMs into createAutonomyHandlers — the live daemon emits, not just the harness)"
  - "Four content-free health_signal obs-row builders (obs-autonomy-rows.ts) + their diagnosticBuffer subscriptions"
  - "DurableRunPort.countByStatus(sinceMs): crash-surviving windowed {orphaned,revoked,running,completed} counts read directly from durable_runs"
affects: [220-02, 220-03, fleet-health, comis-fleet, obs.fleet.health]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Closed-enum-at-the-boundary: a free-text engine reason is mapped to a closed union (TOTAL, default arm) BEFORE the typed-event emit; the free string stays only on the WARN log / notify"
    - "Sibling row-builder module for the 800-line cap (obs-autonomy-rows.ts mirrors obs-orchestration-rows.ts; re-exported from the wiring file so the public API stays byte-identical)"
    - "Windowed-aggregate direct read (countByStatus mirrors getRollingSpendUsd's WHERE … >= ? GROUP BY, via a createRowMapper — no raw SQLite cast)"
    - "Optional-dep gating of an emit: eventBus?/now? on AutonomyHandlerDeps — absent ⇒ no emit, byte-identical pre-220 boot"

key-files:
  created:
    - packages/daemon/src/observability/obs-autonomy-rows.ts
  modified:
    - packages/core/src/event-bus/events-orchestration.ts
    - packages/core/src/ports/durable-run.ts
    - packages/daemon/src/autonomy/durable-resume-engine.ts
    - packages/daemon/src/api/autonomy-handlers.ts
    - packages/daemon/src/api/rpc-dispatch.ts
    - packages/daemon/src/observability/obs-persistence-wiring.ts
    - packages/memory/src/durable-run-store.ts

key-decisions:
  - "Handler timestamp via an optional now?: () => number deps seam supplied by systemNowMs at the wiring layer (rpc-dispatch.ts) — the globals-gate-safe wiring clock, never Date.now()/new Date()"
  - "Engine timestamp via the engine's already-injected nowMs() clock (no new ClockPort seam needed)"
  - "Proved the PRODUCTION wiring with a real-dep-path test (createRpcDispatch → emit lands on container.eventBus) AND the grep gate — not just the harness spy (the BLOCKER-FIX)"
  - "Kept the four row-builders as explicit functions (not a shared helper) — matches the obs-orchestration-rows precedent and keeps each row's content-free intent legible (KISS/YAGNI)"

patterns-established:
  - "FLEET-03 ingestion hop: untyped emit → typed closed-enum event (EventMap) → content-free health_signal row → (Plan 03) fleet finding"
  - "distinct events separate indistinguishable table states: autonomy:killed vs autonomy:revoked (both flip durable status to 'revoked'), so the EVENT is the only count separator"

requirements-completed: [FLEET-03]

# Metrics
duration: 14min
completed: 2026-06-24
---

# Phase 220 Plan 01: FLEET-03 autonomy-run ingestion hop Summary

**Typed the durable/autonomy lifecycle events (closed enums + counts + ids only), enum-mapped the engine's free-text orphan reason at the source, wired the autonomy:revoked/killed emit into the PRODUCTION rpc-dispatch construction site, mapped all four events to content-free `health_signal` obs rows, and added a crash-surviving `DurableRunPort.countByStatus(sinceMs)` direct read — the only genuinely-new mechanism in Phase 220, upstream of Plan 03's fleet assembler.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-06-24T09:15:22Z
- **Completed:** 2026-06-24T09:30:01Z
- **Tasks:** 3 (each RED→GREEN)
- **Files modified:** 12 (8 production + 4 test; 1 new production file)

## Accomplishments
- **Typed events (FLEET-03):** added `durable:orphaned` / `durable:resumed` / `autonomy:revoked` / `autonomy:killed` to `OrchestrationEvents` (folded into `EventMap`), each content-free — closed-enum reason / integer count / numeric stepIndex + rootRunId + numeric timestamp ONLY (§2.7), mirroring `pipeline:authored`.
- **Content-free at the source (T-220-01):** `orphanReasonToEnum` is a TOTAL `string`→closed-union map (default arm `resume_failed`); the engine's free-text orphan reason is mapped to the enum BEFORE the emit and stays only on the WARN log / notify — it can never echo onto the event or obs row.
- **PRODUCTION wiring (the BLOCKER-FIX):** `rpc-dispatch.ts:264` `createAutonomyHandlers({...})` now threads `eventBus: deps.container.eventBus` (the same typed bus as the `execution:aborted` emit) + `now: systemNowMs`, so the LIVE daemon emits `autonomy:revoked/killed` — proven by a real-dep-path test (`createRpcDispatch` → emit on `container.eventBus`) AND the grep gate, not just the harness spy.
- **Obs rows + subscriptions:** new sibling `obs-autonomy-rows.ts` (four builders) re-exported from `obs-persistence-wiring.ts` + four `eventBus.on(...)` subscriptions onto the SAME `diagnosticBuffer` (no new table/buffer/transaction). The wiring file stays 789 lines (≤800 cap).
- **Crash-surviving count:** `DurableRunPort.countByStatus(sinceMs)` returns windowed `{orphaned,revoked,running,completed}` read directly from `durable_runs` (`WHERE updated_at_ms >= ? GROUP BY status` via a `createRowMapper` — no raw cast), the `getRollingSpendUsd` precedent.

## Task Commits

Each task was committed atomically RED→GREEN (the RED commit precedes the GREEN commit per task — TDD gate + CLAUDE.md Tests-First):

1. **Task 1: Type the durable/autonomy events + enum-map the orphan reason**
   - RED  `01805a36` (test) — durable:* events carry closed-enum reason + timestamp; orphanReasonToEnum is TOTAL
   - GREEN `25a6d998` (feat) — add the 4 typed events; add orphanReasonToEnum; emit enum + nowMs() timestamp
2. **Task 2: Emit autonomy:revoked/killed (wired in prod) + countByStatus**
   - RED  `f58ae9da` (test) — handler emits + PRODUCTION wiring (container bus) + windowed countByStatus
   - GREEN `36ae371a` (feat) — eventBus?/now? deps + emit; thread the bus into rpc-dispatch; countByStatus on the store
3. **Task 3: Map the four events to content-free health_signal rows + subscribe**
   - RED  `f57d0221` (test) — four builders + the I1 subscription-wiring assertion (13 rows)
   - GREEN `d7ea91b2` (feat) — obs-autonomy-rows.ts + re-export + four subscriptions

_Note: STATE.md / ROADMAP.md were intentionally NOT modified (worktree-parallel executor; the orchestrator owns those writes after the wave merge)._

## Files Created/Modified
- `packages/daemon/src/observability/obs-autonomy-rows.ts` (NEW) — four content-free `health_signal` row-builders (durableOrphaned/durableResumed/autonomyRevoked/autonomyKilled).
- `packages/core/src/event-bus/events-orchestration.ts` — 4 typed events added to `OrchestrationEvents`.
- `packages/core/src/ports/durable-run.ts` — `countByStatus(sinceMs)` on `DurableRunPort`.
- `packages/memory/src/durable-run-store.ts` — `countByStatus` impl (prepared GROUP-BY stmt + a module-local status-count row-mapper).
- `packages/daemon/src/autonomy/durable-resume-engine.ts` — `orphanReasonToEnum` helper; orphan/resumed emits carry the enum + `nowMs()` timestamp.
- `packages/daemon/src/api/autonomy-handlers.ts` — `eventBus?`/`now?` deps; `autonomy:revoked` (rootRunId revoke) + `autonomy:killed` (run.kill) emits.
- `packages/daemon/src/api/rpc-dispatch.ts` — thread `eventBus: deps.container.eventBus` + `now: systemNowMs` into the `createAutonomyHandlers` call (PRODUCTION wiring).
- `packages/daemon/src/observability/obs-persistence-wiring.ts` — import + re-export the four builders; four `eventBus.on(...)` subscriptions onto the diagnosticBuffer.
- 4 test files extended (durable-resume-engine, autonomy-handlers, durable-run-store, obs-persistence-wiring).

## Decisions Made
- **Handler clock seam:** added an optional `now?: () => number` to `AutonomyHandlerDeps` and supplied `systemNowMs` from the wiring layer (rpc-dispatch.ts) — the same globals-gate-safe clock the `execution:aborted` emit uses. No new `ClockPort`, no bare `Date.now()`/`new Date()` (globals.test.ts green).
- **Engine clock:** reused the engine's already-injected `nowMs()` — the engine is deliberately I/O-free and already had the seam; no new dependency.
- **Production-wiring proof:** the existing deny-by-origin test in `autonomy-handlers.test.ts` already constructs the REAL dispatch via `createRpcDispatch(mockDeps)` with `container.eventBus = { emit: vi.fn(), on: vi.fn() }`; extended it to assert the operator-origin `lease.revoke`/`run.kill` emit `autonomy:revoked`/`autonomy:killed` on the CONTAINER bus — the real-dep-path test (option a), the strongest guard against the green-test-over-dead-prod-path failure.
- **No shared row-builder helper:** kept the four builders explicit (the `obs-orchestration-rows.ts` precedent) — a shared helper would obscure per-event severity (resumed=info, the rest=warning) and the content-free key-set for marginal gain.

## Deviations from Plan

None — plan executed exactly as written. The plan's verified interfaces, file:line anchors, and the BLOCKER-FIX guidance (thread `deps.container.eventBus` at rpc-dispatch.ts:264) all matched HEAD; every change landed where the plan specified.

The plan named the handler-clock seam as a choice ("thread the daemon clock onto AutonomyHandlerDeps … or supply systemNowMs as that seam") — chose the `now?` deps seam supplied with `systemNowMs`, exactly as the plan's note permitted. Not a deviation.

## Issues Encountered
- **Worktree had no `node_modules` / `dist`:** a fresh Claude Code worktree ships no installed deps, and the daemon/memory unit tests import sibling `@comis/*` packages from `dist/`. Resolved by running `pnpm install` (8.3s) + `pnpm build` once at the start; thereafter incremental `pnpm build` propagated each core/memory edit to the daemon dist before each GREEN run. Standard for this monorepo (CLAUDE.md: stale/absent `dist/` masks `src/` changes).

## Verification

Plan `<verification>` — ALL GREEN before this SUMMARY:
- `durable-resume-engine.test.ts` ✓ (21 tests) · `autonomy-handlers.test.ts` ✓ (25) · `durable-run-store.test.ts` ✓ (29) · `obs-persistence-wiring.test.ts` ✓ (81) — **156 tests, all 4 files green together.**
- Production-wiring grep gate ✓ — `eventBus: deps.container.eventBus` threaded into the `createAutonomyHandlers({...})` call (rpc-dispatch.ts:272).
- Content-free grep gate ✓ — ZERO free-text reason substrings in `obs-autonomy-rows.ts`.
- Determinism grep gate ✓ — ZERO real `Date.now()`/`new Date()` calls in the changed regions (only JSDoc prose); `globals.test.ts` green.
- `pnpm build` ✓ — clean across all 16 packages (the typed EventMap members + the new port method compile).
- **Bonus (per-phase gate, [[feedback_full_workspace_gates_per_phase]]):** the FULL architecture project ran green — 99 files / 560 tests (incl. file-size, trajectory-event-types-known, coverage-gate, fleet-health-ga-readiness, audit-metadata-content-free) — no silently-accumulating policy gate tripped.

## Known Stubs
None — every event, row, port method, and the production wiring is fully implemented and wired to a real data source. No hardcoded empties, no placeholders, no TODO/FIXME.

## Threat Flags
None — the changes introduce NO security surface beyond the plan's `<threat_model>` (T-220-01..05). All four events/rows carry counts + closed enums + ids only; the free-text orphan reason is mapped to a closed enum at the source (T-220-01) and never crosses the boundary; the revoke/kill payloads carry no bearer/selector/body (T-220-02); timestamps come from injected/wiring clocks (T-220-03); the events are emitted in-process by trusted daemon paths (T-220-05).

## Next Phase Readiness
- **Plan 03 (the fleet assembler) is unblocked:** it can now read both the four `health_signal` rows (`signal: durable_orphaned | durable_resumed | autonomy_revoked | autonomy_killed`) AND `DurableRunPort.countByStatus(sinceMs)` — both produced and PRODUCTION-wired here, so the counts are non-zero in prod.
- **Plan 02 (parallel wave-1 executor)** is independent of this plan's files; no shared-file conflict expected at merge.
- No blockers. The wave-merge gate (`pnpm validate` + post-merge full validation) is the orchestrator's central step.

## Self-Check: PASSED
- All 9 created/modified files exist on disk (8 production + the SUMMARY).
- All 6 task commits exist in git history: `01805a36` `25a6d998` `f58ae9da` `36ae371a` `f57d0221` `d7ea91b2`.

---
*Phase: 220-full-observability-comis-fleet-autonomy-run-health*
*Completed: 2026-06-24*
