# Phase 112 FORGET — Principled Forgetting (the per-type FadeMem decay + the scaffold-dormant lifecycle; Track C) · GATE REPORT · VERDICT: MEASURED (4 keyless claims) + live eviction DORMANT/deferred

**Date:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat` · **Keyless:** yes (no answer model, no judge, no API key, no provider call, $0)

This gate covers the Phase-112 forgetting mechanism end-to-end: FORGET-01 (the per-type FadeMem decay factor `0.5 + 0.5·exp(−λ·Δt^β)` folded as a gated default-OFF 6th 0.5-centered multiplicand in `score.ts` — importance-modulated λ over the five existing scoring signals, per-type β from `memoryType`, lazy-at-read on the injected clock) and FORGET-02 (the SCAFFOLD-DORMANT `createSqliteMemoryLifecycleStore` + the wired `__MEMORY_LIFECYCLE__` daemon cron that evicts/demotes nothing). Both ship DEFAULT-OFF.

The verdict is **MEASURED** for the four keyless mechanical/safety claims. The **LIVE eviction/demotion enablement** is DORMANT by design (Phase-106 gap-report OD4 — deferred to the operator/v2.10), and any **costed QA-accuracy impact of the decay** is explicitly DEFERRED to an operator-costed re-run. Both deferrals are kept STRICTLY SEPARATE from the keyless measurements below.

---

## §1. What was measured (keyless, $0)

Four claims over the REAL production code path — a fresh `mkdtempSync` `SqliteMemoryAdapter` (the sole `@comis/memory` adapter), the `createSqliteMemoryLifecycleStore` lifecycle adapter over the SAME `getDb()` handle, the LIVE LLM-free `createMemoryRecall` pipeline, and a deterministic `createFakeClock` so the decay's Δt is fixed. No model, no judge, no key. All PASS.

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | **Byte-identity at neutral importance** (the safety gate) — a neutral/legacy memory at event-age 0 scores + ranks identically forget OFF / ON-at-neutral / absent | PASS — `scoreForgetOff=1`, `scoreForgetOnNeutral=1`, `scoreForgetAbsent=1`; `rankForgetOff=1`, `rankForgetOnNeutral=1`, `rankForgetAbsent=1`; `byteIdentical=true` (at Δt=0 the FadeMem factor is `1.0` EXACTLY, even with a live `forgetAlpha=1.0`) | `claim1-byte-identity-report.json` |
| 2 | **The deterministic decay effect** (MEASURED) — an old (90-day) low-importance ephemeral memory's forget factor decays below a fresh (1-day) durable memory's | MEASURED — `oldEphemeralForgetFactor=0.5534545198841266` < `freshDurableForgetFactor=0.9945726783223208` (`forgetFactorGap=0.44111815843819413`, `decayedBelow=true`); recovered as the per-memory on/off boosted-score ratio | `claim2-deterministic-decay-report.json` |
| 3 | **Footprint unchanged when the eviction scaffold is off/dormant** — the wired DORMANT `runLifecycleSweep` over 5 real rows (incl. a stale eviction candidate) evicts/demotes 0 | PASS — `rowCountBefore=5`, `rowCountAfter=5`, `evictedMarkerCount=0`, `demotedMarkerCount=0`, sweep report `{scanned:5, promoted:0, demoted:0, evicted:0}`; `footprintUnchanged=true` | `claim3-footprint-unchanged-report.json` |
| 4 | **Zero category regression** — the recall hot path with forget OFF is byte-identical to a no-forget baseline run on the same mixed-age, mixed-type fixtures | PASS — `baselineOrderLength=4`, `forgetOffOrderLength=4`, `noRegression=true` (Phase-106 baseline ref) | `claim4-no-regression-report.json` |

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The FadeMem factor's byte-identity at neutral (two ways), the deterministic decay effect, the consolidation boost, and trust-first preservation are additionally RED-proven in the pure-fn unit suite (`packages/agent/src/rag/score.test.ts`); the DORMANT sweep's evict-nothing-on-and-off-policy + the `(tenant, agent)` isolation in `packages/memory/src/sqlite-memory-lifecycle-store.test.ts`; the cron's register-only-when-enabled + the keyless dormant sentinel in `packages/daemon/src/wiring/setup-schedulers.test.ts` + `setup-channels-memory-crons.test.ts` — not only in this keyless bench.

## §2. The decay effect — what is keyless-measurable, and the honest sign

The keyless-measurable forgetting effect is the **deterministic decay factor**: with forget enabled under a fixed clock, an old low-importance ephemeral memory's recall score is demoted far more than a fresh durable memory's. We recover each memory's forget CONTRIBUTION as the per-memory ratio `scoreForgetOn / scoreForgetOff` — forget is a pure multiplicand on the boosted score and every other scoring alpha is held at 0, so the ratio IS the `forgetFactor`. The old episodic memory's factor is `0.553` and the fresh semantic memory's is `0.995` (`forgetFactorGap=0.441`): the per-type β (episodic 1.2 sharp drop vs semantic 0.8 slow tail) and the event-age both push the old-ephemeral's factor lower. This is `MEASURED` with its true sign — the intended FadeMem demotion, recorded as observed.

It is **NOT** a "decay improves recall/QA" accuracy claim. FadeMem's decay is never ablated in isolation in the source work (its standalone forgetting-curve evidence is weak — its fusion component dominates its ablations), so there is no keyless evidence for an accuracy gain and a fresh accuracy number here would be fabricated. The keyless-measurable effect is the deterministic factor demotion; a QA-accuracy comparison of the decay-on vs decay-off ranker belongs to the deferred costed re-run (§4). The decay **RANKS, never GATES**: no result is dropped on the factor (it only ever fades a stale memory's score ∈ (0,1]); the trust filter is the sole hard gate.

## §3. The architecture cut + the default-OFF posture

- **agent↛memory cut** preserved: the recall scoring math (`score.ts`) consumes only `@comis/core` types and never imports `@comis/memory`; the `.bench.test.ts` suffix is the SOLE escape that imports `@comis/memory` to drive the real `SqliteMemoryAdapter` + `createSqliteMemoryLifecycleStore` (the blessed `learning-iq.bench.test.ts` / `retrieval-harness.bench.test.ts` precedent).
- **The decay is LLM-free + deterministic + lazy-at-read** — a pure scoring factor over the injected `clock.now()` (no `Date.now`, no write mutation, no new store on the recall path), so the keyless decay sign is reproducible and the recall hot path stays deterministic + LLM-free.
- **DEFAULT-OFF, byte-identity two ways** — with `rag.forget` off the factor is forced to exactly `1.0` (claim 1 / claim 4 byte-identity); on-at-neutral a fresh legacy row is still exactly `1.0` at event-age 0 (claim 1). So the v2.9 baseline holds byte-for-byte in the shipping config; a default-config agent registers no `__MEMORY_LIFECYCLE__` cron.
- **The lifecycle scaffold is DORMANT** — the wired sweep computes strengths/tiers/candidacy but its demote/evict step is dead by construction (`LIVE_EVICTION = false as const`), so even with a stale eviction candidate present it marks/deletes nothing (claim 3). Eviction is NON-DESTRUCTIVE by design when the live policy lands (a marker column — `evicted_at` / `lifecycle_demoted_at` — never a hard DELETE).
- **Counts/ids-only** — the decay factor and the sweep are content-free (scores + counts only); the question, the recalled memories, and the bodies are never logged. The committed manifest carries only numbers + booleans + prose.

## §4. What is DEFERRED

**(a) The costed QA-accuracy impact of the decay.** A question-answering accuracy comparison of the decay-on vs decay-off ranker over real answers is **NOT measured here**. It needs a real answer model + a cross-judge fold (≥2 judges per the credibility protocol) + a costed run, and — because FadeMem's decay is never ablated in isolation — there is no keyless evidence for an accuracy gain, so a fresh number here would be fabricated. Kept STRICTLY SEPARATE from the keyless decay measurement.

Reproduction (one pointer): populate the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH`, `COMIS_BENCH_ANSWER_*`, `COMIS_BENCH_JUDGE_*` — NO values recorded here), enable the FORGET-01 decay (`rag.forget.enabled` + `rag.scoring.forgetAlpha`) with a real provider key, then run the costed QA harness with the decay-on vs decay-off ranker, recording per-category accuracy + zero-regression + N + significance + cost + latency + the raw transcripts. The deferred-path harness: `packages/agent/src/memory/benchmark/qa-judge-harness.bench.test.ts`.

**(b) The LIVE eviction/demotion enablement.** Per Phase-106 gap-report OD4 the lifecycle port + adapter + cron ship DORMANT (the sweep evicts/demotes nothing; the cron registers only when `memoryLifecycle.enabled`, default false). Flipping the live policy — marking eviction candidates NON-DESTRUCTIVELY and threading the operator-configured `MemoryLifecyclePolicy` through the cron — is the deferred operator/v2.10 step (a one-flag flip onto the already-exercised candidacy/tier/strength math). This gate proves the DORMANT footprint-unchanged property (claim 3), not the live eviction policy. The synthetic FadeMem storage-reduction headline (object counts on a synthetic benchmark, not bytes) is not measured here and not echoed — the sole footprint claim is that the dormant scaffold evicts nothing → the footprint is unchanged.

**Baseline to diff against:** `benchmarks/results/2026-06-01-phase106-baser/` (the v2.9 baseline the recall hot path must not move when forget is off).

## §5. The verdict against the gate

**MEASURED (4 keyless claims) + live eviction DORMANT/deferred.** The four keyless mechanical/safety claims are MEASURED at $0: byte-identity at neutral importance (the safety gate, exactly `1.0` even with a live alpha at event-age 0), the deterministic decay effect (an old low-importance ephemeral memory's forget factor `0.553` is measured below a fresh durable memory's `0.995`), footprint unchanged when the eviction scaffold is dormant (the wired sweep evicts/demotes 0), and zero category regression (forget off is byte-identical to the no-forget baseline). The LIVE eviction enablement is DORMANT by design and the costed QA-accuracy impact of the decay is honestly DEFERRED to the operator with a one-command reproduction. No accuracy / comparative-ranking number is claimed; the deterministic decay effect is measured, the costed QA delta is deferred.

## §6. Reproduce the keyless gate

```
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/forget.bench.test.ts
```

Without `COMIS_BENCH` the suite skips cleanly (4 skipped, exit 0). Optionally set `COMIS_FORGET_REPORT_DIR` to refresh the `claim*-report.json` files into a committable dir.

## §7. Honest-benchmarking note

This is an internal regression gate measured against itself (the forgetting mechanism's own mechanical / safety invariants) and the v2.9 baseline the recall hot path must not move when forget is off. No competitor number, no cross-judged accuracy delta, and no comparative-ranking framing appears anywhere in this manifest. Every number traces to a committed `claim*-report.json`, read back from disk before quoting. The deterministic decay effect is recorded with its ACTUAL measured sign (the old ephemeral factor is measured below the fresh durable factor — the intended demotion, not a fabricated QA gain). FadeMem's decay is never ablated in isolation, so the costed QA-accuracy impact is deferred; the synthetic storage-reduction headline is not echoed. The decay RANKS, never GATES. Apache-2.0 harness; the keyless run calls no model, no judge, no key, no provider. The feature ships DEFAULT-OFF. Machine-readable provenance: `run-provenance.json`.

## §8. Files in this manifest

- `GATE-REPORT.md` — this report (VERDICT: MEASURED (4 keyless claims) + live eviction DORMANT/deferred).
- `README.md` — the one-screen summary.
- `run-provenance.json` — machine-readable provenance (measurementsTaken / deferredToOperator / coi / honestyProtocol).
- `claim1-byte-identity-report.json` — byte-identity at neutral importance (the safety gate).
- `claim2-deterministic-decay-report.json` — the deterministic decay effect (the two measured forget factors).
- `claim3-footprint-unchanged-report.json` — the dormant-sweep footprint-unchanged measurement (the row + marker counts).
- `claim4-no-regression-report.json` — the zero-category-regression measurement.
