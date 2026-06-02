# MemoryApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:105–160`
**Construction site:** `packages/daemon/src/daemon.ts` (`buildRpcDispatchDeps`)
**Field count:** 22 (7 required + 15 optional + 0 stale-fallback)
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
| contextStore | optional | dispatcher omits context handlers entirely (`context-handlers.ts:20` gate); ctx_recall / ctx_search / ctx_inspect / ctx_expand RPCs are not registered | packages/daemon/src/api/types.ts:125 |
| contextEngineConfig | optional | context handlers fall back to hardcoded recall-quota / token-cap / timeout defaults at dispatcher wiring time | packages/daemon/src/api/types.ts:126 |
| store | optional | context handlers' `deps.store.*` calls fail with TypeError if invoked; dispatcher gate keeps handlers unregistered when absent | packages/daemon/src/api/types.ts:128 |
| config | optional | context handlers' recall-quota / token-cap checks fail with TypeError if invoked; dispatcher gate keeps handlers unregistered when absent | packages/daemon/src/api/types.ts:130 |
| resolveConversationId | optional | ctx_recall and ctx_search cannot map sessionKey to conversationId (`context-handlers.ts:52`); RPCs return null | packages/daemon/src/api/types.ts:132 |
| rpcCall | optional | ctx_recall cannot self-dispatch session.spawn (`context-handlers.ts:258`); grant creation succeeds but the spawn step is skipped | packages/daemon/src/api/types.ts:134 |
| embeddingCacheStats | optional | memory.embeddingCache RPC returns null stats; dashboard/obs surfaces show "no data" | packages/daemon/src/api/types.ts:137 |
| embeddingCircuitBreakerState | optional | memory persistence operations cannot report breaker state; obs.diagnostics returns null for this field | packages/daemon/src/api/types.ts:139 |
| consolidationStore | optional | memory.observations throws "consolidation store not wired" (`memory-handlers.ts` diagnostic handler); the provenance diagnostic is unavailable until setup-memory threads the store | packages/daemon/src/api/types.ts:146 |
| entityStore | optional | memory.entities throws "entity store not wired"; the entity-graph diagnostic is unavailable until setup-memory threads the store | packages/daemon/src/api/types.ts:150 |
| recallCounters | optional | memory.recall_stats returns a zeroed counter snapshot (the gauge is process-lifetime; absent ⇒ no live counts) when wireRecallCounters has not been wired | packages/daemon/src/api/types.ts:155 |
| dataDir | optional | memory.recall_trace resolves the JSONL artifact under ~/.comis by default (safePath fallback) when no explicit data dir is threaded | packages/daemon/src/api/types.ts:160 |
| dialecticSeam | optional | memory.ask returns the abstain sentinel `{ answer:"", citations:[], abstained:true }` (the dialectic is not wired / no key) — the injected query-time synthesis seam (Plan 109-04 builds + injects it) | packages/daemon/src/api/types.ts:173 |
| buildDialecticRecall | optional | memory.ask returns the abstain sentinel (the per-agent recall factory is not wired) — Plan 109-04 supplies the createMemoryRecall builder over the daemon store set | packages/daemon/src/api/types.ts:184 |
| dialecticMaxRecall | optional | memory.ask falls back to the schema-default grounding ceiling (10) when the per-agent `dialectic.maxRecall` resolver is not wired (CR-04 — a per-agent `(agentId) => number`; the handler clamps `limit` to `[1, ceiling]`) | packages/daemon/src/api/types.ts:192 |
| onSuspiciousContent | optional | memory.ask still sanitizes + wraps recalled grounding content (CR-01) but emits no suspicious-pattern telemetry when the hook is not threaded (detection is silent; neutralization still runs) | packages/daemon/src/api/types.ts:199 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a feature-gate (context DAG, embedding pipeline, security taint scan, observability) that the daemon may omit at runtime. The context-DAG quartet (`contextStore`, `contextEngineConfig`, `store`, `config`, `resolveConversationId`, `rpcCall`) is wired together by the dispatcher gate — present-vs-absent is a binary feature switch documented in `context-handlers.ts:20`.

## Summary

- **Pre-audit count:** 18
- **Final count:** 26 (7 required + 19 optional) — +4 OBS-06 diagnostic deps (Phase 86 Plan 05: consolidationStore, entityStore, recallCounters, dataDir); +4 dialectic deps (Phase 109: dialecticSeam, buildDialecticRecall in Plan 03; dialecticMaxRecall + onSuspiciousContent in the 109 review-fix — the memory.ask handler's per-agent DoS bound + the CR-01 injection-telemetry hook)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `MemoryApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
