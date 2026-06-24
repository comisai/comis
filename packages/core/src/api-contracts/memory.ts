// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-domain RPC contracts. Mirrors the daemon handler factory file that
 * owns the `MemoryApiDeps` cluster slice:
 *
 *   - `packages/daemon/src/api/memory-handlers.ts`  (8 methods)
 *
 * NOTE (v2.12, Phase 126): the sibling `context-handlers.ts` (7 `context.*`
 * methods) and its 7 `Context*Contract` definitions were REMOVED with the DAG
 * context engine. The governed context-expansion RPC surface is reintroduced
 * fresh by the LCD engine (Phase 131).
 *
 * The aggregator below preserves per-handler grouping via
 * `// --- xxx-handlers.ts ---` comment blocks; the order within the array is
 * documentation-only (the bidirectional 1:1 test treats it as an unordered
 * set).
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
 *   - `memory.store`        (rpc) — AGENT-REACHABLE (MD-02): the agent
 *                                      `memory_store` tool is the primary caller.
 *                                      The handler routes on `_trustLevel` — admin
 *                                      (operator) vs the agent path (defaults to
 *                                      `learned` trust + agent attribution).
 *                                      (Was `admin`, which deny-by-origin blocked.)
 *   - `memory.stats`        (admin) — setup-gateway-api.ts line 234.
 *   - `memory.browse`       (admin) — setup-gateway-api.ts line 234.
 *   - `memory.delete`       (admin) — setup-gateway-api.ts line 234.
 *   - `memory.flush`        (admin) — setup-gateway-api.ts line 235.
 *   - `memory.export`       (admin) — setup-gateway-api.ts line 235.
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
 *
 * **CLI memory search/inspect (v2.12).** The CLI's
 * `packages/cli/src/commands/memory.ts` previously borrowed the (now-removed)
 * `context.search` / `context.inspect` RPCs for its `memory search` /
 * `memory inspect` subcommands. With the DAG context engine demolished those
 * commands fail closed (explicit not-available message + non-zero exit) — there
 * is no `memory.search` / `memory.inspect` handler. Full-text context search +
 * entry inspection return with the LCD engine (Phase 131).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";
// Value import for the `...MEMORY_DIAGNOSTIC_CONTRACTS` spread into
// MEMORY_CONTRACTS below (the `export { ... } from` re-export further down is
// type/barrel-only and does not create a usable local value binding).
import { MEMORY_DIAGNOSTIC_CONTRACTS } from "./memory-diagnostics.js";
// Portability contracts extracted to keep this file within the 800-line cap.
export {
  MemoryPortabilityExportContract,
  MemoryPortabilityImportContract,
  MEMORY_PORTABILITY_CONTRACTS,
} from "./memory-portability.js";
// Only the array is needed as a local value (spread into MEMORY_CONTRACTS below);
// the two contract objects are re-exported via the `export { ... } from` above.
import { MEMORY_PORTABILITY_CONTRACTS } from "./memory-portability.js";

// Pinning contracts extracted to memory-pinning.ts (file-size cap §4.1).
// @contract-deferred-handler annotations removed in plan 03-03 (same diff as handler creation).
export {
  MemoryPinContract,
  MemoryUnpinContract,
  MEMORY_PINNING_CONTRACTS,
} from "./memory-pinning.js";
import { MEMORY_PINNING_CONTRACTS } from "./memory-pinning.js";

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
// memory.ask  (the dialectic grounded-Q&A surface)
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
 *     never free text). The cited ids traverse `sourceIds` in the
 *     recall-trace.
 *   - `abstained` is the EXPLICIT mandatory-abstention signal — a
 *     required boolean, never inferred from an empty `answer`. Insufficient
 *     grounding ⇒ `{ answer: "", citations: [], abstained: true }`, never a
 *     fabricated answer.
 *   - the `answer` text is built ONLY from the trust-filtered + redacted recall
 *     output (enforced in the handler), with the higher-trust source
 *     winning on conflict (trust-first, a HARD boundary).
 *
 * Registered via agent tool dispatch (the `memory_ask` tool); contract scope
 * `["rpc"]` documents the intended trust model.
 *
 * CROSS-WAVE SEAM (now closed): the contract SHAPE shipped first with a
 * deferred-handler annotation and was kept OUT of `MEMORY_CONTRACTS` until its
 * daemon handler existed (registering it before the handler would RED-gate
 * contract-handler-parity + bidirectional 1:1). The
 * `[MemoryAskContract.method]:` handler later landed in `memory-handlers.ts` and,
 * in the SAME diff, this contract was spread into `MEMORY_CONTRACTS`
 * (8 + 4 + 7 + 1 = 20) and that annotation removed — so the registry ↔ handler
 * set is 1:1 by construction. (Mirrors the diagnostic cross-wave seam closed
 * earlier.)
 */
export const MemoryAskContract = defineContract({
  method: "memory.ask",
  request: z.object({
    question: z.string(),
    // A positive integer — the grounding-set size the caller may request. The handler
    // additionally clamps it DOWN to the per-agent `dialectic.maxRecall` DoS ceiling; this
    // contract bound rejects the negative / non-integer / huge cases at the parse boundary so
    // the DoS / negative-slice path cannot reach the handler in the first place.
    limit: z.number().int().positive().optional(),
  }),
  response: z.object({
    answer: z.string(),
    citations: z.array(z.string()),
    abstained: z.boolean(),
    // Live finding 2026-06-11: every abstain branch (dialectic not wired,
    // empty recall, synthesis abstain) returned the IDENTICAL bare sentinel —
    // an infrastructure absence was indistinguishable from a genuine "no
    // data" answer. Present ONLY when abstained:true. Values:
    //   "dialectic_unavailable" — seam/recall factory not wired (config/key)
    //   "no_agent_scope"        — no caller agent scope and no default agent
    //   "empty_recall"          — recall ran and returned nothing
    //   "synthesis_abstained"   — grounded synthesis declined to answer
    reason: z.string().optional(),
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
 * `memory.store` — write a memory entry. `scopes:["rpc"]` — AGENT-REACHABLE:
 * the agent `memory_store` tool is the primary caller, where the trust level
 * defaults to `learned`. (Was `scopes:["admin"]`, the MD-02 deny-by-origin
 * regression: `["admin"]` put it in `ADMIN_METHODS` so the `assertNotAgentOrigin`
 * chokepoint threw "Control-plane method memory.store is not reachable from an
 * agent origin" for the agent's `_agentId`-bearing call — the `memory_store`
 * tool could not store anything. Re-scoped admin→rpc 2026-06-24, matching the
 * earlier `message.send`/`skills.*`/`session.list` fixes; guarded by
 * `test/architecture/agent-memory-tools-deny-by-origin.test.ts`.) The handler
 * still routes on the dispatcher-injected `_trustLevel`:
 *   - `_trustLevel === "admin"` (operator path): operator-attributed (channel: web-console), may override trust to learned/external.
 *   - Otherwise (agent path): agent-attributed (channel: agent-tool), trust defaults to `learned` (never `system`).
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
  scopes: ["rpc"] as const,
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
// --- context-handlers.ts (REMOVED in v2.12) ---
//
// The 7 `Context*Contract` definitions (context.search / .inspect / .recall /
// .expand / .conversations / .tree / .searchByConversation) were removed in
// v2.12 (Phase 126) along with the DAG context engine + its daemon handlers
// (Plan 03) + the CLI memory search/inspect rewire (fail-closed, this plan).
// The governed context-expansion RPC surface is reintroduced fresh by the LCD
// engine (Phase 131).
// ===========================================================================

// ===========================================================================
// --- memory-handlers.ts (diagnostic surface) ---
//
// The four admin-scoped memory-diagnostic contracts (memory.recall_trace /
// .observations / .entities / .recall_stats) and their
// `MEMORY_DIAGNOSTIC_CONTRACTS` array were EXTRACTED to the sibling file
// `./memory-diagnostics.ts` purely to keep this file under the 800-line
// architecture cap (file-size.test.ts). They are re-exported below so every
// existing `from "./memory.js"` import — and the api-contracts barrel — still
// resolves, and so they remain part of the memory domain's public surface.
//
// CROSS-WAVE SEAM (now closed): the four contracts are now spread into
// `MEMORY_CONTRACTS` below (`...MEMORY_DIAGNOSTIC_CONTRACTS`), in the SAME wave
// that landed their daemon handlers in `memory-handlers.ts`, and the
// `@contract-deferred-handler` annotations were removed from
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
 * `MEMORY_DIAGNOSTIC_CONTRACTS` (the four diagnostic
 * contracts) is now spread in — in the SAME wave that landed the matching
 * `[Contract.method]:` daemon handlers in `memory-handlers.ts` — so the
 * `API_CONTRACTS` registry ↔ handler set stays 1:1 (the cross-wave seam is
 * closed; the `@contract-deferred-handler` annotations were
 * removed in the same diff).
 *
 * `MemoryAskContract` (the dialectic memory.ask surface) is
 * now spread in — in the SAME diff that landed its `[MemoryAskContract.method]:`
 * handler in `memory-handlers.ts` — so the registry ↔ handler set stays 1:1 and
 * the `@contract-deferred-handler` tag was removed in the same diff.
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
  // Portability contracts extracted to memory-portability.ts.
  ...MEMORY_PORTABILITY_CONTRACTS,
  // Pinning contracts extracted to memory-pinning.ts.
  ...MEMORY_PINNING_CONTRACTS,
  // --- memory-handlers.ts (diagnostic surface) ---
  ...MEMORY_DIAGNOSTIC_CONTRACTS,
  // NOTE: the 7 context.* contracts (context-handlers.ts) were removed in v2.12
  // (Phase 126) with the DAG context engine; reintroduced fresh by LCD (Phase 131).
] as const;
