# Phase 107 USER — Per-user Representation (Track E1) · VERDICT: PARTIAL

One-screen summary of the keyless gate for the per-user representation feature (USER-01 SOLE adapter · USER-02 offline builder · USER-03 LLM-free `<user_profile>` injection · USER-04 daemon wiring + this gate). Full detail: `GATE-REPORT.md`. Machine-readable provenance: `run-provenance.json`.

## What was measured (keyless, $0 — no answer model, no judge, no key)

Six MECHANICAL claims over the REAL production code path (the SOLE `createSqliteUserRepresentationStore` adapter on a fresh `mkdtempSync` db, the offline `runUserRepresentationBuild` with an INJECTED stub build seam, and the pure `buildUserRepresentationBlock` LLM-free formatter). All PASS:

1. **Prefix-typing round-trips** — 4 prefix-types upserted; the scoped read returns all 4 typed. (`claim1`)
2. **External REJECTED** — a forged external-trust upsert is rejected at the write boundary; an external-only source set writes 0 rows (anti-poisoning, before the build seam). (`claim2`)
3. **Redaction-clean** — a secret-shaped candidate is flagged by `validateMemoryWrite` and SKIPPED (never down-stored; the USER Pitfall-2 hardening). (`claim3`)
4. **(tenant, agent, user) isolation** — a row under scope A is absent across all three foreign axes, present in-scope. (`claim4`)
5. **Default-OFF byte-identity** — no rows ⇒ the formatter returns null ⇒ byte-identical prompt (the cost gate). (`claim5-6`)
6. **LLM-free injection** — the read+format path makes 0 model/build calls. (`claim5-6`)

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty).

## What is DEFERRED (the operator-costed re-run)

The **LongMemEval preference-recall accuracy lift** — does the standing `<user_profile>` block raise preference-category QA accuracy under a real answer model + a cross-judge fold? — is **NOT measured here**. It needs keys + judge spend + a real cron-model builder run. The keyless bench proves the MECHANISM at $0 but produces no accuracy number. See `GATE-REPORT.md` §3–§4.

## Reproduce

```
# The keyless mechanical claims (this manifest — $0, no key):
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/user-representation-contribution.bench.test.ts
```

The costed preference-recall lift requires populating the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH`, `COMIS_BENCH_ANSWER_*`, `COMIS_BENCH_JUDGE_*` — NO values recorded here) + enabling `agents.<id>.memoryUserRepresentation.enabled`; see `GATE-REPORT.md` §4 for the one-command pointer.

## Disclosure

Comis authored this harness. No competitor number, no cross-judged accuracy delta, and no comparative-ranking claim appears in this manifest (binding constraint #8). The feature is measured only ON-vs-OFF against itself and the v2.9 baseline (`2026-06-01-phase106-baser/`) it must not move when off. Apache-2.0 harness.
