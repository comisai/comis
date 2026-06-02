# Phase 111 LEARN-RANK — Learning-to-Rank (bounded online weight-tuning, trust FROZEN; Track H2) · GATE REPORT · VERDICT: MEASURED + safety PROVEN; costed cross-judge QA DEFERRED

**Date:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat` · **Keyless:** yes (no answer model, no judge, no API key, no provider call, $0)

This gate covers the Phase-111 learning-to-rank loop end-to-end: LEARN-03 (the pure clamped deterministic `computeTunedAlphas` bandit step, the `SqliteTunedAlphaStore` adapter, the deterministic `buildScoringAlphas` apply overlay, the LLM-free `runOnlineTuning` offline bandit job, the `__ONLINE_TUNING__` cron, and the daemon wiring — all DEFAULT-OFF) and LEARN-04 (the keyless learning-lift gate). The bandit ranges over the FOUR non-trust scoring alphas (recency / temporal / proof / usefulness) only; the trust boost weight and the trust filter are structurally FROZEN.

The verdict is **MEASURED** for the keyless learning lift + the three safety proofs, and the **costed cross-judge QA comparison** of the tuned-vs-static ranker (a question-answering accuracy delta over real answers) is explicitly DEFERRED to the operator. It is kept STRICTLY SEPARATE from the keyless measurements below.

---

## §1. What was measured (keyless, $0)

Four claims over the REAL production code path — a fresh `mkdtempSync` `SqliteMemoryAdapter` (the sole `@comis/memory` adapter), the FEED store (`createSqliteMemoryUsefulnessStore`) and the tuned-alpha store (`createSqliteTunedAlphaStore`) over the SAME `getDb()` handle, the LIVE LLM-free `createMemoryRecall` pipeline, and the SHIPPED LLM-free `runOnlineTuning` bandit run BETWEEN episodes. No model, no judge, no key. All PASS.

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | **Bandit-driven learning lift** (LEARN-04) — over 5 episodes of the same query the bandit climbs the tuned usefulness weight, and that climb raises the repeatedly-attributed gold memory's boosted recall SCORE | MEASURED — usefulnessAlpha climbs 0.125→0.225 (`usefulnessAlphaClimbed=true`); the gold's boosted score climbs `[1, 1.0625, 1.075, 1.0875, 1.1]` (`goldScoreLift=+0.1`, `MEASURED-POSITIVE`, `goldScoreNonDecreasing=true`); the gold's rank POSITION is `MEASURED-FLAT` (`rankLift=0`) | `claim1-bandit-rank-lift-report.json` |
| 2 | **Trust-frozen under tuning** (the OD2 ship-gate) — under the climbing tuned vector the trust boost weight is byte-identical to config across all episodes AND the trust filter still drops an external-trust doc | PASS (`configTrustAlpha=0.1`; `trustAlphaPerEpisode=[0.1, 0.1, 0.1, 0.1, 0.1]`; `trustAlphaStableAcrossEpisodes=true`; `externalDropped=true`) | `claim2-trust-frozen-report.json` |
| 3 | **The clamp holds** — a pathological FEED aggregate (±1e9 gradients) through the shipped `computeTunedAlphas` keeps every tuned alpha in [0,1] | PASS (`output={recencyAlpha:1, temporalAlpha:0, proofAlpha:1, usefulnessAlpha:0}`; `min=0`; `max=1`; `allInRange=true`) | `claim3-clamp-report.json` |
| 4 | **Default-OFF byte-identity + zero category regression** — a no-tuned-store baseline run's episode-1 gold rank equals the tuned path's episode-1 (before any bandit update) | PASS (`defaultOffEpisode1Rank=0`; `tunedEpisode1Rank=0`; `byteIdentical=true`) | `claim4-default-off-byte-identity-report.json` |

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The clamp + trust-exclusion are additionally RED-proven in the pure-fn unit suite (`packages/agent/src/rag/tuned-alpha-update.test.ts`), the adapter isolation in `packages/memory/src/sqlite-tuned-alpha-store.test.ts`, the apply overlay's default-OFF byte-identity in `packages/agent/src/rag/scoring-overlay.test.ts`, and the offline bandit job in `packages/agent/src/memory/online-tuning-job.test.ts` — not only in this keyless bench.

## §2. The learning lift — what is keyless-measurable, and the honest sign

The keyless-measurable learning lift is the **bandit-driven gold-SCORE climb**: the FEED loop attributes the gold memory "used" each episode, the offline bandit reads that accrued signal, aggregates the bounded used-RATE, runs the pure clamped `computeTunedAlphas` step, and upserts the climbed four-alpha vector via the `TunedAlphaStore` port; the next episode's recall reads it back and the gold's boosted score `base × (1 + usefulnessAlpha × (usedRate − 0.5))` rises while the unattributed distractors stay at the neutral factor. That climb is `MEASURED-POSITIVE` (+0.1 over 5 episodes). The lift is bandit-driven — the tuned alpha vector itself learns, not a fixed alpha.

The gold's **rank POSITION** is recorded honestly as `MEASURED-FLAT` (`rankLift=0`): on the keyless FTS-only lane the per-doc base score is `1/rank`, so adjacent docs differ by large positional gaps and a single-rank position move would need the model-only reciprocal-rank-fusion lane's compressed gaps. The gold already tops this fixture, so its rank does not move. This is recorded as observed and NOT fabricated to a positive rank delta — the keyless-measurable learning effect is the gold-score climb; a rank-position / QA-accuracy comparison belongs to the deferred costed re-run (§3).

## §3. The architecture cut + the trust-freeze + the default-OFF posture

- **agent↛memory cut** preserved: the recall apply path + the bandit job consume the `TunedAlphaStore` / `MemoryUsefulnessStore` ports as TYPES only (they never import `@comis/memory`); the `.bench.test.ts` suffix is the SOLE escape that imports `@comis/memory` to drive the real adapters (the blessed `retrieval-harness.bench.test.ts` / `qa-judge-harness.bench.test.ts` precedent).
- **Trust is a HARD boundary, never a soft weight the loop can move** (the OD2 ship-gate) — three structural belts: the tuned four-tuple type has no trust field, the apply overlay sources the trust weight ONLY from static config, and the `tuned_alpha` table has no trust column. Claim 2 measures both belts at the bench layer over the real recall pipeline: the trust weight is byte-identical under tuning and the trust filter still drops the external-trust doc.
- **The bandit is deterministic + LLM-free** — `runOnlineTuning` resolves no model, makes no provider call, and reads no key; it is a bounded deterministic step (no exploration randomness), so the keyless lift is reproducible and the recall hot path stays deterministic + LLM-free.
- **DEFAULT-OFF** — with tuning off / no tuned row the apply overlay returns the static config alphas unchanged (claim 4 byte-identity), so the v2.9 baseline holds byte-for-byte in the shipping config; a default-config agent registers no `__ONLINE_TUNING__` cron.
- **Counts/ids-only** — the FEED + tuned-alpha layers are content-free (counts + numeric alphas only); the question, the recalled memories, and the alpha values are never logged. The committed manifest carries only numbers + booleans + prose.

## §4. What is DEFERRED — the costed cross-judge QA comparison

A question-answering accuracy comparison of the tuned ranker against the static ranker over real answers is **NOT measured here**. It is a different measurement from the keyless learning lift: it needs a real answer model + a cross-judge fold (≥2 judges per the credibility protocol) to score real answers, plus a costed run. The keyless bench drives RANK, not QA, over synthetic fixtures, so a fresh QA-accuracy number here would be fabricated.

Reproduction (one pointer): populate the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH`, `COMIS_BENCH_ANSWER_*`, `COMIS_BENCH_JUDGE_*` — NO values recorded here), enable the H2 tuning knobs (`rag.onlineTuning` + `memoryOnlineTuning`) with a real provider key, then run the costed QA harness with the tuned-vs-static ranker, recording per-category accuracy + zero-regression + N + significance + cost + latency + the raw transcripts. The deferred-path harness: `packages/agent/src/memory/benchmark/qa-judge-harness.bench.test.ts`.

**Baseline to diff against:** `benchmarks/results/2026-06-01-phase106-baser/` (the v2.9 baseline the recall hot path must not move when tuning is off).

## §5. The verdict against the gate

**MEASURED + safety PROVEN; costed cross-judge QA DEFERRED.** The keyless learning lift is MEASURED at $0 (the bandit climbs the tuned usefulness weight and that climb raises the repeatedly-attributed gold memory's boosted recall score, `goldScoreLift=+0.1`; the rank position is recorded honestly as flat on the FTS-only lane). The three safety claims pass keyless (the trust weight is byte-identical under tuning and the trust filter is intact; the clamp holds; default-OFF is byte-identical with zero category regression). The costed cross-judge QA comparison of the tuned-vs-static ranker is DEFERRED to the operator with a one-command reproduction. No accuracy / comparative-ranking number is claimed; the learning effect is measured, the costed QA delta is honestly deferred.

## §6. Reproduce the keyless gate

```
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/learning-lift-harness.bench.test.ts
```

Without `COMIS_BENCH` the suite skips cleanly (5 skipped, exit 0). Optionally set `COMIS_BENCH_DATA` to refresh the `claim*-report.json` files.

## §7. Honest-benchmarking note

This is an internal regression gate measured against itself (the learning-to-rank loop's own mechanical / safety invariants) and the v2.9 baseline the recall hot path must not move when tuning is off. No competitor number, no cross-judged accuracy delta, and no comparative-ranking framing appears anywhere in this manifest. Every number traces to a committed `claim*-report.json`, read back from disk before quoting. The keyless lift is recorded with its ACTUAL measured sign (the gold-score climb is positive; the gold rank-position is flat). Apache-2.0 harness; the keyless run calls no model, no judge, no key, no provider. The feature ships DEFAULT-OFF. Machine-readable provenance: `run-provenance.json`.

## §8. Files in this manifest

- `GATE-REPORT.md` — this report (VERDICT: MEASURED + safety PROVEN; costed cross-judge QA DEFERRED).
- `README.md` — the one-screen summary.
- `run-provenance.json` — machine-readable provenance (measurementsTaken / deferredToOperator / coi / honestyProtocol).
- `claim1-bandit-rank-lift-report.json` — the bandit-driven learning lift (the gold-score climb + the flat rank position).
- `claim2-trust-frozen-report.json` — the trust-frozen-under-tuning measurement (the OD2 gate).
- `claim3-clamp-report.json` — the clamp-holds measurement.
- `claim4-default-off-byte-identity-report.json` — the default-OFF byte-identity measurement.
