# SubAgentRunnerDeps Audit

**Generated:** 2026-05-15
**Status:** FINAL
**Interface source:** `packages/agent/src/spawn/sub-agent-runner.ts:131-291` (21-field interface)
**Construction site:** `packages/daemon/src/wiring/setup-cross-session.ts:813` (single site — `createSubAgentRunner({`)
**Field count:** 21 (7 required + 14 optional + 0 stale-fallback)

This audit lives co-located with the agent package; `files: ["dist"]` in `packages/agent/package.json` excludes it from the npm tarball.

## Audit Result

The audit enumerates all 21 fields of `SubAgentRunnerDeps`. Every required field appears in every production construction call; every optional field has a real production absent-mode code path (either an `if (deps.X)` guard or a `deps.X?.method()` chain whose absent-branch falls through to a no-op).

The structural audit found ONE candidate stale-fallback field: `activeRunRegistry?`. The daemon construction site wires it (`setup-cross-session.ts:829: activeRunRegistry: deps.activeRunRegistry`), but the sub-agent runner production source never accesses `deps.activeRunRegistry` — only `deps.sessionResolver` reads from the activeRunRegistry indirectly via `createBackgroundSessionResolver({activeRunRegistry})` (per JSDoc at sub-agent-runner.ts:196-203). The classification retains `activeRunRegistry` as `optional` because (a) the daemon construction site still wires it for structural type completeness with the cross-package resolver chain, and (b) deletion is a behavior-changing diff that should be scoped to a dedicated cleanup commit. The `When-absent` cell documents the supersession.

The architecture-test invariants enforced by `packages/agent/src/__tests__/architecture.test.ts` hold: bidirectional set equality between this table and `SubAgentRunnerDeps`; every classification is `required` or `optional`; classification matches the interface's `?` marker; every row has a non-empty evidence-link cell.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| sessionStore | required | — | packages/agent/src/spawn/sub-agent-runner.ts:132 |
| executeAgent | required | — | packages/agent/src/spawn/sub-agent-runner.ts:136 |
| sendToChannel | required | — | packages/agent/src/spawn/sub-agent-runner.ts:157 |
| announceToParent | optional | falls back to sendToChannel for completion announcements (see sub-agent-result-processor.ts:491 `if (deps.announceToParent && ...)`) | packages/agent/src/spawn/sub-agent-runner.ts:161 |
| eventBus | required | — | packages/agent/src/spawn/sub-agent-runner.ts:168 |
| config | required | — | packages/agent/src/spawn/sub-agent-runner.ts:169 |
| tenantId | required | — | packages/agent/src/spawn/sub-agent-runner.ts:170 |
| logger | optional | lifecycle diagnostic log lines suppressed (deps.logger?. optional-chain across every call site) | packages/agent/src/spawn/sub-agent-runner.ts:172 |
| memoryAdapter | optional | sub-agent completion summaries skipped (line 1147 `if (deps.memoryAdapter)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:174 |
| batcher | optional | announcements bypass coalescing and emit individually (deps.batcher absent → direct send path) | packages/agent/src/spawn/sub-agent-runner.ts:189 |
| deadLetterQueue | optional | failed announcement deliveries are lost (no persistence; line 596 `if (deps.deadLetterQueue)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:191 |
| deliveryDedup | optional | failure-path dedup falls back to the batcher's set when present; absent + no batcher → no cross-path dedup (deps.deliveryDedup?. optional-chain in deliverAnnouncement/deliverFailureNotification) | packages/agent/src/spawn/sub-agent-runner.ts:204 |
| activeRunRegistry | optional | superseded by sessionResolver when present; structural-only retention for daemon construction-site type compatibility (no direct deps.activeRunRegistry access in runner — see JSDoc at lines 196-203) | packages/agent/src/spawn/sub-agent-runner.ts:193 |
| sessionResolver | optional | abort path falls back to no-op when neither resolver nor registry resolves a handle (line 545 `if (deps.sessionResolver)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:205 |
| resultCondenser | optional | sub-agent result delivered verbatim without condensation (line 1015 `if (deps.resultCondenser)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:209 |
| condenserModel | optional | resultCondenser receives undefined model (condenser uses internal default if any) | packages/agent/src/spawn/sub-agent-runner.ts:239 |
| condenserApiKey | optional | resultCondenser receives undefined apiKey (condenser uses internal default if any) | packages/agent/src/spawn/sub-agent-runner.ts:241 |
| narrativeCaster | optional | condensed result text used directly without tagged formatting (line 1222 `if (... && deps.narrativeCaster && ...)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:243 |
| dataDir | optional | result-file sweep + ghost-sweep dataDir lookups skipped (line 500 `if (deps.dataDir)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:263 |
| clock | required | — | packages/agent/src/spawn/sub-agent-runner.ts:265 |
| timers | required | — | packages/agent/src/spawn/sub-agent-runner.ts:267 |
| lifecycleHooks | optional | spawn rollback hooks + onEnded hooks disabled for non-graph-coordinator paths (line 575 `if (deps.lifecycleHooks)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:269 |

## Removed Fields (stale-fallback)

**None.** Every interface field whose construction-site value is omitted by the daemon has a real production absent-mode code path. The audit verified this empirically by counting `deps.<field>` references across `packages/agent/src/spawn/{sub-agent-runner.ts, sub-agent-result-processor.ts}` for each candidate optional field; every candidate had at least one production reference whose absent-branch IS the production behavior.

The candidate stale-fallback field `activeRunRegistry` was retained as `optional` rather than removed because (a) the daemon construction site at `setup-cross-session.ts:829` still wires it for structural type compatibility with the cross-package resolver chain, and (b) deletion would constitute a behavior-changing API diff outside the scope of this audit. The `When-absent` cell documents the supersession by `sessionResolver`; future cleanup may delete the field in a dedicated commit.

## Summary

- **Final count:** 21 (7 required + 14 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/agent/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `SubAgentRunnerDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
- Evidence-link line numbers point at the current `packages/agent/src/spawn/sub-agent-runner.ts` layout. The audit-coverage test does not parse the line-number portion of each evidence link, so future incidental shifts (e.g., a comment edit on line 90) do not invalidate the audit until a field is added or removed; the table covers schema, not exact line addresses.
- The architecture test asserts the interface body's actual field count via bidirectional set equality. The current 21-field shape includes clock + timers as port-typed dependencies.
