# Phase 114 (PROVE2) — costed cross-judge proof

The v2.10 measure-first keystone. Read **`GATE-REPORT.md`** for the full report.

- **`capability-lift-report.json`** — machine-readable manifest for the per-capability
  QA-lift (PROVE2-02): Comis baseline + each recall-config capability, cross-judged.
- **`run-provenance.json`** — protocol, models, COI, the activation decision, reproduction.
- **`head-to-head-report.json`** — the competitor head-to-head (PROVE2-01), N=8 cross-judged.

**Headline — capability lift (n=50, cross-judged gpt-4o + claude):** Comis as-shipped recall
**98.0% / 94.0%** (spread 4.0, survives). No recall-config capability showed measured QA-lift
→ Phase 115 flips nothing by default (measure-first). Costed: $2.71.

**Headline — competitor head-to-head (n=8 LongMemEval, cross-judged, spread 0.0):** Comis
**87.5%** ties **mem0 87.5%** (both 7/8, indistinguishable at N=8); both beat the letta-fs
full-dump control (**50.0%**) by **+37.5 pt** (the bench discriminates). Comis's edge is
cost/latency/locality — **LLM-free recall at $0 on-device** vs mem0's paid ~53-min ingest.
Honest framing: **"competitive-with mem0 / at-$0-on-device"** — never "beats" (constraint #8).
