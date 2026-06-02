# Phase 106 (BASER) — Keyless Tier Run Log (no-regression re-measurement)

**Date:** 2026-06-01
**Branch:** `feature/v2.9-understanding-learning-moat`
**Commit (system under test):** `010d9973` (v2.8 merged via PR #146 — no `packages/*/src/**` changed since)
**Run cost:** $0 — every tier below is keyless (no API key, no provider call, deterministic stub / structural string check).
**Build:** one clean `pnpm build` (exit 0), then `SKIP_BUILD=1` for each keyless run (the bench imports `@comis/*` from `dist/` via the Vitest alias; no source changed, so one build is correct).

This log is the mechanical re-measurement half of **BASER-01** — the evidence Plan 02 cites in `GATE-REPORT.md §1b` (mechanical deltas) and `§5` (the verdict no-regression clause). It is a **NO-REGRESSION** check: no source changed since #146, so the keyless harnesses (which assert STRUCTURAL invariants, not hard QA floors) are expected to pass unchanged. Any delta is a FINDING to flag, not noise.

> **Two number families, kept STRICTLY SEPARATE (the §1 honesty rule):** the keyless tiers below re-confirm **mechanical invariants only** (counts, monotone @k, `ON <= OFF`, rankLift sign, off=byte-identity). They do **NOT** reproduce the cross-judged QA-accuracy numbers (overall 71.1/73.3, recall@5 0.845, temporal 45/40, …). Those are a prior **costed** cross-judge run, **re-stated (not re-measured)** in Plan 02's `GATE-REPORT.md §1a`. A keyless run produces NO QA accuracy (there is no judge on this path) — any fresh accuracy number here would be fabricated.

---

## 1. Keyless mechanism proofs (`gate` + `head-to-head`)

### 1a. `gate` — the append-only never-overwrite ledger MECHANISM

- **Command:** `SKIP_BUILD=1 bash scripts/bench-memory.sh gate`
- **Harness:** `packages/agent/src/memory/benchmark/head-to-head.bench.test.ts`
- **Result:** **7/7 passed** with `COMIS_BENCH=1` (the harness skips cleanly — 7 skipped — without it). Duration ~2.1s.
- **Honest mechanism wording (quoted verbatim from the runner's own echo — NOT a fabricated "row appended / history swept"):**

  > keyless gate: the append-only never-overwrite ledger MECHANISM is
  > PROVEN over a fresh tmp dir (the keyless run writes NO dated row to
  > benchmarks/results/history/). The real dated append is the operator-
  > costed pass — reproduce with the steps in
  > benchmarks/results/2026-06-01-phase104-prove/GATE-REPORT.md §4.

- **Structural invariant asserted:** a 2nd write to the same dated `<date>-<commit>.json` path is REFUSED and the first file's bytes stay byte-identical; a different-date row coexists. The keyless run writes NOTHING to the committed `benchmarks/results/history/` (no such dir exists on the keyless path) — that dated append is the operator-costed pass.
- **No `require_answer_judge_env` error surfaced** → the path is genuinely keyless ($0).

### 1b. `head-to-head` — the whole proving machine at $0

- **Command:** `SKIP_BUILD=1 bash scripts/bench-memory.sh head-to-head`
- **Harness:** `packages/agent/src/memory/benchmark/head-to-head.bench.test.ts`
- **Result:** **7/7 passed** with `COMIS_BENCH=1` (7 skipped without it). Duration ~1.7s.
- **What the 7 `it`s prove (the believability machine, all over an INJECTED deterministic judge stub — no LLM, no key, no provider call):**
  1. an absent `mem0` adapter SKIPS-with-disclosure carrying NO numeric field (the anti-fabrication union);
  2. the letta-fs baseline runs as the control (`isControl: true`, never the headline);
  3. a real Comis recall cell with the v2.8 lanes ON (`lanes.graphSpread` + `mmr`, fresh tmp db) returns ranked results (the lanes are wired, not dormant);
  4. the results-ledger appends, REFUSES a 2nd same-path write (bytes byte-identical), and coexists a different-date row (the end-to-end never-overwrite invariant, on a FRESH tmp history dir);
  5. the ablation sweep is **off=byte-identity** for every v2.8 factor (`lanes.graphSpread.enabled` / `mmr.enabled` / `queryUnderstanding.intentReweight` / `queryUnderstanding.temporalParse` / write-side `memoryReasoning.enabled`);
  6. the cross-judge spread over injected verdicts survives 3/4 (single-session-preference 30-vs-45 = 15pt flagged UNSTABLE) + significance n-dependence (19pt @ n=100 significant; comparable gap @ n=20 not) + Wilson never-NaN on the boundary;
  7. writes four secret-free manifest JSONs (the write / BENCH-line / secret-omission trio).
- **Manifest side-effect (handled honestly):** by default this run rewrites harness JSONs under `benchmarks/results/2026-06-01-phase104-prove/` — that is the **phase104** manifest, NOT this phase's. The only delta was a regenerated `adapter-conformance-report.json` (a `contextChars: 181` current-run field). It was **restored** with `git checkout -- <file>` and NOT re-committed. This phase captures the OUTCOME (7/7 green + the asserted invariants), not phase104's JSONs.
- **No `require_answer_judge_env` error surfaced** → genuinely keyless ($0).

---

## 2. Keyless suite tiers (`recall-learning` + `redaction`)

### 2a. `suite recall-learning` — FEED-loop gold-rank lift

- **Command:** `SKIP_BUILD=1 bash scripts/bench-memory.sh suite recall-learning`
- **Harness:** `packages/agent/src/memory/benchmark/learning-lift-harness.bench.test.ts` (gates on `COMIS_BENCH` only — measures RANK not QA → no answer/judge LLM).
- **Result:** **2/2 passed** with `COMIS_BENCH=1` (consistently green across re-runs). Duration ~3.1s. The on-device GGUF embedding model is used for the rank measurement (the `init: embeddings ...` notices are llama.cpp embedding-init lines on the keyless on-device path — no API, no cost).
- **Structural invariant asserted (line 16 + 259-308 of the harness):** `rankLift = firstRank − lastRank`, with a **POSITIVE rankLift** the expected directional result — the gold doc climbs the ranked order as the FEED usefulness signal accrues across episodes. The harness consumes `correct: score.rankLift > 0 ? 1 : 0` and asserts `score.episodes` / `score.ranks.length` match the episode count; all held GREEN.
- **rankLift outcome:** **positive (directional pass).** The harness emits the exact `score` via `console.log("BENCH learning lift", …)` (line 301), but the vitest reporter suppresses that line, so the captured signal is the 2/2 structural-assertion GREEN (positive rankLift is the asserted direction). No precise numeric is fabricated here — the committed signal is the GREEN pass of the directional assertion.
- **No `require_answer_judge_env` error** → genuinely keyless ($0).

### 2b. `suite redaction` — privacy/redaction leak-rate

- **Command:** `SKIP_BUILD=1 bash scripts/bench-memory.sh suite redaction`
- **Harness:** `packages/agent/src/memory/benchmark/redaction-harness.bench.test.ts` (gates on `COMIS_BENCH` only — leak detection is a deterministic string check → no LLM).
- **Result:** **2/2 passed** with `COMIS_BENCH=1`. Duration ~2.7s.
- **Structural invariant asserted (line 26-31 of the harness):** every haystack is recalled into TWO stores — mitigations **ON** (write-time validator + recall-time scrubber) and **OFF** (every doc ingested verbatim, no scrub) — and the body asserts **`scoreOn.leakRate <= scoreOff.leakRate`** (directional: the shipped block + scrub drive the leak-rate DOWN; never a hard floor). leak-rate = leaked-probes / valid-probes; the report carries ONLY the two aggregate leak-rate numbers + counts via `buildSuiteReport` (structural omission — NEVER a planted-secret string, NEVER a leaked snippet).
- **ON vs OFF outcome:** **`ON <= OFF` holds (directional pass).** The two leak-rate numbers are emitted via the harness `console.log` (suppressed by the vitest reporter); the captured signal is the 2/2 structural-assertion GREEN — the redaction firewall never INCREASES the leak rate.
- **No `require_answer_judge_env` error** → genuinely keyless ($0).

### `beam` tier — SKIPPED (logged decision, RESEARCH A2 / Open-Q1)

**beam tier skipped — slow (~2h `it` budget for the 1M-token ingest, BUG-001); the FORGET-scope finding is static (BEAM measures recall@k, not footprint/bytes — there is no committed BEAM manifest and `assertStructural` refuses a hard recall floor) and does not require it.** Running `beam` 1M would re-confirm recall@k-at-scale no-regression but would STILL produce no footprint number, so the OD4 (FORGET-scope) resolution stands either way. `COMIS_BENCH_BEAM_10M` was NOT set.

---

## 3. No-regression comparison (vs the committed v2.8 baseline)

No `packages/*/src/**` changed since PR #146 (`010d9973`). The keyless harnesses assert **STRUCTURAL invariants** (counts, monotone @k, `ON <= OFF`, rankLift sign, off=byte-identity) — **NOT** hard QA floors. The expected and observed outcome is **no regression — every structural invariant holds.**

| Keyless tier | Structural invariant asserted | This run | No-regression verdict |
|---|---|---|---|
| `gate` | append-only never-overwrite ledger MECHANISM (2nd same-path write refused, prior bytes byte-identical; different-date row coexists; NO row written to `benchmarks/results/history/` on the keyless path) | 7/7 PASS | **No regression** — mechanism proven over a fresh tmp dir, unchanged |
| `head-to-head` | cross-judge fold survives 3/4 (single-session-preference 30-vs-45 = 15pt flagged UNSTABLE) + significance never-NaN + ledger never-overwrite + **ablation off=byte-identity** for all 5 v2.8 factors + mem0 skip-with-disclosure (no numeric field) + letta-fs control ran + a real Comis recall cell (lanes ON) returned ranked results | 7/7 PASS | **No regression** — the whole proving machine green at $0 |
| `suite recall-learning` | `rankLift = firstRank − lastRank` is **positive** (gold doc climbs as FEED usefulness accrues) | 2/2 PASS | **No regression** — rankLift sign positive (did not flip) |
| `suite redaction` | `scoreOn.leakRate <= scoreOff.leakRate` (redaction firewall never increases leak-rate) | 2/2 PASS | **No regression** — `ON <= OFF` held (did not invert) |

**Verdict: NO REGRESSION across all keyless tiers.** No rankLift sign flip, no `ON > OFF` inversion, no structural-assertion failure, no `beam` monotone-@k violation (beam not run — see §2). No FINDING / BLOCKER surfaced.

### These keyless numbers do NOT reproduce the cross-judged QA accuracy

The keyless mechanical re-measurement above is kept **STRICTLY SEPARATE** from the v2.8 cross-judged QA-accuracy numbers. Those numbers — overall accuracy **71.1 / 73.3** (gpt-4o / gpt-4.1), recall@5 **0.845**, recall@1 0.573, recall@3 0.783, MRR 0.788, temporal-reasoning 45 / 40, knowledge-update 75 / 75, ~15.5k tokens/query, latency P50 6.25s / P95 9.97s, letta-fs control 52.6 / 36.3 — are a prior **COSTED** cross-judge run (2026-05-31 / 06-01). They are **re-stated, NOT re-measured** in Plan 02's `GATE-REPORT.md §1a`. A keyless run produces no QA accuracy (no judge on this path); a fresh cross-judged accuracy number is **deferred to the operator-costed re-run** (the v2.8 precedent — VERDICT: PARTIAL), reproducible per `benchmarks/results/2026-06-01-phase104-prove/GATE-REPORT.md §4`.

---

## 4. Summary

- **Keyless tiers run:** `gate` (7/7), `head-to-head` (7/7), `suite recall-learning` (2/2), `suite redaction` (2/2) — all GREEN at **$0**, no API key, no `require_answer_judge_env` error on any path.
- **No-regression:** every structural invariant holds; **no FINDING, no BLOCKER.**
- **`beam`:** skipped with note (slow ~2h; the FORGET-scope finding is static — BEAM measures recall@k, not footprint).
- **Honesty:** the keyless mechanical re-measurement is kept separate from the re-stated cross-judged QA numbers; the fresh cross-judge + competitor head-to-head are the operator-costed re-run (deferred, with a one-command reproduction).
- **Secret-clean:** no credential-shaped string (the secret-key / bearer-token / api-credential shapes the runner's `sweep_dir` greps for) appears in this log; no superiority framing.
- **No source touched:** `git diff --name-only -- 'packages/*/src/**'` is empty.
