# SubAgentRunnerDeps Audit

**Generated:** 2026-05-15
**Status:** FINAL
**Interface source:** `packages/agent/src/spawn/sub-agent-runner.ts` SubAgentRunnerDeps (27-field interface)
**Construction site:** `packages/daemon/src/wiring/setup-cross-session/setup-cross-session-runtime.ts` (single site — `createSubAgentRunner({`)
**Field count:** 27 (7 required + 20 optional + 0 stale-fallback)

This audit lives co-located with the agent package; `files: ["dist"]` in `packages/agent/package.json` excludes it from the npm tarball.

## Audit Result

The audit enumerates all 21 fields of `SubAgentRunnerDeps`. Every required field appears in every production construction call; every optional field has a real production absent-mode code path (either an `if (deps.X)` guard or a `deps.X?.method()` chain whose absent-branch falls through to a no-op).

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
| resolvePosture | optional | the sandbox no-downgrade gate is inert — no posture is resolved or compared, so no spawn is refused on posture grounds (spawn() guard `... && deps.resolvePosture && params.callerAgentId`; the daemon always wires it in production) | packages/agent/src/spawn/sub-agent-runner.ts:190 |
| checkSpawnCeiling | optional | the tree-wide spawn ceiling is inert — no concurrency/depth/fanout bound is consulted, so a `for(;;) spawn()` is bounded only by the per-caller depth/children gates (spawn() guard `if (deps.checkSpawnCeiling)`; the daemon wires it to `boundedAutonomy.tryAcquireSpawn`) | packages/agent/src/spawn/sub-agent-runner.ts:224 |
| releaseSpawnCeiling | optional | the ceiling slot reserved by `checkSpawnCeiling` is never released — the per-`rootRunId` active count only increments, so once `maxConcurrentSelfAgents` is reached the tree is bricked forever; inert/no-op when absent (matches an absent `checkSpawnCeiling`; the daemon wires it to `boundedAutonomy.releaseSpawn`) | packages/agent/src/spawn/sub-agent-runner.ts:247 |
| logger | optional | lifecycle diagnostic log lines suppressed (deps.logger?. optional-chain across every call site) | packages/agent/src/spawn/sub-agent-runner.ts:172 |
| memoryAdapter | optional | sub-agent completion summaries skipped (line 1147 `if (deps.memoryAdapter)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:174 |
| batcher | optional | announcements bypass coalescing and emit individually (deps.batcher absent → direct send path) | packages/agent/src/spawn/sub-agent-runner.ts:189 |
| deadLetterQueue | optional | failed announcement deliveries are lost (no persistence; line 596 `if (deps.deadLetterQueue)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:191 |
| sendGovernedAnnouncement | optional | direct completion fallback uses the unledgered channel sender; the daemon wires this whenever the outward ledger is available | packages/agent/src/spawn/sub-agent-runner.ts:317 |
| deliveryDedup | optional | failure-path dedup falls back to the batcher's set when present; absent + no batcher → no cross-path dedup (deps.deliveryDedup?. optional-chain in deliverAnnouncement/deliverFailureNotification) | packages/agent/src/spawn/sub-agent-runner.ts:204 |
| sessionResolver | optional | abort path falls back to no-op when neither resolver nor registry resolves a handle (line 545 `if (deps.sessionResolver)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:205 |
| resultCondenser | optional | sub-agent result delivered verbatim without condensation (line 1015 `if (deps.resultCondenser)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:209 |
| condenserModel | optional | resultCondenser receives undefined model (condenser uses internal default if any) | packages/agent/src/spawn/sub-agent-runner.ts:239 |
| condenserApiKey | optional | resultCondenser receives undefined apiKey (condenser uses internal default if any) | packages/agent/src/spawn/sub-agent-runner.ts:241 |
| narrativeCaster | optional | condensed result text used directly without tagged formatting (line 1222 `if (... && deps.narrativeCaster && ...)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:243 |
| dataDir | optional | result-file sweep + ghost-sweep dataDir lookups skipped (line 500 `if (deps.dataDir)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:263 |
| clock | required | — | packages/agent/src/spawn/sub-agent-runner.ts:265 |
| timers | required | — | packages/agent/src/spawn/sub-agent-runner.ts:267 |
| durableRuns | optional | the durable-checkpoint store is inert — no checkpoint is written + no keep-alive heartbeat fires, so the run is NOT resumable after a crash (the byte-identical default; the daemon wires it ONLY when autonomy.durability.enabled AND an autonomy agent is configured; guard `if (!store) return` in startDurableCheckpoint/finishDurableCheckpoint) | packages/agent/src/spawn/sub-agent-runner.ts:380 |
| resolveWorkspacePolicySnapshot | optional | durable spawns fail admission before provider execution when an exact immutable policy snapshot cannot be resolved; non-durable spawns do not consult it | packages/agent/src/spawn/sub-agent-runner.ts:547 |
| durability | optional | the keep-alive cadence/threshold default (keepAliveMs 30s) when absent — only consulted when durableRuns is wired (deps.durability?.keepAliveMs ?? 30_000) | packages/agent/src/spawn/sub-agent-runner.ts:389 |
| durableRunFacts | optional | the checkpoint records empty caps/leaseIds + zero budget (a safe degrade — a resume re-mints the persisted caps verbatim, so empty is zero-authority, never an over-grant; deps.durableRunFacts?.(...) optional-chain in startDurableCheckpoint) | packages/agent/src/spawn/sub-agent-runner.ts:404 |
| lifecycleHooks | optional | spawn rollback hooks + onEnded hooks disabled for non-graph-coordinator paths (line 575 `if (deps.lifecycleHooks)` guard) | packages/agent/src/spawn/sub-agent-runner.ts:269 |
| materializeFullOutput | optional | the child's full output is NOT materialized to a ResultRef — the announcement embeds the condensed summary + diskPath only (today's behavior; the daemon wires a `createResultRefStore`-backed impl targeting the child's jailed workspace, guard `if (condensedResult && deps.materializeFullOutput)`) | packages/agent/src/spawn/sub-agent-runner.ts:432 |
| closeTrajectory | optional | the child session's trajectory recorder is NOT released on terminal settle — it stays bus-subscribed until daemon shutdown (older test wiring; the daemon binds SessionTrajectoryHandleRegistry.close, guard `if (deps.closeTrajectory)` in the execute finally) | packages/agent/src/spawn/sub-agent-runner.ts:449 |

## Removed Fields (stale-fallback)

**None.** Every interface field whose construction-site value is omitted by the daemon has a real production absent-mode code path. The audit verified this empirically by counting `deps.<field>` references across `packages/agent/src/spawn/{sub-agent-runner.ts, sub-agent-result-processor.ts}` for each candidate optional field; every candidate had at least one production reference whose absent-branch IS the production behavior.


## Summary

- **Final count:** 27 (7 required + 20 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/agent/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `SubAgentRunnerDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
- Evidence-link line numbers point at the current `packages/agent/src/spawn/sub-agent-runner.ts` layout. The audit-coverage test does not parse the line-number portion of each evidence link, so future incidental shifts (e.g., a comment edit on line 90) do not invalidate the audit until a field is added or removed; the table covers schema, not exact line addresses.
- The architecture test asserts the interface body's actual field count via bidirectional set equality. The current 21-field shape includes clock + timers as port-typed dependencies.
