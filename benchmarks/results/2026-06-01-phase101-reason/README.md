# Phase 101 REASON — Benchmark Regression Gate manifest (REASON-05)

**Date:** 2026-06-01 · **Harness commit:** `8c4bbd53` · **Branch:** `v2.8-prove-climb`

The REASON-05 regression-gate manifest for Phase 101 (offline deductive + inductive reasoning observations). Keyless, deterministic, $0 — diffed conceptually against `../2026-05-31-j1-baseline/`.

## Verdict: **PARTIAL** (see `GATE-REPORT.md`)

- The reasoning job's three **WRITE-correctness** claims are **MEASURED and PASS** — real production code (`runMemoryReasoning` + the real `applyConsolidation` + the real trust-first `upsertTriple`), keyless, deterministic, no API cost:
  - an INDUCTIVE observation is written at trust **`learned`** (NEVER `system`; the binding constraint, all-`system` cluster) with `observationKind="inductive"`;
  - a DEDUCTIVE knowledge-update is **current-truth** via the real `upsertTriple`;
  - **trust-first** — an older `system` Paris fact SURVIVES a newer `external` Berlin claim.
- **No regression** is **PROVEN** in the shipping config (the job is default-OFF: `reasonCallCount=0`, memory + triple row counts unchanged).
- The end-to-end **QA cross-judge multi-session accuracy lift** from the reasoning observations is **NOT MEASURED** — the shipped QA harness does not wire the reasoning observations into recall (the SAME KG-05 structural gap), so a reasoning-ON QA cross-judge is an **operator costed re-run** (requires wiring the QA harness + a costed reasoning pass over the corpus). See `GATE-REPORT.md` §3.

## Files

| File | Provides |
|---|---|
| `GATE-REPORT.md` | the gate report: measured numbers, the no-regression proof, the PARTIAL verdict |
| `reasoning-write-correctness-report.json` | inductive (≤ learned) + deductive (current-truth) + trust-first write numbers |
| `reasoning-default-off-report.json` | DEFAULT-OFF byte-identity: 0 reason() calls + unchanged row counts |
| `run-provenance.json` | commit, branch, keyless flag, what was measured vs deferred |

## Reproduce

```bash
# Keyless — no API key, no cost. Exercises the real runMemoryReasoning +
# createSqliteMemoryConsolidationStore + createSqliteTripleStore with a deterministic seam.
COMIS_BENCH=1 \
  COMIS_REASON_REPORT_DIR="$PWD/benchmarks/results/2026-06-01-phase101-reason" \
  pnpm exec vitest run packages/agent/src/memory/benchmark/reasoning-observations.bench.test.ts
```

Every number in `GATE-REPORT.md` traces to a JSON in this directory (read back + asserted before quoting). The bench is keyless — no QA accuracy delta is quoted; the QA cell is explicitly "not measured — operator costed re-run". A post-write credential-shape sweep over the manifest JSONs is clean (no secret-key prefixes, bearer tokens, or credential field markers).
