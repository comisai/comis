<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 113 PROVER-01 — Keyless Re-Prove & Consolidated v2.9 Re-Prove Manifest

**Date:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat`
**System under test:** the CLIMBED v2.9 memory recall pipeline end-to-end (the v2.8 lanes + the six v2.9 capabilities — per-user profile, per-channel relationship model (dormant), the grounded cited ask-your-memory tool, per-intent usefulness reorder, bounded learning-to-rank with trust FROZEN, and principled ranking decay of stale memories — all DEFAULT-OFF, driven over the LIVE recall hot path at $0).
**Baseline re-stated (NOT re-measured):** `benchmarks/results/2026-05-31-j1-baseline/` (corroborated by `benchmarks/results/2026-06-01-phase104-prove/`).
**Consolidates the seven committed v2.9 manifests:** `benchmarks/results/2026-06-01-phase{106-baser,107-user,108-social,109-dialectic,110-learn-iq,111-learn-rank,112-forget}/`.
**Intended costed-pass models (this run took NO costed measurement):** answer = anthropic/`claude-sonnet-4-6` · judges = openai/`gpt-4o-2024-11-20` + openai/`gpt-4.1` (cross-**model**); cross-**provider** `claude-opus-4-8`-as-judge is the costed re-run, used only when the answer lane is non-Anthropic (BUG-004: an answerer must never be its own provider's judge).

> **Reading rules (honesty protocol).** Set A (the cross-judged QA accuracy) is a prior **costed** run, **re-stated NOT re-measured** here; it stays STRICTLY SEPARATE from the v2.9 keyless mechanical deltas. The keyless re-prove (the four modes in §2.0) re-confirms **structural invariants only** (the append-only ledger, the 3/4 fold, off=byte-identity, positive `rankLift` direction, leak-rate `ON <= OFF`) and produces **no** QA-accuracy number — a keyless run has no judge. The v2.9 deltas (Set B) are each tagged **"mechanical, keyless, $0 — not a QA-accuracy lift"**. The ONE measured *learning* signal (Set C) is the bandit-driven gold recall-**SCORE** lift **+0.1** (rank position **FLAT**) — never rounded into "+0.1% accuracy". The competitor head-to-head + the per-capability costed QA-lift are **DEFERRED** to the operator, never a guessed number.

> **VERDICT: MEASURED-keyless + costed-DEFERRED** — the four keyless re-prove modes pass at **$0** on the climbed v2.9 system, and the seven v2.9 manifests + the re-stated Set A baseline are consolidated into this one capstone view. The cross-system competitor head-to-head + the per-capability QA-accuracy lift are **NOT MEASURED** — they are the operator-costed re-run (keys + competitor installs + LLM judge spend; §3). A forced "PASS" would require quoting unmeasured costed claims, which the honesty protocol forbids. MEASURED-keyless + costed-DEFERRED with full disclosure is the correct, consistent outcome — the same shape every v2.8 and v2.9 phase reached.

This is the 8th application of the j1 / KG-05 / REASON-05 / IQ-04 / PROVE / BASER gate discipline, and the v2.9 capstone re-prove. Every re-stated number traces to a committed manifest read back from disk before quoting; every keyless delta traces to a committed `claim*-report.json`; the costed head-to-head + per-capability QA-lift are explicitly "not measured — operator costed re-run", never a guess.

---

## §1 Set A — the re-stated v2.8 cross-judged QA accuracy (the ONLY end-to-end accuracy; UNCHANGED)

Produced by a real **costed** cross-judge run on 2026-05-31 / 06-01; every row traces to `benchmarks/results/2026-05-31-j1-baseline/` (corroborated by `benchmarks/results/2026-06-01-phase104-prove/GATE-REPORT.md §2`). These are the v2.9 baseline-to-hold; they are **re-stated, NOT re-measured this phase**. The **fresh** cross-judge refresh is the operator-costed re-run (§3).

### §1a — Per-category QA accuracy (judge gpt-4o / gpt-4.1, n=20 each, disclosed category-stratified subset)

| Category | acc (A / B) | Cross-judge class | Strength |
|---|---|---|---|
| single-session-user | 100 / 95 | STABLE | STRONG |
| single-session-assistant | 100 / 100 | STABLE | STRONG |
| knowledge-update | 75 / 75 | STABLE | moderate |
| multi-session | 60 / 65 | STABLE | WEAK |
| temporal-reasoning | 45 / 40 | STABLE | weakest stable |
| single-session-preference | 30 / 45 | **UNSTABLE (15pt spread)** | weak-but-noisy — NOT a hard gate |
| locomo *(comparability-only)* | 93.3 / 100 | UNSTABLE | never headlined |
| control *(letta-fs baseline)* | 52.6 / 36.3 | — | a labelled control, never Comis's headline |

**Overall (incl. locomo, n=135):** **71.1 / 73.3** (gpt-4o / gpt-4.1; cross-judge spread **2.2pt**, stable).
**LongMemEval-only overall (n=120):** 68.3 / 70.0 (spread 1.7, stable).

### §1b — Retrieval (FULL set — recall@k / MRR)

| Metric | Value | Source (committed, re-read) |
|---|---|---|
| recall@1 | 0.5734 | `2026-05-31-j1-baseline/retrieval-metrics.json` |
| recall@3 | 0.7827 | `2026-05-31-j1-baseline/retrieval-metrics.json` |
| **recall@5** | **0.8450** | `2026-05-31-j1-baseline/retrieval-metrics.json` |
| MRR | 0.7883 | `2026-05-31-j1-baseline/retrieval-metrics.json` |

**Cost / latency:** ~15.5k tokens/query · end-to-end latency P50 **6.25s** / P95 **9.97s**.

> Set A is a prior costed run, **re-stated — NOT re-measured**. A keyless run produces no QA accuracy; a fresh accuracy number this phase would be fabricated. The fresh cross-judge refresh is the operator-costed re-run (§3).

---

## §2 Set B / C — the v2.9 keyless deltas (MEASURED at $0 — NOT QA-accuracy lifts)

### §2.0 The keyless re-prove run (this phase, $0, no env)

The four keyless modes were re-run on the CLIMBED v2.9 system. `scripts/bench-memory.env` was **NOT sourced or created** (it was parked aside so the runner's `[ -f "$ENV_FILE" ]` source line was false); `COMIS_BENCH` defaults to 1; `SKIP_BUILD=1` reused the existing `dist/`. All four exit 0 at $0.

| Keyless mode | Command | Result | What it re-confirms |
|---|---|---|---|
| `gate` | `SKIP_BUILD=1 bash scripts/bench-memory.sh gate` | **exit 0 — 7/7 PASS** | the append-only never-overwrite ledger MECHANISM over a fresh tmp dir (2nd same-path write REFUSED, prior bytes byte-identical, different-date row coexists, **NO** dated row written to `benchmarks/results/history/`) |
| `head-to-head` | `SKIP_BUILD=1 bash scripts/bench-memory.sh head-to-head` | **exit 0 — 7/7 PASS** | the whole proving machine: the cross-judge spread fold over INJECTED verdicts survives 3/4 (single-session-preference 15pt flagged UNSTABLE) + significance never-NaN + skip-with-disclosure competitor adapters (no numeric field) + the letta-fs control + a real Comis recall cell (lanes ON) |
| `suite recall-learning` | `SKIP_BUILD=1 bash scripts/bench-memory.sh suite recall-learning` | **exit 0 — 5/5 PASS** | the FEED-loop gold-rank lift harness GREEN (positive/non-regressing `rankLift` direction as FEED usefulness accrues; the Set C gold-SCORE climb; the trust-frozen / clamp / default-OFF safety claims) |
| `suite redaction` | `SKIP_BUILD=1 bash scripts/bench-memory.sh suite redaction` | **exit 0 — 2/2 PASS** | the privacy firewall: `scoreOn.leakRate <= scoreOff.leakRate` (the firewall never increases leak-rate; deterministic string check, no LLM) |

Each is **mechanical, keyless, $0 — NOT a QA-accuracy lift**. No mode calls `require_answer_judge_env`; none made an API call.

### §2.1 Set B — the six v2.9 capabilities (consolidated from the seven committed manifests)

Each phase reached the keyless-first verdict — the capability's MECHANISM **MEASURED at $0**, the costed per-capability QA-accuracy lift **DEFERRED** to the operator. Every row is tagged **"mechanical, keyless, $0 — not a QA-accuracy lift"** and is kept STRICTLY SEPARATE from §1. The capability descriptions use the safe, measured wording so this manifest can be quoted onto a swept surface.

| Capability (shipped, default-OFF) | Phase / manifest | The MEASURED keyless claim(s) | Verdict |
|---|---|---|---|
| **USER** — per-user **profile** (Track E1) | 107 / `2026-06-01-phase107-user/` | prefix-typing round-trips 4/4 (identity / preference / relationship / instruction) · external-trust upsert REJECTED at the write boundary · secret-shaped candidate BLOCKED (never down-stored) · (tenant, agent, user) 3-way isolation (cross-tenant / agent / user = 0) · default-OFF byte-identity (no rows → null block) · LLM-free read+format (0 build()/model calls) | PARTIAL |
| **SOCIAL** — per-channel **relationship model**, dormant (Track E2) | 108 / `2026-06-01-phase108-social/` | directional A→B ≠ B→A as **two distinct edges** (never symmetrized) · (tenant, agent, channel) isolation (cross-channel / tenant / agent = 0) · external REJECTED + redaction-clean · **the SOCIAL-03 sign-off gate** (knob on but no recorded sign-off ⇒ read+format gate CLOSED ⇒ 0 reads + null block; ships **DEFAULT-OFF, NOT self-enabled**) · default-OFF byte-identity | PARTIAL |
| **DIALECTIC** — the grounded cited **ask-your-memory tool** (Tracks G + D3) | 109 / `2026-06-01-phase109-dialectic/` | opt-in / default-OFF (the tool is ABSENT unless enabled) · **recall stays LLM-free** (`createMemoryRecall` = 0 model calls) · citations are real recalled ids (a bogus id is DROPPED) · mandatory abstention (empty/irrelevant recall ⇒ abstained, the synthesis seam NOT called) · trust-first contradiction (a `system` current-truth ordered BEFORE a contradicting `external` claim) · sourceIds in the recall-trace (ids-only provenance) | PARTIAL |
| **LEARN-IQ** — per-intent usefulness reorder + citation accrual (Tracks H1 + H3) | 110 / `2026-06-01-phase110-learn-iq/` | per-intent bucket reorders recall (`perIntentRankLift = 1`: a used-for-intent-X memory ranks higher for an X-query than a Y-query) · default-OFF byte-identity + `readUsefulness` spy = 0 · citation→FEED accrual (cited used-count **0 → 1**; cited used-rate **1.0 > 0.0**) · (tenant, agent, intent) isolation | PARTIAL |
| **LEARN-RANK** — a loop that learns which memories prove useful / bounded recall-rank tuning, **trust FROZEN** (Track H2) | 111 / `2026-06-01-phase111-learn-rank/` | **THE measured learning signal** (see §2.2 Set C) · trust-frozen under tuning (`trustAlpha = [0.1 ×5]`; external still dropped) · the clamp holds (±1e9 → all alphas ∈ [0,1]) · default-OFF byte-identity | **MEASURED** (learning-lift) + safety PROVEN; costed QA DEFERRED |
| **FORGET** — principled **ranking decay** of stale memories, eviction dormant (Track C) | 112 / `2026-06-01-phase112-forget/` | byte-identity at neutral importance (Δt=0 factor=1.0; ranks identical OFF / ON / absent) · **deterministic decay effect** (old 90-day ephemeral factor **0.5534545198841266** < fresh 1-day durable **0.9945726783223208**; gap **0.44111815843819413**; the decay **RANKS**, never **GATES**) · footprint unchanged when dormant (rowCount **5 → 5**; evicted 0 / demoted 0) · zero category regression | **MEASURED** (4 keyless claims); live eviction DORMANT/deferred (OD4) |

### §2.2 Set C — the ONE measured *learning* signal (stated EXACTLY, never rounded)

`[VERIFIED: benchmarks/results/2026-06-01-phase111-learn-rank/claim1-bandit-rank-lift-report.json]`

> Over **5 episodes** of the same query, the shipped LLM-free bandit climbs the tuned usefulness weight **0.125 → 0.225** (`usefulnessAlphaClimbed = true`), and that climb raises the repeatedly-attributed gold memory's **boosted recall SCORE** monotonically `[1, 1.0625, 1.075, 1.0875, 1.1]` → **`goldScoreLift = +0.1`** (`goldScoreLiftSign = MEASURED-POSITIVE`, `goldScoreNonDecreasing = true`). The gold's **rank POSITION is `MEASURED-FLAT`** (`rankLift = 0`) — on the keyless FTS-only `1/rank` lane the positional gaps are large, so a single-rank move needs the model-only fusion lane (recorded honestly, **never fabricated positive**).

**The exact publishable phrasing:** "the one measured learning signal is a bandit-driven recall-**SCORE** lift of **+0.1** over 5 episodes (rank position **flat** on the keyless lane) — the costed accuracy comparison is the deferred operator re-run." Trust stays frozen; default-OFF byte-identical. **The +0.1 is a recall-SCORE lift, NOT a QA-accuracy lift — it is never blended into §1.**

---

## §3 Deferred-to-operator (costed, NOT publishable as fact)

The cross-system competitor head-to-head + the per-capability costed QA-accuracy lift are **NOT MEASURED** this phase — they require the operator-costed re-run. They are recorded here once (rather than per-phase) with the one-command reproduction. ENV-VAR **names** only — no key values.

### §3a — What is MEASURED-keyless vs DEFERRED-costed (per track)

| Track | MEASURED keyless ($0, publishable) | DEFERRED costed (operator re-run, NOT publishable as fact) |
|---|---|---|
| USER (107) | the 6 mechanical claims | LongMemEval preference-recall accuracy lift |
| SOCIAL (108) | the 5 mechanical claims + the sign-off gate | multi-party grounded-Q&A accuracy lift |
| DIALECTIC (109) | the 6 mechanical claims | answer-faithfulness / grounding QA-accuracy lift |
| LEARN-IQ (110) | per-intent reorder + accrual + isolation | rank-over-episodes accuracy lift |
| LEARN-RANK (111) | **score-lift +0.1** + rank-FLAT + 3 safety proofs | costed cross-judge QA of the tuned-vs-static ranker |
| FORGET (112) | byte-identity + decay factor (0.553 < 0.995) + dormant footprint | QA-accuracy impact of decay-on-vs-off |
| **Cross-system head-to-head (mem0 / zep / hindsight / mnemosyne)** | — (skip-with-disclosure; mechanism only) | **the whole competitor comparison** — operator installs + keys + LLM judge spend |

### §3b — The one-command reproduction

**The keyless re-prove (this phase, $0 — anyone can reproduce):**

```bash
# KEYLESS — no API key, no cost. (Run one clean `pnpm build` first; no packages/*/src/**
# changed since #146, so SKIP_BUILD=1 is correct after it. Do NOT source scripts/bench-memory.env.)
SKIP_BUILD=1 bash scripts/bench-memory.sh gate                  # the never-overwrite ledger MECHANISM (tmp dir)
SKIP_BUILD=1 bash scripts/bench-memory.sh head-to-head          # the whole proving machine (cross-judge fold + ablation + control)
SKIP_BUILD=1 bash scripts/bench-memory.sh suite recall-learning # the FEED-loop gold-rank lift (positive rankLift)
SKIP_BUILD=1 bash scripts/bench-memory.sh suite redaction       # the privacy leak-rate (ON <= OFF)
```

**The DEFERRED costed pass (the operator step — the competitor head-to-head + per-capability QA-lift):**

```bash
# 1. Populate the git-ignored operator env (NEVER committed):
cp scripts/bench-memory.env.example scripts/bench-memory.env
#    fill COMIS_BENCH_ANSWER_* (the answer model) + COMIS_BENCH_JUDGE_* (judge #1).
#    For the cross-judge spread, run a SECOND judge pass and publish the spread.
# 2. Install the competitor systems (operator/external — NEVER a Comis dependency):
#    mem0:      set MEM0_API_KEY + install the mem0ai package
#    zep:       set ZEP_API_KEY  + install the @getzep/zep-js SDK
#    hindsight: clone + build ../hindsight
#    mnemosyne: clone + build ../mnemosyne
# 3. Run the per-release continuous gate. The COSTED pass (with the env + competitor installs
#    above) appends the real dated row to benchmarks/results/history/<date>-<commit>.json
#    and releases the raw answer + judge transcripts alongside it:
scripts/bench-memory.sh gate
```

**Deferred to this costed re-run (diff against `benchmarks/results/2026-05-31-j1-baseline/` — overall 71.1/73.3, recall@5 0.845, temporal 45/40, control 52.6/36.3):**

1. **The fresh cross-judged QA-accuracy refresh** — answering the J1 corpus with the answer model and grading with ≥2 independent judges. There is no keyless judge; a fresh accuracy number this phase would be fabricated.
2. **The competitor head-to-head (mem0 / zep / hindsight / mnemosyne)** — each competitor adapter is a skip-with-disclosure skeleton; **none is a Comis dependency**. The keyless CI always hits the skip branch (that IS the wiring proof). A vendor self-reported number is non-comparable across protocols (the COI).
3. **The per-capability costed QA-accuracy lift** — per the §3a "DEFERRED costed" column, each via `qa-judge-harness.bench.test.ts` with the capability on-vs-off, recording per-category accuracy + zero-regression + N + significance + cost + latency.

---

## §4 Verdict against the PROVER-01 gate

| PROVER-01 clause | Required | Result | Evidence |
|---|---|---|---|
| (a) re-run the keyless gates on the CLIMBED v2.9 system at $0 | keyless measured | ✅ **PASS** — gate 7/7 · head-to-head 7/7 · recall-learning 5/5 · redaction 2/2, all exit 0, env-free | §2.0 |
| (b) consolidate the 7 committed v2.9 manifests into ONE re-prove manifest | authored + committed | ✅ **PASS** — §2.1 consolidates phase106-baser + phase107..112; `measurementsConsolidated[]` lists all seven | §2.1, `run-provenance.json` |
| (c) re-state Set A STRICTLY SEPARATE from the v2.9 keyless deltas | separated | ✅ **PASS** — §1 (Set A, re-stated NOT re-measured) is its own section; §2 (Set B/C) is each labelled mechanical/keyless/$0 | §1, §2 |
| (d) the ONE measured learning number stated EXACTLY (not rounded into accuracy) | recorded verbatim | ✅ **PASS** — Set C: gold-SCORE lift +0.1 (MEASURED-POSITIVE), rank-position FLAT (rankLift 0) — never "+0.1% accuracy" | §2.2 |
| (e) the costed head-to-head + per-capability QA-lift DEFERRED with a reproduction | deferred + reproducible | ✅ **PASS** — §3 records both as DEFERRED with the one-command reproduction; `deferredToOperator[]` carries each `reproductionCommand` | §3, `run-provenance.json` |
| (f) every number traces to a committed manifest; no superiority framing; no credential shape | gated | ✅ **PASS** — every number cites a committed manifest read back from disk; no comparative-ranking framing; credential-shape sweep clean | §6, `run-provenance.json` |
| **The fresh cross-judged QA-accuracy refresh + the competitor head-to-head** | measured | ⏳ **NOT MEASURED** — operator costed re-run | §3, `run-provenance.json` |

### VERDICT: MEASURED-keyless + costed-DEFERRED

- **The keyless re-prove is MEASURED at $0** on the climbed v2.9 system (§2.0), and the seven v2.9 manifests + the re-stated Set A baseline are consolidated into this one capstone view (§1, §2.1, §2.2).
- **The cross-system competitor head-to-head + the per-capability QA-accuracy lift are NOT MEASURED** — they require the operator-costed re-run (keys + competitor installs + LLM judge spend; §3).
- A forced "PASS" would require quoting unmeasured costed claims (forbidden by the honesty protocol). MEASURED-keyless + costed-DEFERRED with full disclosure is the correct, consistent outcome — the same shape every v2.8 and v2.9 phase reached.

---

## §5 Files in this manifest

| File | Provides |
|---|---|
| `GATE-REPORT.md` | this report — §1 the re-stated Set A baseline kept separate from §2 the v2.9 keyless deltas (Set B) + the one measured learning signal (Set C), §3 the operator-costed deferral + the one-command reproduction, §4 the verdict against PROVER-01 |
| `run-provenance.json` | branch / intended costed-pass models + `measurementsTaken[]` (the four keyless outcomes) / `measurementsConsolidated[]` (the seven v2.9 manifest paths) / `deferredToOperator[]` (the costed head-to-head + per-capability QA-lift, each with a `reproductionCommand`) / `coi` / `ossLicense` / `rawTranscriptRelease` / `baselineRef` → `2026-05-31-j1-baseline/` / `honestyProtocol` |
| `README.md` | the one-screen summary + the four keyless reproduce commands + the costed-pass pointer + the disclosure |

---

## §6 Honesty footer

Every number in this consolidated manifest traces to a committed manifest, **read back from disk before quoting**:

- **Set A** (overall 71.1/73.3, recall@5 0.845, per-category, ~15.5k tok/query, P50 6.25s / P95 9.97s) is **re-stated** from `benchmarks/results/2026-05-31-j1-baseline/` (corroborated by `benchmarks/results/2026-06-01-phase104-prove/`) — a prior costed cross-judge run, **NOT re-measured** this phase.
- The keyless re-prove (§2.0) re-confirms **structural invariants only** and produces **no** QA-accuracy number.
- **Set B** (the six v2.9 capabilities) is consolidated from the seven committed v2.9 manifests; each row is **"mechanical, keyless, $0 — not a QA-accuracy lift"**.
- **Set C** (the one measured learning signal) is the bandit-driven gold recall-**SCORE** lift **+0.1** (MEASURED-POSITIVE), rank-position **FLAT** (`rankLift = 0`) — recorded with its actual sign, **never** rounded into accuracy.
- The **competitor head-to-head** + the **per-capability costed QA-accuracy lift** are explicitly **"not measured — operator costed re-run"** (§3), never a guessed delta.

No comparative-ranking framing and no credential shape appears anywhere in this manifest — the keyless claims are settled at $0, and the headline refresh is honestly deferred rather than guessed. This re-prove ships DEFAULT-OFF; `scripts/bench-memory.env` was NOT sourced or created.
