# SessionsApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:63–100`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 23 (11 required + 12 optional + 0 stale-fallback)
**Location:** co-located with @comis/daemon package. The `files: ["dist", "bundled-skills"]` entry in `packages/daemon/package.json` excludes this doc from the npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:66 |
| agents | required | — | packages/daemon/src/api/types.ts:67 |
| costTrackers | required | — | packages/daemon/src/api/types.ts:68 |
| stepCounters | required | — | packages/daemon/src/api/types.ts:69 |
| agentDataDir | optional | session.list skips the JSONL-scan branch (`session-handlers.ts:285` `if (deps.agentDataDir)`); only sessionStore entries are returned | packages/daemon/src/api/types.ts:71 |
| defaultWorkspaceDir | required | — | packages/daemon/src/api/types.ts:73 |
| sessionStore | required | — | packages/daemon/src/api/types.ts:74 |
| crossSessionSender | required | — | packages/daemon/src/api/types.ts:88 |
| subAgentRunner | required | — | packages/daemon/src/api/types.ts:89 |
| resolveRootRunId | optional | session.spawn falls back to the runner's last-resort `root-<agentId>-<ts>` mint (no tree-stable root propagated); the daemon wires it so the spawn ceiling/kill/budget see one tree per spawn tree | packages/daemon/src/api/types.ts:96 |
| securityConfig | required | — | packages/daemon/src/api/types.ts:90 |
| tenantId | required | — | packages/daemon/src/api/types.ts:91 |
| logger | required | — | packages/daemon/src/api/types.ts:95 |
| approvalGate | optional | session.delete / session.reset skip approval-cache clearing (`session-handlers.ts:899` `deps.approvalGate?.clearApprovalCache`); no-op when absent | packages/daemon/src/api/types.ts:98 |
| summarizeSession | optional | session.search returns raw matches without an LLM-summary (`session-handlers.ts:498` gate); only fires when both `shouldSummarize` and the dep are truthy | packages/daemon/src/api/types.ts:100 |
| deliveryQueue | optional | session.history skips the deliveryStatus join (`session-read.ts` `loadPendingKeySet`); every message reported as `confirmed` when absent (no channel queue == nothing pending to mark) | packages/daemon/src/api/types.ts:102 |
| deliveryMirror | optional | session.delete, session.reset, and session.reset_conversation fail closed before deleting transcript layers; production wires the SQLite adapter or the no-op adapter, so absence means daemon startup is incomplete | packages/daemon/src/api/types.ts:109 |
| lcdStore | optional | session.reset_conversation is the only consumer; it fails CLOSED when absent (`session-archive.ts:135` `if (!deps.lcdStore) throw "LCD store not available"`) rather than silently returning 0 — absent only before full daemon init | packages/daemon/src/api/types.ts:109 |
| contextBrowse | optional | session.reset_conversation cannot resolve LCD-only live conversations that have no SessionStorePort row; when absent those references fail honestly as not found instead of clearing a guessed scope | packages/daemon/src/api/types.ts:117 |
| memoryPort | optional | session.reset_conversation `--memory` gates on it (`session-archive.ts` `if (!deps.memoryPort?.deleteBySessionKey)`); when absent the --memory flag logs a not-available WARN and clears LCD + sessionStore only (no RAG delete) — same object as MemoryApiDeps.memoryAdapter, threaded at the composition root | packages/daemon/src/api/types.ts:117 |
| consolidationStore | optional | session.reset_conversation `--memory` unlink/purge gates on it (`session-archive.ts` `if (… && deps.consolidationStore)`); when absent the consolidated-observation unlink + --purge-derived steps are skipped (the by-session memory delete itself still runs) — same instance as MemoryApiDeps.consolidationStore | packages/daemon/src/api/types.ts:122 |
| destroyRuntimeSession | optional | session.reset_conversation Layer-3 runtime destroy (without it the surviving pi runtime JSONL is re-ingested wholesale on the next turn and the forget resurrects); when absent the handler WARNs with the resurrection consequence and reports `runtimeSessionDestroyed: false` (honest degradation) — wired at the composition root from `createConversationReset(...).destroyRuntimeSession` bound to the default agent | packages/daemon/src/api/types.ts:130 |
| clearAgentSessionState | optional | session.reset_conversation / session.delete skip the executor session-state drop (`session-archive.ts` `deps.clearAgentSessionState?.(sessionKey)`); when absent the per-key executor state (tool-schema snapshots, the tool-schema strip once-gate, JIT-guide delivery, cache latches) survives until session:expired TTL — wired at the composition root to @comis/agent clearSessionState | packages/daemon/src/api/types.ts:140 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field has a verified production absent-mode code path: `agentDataDir` gates the JSONL session scan, `approvalGate` gates approval-cache clearing on session.delete/reset, `summarizeSession` gates the LLM summarization branch of session.search, `deliveryQueue` gates the deliveryStatus join, `deliveryMirror` and `lcdStore` make session.reset_conversation fail closed when absent, `contextBrowse` gates authoritative lookup of LCD-only conversations, `memoryPort` + `consolidationStore` gate the session.reset_conversation `--memory` honest reset (graceful degrade when absent), `clearAgentSessionState` gates the executor session-state drop on reset/delete (when absent the state survives until session:expired TTL), and `destroyRuntimeSession` gates the Layer-3 pi-runtime destroy on reset (when absent the handler WARNs with the resurrection consequence and reports `runtimeSessionDestroyed: false`). Daemon wires the mirror and LCD dependencies unconditionally in `buildRpcDispatchDeps`; tests use explicit no-op adapters where persistence is not under test.

## Summary

- **Pre-audit count:** 16
- **Final count:** 23 (11 required + 12 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `SessionsApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
