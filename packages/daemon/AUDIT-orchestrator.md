# OrchestratorApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:331–381`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 19 (10 required + 9 optional + 0 stale-fallback)
**Location rationale:** Co-located with @comis/daemon package. `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes from npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| getAgentCronScheduler | required | — | packages/daemon/src/api/types.ts:217 |
| cronSchedulers | required | — | packages/daemon/src/api/types.ts:218 |
| executionTrackers | required | — | packages/daemon/src/api/types.ts:219 |
| wakeCoalescer | required | — | packages/daemon/src/api/types.ts:220 |
| graphCoordinator | optional | graph.run RPC fails with "graph coordinator unavailable"; named graph execution is disabled (read-only catalog still works via namedGraphStore) | packages/daemon/src/api/types.ts:222 |
| namedGraphStore | optional | graph.list returns an empty array; graph.run with a stored-graph reference returns "named graph not found" | packages/daemon/src/api/types.ts:224 |
| nodeTypeRegistry | optional | graph.run skips driver-config validation; bad node configs surface later at node-execution time instead of being rejected up front | packages/daemon/src/api/types.ts:228 |
| perAgentRunner | optional | heartbeat.run / heartbeat.list cannot trigger or report per-agent heartbeats; global heartbeats (if any) remain available | packages/daemon/src/api/types.ts:230 |
| globalHeartbeatConfig | optional | heartbeat.list omits the global-heartbeat config field; UI shows "not configured" | packages/daemon/src/api/types.ts:231 |
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:233 |
| tenantId | required | — | packages/daemon/src/api/types.ts:235 |
| agents | required | — | packages/daemon/src/api/types.ts:237 |
| persistDeps | optional | heartbeat config mutations are NOT persisted to config.yaml; reverts on next daemon restart (in-memory only) | packages/daemon/src/api/types.ts:239 |
| securityConfig | required | — | packages/daemon/src/api/types.ts:241 |
| logger | required | — | packages/daemon/src/api/types.ts:244 |
| dataDir | optional | graph-handlers cannot write graph-run output files to disk; runs execute in memory only and the audit trail under `<dataDir>/graph-runs/` is not produced | packages/daemon/src/api/types.ts:246 |
| subAgentRunner | required | — | packages/daemon/src/api/types.ts:248 |
| eventBus | optional | graph-handlers cannot emit the counts-only `pipeline:authored` telemetry event (TELEM-01); the small-model pipeline-authoring fleet metric stays empty (handlers otherwise function) | packages/daemon/src/api/types.ts:370 |
| getProviderCapabilityClass | optional | the per-agent `resolveCapabilityClass` wired at rpc-dispatch.ts:200 returns undefined, so every `pipeline:authored` records `capabilityClass:"unknown"` (the tier is recorded honestly, never dropped) | packages/daemon/src/api/types.ts:378 |
| leaseManager | optional | the autonomy-handlers (213-06) `lease.revoke` / `run.kill` are not registered in the dispatcher (a partial boot); a stray call hits the dispatcher's unknown-method path. Plan 07 wires the real instance at the composition root, so production always carries it | packages/daemon/src/api/types.ts:362 |
| durableRuns | optional | Phase 216 DUR-03: the revoke does NOT poison the persisted run record, so a restart could re-mint pre-revoke caps; inert when absent (the in-memory lease revoke alone still stops the live bearer — only matters once durability is enabled, which is when Plan 07 wires this) | packages/daemon/src/api/types.ts:363 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a feature-gate documented above. The graph-handler quartet (`graphCoordinator` / `namedGraphStore` / `nodeTypeRegistry` / `dataDir`) is gated together at dispatcher wiring time; tests omit each independently to exercise the degraded paths. `perAgentRunner` / `globalHeartbeatConfig` reflect optional heartbeat subsystems.

## Summary

- **Pre-audit count:** 17
- **Final count:** 19 (10 required + 9 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `OrchestratorApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
