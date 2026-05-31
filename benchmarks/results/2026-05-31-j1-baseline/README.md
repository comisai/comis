# J1 Baseline — 2026-05-31

The **first honest memory benchmark baseline** for Comis (v2.7 system, default config), measured per the milestone-v2.8 J1 protocol. This is the number the v2.8 "Prove & Climb" milestone gates on.

**Run command:** `pnpm bench:memory retrieval` (full-set recall) + the QA harness (`packages/agent/src/memory/benchmark/qa-judge-harness.bench.test.ts`) on a category-stratified subset, judge A then judge B. Secrets came only from the git-ignored `scripts/bench-memory.env`; every file in this directory is secret-free by construction (the manifest builder structurally omits credentials; a grep sweep gated the commit).

## Files

| File | What it is |
|---|---|
| `retrieval-metrics.json` | recall@1/3/5 + MRR on the **FULL** 500 LongMemEval + 10 LoCoMo (recall@5 **0.845**, MRR 0.788; vector + rerank lanes lit). |
| `qa-report.judge-a.json` | QA accuracy manifest, **judge A** (gpt-4o) — overall + per-category + tokens/query + latency + the filesystem-baseline control row. |
| `qa-report.judge-b.json` | Same, **judge B** (claude-opus-4-8) — the cross-judge pass. |
| `cross-judge-spread.md` | Per-category A-vs-B spread + the survives-both verdict (BASE-03). **All categories survive.** |
| `run-provenance.json` | Reproducibility envelope: commit, node, dataset sha256, model IDs, sample disclosure. |
| `GAP-REPORT.md` | The gap report (BASE-02): per-category → Supremacy-track map, the Phase 100–103 reorder/gate, and the three Open-Decision resolutions. |

## Headline (cross-judge-stable)

- **Comis overall:** 71.1% (judge A) / 71.9% (judge B). LongMemEval-only: 68.3% / 69.2%.
- **Per-category:** user/assistant 100% · knowledge-update 75% · multi-session 60–65% · temporal-reasoning 45% · **preference 30% (weakest).**
- **Retrieval (full set):** recall@5 0.845, MRR 0.788.

## Caveats (read before quoting any number)

- **LoCoMo is comparability-only, never a headline.** The filesystem control *beats* Comis on LoCoMo (100% vs 93.3%) — LoCoMo is gameable; that's the point of keeping it comparability-only.
- **QA accuracy is on a DISCLOSED category-stratified subset** (20 LongMemEval items × 6 categories + 15 LoCoMo QA), because full sequential grading is ~13–24h. Retrieval recall@k is full-set. The full published head-to-head vs competitors is **Phase 104 (PROVE)** — not this directory.
- This is a single-system baseline, not a "beats X" claim.
