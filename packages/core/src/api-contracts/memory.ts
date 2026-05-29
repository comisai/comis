// SPDX-License-Identifier: Apache-2.0
/**
 * Memory + context-domain RPC contracts. Mirrors the two daemon handler
 * factory files that share the `MemoryApiDeps` cluster slice:
 *
 *   - `packages/daemon/src/api/memory-handlers.ts`  (8 methods)
 *   - `packages/daemon/src/api/context-handlers.ts` (7 methods)
 *
 * Both handler files map to the SAME ApiDeps slice (`MemoryApiDeps`) and
 * so share one contract file (one contract file per logical domain
 * mirroring the `*ApiDeps` slices). The aggregator below preserves
 * per-handler grouping via `// --- xxx-handlers.ts ---` comment blocks;
 * the order within the array is documentation-only (the bidirectional
 * 1:1 test treats it as an unordered set).
 *
 * **Scope assignments** (mirror `setup-gateway-api.ts` registrations):
 *
 *   memory-handlers.ts:
 *   - `memory.search_files` (rpc) — agent-level FTS over per-agent
 *                                     workspace files. Registered via
 *                                     agent tool dispatch (not in
 *                                     setup-gateway-api.ts); contract
 *                                     carries `["rpc"]` to document the
 *                                     intended trust model.
 *   - `memory.get_file`     (rpc) — agent-level file read via safePath.
 *                                     Registered via agent tool dispatch.
 *   - `memory.store`        (admin) — setup-gateway-api.ts line 235.
 *                                      Handler ADDITIONALLY supports a
 *                                      non-admin agent path (defaults to
 *                                      `learned` trust level + agent
 *                                      attribution); the contract scope
 *                                      documents the registered gateway
 *                                      route.
 *   - `memory.stats`        (admin) — setup-gateway-api.ts line 234.
 *   - `memory.browse`       (admin) — setup-gateway-api.ts line 234.
 *   - `memory.delete`       (admin) — setup-gateway-api.ts line 234.
 *   - `memory.flush`        (admin) — setup-gateway-api.ts line 235.
 *   - `memory.export`       (admin) — setup-gateway-api.ts line 235.
 *
 *   context-handlers.ts:
 *   - `context.search`               (rpc)   — setup-gateway-api.ts:164.
 *   - `context.inspect`              (rpc)   — setup-gateway-api.ts:164.
 *   - `context.recall`               (rpc)   — setup-gateway-api.ts:164.
 *   - `context.expand`               (rpc)   — setup-gateway-api.ts:164.
 *   - `context.conversations`        (admin) — setup-gateway-api.ts:169.
 *   - `context.tree`                 (admin) — setup-gateway-api.ts:169.
 *   - `context.searchByConversation` (admin) — setup-gateway-api.ts:169.
 *
 * **Loose-record use.** Multiple response shapes carry deeply nested
 * fields with `Record<string, unknown>` or `JSON.parse(...)`-typed
 * payloads where modelling them tighter would pin the underlying wire
 * format across daemon restarts:
 *
 *   - `memory.stats.response` — `MemoryStats` is `Record<string, unknown>`
 *     at the leaf (the underlying impl returns provider-specific keys).
 *   - `memory.browse.response.entries[]` — has nested `metadata?` blocks
 *     in some memory adapters; the typed-out projection in the handler
 *     (lines 204–212) renders the first 500 chars + a typed subset, but
 *     the full row carries unknown fields per memory adapter.
 *   - `memory.export.response.entries[]` — similar nested-record shape;
 *     `source` is `Record<string, unknown>` at the leaf.
 *   - `context.inspect.response` — discriminated by ID prefix (`sum_` vs
 *     `file_`); the two variants carry different field sets. Modelled as
 *     a loose record at the top level + tight inner typing for the known
 *     fields.
 *   - `context.recall.response` — `{ answer, citations[], grantId?,
 *     tokensConsumed? }` is mostly primitive; `answer` is the
 *     unconstrained sub-agent output (loose-modelled internal).
 *   - `context.tree.response.nodes[]` — has nested `childIds[]` and
 *     `parentIds[]` per node.
 *   - `context.searchByConversation.response.results[]` — discriminated
 *     by `type: "message" | "summary"`; the two variants carry the same
 *     wire shape per handler.
 *
 * **Gateway-adapter shim caveat.** The CLI's `packages/cli/src/commands/memory.ts`
 * contains raw `client.call(...)` sites for `memory.search`,
 * `memory.inspect`, and `config.set`. These are NOT memory-handlers.ts or
 * context-handlers.ts methods — they are gateway-adapter shims registered
 * in `packages/gateway/src/rpc/rpc-adapters.ts:171-249` that bypass the
 * daemon handler-factory layer. Those methods have no contract in this
 * file (and no daemon-handler-factory entry to map against, per the
 * bidirectional 1:1 architecture test scope). The CLI retarget here is
 * scoped to `client.call("memory.search_files"|"memory.get_file"|
 * "memory.store"|"memory.stats"|"memory.browse"|"memory.delete"|
 * "memory.flush"|"memory.export"|"context.*", ...)` sites only.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ===========================================================================
// --- memory-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// memory.search_files
// ---------------------------------------------------------------------------

/**
 * `memory.search_files` — agent-level FTS search over per-agent memory
 * entries. Handler returns truncated 500-char previews + score + tags +
 * createdAt for each result row.
 *
 * Registered via agent tool dispatch (NOT in setup-gateway-api.ts); the
 * contract scope `["rpc"]` documents the intended trust model.
 */
export const MemorySearchFilesContract = defineContract({
  method: "memory.search_files",
  request: z.object({
    query: z.string(),
    limit: z.number().optional(),
  }),
  response: z.object({
    results: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        score: z.number(),
        tags: z.array(z.string()),
        createdAt: z.number(),
      }),
    ),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// memory.get_file
// ---------------------------------------------------------------------------

/**
 * `memory.get_file` — agent-level file read via safePath. Handler
 * resolves the file path against the per-agent workspace dir, reads the
 * file, and returns the requested line range (default: full file).
 *
 * Registered via agent tool dispatch; contract scope `["rpc"]` documents
 * the intended trust model.
 */
export const MemoryGetFileContract = defineContract({
  method: "memory.get_file",
  request: z.object({
    path: z.string(),
    startLine: z.number().optional(),
    endLine: z.number().optional(),
  }),
  response: z.object({
    path: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    totalLines: z.number(),
    content: z.string(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// memory.store
// ---------------------------------------------------------------------------

/**
 * `memory.store` — write a memory entry. Admin via gateway route
 * (setup-gateway-api.ts:235); ALSO usable from the agent in-process tool
 * path where the trust level defaults to `learned`. The handler routes
 * on the dispatcher-injected `_trustLevel`:
 *   - `_trustLevel === "admin"`: operator-attributed (channel: web-console).
 *   - Otherwise: agent-attributed (channel: agent-tool).
 *
 * Bespoke pre-Zod validation: `content` is required + non-empty (the
 * handler raises `"Missing required parameter: content"`), and the
 * optional `trustLevel` override is honored ONLY when the caller is admin
 * AND the value is one of `"learned"` / `"external"`.
 *
 * Response: `{ stored: true, id: <uuid> }`. The handler ALWAYS throws on
 * failure (memory adapter rejection, write-validator critical pattern,
 * etc.) so `stored` is constant-literal `true`.
 */
export const MemoryStoreContract = defineContract({
  method: "memory.store",
  request: z.object({
    content: z.string().min(1),
    tags: z.array(z.string()).optional(),
    trustLevel: z.string().optional(),
  }),
  response: z.object({
    stored: z.literal(true),
    id: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.stats
// ---------------------------------------------------------------------------

/**
 * `memory.stats` — return MemoryStats for a tenant (+ optional agent).
 * The handler returns whatever `deps.memoryApi.stats(tenantId, agentId)`
 * yields; the underlying `MemoryStats` shape carries provider-specific
 * keys (totalEntries, byType, byTrustLevel, byAgent, totalSessions,
 * embeddedEntries, dbSizeBytes, etc.) and is modelled with a loose
 * record to avoid pinning the underlying impl's wire format.
 *
 * The CLI's `memory stats` subcommand currently invokes the
 * gateway-adapter `memory.inspect` (which fans out to a different code
 * path), NOT this handler — see the gateway-adapter shim caveat in the
 * file header.
 */
export const MemoryStatsContract = defineContract({
  method: "memory.stats",
  request: z.object({
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.browse
// ---------------------------------------------------------------------------

/**
 * `memory.browse` — paginated browse of memory entries with optional
 * filtering by memory-type / trust-level / tags. Default page size = 20.
 *
 * Response: `{ entries[], total, offset, limit, hasMore }`. Each entry
 * carries the first 500 chars of content + a typed subset of fields;
 * additional adapter-specific keys (when present on the underlying row)
 * are absent from the projected response. The entries[] item shape is
 * modelled with a loose-record value-type to forward-compat against
 * future memory-adapter additions (a tight model would pin the wire
 * shape across daemon restarts).
 *
 * Bespoke pre-Zod validation: none in the handler — `memory.browse` is
 * an agent-level read with safe defaults.
 */
export const MemoryBrowseContract = defineContract({
  method: "memory.browse",
  request: z.object({
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
    sort: z.string().optional(),
    memory_type: z.string().optional(),
    trust_level: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  response: z.object({
    entries: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
    hasMore: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.delete
// ---------------------------------------------------------------------------

/**
 * `memory.delete` — bulk delete memory entries by ID array. Admin-only.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for memory
 *     deletion"`.
 *   - `ids` missing or empty → `"Missing or empty required parameter: ids"`.
 *
 * Response: `{ deleted, failed, total }` — per-ID success/failure
 * counters (the handler iterates over `ids` and tallies the result of
 * each `memoryAdapter.delete()` call).
 */
export const MemoryDeleteContract = defineContract({
  method: "memory.delete",
  request: z.object({
    ids: z.array(z.string()).min(1),
    tenant_id: z.string().optional(),
  }),
  response: z.object({
    deleted: z.number(),
    failed: z.number(),
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.flush
// ---------------------------------------------------------------------------

/**
 * `memory.flush` — wipe ALL memory entries for a tenant scope (+
 * optional agent narrowing). Admin-only. Destructive.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for memory
 *     flush"`.
 *
 * Response: `{ flushed: true, entriesRemoved, scope: { tenantId,
 * agentId: string | null } }`. `agentId` is intentionally nullable —
 * `null` indicates a tenant-wide flush (no agent narrowing).
 */
export const MemoryFlushContract = defineContract({
  method: "memory.flush",
  request: z.object({
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
  }),
  response: z.object({
    flushed: z.literal(true),
    entriesRemoved: z.number(),
    scope: z.object({
      tenantId: z.string(),
      agentId: z.nullable(z.string()),
    }),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.export
// ---------------------------------------------------------------------------

/**
 * `memory.export` — paginated export of full memory entries (NO content
 * truncation, unlike `memory.browse`). Default page size = 1000.
 *
 * Response: `{ entries[], total, offset, limit }` — each entry carries
 * the FULL content + agent attribution + source metadata. The entries[]
 * item shape is modelled with a loose record to avoid pinning the
 * underlying memory-adapter row format.
 */
export const MemoryExportContract = defineContract({
  method: "memory.export",
  request: z.object({
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  response: z.object({
    entries: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- context-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// context.search
// ---------------------------------------------------------------------------

/**
 * `context.search` — FTS5 / regex search across messages and summaries
 * within the caller's active DAG conversation. Resolved from the
 * dispatcher-injected `_callerSessionKey`.
 *
 * Bespoke pre-Zod validation:
 *   - No active DAG conversation → `"No active DAG conversation for
 *     this session"`.
 *   - `query` missing → `"Missing required parameter: query"`.
 *
 * Request fields: `query` (required), `mode` (default `"fts"`), `scope`
 * (default `"both"`), `limit` (max 100).
 *
 * Response: `{ results: SearchResultRow[], total }`. Each row carries
 * `id` (stringified message-id or summaryId), `content` (truncated to
 * 500 chars), `type: "message" | "summary"`, and optional `rank` (FTS5
 * rank — lower is better; absent for regex mode).
 */
export const ContextSearchContract = defineContract({
  method: "context.search",
  request: z.object({
    query: z.string().min(1),
    mode: z.enum(["fts", "regex"]).optional(),
    scope: z.enum(["both", "messages", "summaries"]).optional(),
    limit: z.number().optional(),
  }),
  response: z.object({
    results: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        type: z.enum(["message", "summary"]),
        rank: z.number().optional(),
      }),
    ),
    total: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// context.inspect
// ---------------------------------------------------------------------------

/**
 * `context.inspect` — fetch full content of a summary or file by ID. The
 * ID prefix discriminates the variant: `sum_*` returns a summary row +
 * lineage; `file_*` returns large-file metadata + on-disk content
 * (capped at 100,000 chars).
 *
 * Bespoke pre-Zod validation:
 *   - `id` missing → `"Missing required parameter: id"`.
 *   - Summary not found → `"Summary not found: <id>"`.
 *   - File not found → `"File not found: <id>"`.
 *   - Unknown prefix → `"Unknown ID prefix. Expected 'sum_' or 'file_'..."`.
 *
 * Response: LOOSE RECORD. The two variants carry overlapping but
 * distinct field sets:
 *   - summary: `{ type: "summary", summaryId, content, depth, kind,
 *     tokenCount, earliestAt?, latestAt?, descendantCount, parentIds[],
 *     childIds[], sourceMessageCount }`.
 *   - file:    `{ type: "file", fileId, fileName?, mimeType?, byteSize?,
 *     explorationSummary?, content (capped at 100k) }`.
 *
 * Modelling the discriminated union tightly would require pinning the
 * `kind` enum (varies per compaction strategy) and the per-field
 * nullability (depends on memory-adapter implementation). The loose
 * record preserves the variant discrimination via `type` + lets the
 * underlying types stay authoritative.
 */
export const ContextInspectContract = defineContract({
  method: "context.inspect",
  request: z.object({
    id: z.string().min(1),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// context.recall
// ---------------------------------------------------------------------------

/**
 * `context.recall` — deep recall via bounded sub-agent spawning. Creates
 * an expansion grant (configurable token cap + expiry), spawns a sub-
 * agent with `context_expand` tool group, and returns the sub-agent's
 * answer + citation summaryIds.
 *
 * Bespoke pre-Zod validation:
 *   - No active DAG conversation → `"No active DAG conversation for
 *     this session"`.
 *   - Daily quota exceeded → `"Daily recall quota exceeded
 *     (<N>/day)..."`.
 *   - `prompt` missing → `"Missing required parameter: prompt"`.
 *
 * Request: `{ prompt, query?, summary_ids?, max_tokens? }`. Either
 * `query` (auto-search for candidates) OR `summary_ids` (explicit
 * candidate set) drives the sub-agent's working set.
 *
 * Response: `{ answer, citations: string[], grantId?, tokensConsumed? }`.
 * `grantId` + `tokensConsumed` are absent when zero candidates were
 * found.
 */
export const ContextRecallContract = defineContract({
  method: "context.recall",
  request: z.object({
    prompt: z.string().min(1),
    query: z.string().optional(),
    summary_ids: z.array(z.string()).optional(),
    max_tokens: z.number().optional(),
  }),
  response: z.object({
    answer: z.string(),
    citations: z.array(z.string()),
    grantId: z.string().optional(),
    tokensConsumed: z.number().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// context.expand
// ---------------------------------------------------------------------------

/**
 * `context.expand` — walk deeper into the DAG with a grant. Used by the
 * sub-agent spawned from `context.recall` to traverse summaries down to
 * source messages, bounded by the grant's token cap + conversation
 * allowlist + expiry.
 *
 * Bespoke pre-Zod validation:
 *   - `grant_id` missing → `"Missing required parameter: grant_id"`.
 *   - `summary_id` missing → `"Missing required parameter: summary_id"`.
 *   - Grant not found / revoked / expired → corresponding error message.
 *   - Token cap reached → `"Token cap reached (<consumed>/<cap>)..."`.
 *   - Summary not found → `"Summary not found: <id>"`.
 *   - Summary outside grant's conversation allowlist → `"Summary does
 *     not belong to an authorized conversation"`.
 *
 * Response: `{ summaryId, depth, kind, children[], tokensExpanded,
 * tokenBudgetRemaining }`. Each child is either a summary (when
 * expanding a condensed summary) or a source message (when expanding a
 * leaf summary).
 */
export const ContextExpandContract = defineContract({
  method: "context.expand",
  request: z.object({
    grant_id: z.string().min(1),
    summary_id: z.string().min(1),
  }),
  response: z.object({
    summaryId: z.string(),
    depth: z.number(),
    kind: z.string(),
    children: z.array(
      z.object({
        type: z.enum(["summary", "message"]),
        id: z.union([z.string(), z.number()]),
        content: z.string(),
        tokenCount: z.number(),
      }),
    ),
    tokensExpanded: z.number(),
    tokenBudgetRemaining: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// context.conversations
// ---------------------------------------------------------------------------

/**
 * `context.conversations` — list ALL DAG conversations for the tenant
 * (operator view). Admin-only.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required"`.
 *
 * Response: `{ conversations[], total }`. Each conversation row is the
 * raw `CtxConversationRow` from the context store (loose-record —
 * modelling the row shape tightly would pin the persistence schema).
 */
export const ContextConversationsContract = defineContract({
  method: "context.conversations",
  request: z.object({
    limit: z.number().optional(),
    offset: z.number().optional(),
  }),
  response: z.object({
    conversations: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// context.tree
// ---------------------------------------------------------------------------

/**
 * `context.tree` — summary-tree for a given DAG conversation (operator
 * view). Admin-only.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required"`.
 *   - `conversation_id` missing → `"Missing required parameter:
 *     conversation_id"`.
 *   - Conversation not found → `"Conversation not found"`.
 *
 * Response: `{ conversationId, nodes[], messageCount }`. Each node
 * carries `summaryId, kind, depth, tokenCount, contentPreview` (first
 * 200 chars), `childIds[]`, `parentIds[]`, `createdAt`. `kind` is a
 * loose-string (compaction strategies evolve over time).
 */
export const ContextTreeContract = defineContract({
  method: "context.tree",
  request: z.object({
    conversation_id: z.string().min(1),
  }),
  response: z.object({
    conversationId: z.string(),
    nodes: z.array(
      z.object({
        summaryId: z.string(),
        kind: z.string(),
        depth: z.number(),
        tokenCount: z.number(),
        contentPreview: z.string(),
        childIds: z.array(z.string()),
        parentIds: z.array(z.string()),
        createdAt: z.string(),
      }),
    ),
    messageCount: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// context.searchByConversation
// ---------------------------------------------------------------------------

/**
 * `context.searchByConversation` — FTS5 search within a SPECIFIC DAG
 * conversation (operator view; bypasses the caller's active session).
 * Admin-only.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required"`.
 *   - `conversation_id` missing → `"Missing required parameter:
 *     conversation_id"`.
 *   - `query` missing → `"Missing required parameter: query"`.
 *
 * Response: `{ results[] }`. Each row carries `id`, `type: "message" |
 * "summary"`, `content` (FULL content — no truncation, unlike
 * `context.search`), and optional FTS5 `rank`.
 */
export const ContextSearchByConversationContract = defineContract({
  method: "context.searchByConversation",
  request: z.object({
    conversation_id: z.string().min(1),
    query: z.string().min(1),
    limit: z.number().optional(),
  }),
  response: z.object({
    results: z.array(
      z.object({
        id: z.string(),
        type: z.enum(["message", "summary"]),
        content: z.string(),
        rank: z.number().optional(),
      }),
    ),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- memory-handlers.ts (Phase 86 / OBS-06 diagnostic surface) ---
//
// Four admin-scoped diagnostic contracts: recall-trace inspect, observation
// provenance, entity graph, and recall stats. INTERFACE-FIRST — defined here
// (Plan 02) so Plan 05 has the request/response shapes; the matching daemon
// handlers + CLI subcommands land in Plan 05.
//
// CROSS-WAVE SEAM (load-bearing): these are grouped in their OWN
// `MEMORY_DIAGNOSTIC_CONTRACTS` array below and are NOT included in
// `MEMORY_CONTRACTS` (which feeds `API_CONTRACTS` via index.ts). The
// `api-contracts-bidirectional.test.ts` + `contract-handler-parity.test.ts`
// architecture gates require every `API_CONTRACTS` entry to have a MIGRATED
// (`[Contract.method]:` computed-key) daemon handler — registering these
// before Plan 05's handlers exist would turn those gates RED for the whole
// repo between waves. Plan 05 spreads `MEMORY_DIAGNOSTIC_CONTRACTS` into
// `MEMORY_CONTRACTS` in the SAME diff that adds the handlers, so the
// registry↔handler set is 1:1 at every committed state.
// ===========================================================================

// ---------------------------------------------------------------------------
// memory.recall_trace
// ---------------------------------------------------------------------------

/**
 * `memory.recall_trace` — read recall-trace JSONL records for one recall,
 * keyed by `session_key` OR `trace_id` (admin-only). Models the obs-trace
 * file-reading handler (`bindObsTraceHandlers`): the handler (Plan 05) reads
 * the `diagnostics.recallTrace` artifact (LRU + day-bounded scan) and returns
 * the matching records.
 *
 * Request: both `session_key` and `trace_id` are modelled OPTIONAL; the
 * handler enforces the "at least one required" rule (mirroring
 * `obs.trace.search`'s messageId/traceId pattern) and applies the `limit`
 * default. `tenant_id` / `agent_id` are the scope dimensions the handler
 * threads into the file/row filter.
 *
 * Response: `{ records: Record<string, unknown>[] }` — LOOSE on purpose. The
 * recall-trace JSONL rows are schema-versioned + forward-compat; pinning them
 * in the contract would couple the wire shape to the recorder's evolving
 * record format across daemon restarts.
 */
// @contract-deferred-handler: 86-05 (daemon handler + CLI land in Plan 05; held out of MEMORY_CONTRACTS until then)
export const MemoryRecallTraceContract = defineContract({
  method: "memory.recall_trace",
  request: z.object({
    session_key: z.string().optional(),
    trace_id: z.string().optional(),
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
    limit: z.number().optional(),
  }),
  response: z.object({
    records: z.array(z.record(z.string(), z.unknown())),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.observations
// ---------------------------------------------------------------------------

/**
 * `memory.observations` — list consolidation observations with their
 * provenance (admin-only). The handler (Plan 05) reuses the existing
 * `MemoryConsolidationStore.listObservations` SQL-scoped read.
 *
 * Request: `{ tenant_id?, agent_id?, limit? }` — the scope dimensions the
 * handler threads; `limit` default applied in the handler.
 *
 * Response: `observations[]` with `id`, a truncated `content` PREVIEW (the
 * handler truncates), and the provenance fields read off `MemoryEntry`:
 * `proofCount?`, `sourceIds?`, `confidence?`, `consolidatedAt?`. `createdAt`
 * is always present.
 */
// @contract-deferred-handler: 86-05 (daemon handler + CLI land in Plan 05; held out of MEMORY_CONTRACTS until then)
export const MemoryObservationsContract = defineContract({
  method: "memory.observations",
  request: z.object({
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
    limit: z.number().optional(),
  }),
  response: z.object({
    observations: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        proofCount: z.number().optional(),
        sourceIds: z.array(z.string()).optional(),
        confidence: z.number().optional(),
        consolidatedAt: z.number().optional(),
        createdAt: z.number(),
      }),
    ),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.entities
// ---------------------------------------------------------------------------

/**
 * `memory.entities` — list the entity graph for the scope, ordered
 * most-mentioned-first (admin-only). The handler (Plan 05) calls the new
 * `MemoryEntityStore.listEntities(agentId, tenantId, limit)` scoped read
 * (defined in `ports/memory-entity-store.ts`).
 *
 * Request: `{ tenant_id?, agent_id?, limit? }` — scope dimensions + bound.
 *
 * Response: `entities[]` mirroring `EntityRow` — `id`, `name`,
 * `mentionCount`, optional `firstSeen` / `lastSeen` (epoch ms).
 */
// @contract-deferred-handler: 86-05 (daemon handler + CLI land in Plan 05; held out of MEMORY_CONTRACTS until then)
export const MemoryEntitiesContract = defineContract({
  method: "memory.entities",
  request: z.object({
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
    limit: z.number().optional(),
  }),
  response: z.object({
    entities: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        mentionCount: z.number(),
        firstSeen: z.number().optional(),
        lastSeen: z.number().optional(),
      }),
    ),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.recall_stats
// ---------------------------------------------------------------------------

/**
 * `memory.recall_stats` — return the in-process recall counters
 * (admin-only). The handler (Plan 05) returns `createRecallCounters().
 * snapshot()` (the `@comis/observability` registry wired in Plan 01) plus the
 * two derived rates. Counters reset on process restart (documented).
 *
 * Request: `{ tenant_id?, agent_id? }` — accepted for symmetry with the other
 * diagnostic contracts; the counters are process-global (the handler may
 * ignore the scope or use it once per-scope counters land).
 *
 * Response: the `RecallCountersSnapshot` fields (`laneUsage{fts,vector,
 * entity}`, `rerankRuns`, `rerankFallbacks`, `consolidationClusters`,
 * `observationsCreated`, `recalls`, `recallsWithHits`) PLUS the derived
 * `rerankFallbackRate` (= rerankFallbacks/rerankRuns) and `recallHitRate`
 * (= recallsWithHits/recalls). The handler guards the divide-by-zero on a
 * fresh process.
 */
// @contract-deferred-handler: 86-05 (daemon handler + CLI land in Plan 05; held out of MEMORY_CONTRACTS until then)
export const MemoryRecallStatsContract = defineContract({
  method: "memory.recall_stats",
  request: z.object({
    tenant_id: z.string().optional(),
    agent_id: z.string().optional(),
  }),
  response: z.object({
    laneUsage: z.object({
      fts: z.number(),
      vector: z.number(),
      entity: z.number(),
    }),
    rerankRuns: z.number(),
    rerankFallbacks: z.number(),
    consolidationClusters: z.number(),
    observationsCreated: z.number(),
    recalls: z.number(),
    recallsWithHits: z.number(),
    rerankFallbackRate: z.number(),
    recallHitRate: z.number(),
  }),
  scopes: ["admin"] as const,
});

/**
 * Phase 86 admin-scoped diagnostic contracts (OBS-06). Defined here but held
 * OUT of `MEMORY_CONTRACTS` until Plan 05 lands the matching daemon handlers —
 * see the cross-wave-seam note above the `memory.recall_trace` block. Plan 05
 * folds this array into `MEMORY_CONTRACTS` (`...MEMORY_DIAGNOSTIC_CONTRACTS`)
 * in the same diff as the handlers.
 */
export const MEMORY_DIAGNOSTIC_CONTRACTS = [
  MemoryRecallTraceContract,
  MemoryObservationsContract,
  MemoryEntitiesContract,
  MemoryRecallStatsContract,
] as const;

// ===========================================================================
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ===========================================================================

/**
 * Memory + context domain contract array. Registered into
 * `API_CONTRACTS_ORDERED` by `packages/core/src/api-contracts/index.ts`.
 *
 * The grouping below is documentation-only (the bidirectional 1:1 test
 * treats the tuple as an unordered set).
 *
 * NOTE: `MEMORY_DIAGNOSTIC_CONTRACTS` (the four Phase 86 OBS-06 contracts) is
 * intentionally NOT spread here yet — Plan 05 adds it alongside its handlers
 * to keep the bidirectional 1:1 registry↔handler invariant green between
 * waves.
 */
export const MEMORY_CONTRACTS = [
  // --- memory-handlers.ts ---
  MemorySearchFilesContract,
  MemoryGetFileContract,
  MemoryStoreContract,
  MemoryStatsContract,
  MemoryBrowseContract,
  MemoryDeleteContract,
  MemoryFlushContract,
  MemoryExportContract,
  // --- context-handlers.ts ---
  ContextSearchContract,
  ContextInspectContract,
  ContextRecallContract,
  ContextExpandContract,
  ContextConversationsContract,
  ContextTreeContract,
  ContextSearchByConversationContract,
] as const;
