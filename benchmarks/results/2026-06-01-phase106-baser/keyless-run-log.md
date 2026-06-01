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
