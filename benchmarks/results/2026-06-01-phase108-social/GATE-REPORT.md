# Phase 108 SOCIAL — Relationship / Multi-party Modeling (Track E2) · GATE REPORT · VERDICT: PARTIAL

**Date:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat` · **Keyless:** yes (no answer model, no judge, no API key, no provider call, $0)

This gate covers the directional relationship feature end-to-end: SOCIAL-01 (the sole adapter + the offline directional builder), SOCIAL-02 (per-channel + per-tenant + per-agent structural isolation + the LLM-free `<channel_relationships>` injection), SOCIAL-03 (the privacy-review sign-off gate at the cron + scheduler + read, the `PRIVACY-REVIEW.md` record, default-OFF), and the daemon wiring + the `__SOCIAL_MODELING__` cron.

The verdict is **PARTIAL** by design: the **mechanical** claims are measured here at $0, and TWO things are explicitly DEFERRED — (a) the **human privacy-review sign-off + enabling** (the SOCIAL-03 operator gate, never self-approved in this run), and (b) any **costed QA-accuracy lift**. They are kept STRICTLY SEPARATE from the keyless mechanical measurements below.

---

## §1. What was measured (keyless, $0 — the MECHANICAL claims)

Five mechanical claims over the REAL production code path — the SOLE `createSqliteRelationshipStore` adapter on a fresh `mkdtempSync` db, the offline `runRelationshipBuild` with an INJECTED stub build seam (a pure fn returning fixed directional candidates, no model), and the pure `buildRelationshipBlock` LLM-free formatter gated exactly as prompt-assembly gates it. All PASS.

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | **Directional round-trip** — A→B and B→A upsert as TWO distinct edges (never symmetrized); the scoped read returns both directionally | PASS (edgeCount=2, both directions present) | `claim1-directional-report.json` |
| 2 | **(tenant, agent, channel) isolation** — an edge under scope A is ABSENT cross-channel / cross-tenant / cross-agent, PRESENT in-scope | PASS (in-scope=1, cross-channel=0, cross-tenant=0, cross-agent=0) | `claim2-isolation-report.json` |
| 3 | **External REJECTED + redaction-clean** — a forged external upsert is rejected; an external-only source set writes 0 rows; a secret-shaped candidate is blocked + never stored | PASS (external upsert rejected, external-only written=0, secret blocked, no leak) | `claim3-antipoison-report.json` |
| 4 | **The SOCIAL-03 sign-off gate (read side)** — knob on + NO sign-off ⇒ 0 reads + null block; enabled + signed-off ⇒ the gate opens, the block renders | PASS (gate closed without sign-off, 0 reads; opens with sign-off) | `claim4-signoff-gate-report.json` |
| 5 | **Default-OFF byte-identity** — no rows ⇒ the formatter returns null ⇒ byte-identical prompt; 0 model/build calls on the read path | PASS (empty⇒null, rows⇒non-null, buildCalls=0) | `claim5-offgate-report.json` |

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The cron + scheduler enforcement of the SAME sign-off dual gate, the group-by-resolved-channelId write side, and the NULL-session-key skip are RED-proven in the daemon wiring tests (108-05: `setup-channels-memory-crons.test.ts`, `setup-schedulers.test.ts`), not in this keyless bench.

Each row above is **mechanical, keyless, $0 — NOT a QA-accuracy lift.**

## §2. The architecture cut + security posture

- **agent↛memory cut** preserved: the offline builder + the injection formatter import `@comis/core` TYPES only; the `.bench.test.ts` suffix is the SOLE escape hatch that imports `@comis/memory` to drive the real adapter.
- **High-trust floor, 4 layers** (port type · DB CHECK · adapter reject · builder external-exclude) + the `validateMemoryWrite` redaction firewall (skip-not-downgrade). See `PRIVACY-REVIEW.md` §3.
- **Counts-only logging** — the relationship `content` and the directional user-id pair are never logged. The committed manifest carries only numbers + booleans + prose.

## §3. What is DEFERRED — the human privacy-review SIGN-OFF (the SOCIAL-03 operator gate)

SOCIAL-03 ships the capability + the three-site enforcement + the `PRIVACY-REVIEW.md` record, all DEFAULT-OFF. The **sign-off decision — and thus enabling — is the OPERATOR gate**, and is NOT performed in this run. No committed config sets `socialModeling.enabled` or `privacyReviewSignedOffBy` (a grep for a string-valued `privacyReviewSignedOffBy` over non-test src is empty). An operator reviews `PRIVACY-REVIEW.md`, then (if satisfied) records the sign-off + enables; the `__SOCIAL_MODELING__` cron then registers and the feature activates. See `PRIVACY-REVIEW.md` §6.

## §4. What is DEFERRED — the costed QA-accuracy lift

The costed delta (does the standing `<channel_relationships>` block raise grounded multi-party Q&A accuracy under a real answer model + a cross-judge fold?) is **NOT measured here**. It needs keys + judge spend + a real cron-model builder run to populate edges from a real high-trust multi-party source set. The keyless bench proves the MECHANISM at $0 but produces no accuracy number; a fresh number here would be fabricated.

Reproduction (one pointer): populate the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH`, `COMIS_BENCH_ANSWER_*`, `COMIS_BENCH_JUDGE_*` — NO values recorded here), sign off + enable `agents.<id>.socialModeling`, run the `__SOCIAL_MODELING__` cron with a real cron model, then run a grounded multi-party Q&A harness WITH vs WITHOUT the block under the answer model + two judges; record per-category accuracy delta + N + significance + cost + latency. Baseline to diff against: `benchmarks/results/2026-06-01-phase106-baser/`.

## §5. Reproduce the keyless gate

```
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/relationship-contribution.bench.test.ts
```

Without `COMIS_BENCH` the suite skips cleanly (5 skipped). Optionally set `COMIS_RELATIONSHIP_REPORT_DIR` to this directory to refresh the `claim*-report.json` files.

## §6. Honest-benchmarking note

This is an internal regression gate measured against itself (ON vs OFF mechanics) and the v2.9 baseline it must not move when off. No competitor number, no cross-judged accuracy delta, and no comparative-ranking framing appears anywhere in this manifest. Every number traces to a committed `claim*-report.json`, read back from disk before quoting. Apache-2.0 harness; the keyless run calls no model, no judge, no key, no provider. Machine-readable provenance: `run-provenance.json`. Privacy analysis: `PRIVACY-REVIEW.md`.
