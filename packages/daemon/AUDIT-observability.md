# ObservabilityApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:421–456`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 17 (5 required + 12 optional + 0 stale-fallback)
**Location:** Co-located with the `@comis/daemon` package. `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes this audit from the npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| diagnosticCollector | required | — | packages/daemon/src/api/types.ts:425 |
| billingEstimator | required | — | packages/daemon/src/api/types.ts:426 |
| channelActivityTracker | required | — | packages/daemon/src/api/types.ts:427 |
| deliveryTracer | required | — | packages/daemon/src/api/types.ts:428 |
| budgetGuards | optional | obs.budget returns an empty snapshot map; per-agent budget enforcement guards are not enumerated for the UI | packages/daemon/src/api/types.ts:429 |
| obsStore | optional | obs.usage / obs.billing historical-aggregation queries return live in-memory snapshots only; no persisted timeseries is read or written | packages/daemon/src/api/types.ts:431 |
| clock | optional | the obs.fleet.health assembler reads `deps.clock!` for the window `sinceMs`; absent in handler unit tests that pass `{}` deps, but ALWAYS populated in production from boot.clock (buildRpcDispatchDeps `clock: c.clock`) — an unwired clock throws at request time | packages/daemon/src/api/types.ts:581 |
| startupTimestamp | optional | obs.diagnostics omits the uptime field; UI shows "unknown" for daemon-uptime | packages/daemon/src/api/types.ts:432 |
| sharedCostTracker | optional | obs.reset cannot reset the shared cost tracker; only per-agent trackers are reset | packages/daemon/src/api/types.ts:433 |
| contextPipelineCollector | optional | obs.diagnostics omits the context-pipeline stage metrics; ctx_recall / ctx_search / ctx_inspect / ctx_expand throughput is invisible to operators | packages/daemon/src/api/types.ts:435 |
| eventBus | optional | obs.reset does not emit `observability:reset`; downstream observers do not learn of the counter wipe | packages/daemon/src/api/types.ts:439 |
| agents | required | — | packages/daemon/src/api/types.ts:445 |
| embeddingCacheStats | optional | memory.embeddingCache (routed through obs-handlers) returns null stats; cache-hit-rate dashboards show "no data" | packages/daemon/src/api/types.ts:449 |
| embeddingCircuitBreakerState | optional | obs.diagnostics omits the embedding-breaker state field; UI shows "unknown" for breaker health | packages/daemon/src/api/types.ts:453 |
| tokenTracker | optional | obs cache-stats RPC for token-tracker counters returns null; provider-token cache observability is disabled | packages/daemon/src/api/types.ts:456 |
| dataDir | optional | obs.trace.* handlers default to $HOME/.comis at handler-construction time; session-index scan path falls back to the home directory convention | packages/daemon/src/api/types.ts:470 |
| exportTrajectoryBundle | optional | obs.trace.export throws "exportTrajectoryBundle DI not configured" — the export RPC is unavailable until production wiring injects the bundle pipeline | packages/daemon/src/api/types.ts:477 |
| spendSnapshot | optional | obs.spend.snapshot returns `enabled:false` (no live daemon-wide spend reader wired); the WEBUI-02 live-spend headroom (ceiling − spend) is unavailable and the UI shows spend governance as off | packages/daemon/src/api/types.ts:714 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to an observability data-source whose absence collapses the affected metric to a documented null / empty / "unknown" value. None is a phantom: every consumer in `obs-handlers.ts` reads through `?.` and surfaces the absent state to the UI deterministically.

## Summary

- **Pre-audit count:** 14
- **Final count:** 18 (5 required + 13 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `ObservabilityApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
