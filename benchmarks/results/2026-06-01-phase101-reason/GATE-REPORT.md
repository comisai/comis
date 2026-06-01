# Phase 101 REASON — Benchmark Regression Gate (REASON-05)

**Date:** 2026-06-01 · **Harness commit:** `8c4bbd53` · **Branch:** `v2.8-prove-climb`
**Baseline reference:** `benchmarks/results/2026-05-31-j1-baseline/`
**Models:** KEYLESS — no answer model, no judge, no provider call, no API key, no cost. The reasoning job's offline `reason()` seam is a DETERMINISTIC injected stub; the trust ceilings are computed in the job's CODE.

> **VERDICT: PARTIAL — the reasoning job's two MECHANICAL claims are MEASURED and PASS, and NO regression is PROVEN (default-OFF byte-identity); the end-to-end QA-accuracy multi-session lift from the reasoning observations is NOT MEASURED — it is an operator costed re-run (see §3, §4).** An honest PARTIAL with full disclosure is the correct outcome here, not a forced PASS. This mirrors the Phase-100 KG-05 split exactly: prove WRITE-correctness + DEFAULT-OFF deterministically at $0; honestly DEFER the costed QA cross-judge lift. Every number below traces to a committed JSON in this directory that was read back from disk and asserted before quoting.

---

## 1. What was ACTUALLY measured (real numbers from real files)

| # | Measurement | Kind | Result | Source file (committed, re-read) |
|---|---|---|---|---|
| 1 | **Inductive observation write (≤ learned cap)** | KEYLESS, deterministic, $0 | written at trust **`learned`** (NEVER `system`; `systemInductiveRows=0`) with `observationKind="inductive"` | `reasoning-write-correctness-report.json` |
| 2 | **Deductive knowledge-update (current-truth via upsertTriple)** | KEYLESS, deterministic, $0 | `["short replies"]` is **current-truth** via the real `upsertTriple` | `reasoning-write-correctness-report.json` |
| 3 | **Trust-first anti-poisoning (deductive)** | KEYLESS, deterministic, $0 | older `system` **Paris SURVIVES** a newer `external` Berlin claim (Berlin NOT current) | `reasoning-write-correctness-report.json` |
| 4 | **DEFAULT-OFF byte-identity (no-regression)** | KEYLESS, deterministic, $0 | `reasonCallCount=0`, memories **2→2**, triples **0→0** (`defaultOffWroteNothing=true`) | `reasoning-default-off-report.json` |

### 1a. WRITE-correctness (the inductive + deductive write claims)

The first harness that ACTUALLY runs the offline reasoning job's write paths. It drives the **real production job** — `runMemoryReasoning` (bare `@comis/agent`) + `createSqliteMemoryConsolidationStore` + `createSqliteTripleStore` (bare `@comis/memory`) over a SHARED db — with a **DETERMINISTIC injected `reason()` seam** (a fixed function returning typed deductive + inductive candidates — NO real LLM, NO key). The trust ceilings are computed in the job's CODE, never by the seam.

**INDUCTIVE (REASON-03, the binding constraint — T-101-05-01).** Two all-`system`-trust raw memories form one homogeneous scope; the seam returns a `preference` pattern. The job writes the inductive observation at:

| field | value | the constraint |
|---|---|---|
| `observation_kind` | `inductive` | the typed reasoning-observation kind (REASON-01) |
| `trust_level` | **`learned`** | HARD-capped `minTrustLevel(minTrust(scope), "learned")` — an all-`system` cluster STILL yields `learned`, **NEVER `system`** |
| rows with `observation_kind='inductive' AND trust_level='system'` | **0** | the binding constraint proven at the STORAGE layer (where a poisoning attempt would land) |

**DEDUCTIVE (REASON-02).** The seam returns an S/P/O (`alice prefers "short replies"`); the job writes it via the SHIPPED trust-first `upsertTriple`. `currentTruth` returns `["short replies"]` — the deductive knowledge-update is current-truth, written through the real Phase-100 KG path (not a re-implementation).

### 1b. Trust-first anti-poisoning (the deductive write is non-destructive + trust-first)

A pre-seeded `system` current-truth (`alice lives_in Paris`) must SURVIVE a NEWER `external`-source deductive claim (`alice lives_in Berlin`) the seam emits (`reasonExternal:true` to exercise the external write path):

| query | incumbent trust | correct (older) | current-truth objects | incumbent stays current | external is current |
|---|---|---|---|---|---|
| alice lives_in | system | **Paris** | `["Paris"]` | ✅ true | ✅ false |

The newer `external` Berlin claim is recorded-but-not-believed (soft-closed on write); the older higher-trust fact stays current-truth. **Trust-FIRST, not recency-first** — the anti-poisoning invariant the KG adds, now exercised through the reasoning job's deductive branch.

## 2. DEFAULT-OFF byte-identity — the no-regression proof (the rigorous free proof)

The SHIPPING default ships the reasoning job **OFF** (`memoryReasoning` is `.optional()` + default-OFF, 101-02). With `config.enabled=false` the job is a TRUE no-op:

| metric | before | after | unchanged |
|---|---|---|---|
| `reason()` seam invocations | — | **0** | the cost gate (no LLM spend) |
| `memories` row count | 2 | 2 | ✅ |
| `memory_triples` row count | 0 | 0 | ✅ |

`defaultOffWroteNothing=true`. **Therefore no recall path changes in the shipping configuration** — a reasoning-ON run differs from the Phase-98 baseline ONLY when the job is explicitly enabled + a model key is set. The §baseline numbers (multi-session 60/65, overall 71.1/73.3, recall@5 0.845) are held by construction in the shipping config. This is the no-regression half of the gate, satisfied rigorously and for free.

## 3. Why the QA cross-judge multi-session lift is NOT in this report (the honest structural finding)

The headline a reasoning lift WOULD claim is a measured multi-session accuracy improvement from the reasoning observations on the J1 QA cross-judge. That lift was **NOT measured**, for a concrete, verified reason — not an omission:

**The shipped benchmark harnesses do NOT wire the reasoning observations into recall.** This is the SAME KG-05 structural gap verified in Phase 100: `qa-judge-harness.bench.test.ts` constructs `createMemoryRecall` without the reasoning observations populated, so running `pnpm bench:memory qa` as-built reproduces the Phase-98 baseline with the reasoning observations absent — a NULL result for the headline, not a reasoning-ON measurement.

**What an honest reasoning-ON QA cross-judge requires (the operator costed re-run, scoped beyond this gate plan):**
1. Wire the reasoning observations into the QA recall path (the offline job's outputs must be ingested + recalled).
2. Run a **costed** reasoning pass over the J1 corpus — the offline `reason()` seam needs an injected (costed) LLM; there is NO keyless reasoner.
3. Then run `qa` with judge gpt-4o **and** gpt-4.1, read both reports back, assert `invalid==0 && validTotal==total`, and diff vs the baseline (multi-session 60/65).

That is a Phase-101 gap-closure / follow-on plan, not this regression gate. Quoting a guessed multi-session delta would be exactly the fabrication this gate exists to prevent — so the QA cross-judge cell is **"not measured — operator costed re-run"**, never a number.

## 4. Verdict against the REASON-05 gate

| Gate clause | Required | Result | Evidence |
|---|---|---|---|
| **Inductive observation ≤ learned (binding constraint)** | measured | ✅ **PASS** — written at `learned`, 0 `system` inductive rows | §1a, `reasoning-write-correctness-report.json` |
| **Deductive knowledge-update → current-truth via upsertTriple** | measured | ✅ **PASS** — `["short replies"]` current-truth, real `upsertTriple` | §1a, `reasoning-write-correctness-report.json` |
| **Trust-first anti-poisoning (older high-trust survives)** | measured | ✅ **PASS** — Paris stays current, Berlin not current | §1b, `reasoning-write-correctness-report.json` |
| **DEFAULT-OFF byte-identity (no-regression)** | proven | ✅ **PASS** — 0 reason() calls + unchanged row counts | §2, `reasoning-default-off-report.json` + `memory-reasoning-job.test.ts` default-OFF |
| **QA cross-judge multi-session lift (both judges)** | measured | ⏳ **NOT MEASURED** — operator costed re-run (QA harness does not wire the reasoning observations) | §3, `run-provenance.json` |

### VERDICT: PARTIAL

- **The reasoning job's three mechanical write claims are MEASURED and PASS** (inductive ≤ learned binding constraint; deductive current-truth via the real `upsertTriple`; trust-first anti-poisoning), exercising real production code via the new keyless harness this plan added.
- **No regression is PROVEN** in the shipping config (default-OFF byte-identity: 0 reason() calls, unchanged row counts).
- **The end-to-end QA-accuracy multi-session lift is NOT MEASURED**, because the shipped QA harness does not wire the reasoning observations into recall and a reasoning-ON QA cross-judge requires a costed harness extension (QA wiring + a costed reasoning pass over the corpus). That is the operator costed re-run, scoped as a Phase-101 gap-closure (the FOLLOW-UP-style honest deferral, the Phase-100 KG-05 precedent).

**Honest-benchmarking note (P10):** this is an internal regression gate — no "beats X" framing. The one number that would have headlined (QA multi-session accuracy lift) is honestly marked deferred rather than guessed. The keyless WRITE-correctness + DEFAULT-OFF proofs lift the REASON-05 claim from "guessed" to "measured" for everything that CAN be measured at $0.

## Files in this manifest

| File | Provides |
|---|---|
| `GATE-REPORT.md` | this report — what was measured, the no-regression proof, the PARTIAL verdict |
| `reasoning-write-correctness-report.json` | the inductive (≤ learned) + deductive (current-truth) + trust-first write numbers |
| `reasoning-default-off-report.json` | the DEFAULT-OFF byte-identity proof (0 reason() calls, unchanged row counts) |
| `run-provenance.json` | commit, branch, keyless flag, what was measured vs deferred |
