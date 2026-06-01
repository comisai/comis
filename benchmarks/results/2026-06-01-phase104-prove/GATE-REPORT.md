# Phase 104 PROVE — Head-to-Head Proving Machine + Continuous Gate

**Date:** 2026-06-01 · **Commit:** `56d0f473` · **Harness commit:** `db8ba5b3` · **Branch:** `v2.8-prove-climb`
**Baseline diffed against:** `benchmarks/results/2026-05-31-j1-baseline/`
**Intended costed-pass models:** answer = anthropic/`claude-sonnet-4-6` · judges = openai/`gpt-4o-2024-11-20` + openai/`gpt-4.1` (cross-**model**; cross-**provider** claude-opus-4-8 is the costed re-run, opus-as-judge only when the answer lane is non-Anthropic — BUG-004) · embedding/reranker = local

> **VERDICT: PARTIAL — the proving MACHINE + the per-release gate are MEASURED to run keyless at $0 (the cross-judge fold, the significance layer, the append-only never-overwrite ledger, the off=byte-identity ablation sweep, the skip-with-disclosure adapters, the letta-fs control, and a real Comis recall cell with the v2.8 lanes ON all run deterministically with no key and no provider call). The ACTUAL competitor numbers + the cross-JUDGED headline spread are NOT MEASURED — they are the operator-costed re-run (keys + competitor installs + LLM judge spend; see §4). An honest PARTIAL with full disclosure is the correct outcome — the believable machine is proven before a single dollar is spent, and no competitor number or cross-judged delta is guessed.**

This is the 4th replay of the KG-05 / REASON-05 / IQ-04 gate discipline. Every number below traces to a committed JSON in this directory that was read back from disk and asserted in the harness before quoting.

---

## 1. What was ACTUALLY measured (real numbers from real files, keyless at $0)

| # | Measurement | Kind | Result | Source file (committed, re-read) |
|---|---|---|---|---|
| 1 | **Cross-judge spread survival fold** (injected verdicts) | KEYLESS, deterministic, $0 | **3/4 categories survive** (≤5pt); the 15pt category does **not** survive | `cross-judge-spread.json` |
| 2 | **Two-proportion significance + Wilson CI** | KEYLESS, deterministic, $0 | n-dependence holds; Wilson **never NaN** on the boundary | (asserted in `head-to-head.bench.test.ts`) |
| 3 | **Append-only ledger never-overwrite** (end-to-end) | KEYLESS, deterministic, $0 | 2nd same-path write **refused**, prior bytes **byte-identical**; different date **coexists** | (asserted in `head-to-head.bench.test.ts`) |
| 4 | **Ablation off = byte-identity (every v2.8 factor)** | KEYLESS, deterministic, $0 | **all 5 factors** byte-identical to baseline when OFF | `ablation-contribution-report.json` |
| 5 | **Absent-competitor skip-with-disclosure + letta-fs control** | KEYLESS, deterministic, $0 | mem0 **skipped with disclosure** (no number); letta-fs **control ran** | `adapter-conformance-report.json` |
| 6 | **Real Comis recall cell, v2.8 lanes ON** (wiring proof) | KEYLESS, deterministic, $0 | the real recall pipeline **returned ranked results** (lanes not dormant) | `head-to-head-report.json` (`machine.comisCellRanRealPipeline`) |

### 1a. Cross-judge spread survival fold (PROVE-02)

`computeCrossJudgeSpread` (the j1 ≤5.0pt survival tolerance, now tested code, not hand-arithmetic) folds two per-category accuracy maps into a per-category `|A−B|` + a `survives` flag. The harness feeds **INJECTED deterministic verdicts** (NO LLM — these are the verdicts a real cross-judge pass would *produce*, supplied directly to exercise the fold at $0):

| Category | judge A | judge B | spread | survives |
|---|---|---|---|---|
| single-session-user | 100 | 100 | 0 | ✅ |
| knowledge-update | 75 | 75 | 0 | ✅ |
| temporal-reasoning | 45 | 42 | 3 | ✅ |
| single-session-preference | 30 | 45 | **15** | ❌ (must not headline) |

**3/4 survive.** The 15pt category is correctly flagged unstable — exactly the j1 protocol's "judge-noisy, do not headline" rule, now enforced by tested code. These are injected verdicts proving the *fold*; the real cross-judged numbers are §4.

### 1b. Significance + Wilson CI (PROVE-03)

`twoProportionTest` / `wilsonInterval` (the only net-new algorithm in Phase 104): a 19pt gap at n=100 is **significant**, a comparable gap at n=20 is **not** (the small-N noise the j1 protocol warns about), and the Wilson interval is finite and ≤1 on the `(20,20)` boundary (never the Wald interval's degenerate NaN). Every credible headline number carries N + a significance flag.

### 1c. Append-only ledger never-overwrite (PROVE-03)

The harness drives `buildLedgerRow` + `appendLedgerRow` over a **fresh tmp history dir** (NOT the committed `benchmarks/results/history/` — the keyless proof writes a *synthetic* dated row): it writes `2026-06-01-aaa1111`, then a **2nd write to the same dated path is refused** (the explicit `existsSync` guard — `writeRegularFile`'s default would *silently clobber*) and **the first file's bytes stay byte-identical**, then a `2026-06-02-bbb2222` row **coexists**. The per-release gate can never overwrite a prior committed dated row.

### 1d. Ablation off = byte-identity, every v2.8 factor (PROVE-03)

`applyFactor(baseline, factor, false)` is **JSON-byte-identical** to the explicit-off recall baseline for all 5 factors (a mistyped knob leaf would set a phantom key and diverge — the safety net against a false "no contribution" reading), pinned to the **verified** leaves:

| factor | knob leaf | write-side | off = byte-identity |
|---|---|---|---|
| kg-graph-spread | `lanes.graphSpread.enabled` | no | ✅ |
| iq-mmr | `mmr.enabled` | no | ✅ |
| iq-intent | `queryUnderstanding.intentReweight` | no | ✅ |
| iq-temporal-parse | `queryUnderstanding.temporalParse` | no | ✅ |
| reason-observations | `memoryReasoning.enabled` | **yes** | ✅ |

### 1e. Adapter conformance (PROVE-01)

The absent **mem0** adapter returns `{ ran:false, skipped:true, system:"mem0", reason, disclosure }` with **no numeric field of any name** (`fabricatedNumber:false` — an absent system is *structurally* incapable of fabricating a number via the discriminated union). The **letta-fs baseline** ran keyless at $0 as the labelled **control** (`isControl:true`), structurally distinguishable from a Comis cell — never the headline.

### 1f. Real Comis recall cell, lanes ON (PROVE-01, Pitfall-2 wiring proof)

`createMemoryRecall` (bare `@comis/agent`) + `SqliteMemoryAdapter` + `createSqliteTripleStore` (bare `@comis/memory`) with `lanes.graphSpread` + `mmr` enabled, over a fresh `mkdtempSync` db, **returned ranked results** — proving the shipped v2.8 lanes are wired into the production recall path, not dormant. A number is **not** quoted; this is a wiring proof, not an accuracy measurement.

## 2. Baseline (the regression reference — read back from the committed baseline manifests)

From `benchmarks/results/2026-05-31-j1-baseline/`: overall **71.1 / 73.3** (gpt-4o / gpt-4.1), temporal-reasoning **45 / 40**, knowledge-update **75 / 75**, recall@5 **0.845**; the letta-fs full-context control row **52.6 / 36.3** (the control is far below Comis's recall — the benchmark is not weak). These are the numbers the costed re-run (§4) diffs its head-to-head headline against.

## 3. Why the competitor numbers + cross-judged headline are NOT in this report (the honest structural finding)

The head-to-head's headline is a **cross-judged accuracy comparison across memory systems**. That comparison was **NOT measured**, for a concrete, structural reason — not an omission:

- **The competitor adapters are skip-with-disclosure skeletons.** mem0 / zep need an external package + a hosted key; hindsight / mnemosyne are sibling clones the operator builds. **None is a Comis dependency** (the exact-pin + bundling supply-chain invariant, enforced by an in-test static read of every `package.json`). The keyless CI **always** hits the skip branch — that *is* the wiring proof. A real competitor cell needs the operator's installs + keys + LLM spend.
- **There is no keyless judge.** The cross-judged headline spread requires answering the J1 corpus with the answer model and grading with ≥2 independent judges. The spread in §1a is computed over *injected deterministic verdicts* (proving the fold); the real cross-judged numbers need a costed pass.
- **Vendor self-reported numbers are non-comparable** across protocols/harnesses (the COI), and a guessed delta would be exactly the integrity threat (T-104-04-02) this gate exists to prevent.

So the competitor numbers + the cross-judged headline are **"not measured — operator costed re-run"**, never a number. This is the home for the **KG-05 / REASON-05 / IQ-04 deferred QA lifts**: the same costed re-run (the QA harness wired with the v2.8 lanes + ≥2 judges) fills all three headline lifts together.

## 4. How to reproduce the costed head-to-head (the operator-costed re-run)

```bash
# 1. Populate the git-ignored operator env (NEVER committed):
cp scripts/bench-memory.env.example scripts/bench-memory.env
#    fill COMIS_BENCH_ANSWER_* (the answer model) + COMIS_BENCH_JUDGE_* (judge #1).
#    For the cross-judge spread, run a SECOND judge pass and publish the spread.
# 2. Install the competitor systems (operator/external — NEVER a Comis dependency):
#    mem0:      set MEM0_API_KEY + install the mem0ai package
#    zep:       set ZEP_API_KEY + install the @getzep/zep-js SDK
#    hindsight: clone + build ../hindsight
#    mnemosyne: clone + build ../mnemosyne
# 3. Run the per-release continuous gate (appends ONE dated row to the history ledger):
scripts/bench-memory.sh gate
```

The `gate` mode appends an immutable dated row to `benchmarks/results/history/<date>-<commit>.json` and releases the raw answer + judge transcripts alongside it. Wiring a CI `schedule:` cron to run `gate` automatically is an **operator/follow-up** step (it costs real spend — a keyless scheduled run would never produce a useful headline); the `gate` MODE itself is built + proven at $0 here (§1c is its ledger invariant).

## 5. Verdict against the PROVE gate

| Gate clause (PROVE-01/02/03) | Required | Result | Evidence |
|---|---|---|---|
| **Uniform competitor adapters; absent → skip-with-disclosure (never a number)** | built + proven | ✅ **PASS** — keyless skip, no numeric field | §1e, `adapter-conformance-report.json` |
| **letta-fs control runs keyless ($0); never the headline** | built + proven | ✅ **PASS** — `isControl:true`, control-labelled | §1e |
| **Real Comis cell drives the v2.8 lanes (not dormant)** | proven | ✅ **PASS** — real recall pipeline returned ranked results | §1f, `head-to-head-report.json` |
| **Cross-judge spread survival fold** | built + proven | ✅ **PASS** — 3/4 survive; 15pt flagged unstable | §1a, `cross-judge-spread.json` |
| **N + statistical significance (Wilson CI + two-proportion)** | built + proven | ✅ **PASS** — n-dependence; never-NaN | §1b |
| **Append-only, never-overwrite results ledger** | built + proven | ✅ **PASS** — 2nd same-path write refused, prior bytes intact | §1c |
| **Ablation toggle per v2.8 factor (off = byte-identity)** | built + proven | ✅ **PASS** — all 5 factors byte-identical OFF | §1d, `ablation-contribution-report.json` |
| **Per-release continuous gate entry point** | built + proven at $0 | ✅ **PASS** — `bench-memory.sh gate` | §4 |
| **The actual competitor numbers + the cross-JUDGED headline spread** | measured | ⏳ **NOT MEASURED** — operator costed re-run | §3, §4, `run-provenance.json` |

### VERDICT: PARTIAL

- **The proving MACHINE is MEASURED and PASSES, keyless at $0** — the cross-judge fold, the significance layer, the never-overwrite ledger, the off=byte-identity ablation sweep, the skip-with-disclosure adapters, the letta-fs control, and a real Comis recall cell with the v2.8 lanes ON all run deterministically with no key and no provider call (7/7 in `head-to-head.bench.test.ts`).
- **The per-release continuous gate is built + proven at $0** (`bench-memory.sh gate`; the append-only never-overwrite ledger is its invariant).
- **The ACTUAL competitor numbers + the cross-JUDGED headline spread are NOT MEASURED** — they require the operator-costed re-run (keys + competitor installs + LLM judge spend). That is the home for the KG-05 / REASON-05 / IQ-04 deferred QA lifts, with the exact one-command reproduction in §4.

**Honest-benchmarking note (P10):** no competitor number, no cross-judged delta, and no "X" framing of a comparison appears anywhere in this manifest — the believable machine is proven before any spend, and the headline number is honestly deferred rather than guessed (the COI + the OSS-licensed harness + the raw-transcript-release mechanism are recorded in `run-provenance.json`).

## Files in this manifest

| File | Provides |
|---|---|
| `GATE-REPORT.md` | this report — what was measured at $0, why the headline is deferred, the verdict, the reproduction command |
| `head-to-head-report.json` | the machine's manifest: the keyless claims + the verdict + the COI block |
| `cross-judge-spread.json` | the survival fold over the injected verdicts (3/4 survive; 15pt flagged) |
| `ablation-contribution-report.json` | the off=byte-identity + per-factor sweep (all 5 factors, verified leaves) |
| `adapter-conformance-report.json` | the skip-with-disclosure + letta-fs control wiring proof |
| `run-provenance.json` | commit, branch, models, what was measured vs deferred, the COI / OSS-license / transcript-release fields, the honesty protocol |
