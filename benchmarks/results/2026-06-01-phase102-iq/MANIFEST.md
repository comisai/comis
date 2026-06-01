# Phase 102 IQ — Benchmark Regression Gate MANIFEST (IQ-04)

**Date:** 2026-06-01 · **Harness commit:** `dee50e97` · **Branch:** `v2.8-prove-climb`
**Baseline reference:** `benchmarks/results/2026-05-31-j1-baseline/`

The IQ-04 regression-gate manifest for Phase 102 (recall IQ — MMR diversity + LLM-free query understanding). Keyless, deterministic, $0. The full report is **`GATE-REPORT.md`** (the primary manifest doc, mirroring the committed `2026-06-01-phase100-kg/` KG-05 + `2026-06-01-phase101-reason/` REASON-05 precedent); this file is the index + the verdict line.

## VERDICT: **PARTIAL**

The four **deterministic IQ claims** are **MEASURED and PASS** keyless at $0 via the REAL production pipeline (`createMemoryRecall` + `SqliteMemoryAdapter` + `createSqliteMemoryEmbeddingStore` + `createSqliteMemoryTemporalStore` over a shared db):

| # | Claim | Measured result | `vectorLane` | Source JSON |
|---|---|---|---|---|
| 1 | **MMR diversity contribution (λ-sweep)** | diverse-doc rank **OFF=3 → ON(λ=0.3)=2** (lift +1); **λ=1.0 byte-identical to OFF**; sweep `{1.0:3, 0.7:2, 0.5:2, 0.3:2}` | `false` (`vecAvailable=true`) | `mmr-diversity-report.json` |
| 2 | **Intent reweight** | temporal-marker query classified `temporal`; temporal-lane candidate rank **OFF=2 → ON=1** (lift +1) | `false` | `intent-reweight-report.json` |
| 3 | **NL temporal-range filter** | dated query in-window precision **OFF=0.5 → ON=1.0** (out-of-window filtered); **unparseable → no filter** (byte-identity) | `false` | `temporal-range-report.json` |
| 4 | **DEFAULT-OFF byte-identity** | shipping config (all IQ knobs off) **byte-identical** to the IQ-features-absent path; `readEmbeddingsCalls=0` | `false` | `default-off-byte-identity-report.json` |

**No-regression by construction:** the DEFAULT-OFF byte-identity proof (#4) means the Phase-98 baseline (temporal-reasoning 45/40, overall 71.1/73.3, recall@5 0.845) holds in the shipping config → **no stable category can regress**.

**HONEST DEFERRAL (the one FOLLOW-UP):** the costed QA cross-judge accuracy lift on temporal / IE-precision / abstention is **NOT MEASURED** — the shipped qa/retrieval harnesses construct `createMemoryRecall` WITHOUT the new knobs (verified `retrieval-harness.bench.test.ts:225-247`), so a KG-05-style QA-ON cross-judge needs the QA harness wired with `mmr`/`queryUnderstanding`/`embeddingStore` + a costed judge re-run = an operator costed re-run. The KG-05 / REASON-05 precedent. Diff target: `benchmarks/results/2026-05-31-j1-baseline/` (temporal 45/40, overall 71.1/73.3, recall@5 0.845). NO delta is guessed.

**Secret hygiene:** the post-run credential-shape sweep over this manifest is clean — pure numbers + booleans, no secret-key prefix, bearer-token marker, or credential field name.

## Files

| File | Provides |
|---|---|
| `GATE-REPORT.md` | the full gate report: measured numbers, the no-regression proof, the PARTIAL verdict |
| `README.md` | manifest summary + reproduce command |
| `mmr-diversity-report.json` · `intent-reweight-report.json` · `temporal-range-report.json` · `default-off-byte-identity-report.json` | the four measured-claim reports (numbers + booleans, read back from disk before quoting) |
| `run-provenance.json` | commit, branch, keyless flag, vecAvailable/vectorLane, what was measured vs deferred |

## Reproduce

```bash
COMIS_BENCH=1 \
  COMIS_IQ_REPORT_DIR="$PWD/benchmarks/results/2026-06-01-phase102-iq" \
  pnpm exec vitest run packages/agent/src/memory/benchmark/recall-iq-contribution.bench.test.ts
```
