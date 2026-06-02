# Phase 109 DIALECTIC — Grounded Cited Memory Synthesis (Tracks G + D3) · GATE REPORT · VERDICT: PARTIAL

**Date:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat` · **Keyless:** yes (no answer model, no judge, no API key, no provider call, $0)

This gate covers the `memory_ask` dialectic end-to-end: DIAL-01 (a grounded, cited NL answer over the LLM-free recall pipeline, with trust-first contradiction + mandatory abstention), DIAL-02 (opt-in / default-OFF, never on the recall hot path, answers only from trust-filtered + redacted recall output, citations are ids), and DIAL-03 (the citation→sourceId reasoning-tree chain surfaced in the recall-trace) — plus the daemon wiring (the injected query-time seam + the per-agent recall factory) and the opt-in registry gate.

The verdict is **PARTIAL** by design: the **mechanical** claims are measured here at $0, and the **costed answer-faithfulness / grounding QA-accuracy lift** (does the synthesized cited answer raise grounded-QA accuracy under a real answer model + a real judge?) is explicitly DEFERRED to the operator-costed re-run. It is kept STRICTLY SEPARATE from the keyless mechanical measurements below.

---

## §1. What was measured (keyless, $0 — the MECHANICAL claims)

Six mechanical claims over the REAL production code path — a fresh `mkdtempSync` `SqliteMemoryAdapter` (the SOLE @comis/memory adapter), the LIVE LLM-free `createMemoryRecall` pipeline, and the PURE Plan-02 synthesis core (`orderByTrust` + `assembleSynthesis` + `citationChains`) with an INJECTED deterministic STUB seam (a pure fn returning a fixed `{ abstain, answer, citedIds }` — no model, no key). All PASS.

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | **Opt-in / default-OFF** — with `dialectic.enabled` false/absent the `memory_ask` tool is ABSENT from the built tool set (the registry conditional gate filters it before build); on ⇒ present | PASS (absent when absent/false, present when on) | `claim1-optin-default-off-report.json` |
| 2 | **Recall stays LLM-free** — a full `createMemoryRecall` run over the fixture adapter makes NO model call (the pi-ai `completeSimple`/`getModel` spies record 0 invocations) | PASS (recalled=2, completeSimpleCalls=0, getModelCalls=0) | `claim2-recall-llm-free-report.json` |
| 3 | **Citations are real recalled ids** — a stub seam emitting a BOGUS id ⇒ the bogus id is dropped; the assembled citations are a subset of the recalled ids | PASS (bogusDropped, allCitationsReal) | `claim3-citations-are-real-ids-report.json` |
| 4 | **Mandatory abstention** — empty / irrelevant recall ⇒ `abstained:true` AND the stub seam is NOT called (abstain decided in CODE before any LLM call) | PASS (recalled=0, abstained=true, seamCalls=0) | `claim4-mandatory-abstention-report.json` |
| 5 | **Trust-first contradiction** — a `system` claim is ordered BEFORE a contradicting `external` claim (the HARD trust boundary — the grounding order the seam receives) | PASS (systemFirst, firstOrderedIsSystem) | `claim5-trust-first-report.json` |
| 6 | **sourceIds in the recall-trace** — the `citationChains` reasoning-tree carries the citation→sourceId chain, ids only (the memory body never leaks into the chain) | PASS (chainCount=1, sourceIdCount=2, noBodyLeak) | `claim6-sourceids-in-trace-report.json` |

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The `memory.ask` RPC handler's end-to-end composition (recall-not-search, abstain-without-seam, trust-first grounding, citations-validated, counts/ids-only logging) is additionally RED-proven in the daemon handler tests (`packages/daemon/src/api/memory-handlers.test.ts`, 8 tests) and the seam/recall-factory forward-presence belt (`packages/daemon/src/wiring/setup-dialectic.test.ts`), not only in this keyless bench.

Each row above is **mechanical, keyless, $0 — NOT a QA-accuracy lift.**

## §2. The architecture cut + security posture

- **agent↛memory cut** preserved: the synthesis core (`orderByTrust`/`assembleSynthesis`/`citationChains`) + the seam import `@comis/core` TYPES only; the `.bench.test.ts` suffix is the SOLE escape that imports `@comis/memory` to drive the real adapter. (The bench's claim-1 gate is the conditional PREDICATE replicated in-package — the agent has no `@comis/skills` edge; the REAL `memory_ask` descriptor is pinned in `tool-registry-parity.test.ts`.)
- **The dialectic runs the FULL `createMemoryRecall`, NOT `memoryApi.search`** — the latter bypasses the trust filter + redaction (the documented trap). The grounding is `orderByTrust` THEN `wrapExternalContent` (the redaction firewall): the dialectic answers only from trust-filtered + redacted recall output (DIAL-02).
- **Trust is a HARD boundary** — the higher-trust claim is presented first; a lower-trust contradiction is never blended. The parser STRIPS any model-asserted trust; trust is read from `entry.trustLevel` in CODE.
- **The apiKey is resolved BY NAME** (`secretManager.get(apiKeyName)`) and never logged; `apiKey: ""` when unresolved ⇒ the seam degrades to abstain at call time.
- **Counts/ids-only logging** — the question, the recalled memories, and the answer text are NEVER logged. The committed manifest carries only numbers + booleans + prose.

## §3. What is DEFERRED — the costed answer-faithfulness / grounding QA-accuracy lift

The costed delta — does the synthesized cited answer raise grounded-QA / answer-faithfulness accuracy under a real answer model + a cross-judge fold? — is **NOT measured here**. It needs keys + judge spend + a real cron-model synthesis run (not the keyless stub seam). The keyless bench proves the MECHANISM at $0 (grounded-only, abstaining, trust-first, citation-validated, provenance-traced) but produces no accuracy number; a fresh number here would be fabricated.

Reproduction (one pointer): populate the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH`, `COMIS_BENCH_ANSWER_*`, `COMIS_BENCH_JUDGE_*` — NO values recorded here), enable `agents.<id>.dialectic.enabled` with a real provider key, then run an answer-faithfulness / grounding QA harness over the live `memory.ask` path WITH a real cron-model seam, scoring each answer for grounding (every claim traceable to a cited recalled id) + abstention-correctness under the answer model + two judges; record per-category accuracy + N + significance + cost + latency. The existing deferred-path harness header to extend: `packages/agent/src/memory/benchmark/qa-judge-harness.bench.test.ts` (the apples-to-apples answer + LLM-judge engine):

```
COMIS_BENCH=1 <answer + judge env> pnpm exec vitest run packages/agent/src/memory/benchmark/qa-judge-harness.bench.test.ts
```

Baseline to diff against: `benchmarks/results/2026-06-01-phase106-baser/` (the v2.9 baseline the recall hot path must not move when the dialectic is off).

## §4. The verdict against the gate

**PARTIAL.** The six mechanical claims pass at $0 (the dialectic is opt-in/default-OFF, recall stays LLM-free, citations are real recalled ids, abstention is mandatory + LLM-free, trust-first is HARD, and provenance is traced ids-only). The costed answer-faithfulness lift is DEFERRED to the operator with a one-command reproduction. No accuracy number is claimed; the mechanism is proven, the lift is honestly deferred.

## §5. Reproduce the keyless gate

```
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/dialectic.bench.test.ts
```

Without `COMIS_BENCH` the suite skips cleanly (6 skipped). Optionally set `COMIS_DIALECTIC_REPORT_DIR` to this directory to refresh the `claim*-report.json` files.

## §6. Honest-benchmarking note

This is an internal regression gate measured against itself (the dialectic's own mechanical invariants) and the v2.9 baseline the recall hot path must not move when off. No competitor number, no cross-judged accuracy delta, and no comparative-ranking framing appears anywhere in this manifest. Every number traces to a committed `claim*-report.json`, read back from disk before quoting. Apache-2.0 harness; the keyless run calls no model, no judge, no key, no provider (the synthesis seam is an injected pure stub). Machine-readable provenance: `run-provenance.json`.
