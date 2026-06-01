# J1 Baseline — Cross-Judge Spread (BASE-03)

**Date:** 2026-06-01 · **Commit:** `af64462f` · **Subset:** 120 LongMemEval (20/category) + 15 LoCoMo QA
**Answer model (fixed):** anthropic `claude-sonnet-4-6` · **Judge A:** openai `gpt-4o-2024-11-20` · **Judge B:** openai `gpt-4.1`

The judge model is the single biggest source of non-comparable memory-benchmark numbers (mem0 reported ~49% under an independent judge vs ~94% self-judged). So **no per-category number is trusted until two independent judges agree within tolerance.** Both committed manifests have **`invalid: 0` / `validTotal: 135`** — real graded runs. (The first judge-B attempt used `claude-opus-4-8` and produced an all-invalid (0/135) manifest, so it was discarded — see `../../.planning/v2.8-APP-BUGS-FOUND.md` BUG-004; the cause was the same-provider answer+judge pairing on one Anthropic key, not model resolution — the model resolved. The later `@earendil-works/pi` 0.78.0 upgrade adds `claude-opus-4-8` to pi-ai's registry.)

> **Independence caveat (honest):** Judge A and Judge B are two **different OpenAI models** (gpt-4o + gpt-4.1) — a cross-**model** check, not cross-**provider** (the intended Anthropic judge failed, BUG-004). A true cross-provider judge is deferred to **Phase 104**. A same-provider pair is a *weaker* independence test than cross-provider, so treat "survives" here as necessary-not-sufficient evidence.

**Tolerance: a category SURVIVES if `|A − B| ≤ 5.0` points.** (Per-category n=20 → binomial SE ≈ 10–11pt.)

## Per-category accuracy — Judge A vs Judge B

| Category | n | Judge A (gpt-4o) | Judge B (gpt-4.1) | Spread \|A−B\| | Survives (≤5)? |
|---|---|---|---|---|---|
| single-session-user | 20 | 100.0 | 95.0 | 5.0 | ✅ yes |
| single-session-assistant | 20 | 100.0 | 100.0 | 0.0 | ✅ yes |
| knowledge-update | 20 | 75.0 | 75.0 | 0.0 | ✅ yes |
| multi-session | 20 | 60.0 | 65.0 | 5.0 | ✅ yes |
| temporal-reasoning | 20 | 45.0 | 40.0 | 5.0 | ✅ yes |
| **single-session-preference** | 20 | 30.0 | 45.0 | **15.0** | ❌ **NO** |
| **LongMemEval overall** | 120 | 68.3 | 70.0 | 1.7 | ✅ yes |
| locomo *(comparability-only)* | 15 | 93.3 | 100.0 | 6.7 | ❌ no |
| **Overall (incl. locomo)** | 135 | 71.1 | 73.3 | 2.2 | ✅ yes |
| control *(filesystem baseline)* | 135 | 52.6 | 36.3 | 16.3 | ❌ no |

## Verdict

**5 of 6 LongMemEval categories survive** (user, assistant, knowledge-update, multi-session, temporal — all ≤5pt). LongMemEval-only overall agrees to 1.7pt; overall to 2.2pt. **These 5 are cross-judge-stable and safe to drive the Phase 100–103 reorder/gate.**

**`single-session-preference` does NOT survive (30 vs 45 = 15pt).** The two judges disagree sharply on what counts as a correct preference answer — so the preference number is **too judge-noisy to drive a hard decision**. The gap report treats it as "a real but unstable signal," not a precise figure. (This is itself a finding: preference grading is judge-sensitive — a reason PrefEval + a cross-provider judge in Phases 99/104 matter.)

**`locomo` and the `control` row do not survive either** — both are judge-dependent and neither drives a decision (LoCoMo is comparability-only; the control is a sanity baseline).

- **Cross-judge-stable WEAK axes** (gap-report drivers): temporal-reasoning **40–45%**, multi-session **60–65%**.
- **Cross-judge-stable STRONG axes:** single-session-user/assistant **95–100%**, knowledge-update **75%**.
- **Unstable (do not drive decisions):** preference (30–45), locomo (93–100), control (36–53).

## Caveats

- **LoCoMo is comparability-only and never headlined.** The filesystem-baseline control's LoCoMo score is wildly judge-dependent (judge A: control 100 > Comis 93.3 — control *beats* Comis; judge B: control 20 ≪ Comis 100). Under judge A the canonical "trivial baseline beats the recall system on LoCoMo → LoCoMo is gameable" result holds; under judge B it does not. The *instability itself* reinforces keeping LoCoMo comparability-only (its numbers are not robust). On LongMemEval the control trails Comis substantially under both judges (52.6 / 36.3 vs 71.1 / 73.3) — recall earns its keep on the real benchmark.
- The `control` row is the **Letta-style filesystem baseline, NOT Comis's score.**
- QA accuracy is on the disclosed stratified subset (n=20/category); retrieval recall@k is full-set. See `run-provenance.json`.
