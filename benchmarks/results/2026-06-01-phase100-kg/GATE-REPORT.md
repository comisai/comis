# Phase 100 KG — Benchmark Regression Gate (KG-05)

**Date:** 2026-06-01 · **Commit:** `e2c3c224` · **Branch:** `v2.8-prove-climb`
**Baseline diffed against:** `benchmarks/results/2026-05-31-j1-baseline/`
**Models:** answer = anthropic/`claude-sonnet-4-6` · judges = openai/`gpt-4o-2024-11-20` + openai/`gpt-4.1` (same pair as the baseline; cross-**model**, both OpenAI — cross-provider is Phase 104) · embedding/reranker = local

> **VERDICT: PARTIAL — the KG lane's read-side + write-side claims are MEASURED and PASS, and NO regression is PROVEN (byte-identity); the end-to-end QA-accuracy headline lift on temporal-reasoning / knowledge-update is NOT MEASURED — it is an operator costed re-run (see §3, §4).** An honest PARTIAL with full disclosure is the correct outcome here, not a forced PASS. The two prior fabrication near-misses in this milestone make it imperative: every number below traces to a committed JSON in this directory that was read back from disk and asserted before quoting.

---

## 1. What was ACTUALLY measured (real numbers from real files)

| # | Measurement | Kind | Result | Source file (committed, re-read) |
|---|---|---|---|---|
| 1 | **Graph-spread lane recall contribution** | KEYLESS, deterministic, $0 | linked-doc recall **delta +1** (OFF: linked **absent**; ON: linked **surfaced** purely by the KG edge) | `graph-spread-contribution-report.json` |
| 2 | **Trust-first KG write-path invalidation (SUITE-04 Paris/vegetarian)** | KEYLESS, deterministic, $0 | **100% (2/2)** older-high-trust-wins via the real `upsertTriple` | `trust-first-kg-invalidation-report.json` |
| 3 | **No-regression of the shipping config** | in-CI proof | **byte-identical to Phase-98** (lane default-OFF ⇒ `spreadLane` never called) | `packages/agent/src/rag/memory-recall.test.ts:2109` |

### 1a. Graph-spread lane contribution (the read-side KG claim)

The first harness that ACTUALLY exercises the KG lane (the shipped qa/retrieval/contradiction harnesses do **not** — §3). It drives the **real production path** — `createMemoryRecall` (bare `@comis/agent`) + `createSqliteTripleStore` (bare `@comis/memory`) + the real bounded recursive-CTE `spreadLane` + the real `source_memory_id → memories` hydrate — over a scenario where a memory is **structurally linked** (subject→object current-truth edges) to a query's top base hit but is **NOT lexically retrievable** for that query.

| Config | recalled ids | linked doc present | linked-doc recall |
|---|---|---|---|
| `graphSpread.enabled=false` (shipping default) | 1 (seed only) | **false** | 0 |
| `graphSpread.enabled=true` | 2 (seed + linked) | **true** | 1 |
| **Lane-attributable delta** | **+1** | — | **+1** |

A non-lexical, structurally-linked memory is surfaced into recall **purely by the graph edge** when the lane is ON, and is absent when it is OFF. This is the read-side KG claim, measured for free, exercising production code (not a mock). `vectorLane=false` (FTS-only base) — with the vector lane lit the claim is only *stronger* (the linked doc is non-lexical AND non-semantic for the query, so only the graph edge can reach it).

### 1b. Trust-first KG write-path invalidation (the write-side KG claim)

Drives the **same SUITE-04 fixtures the gate names** (Paris/vegetarian) through the **real `upsertTriple` trust-first single-current-truth invalidation**, in the correct temporal order — the OLDER high-trust fact written first, THEN the NEWER `external` contradiction — and reads `currentTruth`:

| query | incumbent trust | correct (older) | current-truth objects | incumbent stays current | external is current |
|---|---|---|---|---|---|
| user's home city | system | **Paris** | `["Paris"]` | ✅ true | ✅ false |
| user's diet | learned | **vegetarian** | `["vegetarian"]` | ✅ true | ✅ false |

**Trust-first-correct rate: 100% (2/2).** The newer `external` Berlin/meat claims are recorded-but-not-believed (soft-closed on write); the older higher-trust fact stays current-truth. Trust-FIRST, not recency-first — the anti-poisoning invariant the KG adds. This is a HARD ladder, not a noisy LLM number (the harness asserts the rate is exactly 100).

> Distinct from `contradiction-harness.bench.test.ts`, which measures the **shipped v2.7 recall trust FILTER** (external excluded from recall), NOT the new KG write path. Its keyless structural witness (`recall keeps the older high-trust fact and excludes the newer low-trust claim`) was also re-run green this session — both the shipped filter AND the new KG write path enforce trust-first, by independent mechanisms.

## 2. Baseline (the regression reference — read back from the committed baseline manifests)

From `benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-{a,b}.json` (both `invalid:0`, `validTotal:135`):

| Category | n | baseline A (gpt-4o) | baseline B (gpt-4.1) | cross-judge stable? |
|---|---|---|---|---|
| single-session-user | 20 | 100 | 95 | ✅ |
| single-session-assistant | 20 | 100 | 100 | ✅ |
| knowledge-update | 20 | **75** | **75** | ✅ |
| multi-session | 20 | 60 | 65 | ✅ |
| temporal-reasoning | 20 | **45** | **40** | ✅ |
| single-session-preference | 20 | 30 | 45 | ❌ unstable (not gated) |
| locomo *(comparability-only)* | 15 | 93.3 | 100 | ❌ (never headlined) |
| **overall** | 135 | **71.1** | **73.3** | — |

Retrieval (full 500+10, baseline): recall@1 0.573 · recall@3 0.783 · **recall@5 0.845** · MRR 0.788.

## 3. Why the QA cross-judge headline lift is NOT in this report (the honest structural finding)

The §5 gate's headline is a **measured lift on temporal-reasoning + knowledge-update** from the J1 QA cross-judge. That lift was **NOT measured**, for a concrete, verified reason — not an omission:

**The shipped benchmark harnesses do NOT exercise the KG lane.** Verified by grep on `e2c3c224`:

- `qa-judge-harness.bench.test.ts` — constructs `createMemoryRecall` with **no `tripleStore` dep** and **no `lanes.graphSpread` config**. (grep: `tripleStore|graphSpread|TripleStore` → **0 matches**.)
- `retrieval-harness.bench.test.ts` — same (0 matches).
- `contradiction-harness.bench.test.ts` — same (0 matches); it measures the **shipped recall trust filter**, not the KG lane.

With `lanes.graphSpread` absent (default-OFF), the recall pipeline's precondition gate (`gs?.enabled === true && deps.tripleStore !== undefined && seedPool.length > 0`, `memory-recall.ts:288`) is never entered. So **running `pnpm bench:memory qa` as-built reproduces the Phase-98 baseline with the KG lane DORMANT** — a NULL result for the headline, not a KG-ON measurement. Quoting a "no-lift" number from such a run, or any guessed delta, would be exactly the fabrication this gate exists to prevent — so the QA cross-judge cell is **"not measured — operator costed re-run"**, never a number.

**What an honest KG-ON QA cross-judge requires (the operator costed re-run, scoped beyond this gate plan):**
1. Wire `tripleStore = createSqliteTripleStore({ db: adapter.getDb() })` + a `lanes.graphSpread` config into `qa-judge-harness.bench.test.ts` (the same wiring this plan's new harness demonstrates).
2. Populate `memory_triples` over the 120-item J1 corpus — the offline triple-extraction job (`runMemoryTripleExtraction`) needs an **injected (costed) LLM extractor** pass over every ingested memory; there is no keyless extractor.
3. Then run `qa` with judge gpt-4o **and** gpt-4.1, read both reports back, assert `invalid==0 && validTotal==total`, and diff vs §2.

That is a Phase-100 gap-closure / follow-on plan, not this regression gate.

## 4. No-regression — PROVEN by byte-identity (the rigorous free proof)

The shipping default ships the graph-spread lane **OFF** (`lanes.graphSpread.enabled:false`). Plan 100-04's in-CI characterization proves the OFF path is **byte-identical** to the pre-KG pipeline:

> `memory-recall.test.ts:2109` — *"DEFAULT-OFF BYTE-IDENTITY: graphSpread.enabled=false → spreadLane NEVER called → output identical to the pre-graphSpread fused path"* (+ `:2130` no-config, `:2168` no-store, `:2180` non-fatal-on-err). All green this session.

**Therefore no stable category can regress in the shipping configuration** — a KG-ON re-run differs from baseline *only* when the lane is explicitly enabled and triples exist; the default surface is provably unchanged. The §2 baseline numbers (overall 71.1/73.3, temporal 45/40, knowledge-update 75/75, recall@5 0.845) are held by construction in the shipping config. This is the no-regression half of the §5 gate, satisfied rigorously and for free.

## 5. Verdict against the GAP-REPORT §5 gate

| Gate clause | Required | Result | Evidence |
|---|---|---|---|
| **No stable category regresses >5pt** | hold all stable axes | ✅ **PASS** — byte-identical in the shipping config | §4, `memory-recall.test.ts:2109` |
| **~71% overall floor + recall@5 0.845 held** | hold | ✅ **PASS** — unchanged in the shipping config (lane OFF = no-op) | §4 + §2 |
| **KG read-side lane contributes** | measured | ✅ **PASS** — +1 linked-doc recall delta, real production path | §1a, `graph-spread-contribution-report.json` |
| **KG write-side trust-first invalidation** | measured | ✅ **PASS** — 100% (2/2) older-high-trust-wins, real `upsertTriple` | §1b, `trust-first-kg-invalidation-report.json` |
| **Lift on temporal-reasoning + knowledge-update (QA cross-judge, both judges)** | measured | ⏳ **NOT MEASURED** — operator costed re-run (QA harness does not wire the lane) | §3, `run-provenance.json` |
| **single-session-preference** | tracked, not gated (unstable) | n/a | §2 |
| **LoCoMo** | comparability-only | n/a | §2 |

### VERDICT: PARTIAL

- **The KG's two mechanical claims are MEASURED and PASS** (read-side lane contribution; write-side trust-first invalidation), exercising real production code via the new keyless harness this plan added.
- **No regression is PROVEN** in the shipping config (byte-identity).
- **The end-to-end QA-accuracy headline lift on temporal-reasoning / knowledge-update is NOT MEASURED**, because the shipped QA harness does not wire the KG lane and a KG-ON QA cross-judge requires a costed harness extension (QA wiring + a costed triple-extraction pass over the corpus). That is the operator costed re-run, scoped as a Phase-100 gap-closure.

**Honest-benchmarking note (P10):** this is an internal regression gate — no "beats X" framing. The disclosed-subset + cross-judge-baseline discipline is inherited from the J1 baseline; the one number that would have headlined (QA accuracy lift) is honestly marked deferred rather than guessed.

## Files in this manifest

| File | Provides |
|---|---|
| `GATE-REPORT.md` | this report — what was measured, the no-regression proof, the verdict |
| `graph-spread-contribution-report.json` | the read-side lane-contribution numbers (delta +1) |
| `trust-first-kg-invalidation-report.json` | the write-side trust-first invalidation rate (100% on SUITE-04) |
| `run-provenance.json` | commit, branch, models, the KG-ON flag, what was measured vs deferred |
