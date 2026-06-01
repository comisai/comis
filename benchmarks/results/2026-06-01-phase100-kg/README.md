# Phase 100 KG — Benchmark Regression Gate manifest (KG-05)

**Date:** 2026-06-01 · **Commit:** `e2c3c224` · **Harness commit:** `7c93aabf` · **Branch:** `v2.8-prove-climb`

The KG-05 regression-gate manifest for Phase 100 (trust-first bi-temporal KG). Diffed against `../2026-05-31-j1-baseline/`.

## Verdict: **PARTIAL** (see `GATE-REPORT.md`)

- The KG lane's **read-side** (graph-spread recall contribution) and **write-side** (trust-first invalidation) claims are **MEASURED and PASS** — real production code, keyless, deterministic, no API cost.
- **No regression** is **PROVEN** in the shipping config (the lane is default-OFF and byte-identical to Phase-98, `memory-recall.test.ts:2109`).
- The end-to-end **QA cross-judge accuracy lift** on temporal-reasoning / knowledge-update is **NOT MEASURED** — the shipped QA harness does not wire the KG lane, so a KG-ON QA cross-judge is an **operator costed re-run** (requires wiring the QA harness + a costed triple-extraction pass over the corpus). See `GATE-REPORT.md` §3.

## Files

| File | Provides |
|---|---|
| `GATE-REPORT.md` | the gate report: measured numbers, the no-regression proof, the PARTIAL verdict |
| `graph-spread-contribution-report.json` | read-side lane contribution: linked-doc recall **delta +1** (OFF absent → ON surfaced) |
| `trust-first-kg-invalidation-report.json` | write-side trust-first invalidation: **100% (2/2)** on the SUITE-04 Paris/vegetarian fixtures |
| `run-provenance.json` | commit, branch, models, the KG-ON flag, what was measured vs deferred |

## Reproduce

```bash
# Keyless — no API key, no cost. Exercises the real createMemoryRecall + createSqliteTripleStore.
COMIS_BENCH=1 \
  COMIS_KG_REPORT_DIR="$PWD/benchmarks/results/2026-06-01-phase100-kg" \
  pnpm exec vitest run packages/agent/src/memory/benchmark/graph-spread-lane-contribution.bench.test.ts
```

Every number in `GATE-REPORT.md` traces to a JSON in this directory (read back + asserted before quoting). No QA accuracy delta is quoted that was not produced by a real `invalid==0` run — the QA cell is explicitly "not measured — operator costed re-run".
