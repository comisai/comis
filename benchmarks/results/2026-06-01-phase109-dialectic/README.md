# Phase 109 DIALECTIC — Grounded Cited Memory Synthesis (Tracks G + D3) · VERDICT: PARTIAL

One-screen summary of the keyless gate for the `memory_ask` dialectic (DIAL-01 grounded + cited + trust-first contradiction + mandatory abstention · DIAL-02 opt-in / off-the-recall-hot-path / citations-are-ids · DIAL-03 the citation→sourceId reasoning-tree in the recall-trace · the daemon wiring + the opt-in registry gate). Full detail: `GATE-REPORT.md`. Machine-readable provenance: `run-provenance.json`.

## What was measured (keyless, $0 — no answer model, no judge, no key)

Six MECHANICAL claims over the REAL production code path (a fresh `mkdtempSync` `SqliteMemoryAdapter`, the LIVE LLM-free `createMemoryRecall`, and the PURE Plan-02 synthesis core `orderByTrust`/`assembleSynthesis`/`citationChains` with an INJECTED deterministic STUB seam — no model, no key). All PASS:

1. **Opt-in / default-OFF** — `dialectic.enabled` false/absent ⇒ `memory_ask` is ABSENT from the built tool set (the registry conditional gate); on ⇒ present. (`claim1`)
2. **Recall stays LLM-free** — a full `createMemoryRecall` run makes 0 model calls (the pi-ai spy). (`claim2`)
3. **Citations are real recalled ids** — a stub seam emitting a bogus id ⇒ dropped; citations ⊆ recalled ids. (`claim3`)
4. **Mandatory abstention** — empty / irrelevant recall ⇒ `abstained:true` AND the seam is NOT called (abstain in CODE, no LLM). (`claim4`)
5. **Trust-first contradiction** — a `system` claim is ordered before a contradicting `external` claim (the HARD trust boundary). (`claim5`)
6. **sourceIds in the recall-trace** — the citation→sourceId chain is surfaced, ids only (no body leak). (`claim6`)

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The `memory.ask` handler's end-to-end composition + the seam/recall-factory forward-presence belt are additionally RED-proven in the daemon tests (`memory-handlers.test.ts`, `setup-dialectic.test.ts`).

## What is DEFERRED

- **The costed answer-faithfulness / grounding QA-accuracy lift** — does the synthesized cited answer raise grounded-QA / answer-faithfulness accuracy under a real answer model + a cross-judge fold? **NOT measured here** (needs keys + judge spend + a real cron-model synthesis run). The keyless bench proves the MECHANISM at $0 but produces no accuracy number. See `GATE-REPORT.md` §3.

## Reproduce

```
# The keyless mechanical claims (this manifest — $0, no key):
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/dialectic.bench.test.ts
```

The costed lift requires populating the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH` + `COMIS_BENCH_ANSWER_*` + `COMIS_BENCH_JUDGE_*` — NO values recorded here) + enabling `agents.<id>.dialectic.enabled` with a real provider key; extend `qa-judge-harness.bench.test.ts`. See `GATE-REPORT.md` §3.

## Disclosure

Comis authored this harness. No competitor number, no cross-judged accuracy delta, and no comparative-ranking claim appears in this manifest. The dialectic is measured only against its own mechanical invariants and the v2.9 baseline (`2026-06-01-phase106-baser/`) the recall hot path must not move when off. Apache-2.0 harness — the keyless run calls no model, no judge, no key, no provider (the synthesis seam is an injected pure stub).
