# J1 Baseline — Gap Report (BASE-02)

**Date:** 2026-06-01 · **Commit:** `af64462f` · **Branch:** `v2.8-prove-climb`
**Inputs:** `qa-report.judge-a.json` (gpt-4o) · `qa-report.judge-b.json` (gpt-4.1) · `cross-judge-spread.md` · `retrieval-metrics.json` · `run-provenance.json`
**Models:** answer = anthropic/`claude-sonnet-4-6` · judges = openai/`gpt-4o-2024-11-20` + openai/`gpt-4.1` (cross-**model**; the intended cross-provider Anthropic judge failed — BUG-004 — so cross-provider judging is deferred to Phase 104) · embedding/reranker = local (default config proven)

> **Reading rules (honesty protocol).** Every prioritization decision is driven **only by cross-judge-SURVIVING per-category numbers**. **5 of 6 LongMemEval categories survive the ≤5pt tolerance; `single-session-preference` does NOT (30 vs 45 = 15pt) and is treated as an unstable signal, not a precise figure.** `locomo` (6.7pt) and the filesystem `control` (16.3pt) also do not survive and drive nothing. QA accuracy is on a **disclosed category-stratified subset** (20 LongMemEval items/question_type = 120 of 500, + 15 LoCoMo QA); retrieval recall@k is full-set. Per-category n=20 (~±11pt SE) — the gap report makes **coarse track-level** decisions (each weak category maps to a *different* track). The full published head-to-head is Phase 104.

---

## 1. Measured baseline

| Category | n | Comis acc (A / B) | Cross-judge | Class | Targeting track → phase |
|---|---|---|---|---|---|
| single-session-user | 20 | 100 / 95 | ✅ stable | **STRONG** | reranker (shipped) → none |
| single-session-assistant | 20 | 100 / 100 | ✅ stable | **STRONG** | reranker (shipped) → none |
| knowledge-update | 20 | 75 / 75 | ✅ stable | moderate | Track F (bi-temporal KG) → **Phase 100** |
| multi-session | 20 | 60 / 65 | ✅ stable | **WEAK** | Track D (reasoning/multi-hop) → **Phase 101** |
| temporal-reasoning | 20 | 45 / 40 | ✅ stable | **WEAK (weakest stable)** | Track F (KG) + Track B2 (temporal parse) → **Phase 100 + 102** |
| single-session-preference | 20 | 30 / 45 | ❌ **unstable (15pt)** | weak-but-noisy | Track E1 — *conditional* (Open Decision 1) |
| locomo *(comparability-only)* | 15 | 93.3 / 100 | ❌ unstable | — | never headlined |

**Context rows (not decision drivers):**
- **Retrieval (FULL 500+10):** recall@1 0.573 · recall@3 0.783 · recall@5 **0.845** · MRR 0.788 · vector + rerank lanes lit.
- **Cost / latency (judge-A run, incl. control):** ≈ 15.5k tokens/query · end-to-end latency P50 **6.25s** / P95 9.97s.
- **Filesystem-baseline control:** 52.6 / 36.3 overall (vs Comis 71.1 / 73.3) — control trails Comis by ~19–37pt on the real benchmark under both judges. Its LoCoMo score is wildly judge-dependent (A: 100, *beats* Comis 93.3; B: 20, far below Comis 100) — under judge A the "trivial baseline games LoCoMo" result holds, under judge B it doesn't; the *instability* itself argues for keeping LoCoMo comparability-only.

**The cross-judge-STABLE gap is per-ability:** temporal-reasoning (40–45) and multi-session (60–65) are the weak stable axes; knowledge-update (75) is moderate; single-session (95–100) is saturated by the shipped reranker. **Preference shows a real but judge-noisy gap (30–45)** — directionally weak, but too unstable to set a precise target. All headroom is in the cross-session / temporal abilities the Supremacy tracks target.

## 2. Gap → track mapping (weak axes)

| Weak axis (measured, stable unless noted) | Why it's weak | Supremacy track | Phase |
|---|---|---|---|
| temporal-reasoning **40–45%** (stable) | no time-travel / as-of reasoning; recency-scored recall mis-orders dated facts | Track F (trust-first bi-temporal KG) + Track B2 (NL temporal parse) | **100** + **102** |
| knowledge-update **75%** (stable) | newer facts don't reliably supersede older ones at read time | Track F (single-current-truth invalidation) | **100** |
| multi-session **60–65%** (stable) | merge-only consolidation can't multi-hop across sessions | Track D (reasoning observations) | **101** |
| single-session-preference **30–45%** (UNSTABLE) | no per-user preference model; AND preference grading is judge-sensitive | Track E1 + Track D inductive | E1 *(deferred — OD1)* / **101** |

## 3. Reorder / gate of Phases 100–103 (by measured impact, stable axes only)

**Numeric order is NOT renumbered; this report is the prioritization layer each later `plan-phase` run reads.**

1. **Phase 100 — Trust-first Bi-temporal KG (Track F) — BUILD FIRST.** Targets the weakest *stable* axis (temporal-reasoning 40–45) plus knowledge-update (75), which share a root cause (time + supersession). Highest measured leverage.
2. **Phase 101 — Reasoning Observations (Track D) — BUILD SECOND.** Targets multi-session (60–65); its inductive preference-pattern path is also the in-milestone lever on the (noisy) preference gap.
3. **Phase 102 — Recall IQ: MMR + Query Understanding (B1+B2) — BUILD THIRD.** Targets temporal (NL temporal parse, complementing 100) + IE precision + abstention.
4. **Phase 103 — Principled Forgetting (Track C) — DEFER (Open Decision 3).**

## 4. Open Decisions — resolved with the measured number behind each

**Open Decision 1 — E1 (per-user representation) → DEFER to v2.9.** The preference gap is real and directionally the lowest, BUT it is **cross-judge-UNSTABLE (30 vs 45 = 15pt)** at n=20 — too noisy to justify standing up a new per-user-representation subsystem now. Phase 101's inductive observations are the in-milestone lever; Phase 99's **PrefEval** (a purpose-built preference benchmark) + a cross-provider judge in Phase 104 will give a *stable* preference number. **Verdict:** defer E1; re-evaluate against the stable post-101 / PrefEval number — promote in v2.9 if preference is then confirmed weak.

**Open Decision 2 — BEAM scope → 1M FIRST, 10M behind a stretch flag.** The J1 accuracy baseline doesn't bear on scale; this is a Phase-99 SUITE-01 scope note. **Verdict:** Phase 99 builds BEAM at 1M first; 10M is a stretch flag. (BEAM's footprint signal also feeds OD3.)

**Open Decision 3 — FORGET (Phase 103) → DEFER to v2.9.** FORGET targets footprint at scale, which the J1 *accuracy* baseline does not stress (it measures recall/QA quality, not memory growth). The footprint signal comes from Phase 99's BEAM (1M) probe. **Verdict:** provisionally defer FORGET-103; revisit after Phase-99 BEAM — build in v2.8 only if BEAM shows measured footprint pressure, else v2.9.

**Net v2.8 CLIMB scope:** build **Phase 100 → 101 → 102**; **Phase 103 deferred** (revisit post-99-BEAM); **E1 deferred** (revisit post-101 / PrefEval). Phases 99 (SUITE), 104 (PROVE), 105 (PUB) proceed as planned.

## 5. Benchmark regression-gate reference (for Phases 100–103)

Cross-judge-stable per-category numbers are the regression reference. Each CLIMB phase re-runs the suite: **no stable category regresses** beyond tolerance, **and** a target lift on the category its track targets.

| Phase | Target category | Baseline (stable, must beat) |
|---|---|---|
| 100 (KG) | temporal-reasoning / knowledge-update | 40–45% / 75% |
| 101 (REASON) | multi-session (+ preference via inductive) | 60–65% (preference 30–45, unstable) |
| 102 (IQ) | temporal / abstention / IE precision | temporal 40–45% (+ recall@5 0.845) |

Overall floor to hold: **~71% (cross-judge), recall@5 0.845.** Preference is tracked but, being cross-judge-unstable, is not a hard gate until a stable measure exists. LoCoMo stays comparability-only.
