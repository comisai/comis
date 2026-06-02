# Phase 110 LEARN-IQ — Intent-bucketed Usefulness + Citation Attribution (Tracks H1 + H3) · GATE REPORT · VERDICT: PARTIAL

**Date:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat` · **Keyless:** yes (no answer model, no judge, no API key, no provider call, $0)

This gate covers the Phase-110 learning mechanism end-to-end: LEARN-01 (the per-intent usefulness bucket the recall hot path reads, LLM-free, plus the per-intent write-back the daemon subscriber drives) and LEARN-02 (the dialectic's validated citations emitted into the SHIPPED `memory:recall_used` FEED write path, plus the offline usefulness-judge scaffold shipped DEFAULT-OFF).

The verdict is **PARTIAL** by design: the **mechanical** claims are measured here at $0, and the **costed rank-over-episodes learning-LIFT** (does the FEED loop LIFT a repeatedly-attributed gold memory's rank over episodes, with zero regression?) is explicitly DEFERRED to Phase 111 / LEARN-04. It is kept STRICTLY SEPARATE from the keyless mechanical measurements below.

---

## §1. What was measured (keyless, $0 — the MECHANICAL claims)

Four mechanical claims over the REAL production code path — a fresh `mkdtempSync` `SqliteMemoryAdapter` (the SOLE @comis/memory adapter), the per-intent `createSqliteMemoryUsefulnessStore` over the SAME `getDb()` handle, and the LIVE LLM-free `createMemoryRecall` pipeline. The per-intent buckets are seeded DIRECTLY via `recordUsage` (the write path the daemon subscriber drives — Plan 110-05); no model, no judge, no key. All PASS.

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | **Per-intent bucket drives the order** (LEARN-01) — a memory used-for-intent-X (a high used-rate in the X bucket, none in the Y bucket) ranks HIGHER for an X-classified query than for a Y-classified query | PASS (mRankForUsedForIntentQuery=1 < mRankForOtherIntentQuery=2) | `claim1-per-intent-bucket-report.json` |
| 2 | **Default-OFF byte-identity + read-spy=0** (the cost gate) — with `feedback` OFF, recall is byte-identical to a store-absent run AND `readUsefulness` is NEVER called | PASS (defaultOffByteIdentical=true, readUsefulnessCalls=0) | `claim2-default-off-byte-identity-report.json` |
| 3 | **Citation→FEED accrual** (LEARN-02) — `recordUsage(usedIds=[cited], ignoredIds=[other])` then `readUsefulness` shows the cited id's used-count incremented and its used-rate higher than the ignored sibling's | PASS (citedUsedCountAfter=1, citedUsedRate=1.0 > otherUsedRate=0.0) | `claim3-citation-feed-accrual-report.json` |
| 4 | **Tenant/agent/intent isolation** — a write under (tenantA, agentA, intentX) is invisible to a foreign-tenant / foreign-agent read; the in-scope read sees it | PASS (inScopePresent=true, foreignTenantPresent=false, foreignAgentPresent=false) | `claim4-tenant-agent-intent-isolation-report.json` |

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The recall read-side per-intent threading + the default-OFF byte-identity + the citation→FEED emit + the per-intent adapter's no-clobber/isolation are additionally RED-proven in the unit/integration suites (`packages/agent/src/rag/memory-recall.test.ts`, `packages/memory/src/sqlite-memory-usefulness-store.test.ts`, `packages/daemon/src/api/memory-handlers.test.ts`, `packages/daemon/src/wiring/setup-memory-usefulness-wiring.test.ts`), not only in this keyless bench.

Each row above is **mechanical, keyless, $0 — NOT a learning-LIFT.**

## §2. The architecture cut + security posture

- **agent↛memory cut** preserved: the recall read path consumes the `MemoryUsefulnessStore` port TYPE only (it never imports @comis/memory); the `.bench.test.ts` suffix is the SOLE escape that imports @comis/memory to drive the real adapter (the blessed `recall-iq-contribution.bench.test.ts` / `learning-lift-harness.bench.test.ts` precedent).
- **The per-intent read makes NO model call** — when `feedback` + `intentReweight` are ON the read scope carries the SAME pure `classifyIntent` already computed for lane reweighting (no second classify); the recall hot path stays deterministic + LLM-free. The harness measures the OBSERVABLE rank effect and never imports `classifyIntent` (Pitfall 2).
- **(tenant, agent) is a HARD isolation boundary** — every usefulness statement filters on `(tenant_id, agent_id)`; intent is an ADDITIONAL key, never a relaxation. A write under one (tenant, agent) is structurally invisible to a read under another even when the `memory_id` is byte-identical.
- **DEFAULT-OFF cost gate** — with `feedback` OFF the usefulness read is SKIPPED entirely (the spy proves 0 reads), so the v2.9 baseline holds byte-for-byte in the shipping config and the offline usefulness judge (shipped DEFAULT-OFF) adds no call.
- **Counts/ids-only** — the usefulness layer is content-free (counts only); the question, the recalled memories, and the answer text are NEVER logged. The committed manifest carries only numbers + booleans + prose.

## §3. What is DEFERRED — the costed rank-over-episodes learning-LIFT

The costed delta — does the FEED loop LIFT a repeatedly-attributed gold memory's rank over N episodes of the same query (a positive, bounded lift with zero regression on the v2.9 baseline)? — is **NOT measured here**. It needs the H2 outcome-driven re-rank (the bandit), a costed run over episodes, a real answer model + a cross-judge fold to attribute usefulness over real answers, and the costed enablement of the offline usefulness judge (shipped DEFAULT-OFF here as a scaffold only). The keyless bench proves the MECHANISM at $0 (per-intent ordering, the default-OFF cost gate, citation accrual, isolation) but produces no learning-lift number; a fresh number here would be fabricated.

Reproduction (one pointer): populate the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH`, `COMIS_BENCH_ANSWER_*`, `COMIS_BENCH_JUDGE_*` — NO values recorded here), enable the H2 re-rank + the offline usefulness judge with a real provider key, then run the rank-over-episodes harness over N episodes of the SAME query, scoring the gold doc's per-episode rank lift (`rankLift = firstRank − lastRank`) + zero-regression + N + significance + cost + latency. The deferred-path harness to extend: `packages/agent/src/memory/benchmark/learning-lift-harness.bench.test.ts` (the rank-over-episodes FEED-loop engine):

```
COMIS_BENCH=1 <answer + judge env> pnpm exec vitest run packages/agent/src/memory/benchmark/learning-lift-harness.bench.test.ts
```

**Target phase:** Phase 111 / LEARN-04. **Baseline to diff against:** `benchmarks/results/2026-06-01-phase106-baser/` (the v2.9 baseline the recall hot path must not move when learning is off).

## §4. The verdict against the gate

**PARTIAL.** The four mechanical claims pass at $0 (the per-intent usefulness bucket drives the order, the default-OFF cost gate skips the read byte-identically with the spy at 0, the citation→FEED accrual raises a cited id's used-rate, and tenant/agent/intent isolation holds). The costed rank-over-episodes learning-LIFT is DEFERRED to Phase 111 / LEARN-04 with a one-command reproduction. No accuracy / lift number is claimed; the mechanism is proven, the lift is honestly deferred.

## §5. Reproduce the keyless gate

```
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/learning-iq.bench.test.ts
```

Without `COMIS_BENCH` the suite skips cleanly (4 skipped, exit 0). Optionally set `COMIS_LEARN_REPORT_DIR` to this directory to refresh the `claim*-report.json` files.

## §6. Honest-benchmarking note

This is an internal regression gate measured against itself (the learning mechanism's own mechanical invariants) and the v2.9 baseline the recall hot path must not move when off. No competitor number, no cross-judged accuracy delta, and no comparative-ranking framing appears anywhere in this manifest. Every number traces to a committed `claim*-report.json`, read back from disk before quoting. Apache-2.0 harness; the keyless run calls no model, no judge, no key, no provider (the per-intent buckets are seeded directly and a pure `classifyIntent` makes 0 model calls on the read path). The feature ships DEFAULT-OFF (no committed config enables feedback or the offline usefulness judge). Machine-readable provenance: `run-provenance.json`.

## §7. Files in this manifest

- `GATE-REPORT.md` — this report (VERDICT: PARTIAL).
- `README.md` — the one-screen summary.
- `run-provenance.json` — machine-readable provenance (measurementsTaken / deferredToOperator / coi / honestyProtocol).
- `claim1-per-intent-bucket-report.json` — the per-intent ordering measurement.
- `claim2-default-off-byte-identity-report.json` — the default-OFF byte-identity + read-spy=0 measurement.
- `claim3-citation-feed-accrual-report.json` — the citation→FEED accrual measurement.
- `claim4-tenant-agent-intent-isolation-report.json` — the tenant/agent/intent isolation measurement.
