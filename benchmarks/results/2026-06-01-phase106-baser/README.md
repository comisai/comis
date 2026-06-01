# Phase 106 BASER — Baseline Refresh & Gap manifest

**Date:** 2026-06-01 · **Commit:** `da3e0140` · **Branch:** `feature/v2.9-understanding-learning-moat`

The BASER manifest for Phase 106 (the proof gate that runs first). It re-states the committed v2.8 cross-judged baseline (kept STRICTLY SEPARATE from the keyless mechanical deltas), reorders/gates the CLIMB phases 107–113, and resolves the four open decisions from codebase evidence. System under test: `010d9973` (v2.8 merged via PR #146). Diffed against `../2026-05-31-j1-baseline/`.

## Verdict: **PARTIAL** (see `GATE-REPORT.md`)

- The **keyless mechanical claims** (Wave 1) are **MEASURED at $0** with **no regression** — positive recall-learning rankLift, redaction leak-rate `ON <= OFF`, the append-only never-overwrite ledger MECHANISM, off=byte-identity for all 5 v2.8 factors, and the 3/4 cross-judge fold over injected verdicts (the 15pt single-session-preference category flagged UNSTABLE). Each is "mechanical, keyless, $0 — not a QA-accuracy lift".
- The **four open decisions are RESOLVED** from cited codebase evidence: **E1 = NOT SHIPPED** (Phase 107 USER is a full build) · **H2 = conditional gate** (Phase 110/111) · **E2 = per-channel, default-OFF until a privacy-review sign-off** (SOCIAL-03) · **FORGET = decay-only** (FORGET-01; eviction FORGET-02 deferred).
- The **fresh cross-judged QA-accuracy refresh** + the **competitor head-to-head** (mem0 / zep / hindsight / mnemosyne) are **NOT MEASURED** — they require the operator-costed re-run (keys + competitor installs + LLM judge spend). See `GATE-REPORT.md` §4.

The re-stated v2.8 cross-judged numbers (overall 71.1/73.3, recall@5 0.845, temporal 45/40, single-session-preference 30/45 UNSTABLE, ~15.5k tokens/query, latency P50 6.25s/P95 9.97s, letta-fs control 52.6/36.3) are a prior costed run, re-stated — NOT re-measured this phase. No competitor number, no cross-judged delta, and no superiority-comparison framing appears in this manifest — the keyless mechanical claims + the decisions are settled at $0, and the headline refresh is honestly deferred rather than guessed.

## Files

| File | Provides |
|---|---|
| `GATE-REPORT.md` | the gap report (the keystone): the re-stated baseline (§1a) kept separate from the keyless mechanical deltas (§1b), the 107–113 reorder/gate (§2), the four decision resolutions (§3), the operator-costed deferral + reproduction (§4), the PARTIAL verdict (§5), the regression-gate reference (§6) |
| `run-provenance.json` | commit / branch / intended-models + `measurementsTaken` / `measurementsDeferredToOperatorCostedReRun` + `decisionsResolved` + the `coi` / `ossLicense` / `rawTranscriptRelease` + `honestyProtocol` block |
| `README.md` | this one-screen summary + the keyless reproduce + the costed-pass pointer |
| `keyless-run-log.md` | Wave 1 (Plan 01): the captured $0 keyless tier outcomes + the no-regression comparison vs the committed v2.8 baseline (the source of §1b) |

## Reproduce

```bash
# KEYLESS — no API key, no cost. The Wave-1 mechanical re-confirmation at $0:
SKIP_BUILD=1 bash scripts/bench-memory.sh gate                 # the never-overwrite ledger MECHANISM (tmp dir)
SKIP_BUILD=1 bash scripts/bench-memory.sh head-to-head         # the whole proving machine (cross-judge fold + ablation + control)
SKIP_BUILD=1 bash scripts/bench-memory.sh suite recall-learning # FEED-loop gold-rank lift (positive rankLift)
SKIP_BUILD=1 bash scripts/bench-memory.sh suite redaction       # privacy leak-rate (ON <= OFF)
# (run one clean `pnpm build` first; no source changed since #146, so SKIP_BUILD=1 is correct after it)
```

The **costed** cross-judged QA refresh + the competitor head-to-head (real competitor installs + keys + ≥2 LLM judges) is the operator-costed re-run — see `GATE-REPORT.md` §4 for the one-command reproduction (`scripts/bench-memory.sh gate` with a populated `scripts/bench-memory.env`). Every re-stated number in `GATE-REPORT.md` §1a traces to a committed manifest under `benchmarks/results/2026-05-31-j1-baseline/`; the keyless mechanical deltas trace to `keyless-run-log.md`; both deferred items are explicitly "not measured — operator costed re-run", never a number.
