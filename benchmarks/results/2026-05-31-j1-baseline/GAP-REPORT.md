# J1 Baseline — Gap Report (BASE-02)

**Date:** 2026-05-31 · **Commit:** `af64462f` · **Branch:** `v2.8-prove-climb`
**Inputs:** `qa-report.judge-a.json` (gpt-4o) · `qa-report.judge-b.json` (claude-opus-4-8) · `cross-judge-spread.md` · `retrieval-metrics.json` · `run-provenance.json`
**Models:** answer = anthropic/`claude-sonnet-4-6` · judges = openai/`gpt-4o-2024-11-20` + anthropic/`claude-opus-4-8` · embedding/reranker = local (default config proven)

> **Reading rules (honesty protocol).** Every prioritization decision below is driven **only by cross-judge-SURVIVING per-category numbers** (all categories survived the ≤5pt tolerance — see `cross-judge-spread.md`). **LoCoMo is comparability-only and never drives a decision.** QA accuracy is on a **disclosed category-stratified subset** (20 LongMemEval items/question_type = 120 of 500, + 15 LoCoMo QA); retrieval recall@k is full-set. Per-category n=20 (~±11pt SE) — the gap report makes **coarse track-level** decisions (each weak category maps to a *different* track), which the subset supports; the full published head-to-head is Phase 104.

---

## 1. Measured baseline (cross-judge-stable)

| Category | n | Comis acc (A / B) | Survives | Class (relative) | Targeting track → phase |
|---|---|---|---|---|---|
| single-session-user | 20 | 100 / 100 | ✅ | **STRONG** | reranker (already shipped) → none |
| single-session-assistant | 20 | 100 / 100 | ✅ | **STRONG** | reranker (already shipped) → none |
| knowledge-update | 20 | 75 / 75 | ✅ | moderate | Track F (bi-temporal KG) → **Phase 100** |
| multi-session | 20 | 60 / 65 | ✅ | **WEAK** | Track D (reasoning/multi-hop) → **Phase 101** |
| temporal-reasoning | 20 | 45 / 45 | ✅ | **WEAK** | Track F (KG) + Track B2 (temporal parse) → **Phase 100 + 102** |
| single-session-preference | 20 | 30 / 30 | ✅ | **WEAKEST** | Track E1 (user model) — *conditional* (Open Decision 1) |
| locomo *(comparability-only)* | 15 | 93.3 / 93.3 | ✅ | — | never headlined |

**Context rows (not decision drivers):**
- **Retrieval (FULL 500+10):** recall@1 0.573 · recall@3 0.783 · recall@5 **0.845** · MRR 0.788 · vector + rerank lanes lit.
- **Cost / latency (judge A run, incl. control):** answer ≈ 15.2k tokens/query · end-to-end latency P50 **6.25s** / P95 9.97s (recall P50 1.46s, answer P50 3.86s, judge P50 0.86s).
- **Filesystem-baseline control:** 52.6 / 53.3 overall (vs Comis 71.1 / 71.9). **On LoCoMo the control scores 100% vs Comis 93.3%** — a trivial full-context dump *beats* the recall system on LoCoMo → LoCoMo is gameable → comparability-only confirmed. On LongMemEval the control trails Comis by ~19pt (recall earns its keep where the haystack exceeds the context budget).

**The gap is per-ability, and it is real and stable:** preference (30) ≪ temporal (45) ≪ multi-session (60–65) ≪ knowledge-update (75) ≪ single-session user/assistant (100). The two strong categories (single-session) are already saturated by the shipped reranker; **all headroom is in the cross-session / temporal / preference abilities** — exactly the abilities the Supremacy tracks target.

## 2. Gap → track mapping (weak categories only)

| Weak category (measured) | Why it's weak | Supremacy track | Phase |
|---|---|---|---|
| single-session-preference **30%** | no per-user preference model; recall treats preferences as generic facts | Track E1 (per-user representation) **and** Track D inductive preference-pattern observations | E1 *(deferred — see OD1)* / **101** |
| temporal-reasoning **45%** | no time-travel / "as-of" reasoning; recency-scored recall mis-orders dated facts | Track F (trust-first bi-temporal KG) + Track B2 (NL temporal-range parse) | **100** + **102** |
| multi-session **60–65%** | merge-only consolidation can't do multi-hop across sessions | Track D (typed deductive/inductive reasoning observations) | **101** |
| knowledge-update **75%** | newer facts don't reliably supersede older ones at read time | Track F (trust-first single-current-truth invalidation) | **100** |

## 3. Reorder / gate of Phases 100–103 (by measured impact)

**Build order is set by which track targets the weakest cross-judge-stable, in-milestone-addressable category. The numeric phase order is NOT renumbered** (avoids the documented planner-overwrite hazard); this report is the authoritative prioritization layer each later `plan-phase` run reads.

1. **Phase 100 — Trust-first Bi-temporal KG (Track F) — BUILD FIRST.** Targets the two clearly-weak knowledge axes that share a root cause (time + supersession): **temporal-reasoning 45%** and **knowledge-update 75%**. Highest measured leverage.
2. **Phase 101 — Reasoning Observations (Track D) — BUILD SECOND.** Targets **multi-session 60–65%** (multi-hop) and, via its **inductive preference-pattern** path, gives the in-milestone lever on **preference 30%**.
3. **Phase 102 — Recall IQ: MMR + Query Understanding (Tracks B1+B2) — BUILD THIRD.** Targets temporal (NL temporal-range parse, complementing Phase 100) + IE precision + abstention (cross-cutting recall quality).
4. **Phase 103 — Principled Forgetting (Track C) — DEFER (see Open Decision 3).**

Numeric order 100 → 101 → 102 is unchanged; 103 is deferred. Each CLIMB phase re-measures against this baseline (§5).

## 4. Open Decisions — resolved with the measured number behind each

**Open Decision 1 — E1 (per-user representation) promotion → DEFER to v2.9 (gap acknowledged).**
The data shows a real, cross-judge-stable preference gap (single-session-preference **30%**, the weakest category), which is precisely the signal E1 watches for. However, **Track D / Phase 101's inductive observations** (behavioral/preference patterns, trust-capped ≤ `learned`) are the in-milestone lever on preference, and a dedicated per-user-representation subsystem is a large scope expansion beyond the bounded 100–103 set. **Verdict:** defer E1 to v2.9; re-evaluate against the post-Phase-101 preference number — if preference remains < ~50% after 101's inductive path, promote E1 in v2.9.

**Open Decision 2 — BEAM 1M-vs-10M scope → 1M FIRST, 10M behind a stretch flag (confirmed).**
The J1 accuracy baseline does not bear on BEAM scale; this is a Phase-99 SUITE-01 scope note. **Verdict:** Phase 99 builds the BEAM probe at **1M first**; **10M is a stretch flag**. (The footprint signal BEAM produces also feeds Open Decision 3.)

**Open Decision 3 — FORGET (Phase 103) inclusion → DEFER to v2.9 (no footprint pressure measured; revisit after Phase-99 BEAM).**
FORGET targets **footprint at scale**, which the J1 *accuracy* baseline does not stress (it measures recall/QA quality, not memory growth) — so J1 produces no signal that forgetting moves the number. The footprint-pressure signal comes from **Phase 99's BEAM (1M) probe**, not here. **Verdict:** provisionally defer FORGET-103 to v2.9; revisit the decision after Phase 99's BEAM result — build 103 in v2.8 only if BEAM (1M) shows a measured footprint/regression pressure, else it ships in v2.9.

**Net v2.8 CLIMB scope:** **Phase 100 → 101 → 102** build (in that priority order); **Phase 103 deferred** (revisit post-99-BEAM); **E1 deferred** (revisit post-101). Phases 99 (SUITE), 104 (PROVE), 105 (PUB) proceed as planned.

## 5. Benchmark regression-gate reference (for Phases 100–103)

These cross-judge-stable per-category numbers are the **regression reference**. Every CLIMB phase re-runs the suite and must show: **no category regresses** beyond the cross-judge tolerance, **and** a target lift on the category its track targets:

| Phase | Target category | Baseline (must beat) |
|---|---|---|
| 100 (KG) | temporal-reasoning / knowledge-update | 45% / 75% |
| 101 (REASON) | multi-session (+ preference via inductive) | 60–65% (preference 30%) |
| 102 (IQ) | temporal / abstention / IE precision | temporal 45% (+ recall@5 0.845) |

Overall floor to hold: **71% (cross-judge), recall@5 0.845.** LoCoMo stays comparability-only at every gate.
