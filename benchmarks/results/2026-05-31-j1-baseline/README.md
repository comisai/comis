# J1 Baseline — 2026-05-31

The **first honest memory benchmark baseline** for Comis (v2.7 system, default config), measured per the milestone-v2.8 J1 protocol. The number the v2.8 "Prove & Climb" milestone gates on.

**Run command:** `pnpm bench:memory retrieval` (full-set recall) + the QA harness (`packages/agent/src/memory/benchmark/qa-judge-harness.bench.test.ts`) on a category-stratified subset, judge A then judge B. Secrets came only from the git-ignored `scripts/bench-memory.env`; every file here is secret-free by construction (the manifest builder structurally omits credentials; a grep sweep gated the commit).

## Files

| File | What it is |
|---|---|
| `retrieval-metrics.json` | recall@1/3/5 + MRR on the **FULL** 500 LongMemEval + 10 LoCoMo (recall@5 **0.845**, MRR 0.788; vector + rerank lit). |
| `qa-report.judge-a.json` | QA accuracy manifest, **judge A** (gpt-4o) — overall + per-category + tokens/query + latency + filesystem-baseline control row. |
| `qa-report.judge-b.json` | Same, **judge B** (gpt-4.1) — the cross-judge pass (invalid:0). |
| `cross-judge-spread.md` | Per-category A-vs-B spread + survives-both verdict (BASE-03). |
| `run-provenance.json` | Reproducibility envelope: commit, node, dataset sha256, model IDs, sample disclosure. |
| `GAP-REPORT.md` | Gap report (BASE-02): per-category → Supremacy-track map, Phase 100–103 reorder/gate, the three Open-Decision resolutions. |

## Headline

- **Comis overall:** 71.1% (judge A) / 73.3% (judge B). LongMemEval-only: 68.3% / 70.0%.
- **Cross-judge-stable per-category:** user 100/95 · assistant 100/100 · knowledge-update 75/75 · multi-session 60/65 · temporal-reasoning 45/40 — **5 of 6 survive ≤5pt.**
- **single-session-preference 30/45 does NOT survive (15pt)** — a real but judge-noisy gap, treated as an unstable signal (see GAP-REPORT §4 / cross-judge-spread.md).
- **Retrieval (full set):** recall@5 0.845, MRR 0.788.

## Caveats (read before quoting any number)

- **LoCoMo is comparability-only, never a headline.** The filesystem control's LoCoMo score is wildly judge-dependent (A: 100 > Comis 93.3; B: 20 ≪ Comis 100) — its instability is itself a reason LoCoMo stays comparability-only.
- **QA accuracy is on a DISCLOSED category-stratified subset** (20 LongMemEval items × 6 categories + 15 LoCoMo QA), because full sequential grading is ~13–24h. Retrieval recall@k is full-set. The full published head-to-head vs competitors is **Phase 104 (PROVE)**.
- **Cross-judge is cross-model (both OpenAI: gpt-4o + gpt-4.1), not cross-provider** — the Anthropic judge failed (BUG-004); a true cross-provider judge is deferred to Phase 104. Same-provider agreement is weaker evidence than cross-provider.
- This is a single-system baseline, not a "beats X" claim.
