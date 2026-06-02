<!-- SPDX-License-Identifier: Apache-2.0 -->

# Phase 113 PROVER-01 — Keyless Re-Prove & Consolidated v2.9 Re-Prove manifest

**Date:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat`

The v2.9 capstone re-prove manifest. It re-runs the four keyless gates on the **CLIMBED v2.9 system** at **$0** (no key, no env), then consolidates the seven committed v2.9 manifests (`phase{106-baser,107-user,108-social,109-dialectic,110-learn-iq,111-learn-rank,112-forget}`) into ONE view — re-stating the v2.8 cross-judged baseline (Set A) STRICTLY SEPARATE from the v2.9 keyless mechanical deltas (Set B) + the one measured learning signal (Set C). The costed competitor head-to-head + the per-capability QA-accuracy lift are recorded as **DEFERRED** to the operator. Baseline re-stated against `../2026-05-31-j1-baseline/`.

## Verdict: **MEASURED-keyless + costed-DEFERRED** (see `GATE-REPORT.md`)

- The **four keyless re-prove modes** pass at **$0** on the climbed v2.9 system: `gate` 7/7 · `head-to-head` 7/7 · `suite recall-learning` 5/5 · `suite redaction` 2/2 — all exit 0, env-free (`scripts/bench-memory.env` was NOT sourced or created). Each is "mechanical, keyless, $0 — not a QA-accuracy lift".
- The **six v2.9 capabilities** are consolidated (Set B), each tracing to its committed manifest and tagged "mechanical, keyless, $0 — not a QA-accuracy lift": USER (per-user profile) · SOCIAL (per-channel relationship model, dormant + the sign-off gate) · DIALECTIC (the grounded cited ask-your-memory tool) · LEARN-IQ (per-intent usefulness reorder) · LEARN-RANK (a loop that learns which memories prove useful, trust frozen) · FORGET (principled ranking decay of stale memories).
- The **one measured learning signal** (Set C): a bandit-driven recall-**SCORE** lift of **+0.1** over 5 episodes (rank position **flat** on the keyless lane) — quoted verbatim from `../2026-06-01-phase111-learn-rank/claim1-bandit-rank-lift-report.json`, never rounded into "+0.1% accuracy".
- The re-stated v2.8 cross-judged numbers (overall **71.1 / 73.3**, recall@5 **0.845**, temporal 45/40, single-session-preference 30/45 UNSTABLE, ~15.5k tok/query, P50 6.25s / P95 9.97s, letta-fs control 52.6/36.3) are a prior costed run, **re-stated — NOT re-measured** this phase.
- The **costed competitor head-to-head** (mem0 / zep / hindsight / mnemosyne) + the **per-capability QA-accuracy lift** are **NOT MEASURED** — they require the operator-costed re-run (keys + competitor installs + LLM judge spend). See `GATE-REPORT.md` §3.

## Files

| File | Provides |
|---|---|
| `GATE-REPORT.md` | the consolidated report: §1 the re-stated Set A baseline kept separate from §2 the v2.9 keyless deltas (Set B) + the one measured learning signal (Set C), §3 the operator-costed deferral + the one-command reproduction, §4 the verdict against PROVER-01 |
| `run-provenance.json` | branch / intended costed-pass models + `measurementsTaken[]` / `measurementsConsolidated[]` (the seven v2.9 manifest paths) / `deferredToOperator[]` (each with a `reproductionCommand`) / `coi` / `ossLicense` / `rawTranscriptRelease` / `baselineRef` → `../2026-05-31-j1-baseline/` / `honestyProtocol` |
| `README.md` | this one-screen summary + the four keyless reproduce commands + the costed-pass pointer + the disclosure |

## Reproduce — the keyless re-prove ($0)

```bash
# KEYLESS — no API key, no cost. (Run one clean `pnpm build` first; no packages/*/src/**
# changed since #146, so SKIP_BUILD=1 is correct after it. Do NOT source scripts/bench-memory.env.)
SKIP_BUILD=1 bash scripts/bench-memory.sh gate                  # the never-overwrite ledger MECHANISM (tmp dir)
SKIP_BUILD=1 bash scripts/bench-memory.sh head-to-head          # the whole proving machine (cross-judge fold + ablation + control)
SKIP_BUILD=1 bash scripts/bench-memory.sh suite recall-learning # the FEED-loop gold-rank lift (positive rankLift)
SKIP_BUILD=1 bash scripts/bench-memory.sh suite redaction       # the privacy leak-rate (ON <= OFF)
```

The **costed** competitor head-to-head + the per-capability QA-accuracy lift (real competitor installs + keys + ≥2 LLM judges) is the operator-costed re-run — see `GATE-REPORT.md` §3 for the one-command reproduction (`scripts/bench-memory.sh gate` with a populated `scripts/bench-memory.env`). Every re-stated number in `GATE-REPORT.md` §1 traces to a committed manifest under `../2026-05-31-j1-baseline/`; the v2.9 keyless deltas trace to the seven committed v2.9 manifests; both deferred items are explicitly "not measured — operator costed re-run", never a number.
