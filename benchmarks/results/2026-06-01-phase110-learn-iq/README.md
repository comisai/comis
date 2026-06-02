# Phase 110 LEARN-IQ — Intent-bucketed Usefulness + Citation Attribution (Tracks H1 + H3) · VERDICT: PARTIAL

One-screen summary of the keyless gate for the Phase-110 learning mechanism (LEARN-01 the per-intent usefulness bucket the recall hot path reads + the per-intent write-back · LEARN-02 the dialectic citation→FEED emit + the offline usefulness-judge scaffold shipped DEFAULT-OFF). Full detail: `GATE-REPORT.md`. Machine-readable provenance: `run-provenance.json`.

## What was measured (keyless, $0 — no answer model, no judge, no key)

Four MECHANICAL claims over the REAL production code path (a fresh `mkdtempSync` `SqliteMemoryAdapter`, the per-intent `createSqliteMemoryUsefulnessStore` over the same `getDb()` handle, and the LIVE LLM-free `createMemoryRecall`; the per-intent buckets are seeded directly via `recordUsage` — no model, no key). All PASS:

1. **Per-intent bucket drives the order** (LEARN-01) — a memory used-for-intent-X ranks HIGHER for an X-classified query than for a Y-classified query (rank 1 vs rank 2). The per-intent usefulness bucket reorders recall. (`claim1`)
2. **Default-OFF byte-identity + read-spy=0** — `feedback` OFF ⇒ recall byte-identical to a store-absent run AND `readUsefulness` is NEVER called (the cost gate). (`claim2`)
3. **Citation→FEED accrual** (LEARN-02) — a cited id's used-count increments (0→1) and its used-rate exceeds an ignored sibling's (1.0 > 0.0) — the citation attribution Plan 110-04 emits into the SHIPPED FEED write path. (`claim3`)
4. **Tenant/agent/intent isolation** — a write under (tenantA, agentA, intentX) is invisible to a foreign-tenant / foreign-agent read; the in-scope read sees it. (`claim4`)

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The recall read-side threading + the per-intent adapter's no-clobber/isolation + the dialectic citation emit are additionally RED-proven in the unit/integration suites (`memory-recall.test.ts`, `sqlite-memory-usefulness-store.test.ts`, `memory-handlers.test.ts`, `setup-memory-usefulness-wiring.test.ts`).

## What is DEFERRED

- **The costed rank-over-episodes learning-LIFT** — does the FEED loop LIFT a repeatedly-attributed gold memory's rank over N episodes (a positive, bounded lift with zero regression)? **NOT measured here** (needs the H2 bandit + a costed run over episodes + a real answer model + a cross-judge fold + the costed enablement of the offline usefulness judge). The keyless bench proves the MECHANISM at $0 but produces no lift number. **Target: Phase 111 / LEARN-04.** See `GATE-REPORT.md` §3.

## Reproduce

```
# The keyless mechanical claims (this manifest — $0, no key):
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/learning-iq.bench.test.ts
```

The costed lift requires populating the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH` + `COMIS_BENCH_ANSWER_*` + `COMIS_BENCH_JUDGE_*` — NO values recorded here), enabling the H2 re-rank + the offline usefulness judge with a real provider key, and running `learning-lift-harness.bench.test.ts` over N episodes. See `GATE-REPORT.md` §3.

## Disclosure

Comis authored this harness. No competitor number, no cross-judged accuracy delta, and no comparative-ranking claim appears in this manifest. The learning mechanism is measured only against its own mechanical invariants and the v2.9 baseline (`2026-06-01-phase106-baser/`) the recall hot path must not move when off. Apache-2.0 harness — the keyless run calls no model, no judge, no key, no provider (the per-intent buckets are seeded directly; the read makes 0 model calls). Ships DEFAULT-OFF (no committed config enables feedback or the offline usefulness judge).
