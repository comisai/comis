# Phase 111 LEARN-RANK — Learning-to-Rank (bounded online weight-tuning, trust FROZEN; Track H2) · VERDICT: MEASURED + safety PROVEN; costed cross-judge QA DEFERRED

One-screen summary of the keyless gate for the Phase-111 learning-to-rank loop (LEARN-03 the pure clamped deterministic bandit step + the tuned-alpha store + the deterministic apply overlay + the LLM-free offline bandit job + the cron + the daemon wiring, all DEFAULT-OFF · LEARN-04 the keyless learning-lift gate). Full detail: `GATE-REPORT.md`. Machine-readable provenance: `run-provenance.json`.

## What was measured (keyless, $0 — no answer model, no judge, no key)

Four claims over the REAL production code path (a fresh `mkdtempSync` `SqliteMemoryAdapter`, the FEED store + the tuned-alpha store over the same `getDb()` handle, the LIVE LLM-free `createMemoryRecall`, and the SHIPPED LLM-free `runOnlineTuning` bandit run BETWEEN episodes). All PASS:

1. **Bandit-driven learning lift** (LEARN-04) — over 5 episodes of the same query the bandit climbs the tuned usefulness weight (0.125→0.225) and that climb raises the repeatedly-attributed gold memory's boosted recall SCORE monotonically (`[1, 1.0625, 1.075, 1.0875, 1.1]`, `goldScoreLift=+0.1`, `MEASURED-POSITIVE`). The lift is bandit-driven — the tuned alpha vector itself learns. The gold's rank POSITION is `MEASURED-FLAT` (already top on the keyless FTS-only `1/rank` lane; a single-rank position move needs the model-only fusion lane) — recorded honestly. (`claim1`)
2. **Trust-frozen under tuning** (the OD2 ship-gate) — under the climbing tuned vector the trust boost weight is byte-identical to config across all episodes (`[0.1, 0.1, 0.1, 0.1, 0.1]`) AND the trust filter still drops an external-trust doc (`externalDropped=true`). The bandit ranges over the four non-trust alphas only. (`claim2`)
3. **The clamp holds** — a pathological ±1e9 FEED aggregate through the shipped `computeTunedAlphas` keeps every tuned alpha in [0,1] (`allInRange=true`). (`claim3`)
4. **Default-OFF byte-identity + zero category regression** — a no-tuned-store baseline run's episode-1 gold rank equals the tuned path's episode-1 (`byteIdentical=true`). Tuning OFF ⇒ recall unchanged. (`claim4`)

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The clamp + trust-exclusion + the apply overlay's default-OFF byte-identity + the adapter isolation + the offline bandit job are additionally RED-proven in the unit suites (`tuned-alpha-update.test.ts`, `scoring-overlay.test.ts`, `sqlite-tuned-alpha-store.test.ts`, `online-tuning-job.test.ts`).

## What is DEFERRED

- **The costed cross-judge QA comparison** of the tuned-vs-static ranker (a question-answering accuracy delta over real answers) — **NOT measured here** (needs a real answer model + a cross-judge fold + a costed run). The keyless bench drives RANK, not QA, so a fresh accuracy number here would be fabricated. Kept STRICTLY SEPARATE from the keyless learning lift. See `GATE-REPORT.md` §4.

## Reproduce

```
# The keyless learning lift + the safety claims (this manifest — $0, no key):
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/learning-lift-harness.bench.test.ts
```

The costed cross-judge QA comparison requires populating the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH` + `COMIS_BENCH_ANSWER_*` + `COMIS_BENCH_JUDGE_*` — NO values recorded here), enabling the H2 tuning knobs with a real provider key, and running `qa-judge-harness.bench.test.ts` with the tuned-vs-static ranker. See `GATE-REPORT.md` §4.

## Disclosure

Comis authored this harness. No competitor number, no cross-judged accuracy delta, and no comparative-ranking claim appears in this manifest. The learning-to-rank loop is measured only against its own mechanical / safety invariants and the v2.9 baseline (`2026-06-01-phase106-baser/`) the recall hot path must not move when tuning is off. Apache-2.0 harness — the keyless run calls no model, no judge, no key, no provider. The keyless lift is recorded with its ACTUAL measured sign (the gold-score climb is positive; the gold rank-position is flat). Ships DEFAULT-OFF (no committed config enables the tuning knobs or the `__ONLINE_TUNING__` cron).
