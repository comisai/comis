# Phase 102 IQ — Benchmark Regression Gate (IQ-04)

**Date:** 2026-06-01 · **Harness commit:** `dee50e97` · **Branch:** `v2.8-prove-climb`
**Baseline reference:** `benchmarks/results/2026-05-31-j1-baseline/`
**Models:** KEYLESS — no answer model, no judge, no provider call, no API key, no cost. The MMR-diversity probe supplies EXPLICIT 4-dim embedding vectors at store time + FTS-ranked candidates (no model query embedding needed); the intent classifier + NL temporal-range grammar are LLM-free deterministic code.

> **VERDICT: PARTIAL — the four DETERMINISTIC IQ claims (MMR diversity contribution, intent reweight, NL temporal-range filter, DEFAULT-OFF byte-identity) are MEASURED and PASS keyless at $0, and NO regression is PROVEN by construction (DEFAULT-OFF byte-identity); the end-to-end QA cross-judge accuracy lift on temporal / IE-precision / abstention is NOT MEASURED — it is an operator costed re-run (see §3, §4).** An honest PARTIAL with full disclosure is the correct outcome here, not a forced PASS. This mirrors the Phase-100 KG-05 + Phase-101 REASON-05 split exactly: prove deterministic correctness + DEFAULT-OFF byte-identity at $0; honestly DEFER the costed QA cross-judge lift. Every number below traces to a committed JSON in this directory that was read back from disk and asserted in the harness before quoting.

---

## 1. What was ACTUALLY measured (real numbers from real files)

| # | Measurement | Kind | Result | Source file (committed, re-read) |
|---|---|---|---|---|
| 1 | **MMR diversity contribution (λ-sweep)** | KEYLESS, deterministic, $0 | diverse-doc rank **OFF=3 → ON(λ=0.3)=2** (`diversityRankLift=1`); **λ=1.0 byte-identical to OFF** (`lambdaOneIsIdentity=true`) | `mmr-diversity-report.json` |
| 2 | **Intent reweight contribution** | KEYLESS, deterministic, $0 | temporal-marker query classified `temporal`; temporal-lane candidate rank **OFF=2 → ON=1** (`reweightRankLift=1`) | `intent-reweight-report.json` |
| 3 | **NL temporal-range filter** | KEYLESS, deterministic, $0 | dated query in-window precision **OFF=0.5 → ON=1.0** (out-of-window FILTERED); **unparseable → no filter** (byte-identity, `countOn==countOff==2`) | `temporal-range-report.json` |
| 4 | **DEFAULT-OFF byte-identity (no-regression)** | KEYLESS, deterministic, $0 | `defaultOffByteIdentical=true`; `readEmbeddingsCalls=0` (the cost gate — spy-proven) | `default-off-byte-identity-report.json` |

All four were produced by the FIRST harness that ACTUALLY runs the Phase-102 recall-IQ knobs through the **real production pipeline** — `createMemoryRecall` (bare `@comis/agent`) + `SqliteMemoryAdapter` + `createSqliteMemoryEmbeddingStore` + `createSqliteMemoryTemporalStore` (bare `@comis/memory`) over a SHARED `getDb()` handle. No mock recall, no re-implemented MMR/parser — the REAL `mmrRerank` over the REAL scoped `readEmbeddings`, the REAL `classifyIntent`/`intentMultiplier` lane-weight closure, the REAL `parseTemporalRange` → `occurredAtRange` ANDed onto the scoped query.

### 1a. MMR diversity (IQ-01) — the diverse doc is promoted ahead of a near-duplicate

Three FTS-matched candidates with EXPLICIT 4-dim embeddings: two near-duplicates (cosine ≈ 1) at FTS rank 1–2 and one orthogonal-but-relevant doc at FTS rank 3. The pure-relevance (OFF) order is `[DUP_A, DUP_B, DIVERSE]`. With `mmr.enabled` + a real scoped embedding read, MMR trades relevance against similarity-to-selected — after selecting `DUP_A`, the near-duplicate `DUP_B` is penalised while `DIVERSE` (orthogonal) is not:

| λ | diverse-doc rank | order |
|---|---|---|
| 1.0 (= OFF) | 3 | `[DUP_A, DUP_B, DIVERSE]` (pure relevance — the neutral guarantee) |
| 0.7 | 2 | `[DUP_A, DIVERSE, DUP_B]` |
| 0.5 | 2 | `[DUP_A, DIVERSE, DUP_B]` |
| 0.3 | 2 | `[DUP_A, DIVERSE, DUP_B]` |

`λ=1.0` is byte-identical to OFF (`lambdaOneIsIdentity=true` — the locked neutral guarantee); a diversity-favoring λ lifts the diverse doc one place ahead of the near-duplicate it trailed when off (`diversityRankLift=1`). `vecAvailable=true` (sqlite-vec loaded); `vectorLane=false` (no `LLAMA_MODEL_PATH` — the diversity claim supplies its own embeddings, so it does not depend on a model query-embedding lane).

### 1b. Intent reweight (IQ-02) — a temporal query up-weights the temporal lane

A temporal-marker query (`"when did the deployment incident last happen"`) is classified `temporal` by the real `classifyIntent`, which applies `intentMultiplier(temporal, "temporal") = 1.5` to the temporal lane. The temporal lane is lit via the REAL `createSqliteMemoryTemporalStore`: a near-seed memory (NOT FTS-matched, near the seed's `occurred_at`) is surfaced ONLY by the temporal lane. Raising that lane's RRF weight raises the near-seed candidate's fused rank:

| query intent | temporal candidate rank OFF | rank ON | lift |
|---|---|---|---|
| `temporal` | 2 | **1** | +1 (the reweight raises the temporal lane; never demotes) |

### 1c. NL temporal-range filter (IQ-03b) — a dated query narrows to the occurred_at window

Two distinct-content memories both lexically matching `"sprint planning summary"`, one inside a "last week" window (3 days ago) and one far outside (90 days ago). With `temporalParse` ON, the real `parseTemporalRange` yields an `occurred_at` range the scoped query ANDs in:

| path | in-window present | out-of-window present | in-window precision |
|---|---|---|---|
| `temporalParse=false` | ✅ | ✅ | 0.5 (both surface) |
| `temporalParse=true` | ✅ | ❌ (filtered) | **1.0** (only in-window) |

An UNPARSEABLE query (`"tell me about the sprint planning summary"`) with `temporalParse=true` applies NO range — recall is byte-identical to the OFF path (`countOn == countOff == 2`). The range can only NARROW (it ANDs onto the already-`(tenant, agent)`-scoped query; never widens — T-102-03-02).

## 2. DEFAULT-OFF byte-identity — the no-regression proof (the rigorous free proof)

The SHIPPING default ships every IQ knob **OFF** (`rag.mmr.enabled=false`; `rag.queryUnderstanding.{intentReweight,synonyms,temporalParse}=false`, all default-OFF — 102-01/102-04). With the stores PRESENT (the daemon always injects `embeddingStore` + `temporalStore`, 102-05) but the knobs off, recall is a TRUE no-op vs the IQ-features-absent path:

| metric | IQ-features-absent path | shipping config (knobs off) | identical |
|---|---|---|---|
| recall id order | `[M1, M2, M3]` (3 docs) | `[M1, M2, M3]` (3 docs) | ✅ `defaultOffByteIdentical=true` |
| `readEmbeddings` invocations | — | **0** | the cost gate (a spy wrapping the real store proves zero reads) |

**Therefore no recall path changes in the shipping configuration** — an IQ-ON run differs from the Phase-98 baseline ONLY when an operator explicitly enables a knob per-agent. The §baseline numbers (temporal-reasoning 45/40, overall 71.1/73.3, recall@5 0.845) are held by construction in the shipping config. This is the no-regression half of the gate, satisfied rigorously and for free — **no stable category can regress.**

## 3. Why the QA cross-judge accuracy lift is NOT in this report (the honest structural finding)

The headline an IQ lift WOULD claim is a measured QA cross-judge accuracy improvement on the temporal / IE-precision / abstention abilities. That lift was **NOT measured**, for a concrete, verified reason — not an omission:

**The shipped benchmark harnesses do NOT wire the IQ knobs into recall.** This is the SAME KG-05 / REASON-05 structural gap, verified again here: `retrieval-harness.bench.test.ts:225-247` constructs the recall config with `maxResults / minScore / includeTrustLevels / rerank / scoring` ONLY — no `mmr`, no `queryUnderstanding`, no `embeddingStore`. So running `pnpm bench:memory qa` as-built reproduces the Phase-98 baseline with the IQ features dormant — a NULL result for the headline, not an IQ-ON measurement.

**What an honest IQ-ON QA cross-judge requires (the operator costed re-run, scoped beyond this gate plan):**
1. Wire the QA recall path with `mmr` + `queryUnderstanding` + `embeddingStore` (the J1 corpus must be recalled through the IQ knobs).
2. Run a **costed** cross-judge pass — an answer model + ≥ 2 judges over the J1 corpus; there is NO keyless judge.
3. Then diff vs the baseline (temporal-reasoning 45/40) and assert `invalid==0 && validTotal==total` under both judges.

That is a Phase-102 gap-closure / follow-on plan, not this regression gate. Quoting a guessed temporal/abstention delta would be exactly the fabrication this gate exists to prevent — so the QA cross-judge cell is **"not measured — operator costed re-run"**, never a number.

## 4. Verdict against the IQ-04 gate

| Gate clause | Required | Result | Evidence |
|---|---|---|---|
| **MMR diversity contribution (λ-sweep)** | measured | ✅ **PASS** — diverse-doc rank 3→2 at λ<1; λ=1.0 byte-identical to OFF | §1a, `mmr-diversity-report.json` |
| **Intent reweight raises the targeted lane** | measured | ✅ **PASS** — temporal candidate rank 2→1 on a temporal query | §1b, `intent-reweight-report.json` |
| **NL temporal-range filter (+ unparseable→no-filter)** | measured | ✅ **PASS** — in-window precision 0.5→1.0; unparseable byte-identical | §1c, `temporal-range-report.json` |
| **DEFAULT-OFF byte-identity (no-regression)** | proven | ✅ **PASS** — byte-identical output + 0 readEmbeddings calls | §2, `default-off-byte-identity-report.json` + `memory-recall.test.ts` DEFAULT-OFF per-knob |
| **QA cross-judge temporal / IE / abstention lift** | measured | ⏳ **NOT MEASURED** — operator costed re-run (QA harness does not wire the IQ knobs) | §3, `run-provenance.json` |

### VERDICT: PARTIAL

- **The four deterministic IQ claims are MEASURED and PASS** (MMR diversity contribution with a λ-sweep; intent reweight raising the temporal lane; NL temporal-range narrowing + unparseable→no-filter), exercising real production code via the new keyless harness this plan added.
- **No regression is PROVEN** in the shipping config (DEFAULT-OFF byte-identity: byte-identical recall order, 0 `readEmbeddings` calls) — no stable category can regress by construction.
- **The end-to-end QA cross-judge accuracy lift is NOT MEASURED**, because the shipped QA harness does not wire the IQ knobs into recall and an IQ-ON QA cross-judge requires a costed harness extension (QA wiring + a costed cross-judge pass over the corpus). That is the operator costed re-run, scoped as a Phase-102 gap-closure (the FOLLOW-UP-style honest deferral, the KG-05 / REASON-05 precedent).

**FOLLOW-UP (the one deferred costed run):** wire `qa-judge-harness.bench.test.ts` (and the retrieval harness) to construct `createMemoryRecall` with `mmr` + `queryUnderstanding` + `embeddingStore`, then run a costed cross-judge (≥ 2 judges) IQ-ON pass over the J1 corpus and diff temporal-reasoning / abstention vs `benchmarks/results/2026-05-31-j1-baseline/` (temporal 45/40, overall 71.1/73.3, recall@5 0.845). Quote the measured delta then — never a guess.

**Honest-benchmarking note (binding constraint #8 / P10):** this is an internal regression gate — no "beats X" framing. The one number that would have headlined (QA temporal/abstention accuracy lift) is honestly marked deferred rather than guessed. The keyless deterministic-correctness + DEFAULT-OFF proofs lift the IQ-04 claim from "guessed" to "measured" for everything that CAN be measured at $0.

## Files in this manifest

| File | Provides |
|---|---|
| `GATE-REPORT.md` | this report — what was measured, the no-regression proof, the PARTIAL verdict |
| `README.md` | manifest summary + reproduce command |
| `mmr-diversity-report.json` | the MMR diversity λ-sweep numbers (diverse-doc rank OFF vs ON per λ) |
| `intent-reweight-report.json` | the intent-reweight temporal-lane rank delta |
| `temporal-range-report.json` | the NL temporal-range in-window precision (dated) + unparseable→no-filter byte-identity |
| `default-off-byte-identity-report.json` | the DEFAULT-OFF byte-identity proof (byte-identical order, 0 readEmbeddings calls) |
| `run-provenance.json` | commit, branch, keyless flag, vecAvailable/vectorLane, what was measured vs deferred |
