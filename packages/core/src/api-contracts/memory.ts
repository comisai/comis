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
// Value import for the `...MEMORY_DIAGNOSTIC_CONTRACTS` spread into
// MEMORY_CONTRACTS below (the `export { ... } from` re-export further down is
// type/barrel-only and does not create a usable local value binding).
import { MEMORY_DIAGNOSTIC_CONTRACTS } from "./memory-diagnostics.js";

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
// memory.ask  (Phase 109 — DIAL-01/02, the dialectic grounded-Q&A surface)
// ---------------------------------------------------------------------------

/**
 * `memory.ask` — the dialectic: a grounded, cited NL answer over the agent's
 * LLM-free recall pipeline. The handler runs `createMemoryRecall` for the
 * question (the SAME trust-filtered + redacted recall the prompt path uses),
 * then synthesizes the answer via the ONE allowed query-time LLM seam, and
 * returns it WITH citations.
 *
 * Request: `{ question, limit? }` — `question` is the (untrusted) NL query;
 * `limit` optionally caps the grounding-set size.
 *
 * Response: `{ answer, citations, abstained }`.
 *   - `citations` are recalled memory IDS (the entry id is a `z.guid()` at the
 *     source, but the contract types it as opaque `string` — citations are ids,
 *     never free text; DIAL-02). The cited ids traverse `sourceIds` in the
 *     recall-trace (DIAL-03).
 *   - `abstained` is the EXPLICIT DIAL-01 mandatory-abstention signal — a
 *     required boolean, never inferred from an empty `answer`. Insufficient
 *     grounding ⇒ `{ answer: "", citations: [], abstained: true }`, never a
 *     fabricated answer.
 *   - the `answer` text is built ONLY from the trust-filtered + redacted recall
 *     output (enforced in the Plan 03 handler), with the higher-trust source
 *     winning on conflict (trust-first, a HARD boundary).
 *
 * Registered via agent tool dispatch (the `memory_ask` tool); contract scope
 * `["rpc"]` documents the intended trust model.
 *
 * CROSS-WAVE SEAM CLOSED (Plan 03): the contract SHAPE shipped in Plan 01 with a
 * deferred-handler annotation and was kept OUT of `MEMORY_CONTRACTS` until its
 * daemon handler existed (registering it before the handler would RED-gate
 * contract-handler-parity + bidirectional 1:1). Plan 03 landed the
 * `[MemoryAskContract.method]:` handler in `memory-handlers.ts` and, in the SAME
 * diff, spread this contract into `MEMORY_CONTRACTS` (8 + 4 + 7 + 1 = 20) and
 * removed that annotation — so the registry ↔ handler set is 1:1 by construction.
 * (Mirrors the OBS-06 cross-wave seam closed in Phase 86 Plan 05.)
 */
export const MemoryAskContract = defineContract({
  method: "memory.ask",
  request: z.object({
    question: z.string(),
    limit: z.number().optional(),
  }),
  response: z.object({
    answer: z.string(),
    citations: z.array(z.string()),
    abstained: z.boolean(),
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
// The four admin-scoped memory-diagnostic contracts (memory.recall_trace /
// .observations / .entities / .recall_stats) and their
// `MEMORY_DIAGNOSTIC_CONTRACTS` array were EXTRACTED to the sibling file
// `./memory-diagnostics.ts` purely to keep this file under the 800-line
// architecture cap (file-size.test.ts). They are re-exported below so every
// existing `from "./memory.js"` import — and the api-contracts barrel — still
// resolves, and so they remain part of the memory domain's public surface.
//
// CROSS-WAVE SEAM (closed in Plan 05): the four contracts are now spread into
// `MEMORY_CONTRACTS` below (`...MEMORY_DIAGNOSTIC_CONTRACTS`), in the SAME wave
// that landed their daemon handlers in `memory-handlers.ts`, and the
// `@contract-deferred-handler: 86-05` annotations were removed from
// `./memory-diagnostics.ts`. The bidirectional 1:1 + contract-handler-parity
// gates remain green by construction (registry ↔ handler set is 1:1).
// ===========================================================================

export {
  MemoryRecallTraceContract,
  MemoryObservationsContract,
  MemoryEntitiesContract,
  MemoryRecallStatsContract,
} from "./memory-diagnostics.js";
// Re-export the locally-imported (for the spread below) diagnostics array so
// the public barrel surface is unchanged.
export { MEMORY_DIAGNOSTIC_CONTRACTS };

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
 * Phase 86 (Plan 05): `MEMORY_DIAGNOSTIC_CONTRACTS` (the four OBS-06
 * contracts) is now spread in — in the SAME wave that landed the matching
 * `[Contract.method]:` daemon handlers in `memory-handlers.ts` — so the
 * `API_CONTRACTS` registry ↔ handler set stays 1:1 (the cross-wave seam from
 * Plan 02 is closed; the `@contract-deferred-handler: 86-05` annotations were
 * removed in the same diff).
 *
 * Phase 109 (Plan 03): `MemoryAskContract` (the dialectic memory.ask surface) is
 * now spread in — in the SAME diff that landed its `[MemoryAskContract.method]:`
 * handler in `memory-handlers.ts` — so the registry ↔ handler set stays 1:1 and
 * the `@contract-deferred-handler: 109-03` tag was removed in the same diff.
 */
export const MEMORY_CONTRACTS = [
  // --- memory-handlers.ts ---
  MemorySearchFilesContract,
  MemoryAskContract,
  MemoryGetFileContract,
  MemoryStoreContract,
  MemoryStatsContract,
  MemoryBrowseContract,
  MemoryDeleteContract,
  MemoryFlushContract,
  MemoryExportContract,
  // --- memory-handlers.ts (Phase 86 / OBS-06 diagnostic surface) ---
  ...MEMORY_DIAGNOSTIC_CONTRACTS,
  // --- context-handlers.ts ---
  ContextSearchContract,
  ContextInspectContract,
  ContextRecallContract,
  ContextExpandContract,
  ContextConversationsContract,
  ContextTreeContract,
  ContextSearchByConversationContract,
] as const;
