# Phase 104 PROVE — Head-to-Head Proving Machine + Continuous Gate manifest

**Date:** 2026-06-01 · **Commit:** `56d0f473` · **Harness commit:** `db8ba5b3` · **Branch:** `v2.8-prove-climb`

The PROVE manifest for Phase 104 (Track J — head-to-head + continuous gate). Diffed against `../2026-05-31-j1-baseline/`.

## Verdict: **PARTIAL** (see `GATE-REPORT.md`)

- The proving **MACHINE** is **MEASURED to run keyless at $0** — the cross-judge survival fold, the Wilson CI + two-proportion significance, the append-only **never-overwrite** ledger, the **off=byte-identity** ablation sweep (all 5 v2.8 factors), the **skip-with-disclosure** competitor adapters, the **letta-fs control**, and a **real Comis recall cell with the v2.8 lanes ON** all run deterministically with no key and no provider call (7/7 in `head-to-head.bench.test.ts`).
- The per-release **continuous gate** (`scripts/bench-memory.sh gate`) is **built + proven at $0**; its invariant is the append-only never-overwrite ledger.
- The **actual competitor numbers** + the **cross-JUDGED headline spread** are **NOT MEASURED** — they require the operator-costed re-run (keys + competitor installs + LLM judge spend). That is the home for the KG-05 / REASON-05 / IQ-04 deferred QA lifts. See `GATE-REPORT.md` §3–4.

No competitor number, no cross-judged delta, and no "X" comparison framing appears in this manifest — the believable machine is proven before any spend, and the headline number is honestly deferred rather than guessed.

## Files

| File | Provides |
|---|---|
| `GATE-REPORT.md` | the gate report: the $0-measured claims, why the headline is deferred, the PARTIAL verdict, the reproduction command |
| `head-to-head-report.json` | the machine's manifest: the keyless claims + the verdict + the COI block |
| `cross-judge-spread.json` | the survival fold over the injected verdicts (3/4 survive; the 15pt category flagged unstable) |
| `ablation-contribution-report.json` | the off=byte-identity + per-factor sweep (all 5 v2.8 factors, verified knob leaves) |
| `adapter-conformance-report.json` | the skip-with-disclosure (no fabricated number) + the letta-fs control wiring proof |
| `run-provenance.json` | commit, branch, models, what was measured vs deferred, the COI / OSS-license / raw-transcript-release fields, the honesty protocol |

## Reproduce

```bash
# Keyless — no API key, no cost. Proves the whole machine at $0 (7/7 green).
SKIP_BUILD=1 scripts/bench-memory.sh head-to-head
# (or directly:)
COMIS_BENCH=1 \
  COMIS_PROVE_REPORT_DIR="$PWD/benchmarks/results/2026-06-01-phase104-prove" \
  pnpm exec vitest run packages/agent/src/memory/benchmark/head-to-head.bench.test.ts
```

The **costed** head-to-head (real competitor installs + keys + ≥2 LLM judges) is `scripts/bench-memory.sh gate` with a populated `scripts/bench-memory.env` — see `GATE-REPORT.md` §4. Every number in `GATE-REPORT.md` traces to a JSON in this directory (read back + asserted before quoting). No competitor number or cross-judged delta is quoted that was not produced by a real `invalid==0` run — both are explicitly "not measured — operator costed re-run".
