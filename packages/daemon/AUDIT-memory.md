# MemoryApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts` (`MemoryApiDeps`)
**Construction site:** `packages/daemon/src/daemon.ts` (`buildRpcDispatchDeps`)
**Field count:** 20 (7 required + 13 optional + 0 stale-fallback)
**Location:** Co-located with the `@comis/daemon` package. `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes from npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:109 |
| defaultWorkspaceDir | required | — | packages/daemon/src/api/types.ts:110 |
| tenantId | required | — | packages/daemon/src/api/types.ts:111 |
| workspaceDirs | required | — | packages/daemon/src/api/types.ts:112 |
| memoryApi | required | — | packages/daemon/src/api/types.ts:113 |
| memoryAdapter | required | — | packages/daemon/src/api/types.ts:114 |
| embeddingQueue | optional | memory.write skips embedding enqueue (`memory-handlers.ts:162` `if (deps.embeddingQueue)`); entries persist without vector indexing | packages/daemon/src/api/types.ts:115 |
| memoryWriteValidator | optional | memory.write skips taint scanning (`memory-handlers.ts:82` `if (deps.memoryWriteValidator)`); content is stored verbatim | packages/daemon/src/api/types.ts:117 |
| eventBus | optional | memory.write taint events are not emitted (`memory-handlers.ts:95` `deps.eventBus?.emit("security:memory_tainted")`) | packages/daemon/src/api/types.ts:120 |
| logger | required | — | packages/daemon/src/api/types.ts:123 |
| embeddingCacheStats | optional | memory.embeddingCache RPC returns null stats; dashboard/obs surfaces show "no data" | packages/daemon/src/api/types.ts:137 |
| embeddingCircuitBreakerState | optional | memory persistence operations cannot report breaker state; obs.diagnostics returns null for this field | packages/daemon/src/api/types.ts:139 |
| consolidationStore | optional | memory.observations throws "consolidation store not wired" (`memory-handlers.ts` diagnostic handler); the provenance diagnostic is unavailable until setup-memory threads the store | packages/daemon/src/api/types.ts:146 |
| entityStore | optional | memory.entities throws "entity store not wired"; the entity-graph diagnostic is unavailable until setup-memory threads the store | packages/daemon/src/api/types.ts:150 |
| recallCounters | optional | memory.recall_stats returns a zeroed counter snapshot (the gauge is process-lifetime; absent ⇒ no live counts) when wireRecallCounters has not been wired | packages/daemon/src/api/types.ts:155 |
| dataDir | optional | memory.recall_trace resolves the JSONL artifact under ~/.comis by default (safePath fallback) when no explicit data dir is threaded | packages/daemon/src/api/types.ts:160 |
| recallTraceEnabled | optional | memory.recall_trace reports the recorder gate as `tracingEnabled` and explains an empty result (recorder disabled vs no matching traces) instead of a silent `{records: []}` (live finding 2026-06-11); absent reads as false — the schema default for the opt-in recorder | packages/daemon/src/api/types.ts:199 |
| dialecticSeam | optional | memory.ask returns the abstain sentinel `{ answer:"", citations:[], abstained:true }` (the dialectic is not wired / no key) — the injected query-time synthesis seam | packages/daemon/src/api/types.ts:173 |
| buildDialecticRecall | optional | memory.ask returns the abstain sentinel (the per-agent recall factory is not wired) — the createMemoryRecall builder over the daemon store set | packages/daemon/src/api/types.ts:184 |
| dialecticMaxRecall | optional | memory.ask falls back to the schema-default grounding ceiling (10) when the per-agent `dialectic.maxRecall` resolver is not wired (a per-agent `(agentId) => number`; the handler clamps `limit` to `[1, ceiling]`) | packages/daemon/src/api/types.ts:192 |
| onSuspiciousContent | optional | memory.ask still sanitizes + wraps recalled grounding content but emits no suspicious-pattern telemetry when the hook is not threaded (detection is silent; neutralization still runs) | packages/daemon/src/api/types.ts:199 |
| lcdStore | optional | context.tree returns an empty tree (`context-handlers.ts` fail-closes `{ conversationId, nodes:[], messageCount:0 }`) when the LCD ContextStorePort is not threaded; the Context DAG browser shows no DAG until setup-memory wires it | packages/daemon/src/api/types.ts:198 |
| contextBrowse | optional | context.conversations returns an empty page (`context-handlers.ts` fail-closes `{ conversations:[], total:0 }`) when the ContextBrowsePort is not threaded; the Context DAG browser lists no conversations until setup-memory wires it | packages/daemon/src/api/types.ts:203 |

## Removed Fields

**Phase 126 Plan 03 (DAG demolition):** the context-DAG quartet — `contextStore`, `contextEngineConfig`, `store`, `config`, `resolveConversationId`, `rpcCall` (6 fields) — was removed alongside the deleted `context-handlers.ts` and the `rpc-dispatch.ts` context-handler mount. These were never a stale-fallback; they were a binary dispatcher feature-gate for the DAG `ctx_*` RPC surface, demolished in v2.12. The governed expansion surface is rebuilt fresh against the `lcd_*` store in Phase 131.

Every surviving optional field still corresponds to a live feature-gate (embedding pipeline, security taint scan, observability, memory-diagnostics, dialectic) that the daemon may omit at runtime.

## Summary

- **Final count:** 22 (7 required + 15 optional) — after the Phase-126 removal of the 6 context-DAG quartet fields and the addition of `lcdStore` + `contextBrowse` for the context.* operator-browse RPCs
- **Removed (Phase 126 Plan 03):** 6 (the context-DAG quartet, deleted with `context-handlers.ts`)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `MemoryApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
