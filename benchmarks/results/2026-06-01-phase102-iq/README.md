# Phase 102 IQ — Benchmark Regression Gate manifest (IQ-04)

**Date:** 2026-06-01 · **Harness commit:** `dee50e97` · **Branch:** `v2.8-prove-climb`

The IQ-04 regression-gate manifest for Phase 102 (recall IQ — MMR diversity + LLM-free query understanding: intent reweight, synonym expansion, NL temporal-range parse). Keyless, deterministic, $0 — diffed conceptually against `../2026-05-31-j1-baseline/`.

## Verdict: **PARTIAL** (see `GATE-REPORT.md`)

- The four **deterministic IQ claims** are **MEASURED and PASS** — real production code (`createMemoryRecall` + `SqliteMemoryAdapter` + `createSqliteMemoryEmbeddingStore` + `createSqliteMemoryTemporalStore` over a shared db), keyless, deterministic, no API cost:
  - **MMR diversity contribution** — a diverse-but-relevant doc is promoted ahead of a near-duplicate (diverse-doc rank **3 → 2** at λ < 1); **λ=1.0 is byte-identical to OFF** (the neutral guarantee). λ-sweep `{1.0:3, 0.7:2, 0.5:2, 0.3:2}`.
  - **Intent reweight** — a temporal-marker query classified `temporal` up-weights the temporal lane (×1.5), so its candidate climbs the fused order (rank **2 → 1**).
  - **NL temporal-range filter** — a dated query narrows to the `occurred_at` window (in-window precision **0.5 → 1.0**, out-of-window filtered); an unparseable query applies no range (recall byte-identical).
- **No regression** is **PROVEN** in the shipping config (every IQ knob default-OFF: recall byte-identical to the IQ-features-absent path, `readEmbeddings` never called) → **no stable category can regress**.
- The end-to-end **QA cross-judge accuracy lift** on temporal / IE-precision / abstention is **NOT MEASURED** — the shipped QA harness does not wire the IQ knobs into recall (the SAME KG-05 / REASON-05 structural gap, verified `retrieval-harness.bench.test.ts:225-247`), so an IQ-ON QA cross-judge is an **operator costed re-run** (requires wiring the QA harness + a costed cross-judge pass over the corpus). See `GATE-REPORT.md` §3.

## Files

| File | Provides |
|---|---|
| `GATE-REPORT.md` | the gate report: measured numbers, the no-regression proof, the PARTIAL verdict |
| `mmr-diversity-report.json` | the MMR diversity λ-sweep numbers (diverse-doc rank OFF vs ON per λ) |
| `intent-reweight-report.json` | the intent-reweight temporal-lane rank delta |
| `temporal-range-report.json` | the NL temporal-range in-window precision (dated) + unparseable→no-filter byte-identity |
| `default-off-byte-identity-report.json` | DEFAULT-OFF byte-identity: byte-identical order + 0 readEmbeddings calls |
| `run-provenance.json` | commit, branch, keyless flag, vecAvailable/vectorLane, what was measured vs deferred |

## Reproduce

```bash
# Keyless — no API key, no cost. Exercises the real createMemoryRecall +
# SqliteMemoryAdapter + createSqliteMemoryEmbeddingStore + createSqliteMemoryTemporalStore.
COMIS_BENCH=1 \
  COMIS_IQ_REPORT_DIR="$PWD/benchmarks/results/2026-06-01-phase102-iq" \
  pnpm exec vitest run packages/agent/src/memory/benchmark/recall-iq-contribution.bench.test.ts
```

Every number in `GATE-REPORT.md` traces to a JSON in this directory (read back + asserted in the harness before quoting). The bench is keyless — no QA accuracy delta is quoted; the QA cell is explicitly "not measured — operator costed re-run". A post-run credential-shape sweep over the manifest is clean: no secret-key prefixes, bearer-token markers, or credential field names — the manifest carries pure numbers + booleans.
