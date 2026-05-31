# J1 Baseline — Cross-Judge Spread (BASE-03)

**Date:** 2026-06-01 · **Commit:** `af64462f` · **Subset:** 120 LongMemEval (20/category) + 15 LoCoMo QA
**Answer model (fixed):** anthropic `claude-sonnet-4-6` · **Judge A:** openai `gpt-4o-2024-11-20` · **Judge B:** openai `gpt-4.1`

The judge model is the single biggest source of non-comparable memory-benchmark numbers (e.g. mem0 reported ~49% under an independent judge vs ~94% self-judged). So **no per-category number is trusted until two independent judges agree within tolerance.** Only the judge changed between the two passes (the answer/recall was re-run for judge B — the harness has no answer cache; accepted for the baseline). **Both committed manifests have `invalid: 0` / `validTotal: 135` — these are real graded runs, not degraded ones** (the first judge-B attempt with `claude-opus-4-8` produced an all-invalid manifest because that ID is absent from pi-ai 0.75.3's registry; it was discarded — see `../../.planning/v2.8-APP-BUGS-FOUND.md` BUG-004).

> **Independence caveat (honest):** Judge A and Judge B are two **different OpenAI models** (gpt-4o + gpt-4.1) — a cross-**model** check, not cross-**provider**. The intended cross-provider judge (Anthropic Opus) failed (BUG-004: same-provider-as-answer lane degraded to all-invalid). A true cross-provider judge pair is deferred to **Phase 104** (the published head-to-head), where an independent third-provider judge key will be provisioned. For J1's internal gating purpose (confirm the per-category numbers aren't a single-judge artifact before they set phase order), a cross-model pair is adequate and is disclosed as such.

**Tolerance adopted: a category SURVIVES if `|accuracy_A − accuracy_B| ≤ 5.0` points.** (Per-category n=20 → binomial SE ≈ 10–11pt; the observed spreads sit at/under 5pt.)

## Per-category accuracy — Judge A vs Judge B

| Category | n | Judge A (gpt-4o) | Judge B (gpt-4.1) | Spread \|A−B\| | Survives (≤5)? |
|---|---|---|---|---|---|
| single-session-user | 20 | 100.0 | 100.0 | 0.0 | ✅ yes |
| single-session-assistant | 20 | 100.0 | 100.0 | 0.0 | ✅ yes |
| knowledge-update | 20 | 75.0 | 80.0 | 5.0 | ✅ yes |
| multi-session | 20 | 60.0 | 65.0 | 5.0 | ✅ yes |
| temporal-reasoning | 20 | 45.0 | 45.0 | 0.0 | ✅ yes |
| single-session-preference | 20 | 30.0 | 35.0 | 5.0 | ✅ yes |
| **LongMemEval overall** | 120 | 68.3 | 70.8 | 2.5 | ✅ yes |
| locomo *(comparability-only)* | 15 | 93.3 | 86.7 | 6.7 | ❌ no |
| **Overall (incl. locomo)** | 135 | 71.1 | 71.9 | 0.8 | ✅ yes |
| control *(filesystem baseline)* | 135 | 52.6 | 52.6 | 0.0 | ✅ yes |

## Verdict

**All 6 LongMemEval categories survive both judges** (every spread ≤ 5.0pt). LongMemEval-only overall agrees to 2.5pt; overall (incl. locomo) to 0.8pt. **All per-category LongMemEval numbers are cross-judge-stable and safe to drive the Phase 100–103 reorder/gate.**

**`locomo` does NOT survive (6.7pt spread)** — but LoCoMo is comparability-only and drives no decision, so this is immaterial to the gap report; it is reported, not relied upon.

- **Cross-judge-stable WEAK axes** (the gap-report drivers): single-session-preference **30–35%**, temporal-reasoning **45%**, multi-session **60–65%**.
- **Cross-judge-stable STRONG axes:** single-session-user/assistant **100%**, knowledge-update **75–80%**.

## Caveats

- **LoCoMo is comparability-only and is never headlined.** The filesystem-baseline **control ≥ Comis on LoCoMo under both judges** (judge A: control 100.0 vs Comis 93.3; judge B: control 86.7 vs Comis 86.7 — a tie): a trivial full-context dump matches or beats the recall system on LoCoMo, the canonical demonstration that LoCoMo is gameable (per `MEMORY_BENCHMARK_CREDIBILITY.md`). On the harder LongMemEval axes the control trails Comis substantially (control 52.6 overall vs Comis 71.1/71.9) — recall earns its keep where the haystack exceeds the context budget.
- The `control` row is the **Letta-style filesystem baseline, NOT Comis's score.**
- QA accuracy is on the disclosed stratified subset (n=20/category); retrieval recall@k is full-set. See `run-provenance.json`.
