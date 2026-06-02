# Phase 112 FORGET — Principled Forgetting (the per-type FadeMem decay + the scaffold-dormant lifecycle; Track C) · VERDICT: MEASURED (4 keyless claims) + live eviction DORMANT/deferred

One-screen summary of the keyless gate for the Phase-112 forgetting mechanism (FORGET-01 the per-type FadeMem decay factor folded as a gated default-OFF scoring multiplicand · FORGET-02 the scaffold-dormant lifecycle sweep + the wired daemon cron that evicts/demotes nothing). Full detail: `GATE-REPORT.md`. Machine-readable provenance: `run-provenance.json`.

## What was measured (keyless, $0 — no answer model, no judge, no key)

Four claims over the REAL production code path (a fresh `mkdtempSync` `SqliteMemoryAdapter`, the `createSqliteMemoryLifecycleStore` lifecycle adapter over the same `getDb()` handle, the LIVE LLM-free `createMemoryRecall`, and a deterministic `createFakeClock`). All PASS:

1. **Byte-identity at neutral importance** (the safety gate) — a neutral/legacy memory at event-age 0 scores + ranks identically forget OFF / ON-at-neutral (with a live `forgetAlpha=1.0`) / absent (`scoreForgetOff=1`, `scoreForgetOnNeutral=1`, `scoreForgetAbsent=1`; all ranks 1; `byteIdentical=true`). At Δt=0 the FadeMem factor is exactly `1.0`, so a fresh neutral row is never reordered even with the decay enabled. (`claim1`)
2. **The deterministic decay effect** (MEASURED) — an old (90-day) low-importance ephemeral memory's forget factor decays below a fresh (1-day) durable memory's: `oldEphemeralForgetFactor=0.553` < `freshDurableForgetFactor=0.995` (`forgetFactorGap=0.441`, `decayedBelow=true`), recovered as the per-memory on/off boosted-score ratio. The intended FadeMem demotion, MEASURED — not a QA-accuracy claim. The decay RANKS, never GATES. (`claim2`)
3. **Footprint unchanged when the eviction scaffold is off/dormant** — the wired DORMANT `runLifecycleSweep` over 5 real rows (incl. a stale eviction candidate) evicts/demotes 0: `rowCountBefore=5`, `rowCountAfter=5`, both marker counts 0, report `{scanned:5, promoted:0, demoted:0, evicted:0}`, `footprintUnchanged=true`. (`claim3`)
4. **Zero category regression** — the recall hot path with forget OFF is byte-identical to a no-forget baseline run on the same mixed-age, mixed-type fixtures (`noRegression=true`, Phase-106 baseline ref). (`claim4`)

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The FadeMem factor's byte-identity at neutral + the deterministic decay effect, the DORMANT sweep's evict-nothing-on-and-off-policy + isolation, and the cron's register-only-when-enabled + the keyless dormant sentinel are additionally RED-proven in the unit suites (`score.test.ts`, `sqlite-memory-lifecycle-store.test.ts`, `setup-schedulers.test.ts`, `setup-channels-memory-crons.test.ts`).

## What is DEFERRED

- **The costed QA-accuracy impact of the decay** (a question-answering accuracy delta of the decay-on vs decay-off ranker over real answers) — **NOT measured here** (needs a real answer model + a cross-judge fold + a costed run). FadeMem's decay is never ablated in isolation, so a fresh accuracy number here would be fabricated. Kept STRICTLY SEPARATE from the keyless decay measurement. See `GATE-REPORT.md` §4.
- **The LIVE eviction/demotion enablement** of the lifecycle scaffold — DORMANT by design (Phase-106 gap-report OD4); the live policy (mark candidates NON-DESTRUCTIVELY + thread the operator policy) is the deferred operator/v2.10 step. The synthetic FadeMem storage-reduction headline is not measured here and not echoed — the sole footprint claim is that the dormant scaffold evicts nothing → the footprint is unchanged.

## Reproduce

```
# The keyless decay sign + the safety/footprint claims (this manifest — $0, no key):
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/forget.bench.test.ts
```

Without `COMIS_BENCH` the suite skips cleanly (4 skipped, exit 0). Optionally set `COMIS_FORGET_REPORT_DIR` to refresh the `claim*-report.json` files. The costed QA-accuracy comparison requires populating the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH` + `COMIS_BENCH_ANSWER_*` + `COMIS_BENCH_JUDGE_*` — NO values recorded here), enabling the FORGET-01 decay knobs with a real provider key, and running `qa-judge-harness.bench.test.ts` with the decay-on vs decay-off ranker. See `GATE-REPORT.md` §4.

## Disclosure

Comis authored this harness. No competitor number, no cross-judged accuracy delta, and no comparative-ranking claim appears in this manifest. The forgetting mechanism is measured only against its own mechanical / safety invariants (byte-identity, the deterministic decay sign, the dormant footprint, no-regression) and the v2.9 baseline (`2026-06-01-phase106-baser/`) the recall hot path must not move when forget is off. Apache-2.0 harness — the keyless run calls no model, no judge, no key, no provider. The deterministic decay effect is recorded with its ACTUAL measured sign (the old ephemeral factor is measured below the fresh durable factor — the intended demotion, not a fabricated QA gain). Ships DEFAULT-OFF (no committed config enables `rag.forget` or the `__MEMORY_LIFECYCLE__` cron).
