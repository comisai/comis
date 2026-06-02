# Phase 114 (PROVE2) — costed cross-judge proof

The v2.10 measure-first keystone. Read **`GATE-REPORT.md`** for the full report.

- **`capability-lift-report.json`** — machine-readable manifest for the per-capability
  QA-lift (PROVE2-02): Comis baseline + each recall-config capability, cross-judged.
- **`run-provenance.json`** — protocol, models, COI, the activation decision, reproduction.
- **`head-to-head-report.json`** — the competitor head-to-head (PROVE2-01); appended when
  the mem0 run completes.

**Headline (n=50, cross-judged gpt-4o + claude):** Comis as-shipped recall **98.0% / 94.0%**
(spread 4.0 pts, survives). No recall-config capability showed measured QA-lift on this
near-ceiling bench → Phase 115 flips nothing by default (measure-first). Costed: $2.71.
No "beats X" claim is made (binding constraint #8).
