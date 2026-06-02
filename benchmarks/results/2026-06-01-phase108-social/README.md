# Phase 108 SOCIAL — Relationship / Multi-party Modeling (Track E2) · VERDICT: PARTIAL

One-screen summary of the keyless gate for the directional relationship feature (SOCIAL-01 sole adapter + offline builder · SOCIAL-02 per-channel/tenant/agent isolation + LLM-free `<channel_relationships>` injection · SOCIAL-03 sign-off gate + the privacy-review record + daemon wiring). Full detail: `GATE-REPORT.md`. Machine-readable provenance: `run-provenance.json`. Privacy analysis: `PRIVACY-REVIEW.md`.

## What was measured (keyless, $0 — no answer model, no judge, no key)

Five MECHANICAL claims over the REAL production code path (the SOLE `createSqliteRelationshipStore` adapter on a fresh `mkdtempSync` db, the offline `runRelationshipBuild` with an INJECTED stub build seam, and the pure `buildRelationshipBlock` LLM-free formatter gated as prompt-assembly gates it). All PASS:

1. **Directional round-trip** — A→B and B→A upsert as TWO distinct edges (never symmetrized); the scoped read returns both. (`claim1`)
2. **(tenant, agent, channel) isolation** — an edge under scope A is absent cross-channel / cross-tenant / cross-agent, present in-scope (the per-channel privacy boundary). (`claim2`)
3. **External REJECTED + redaction-clean** — a forged external upsert is rejected; an external-only source set writes 0 rows; a secret-shaped candidate is blocked and never stored. (`claim3`)
4. **The SOCIAL-03 sign-off gate** — knob on but NO recorded sign-off ⇒ 0 reads + null block; enabled + signed-off ⇒ the gate opens. (`claim4`)
5. **Default-OFF byte-identity** — no rows ⇒ the formatter returns null ⇒ byte-identical prompt; 0 model/build calls on the read path. (`claim5`)

Each claim writes a confined `claim*-report.json` (pure numbers + booleans; the secret-shape sweep is empty). The cron + scheduler gate, the group-by-resolved-channelId write side, and the NULL-session-key skip are RED-proven in the daemon wiring tests (108-05).

## What is DEFERRED

- **The human privacy-review SIGN-OFF + enabling** (the SOCIAL-03 operator gate) — this run ships the capability + the three-site enforcement + `PRIVACY-REVIEW.md`, all DEFAULT-OFF, and does NOT self-approve or self-enable. No committed config sets `socialModeling.enabled` or `privacyReviewSignedOffBy`. See `PRIVACY-REVIEW.md` §6.
- **The costed multi-party Q&A accuracy lift** — does the standing `<channel_relationships>` block raise grounded multi-party Q&A accuracy under a real answer model + a cross-judge fold? **NOT measured here** (needs keys + judge spend + a real cron-model builder run). See `GATE-REPORT.md` §4.

## Reproduce

```
# The keyless mechanical claims (this manifest — $0, no key):
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/relationship-contribution.bench.test.ts
```

The costed lift requires populating the git-ignored `scripts/bench-memory.env` (variable NAMES `COMIS_BENCH`, `COMIS_BENCH_ANSWER_*`, `COMIS_BENCH_JUDGE_*` — NO values recorded here) + signing off + enabling `agents.<id>.socialModeling`; see `GATE-REPORT.md` §4.

## Disclosure

Comis authored this harness. No competitor number, no cross-judged accuracy delta, and no comparative-ranking claim appears in this manifest. The feature is measured only ON-vs-OFF against itself and the v2.9 baseline (`2026-06-01-phase106-baser/`) it must not move when off. Apache-2.0 harness.
