// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions-domain RPC contracts implemented by the handlers under
 * `packages/daemon/src/api/session-handlers/`. These schemas are the
 * authoritative wire surface and generate the client contracts.
 *
 * Session data operations identify their exact storage partition with
 * `{ tenant_id, agent_id, conversation_ref }`; handlers must not infer a
 * tenant or agent from a display session key. Loose records remain only where
 * provider-specific message bodies or mode-specific responses cannot be
 * modeled without duplicating their owning domain contracts.
 *
 * @module
 */
import { z } from "zod";
import { ChannelEndpointSchema } from "../domain/conversation-scope.js";
import {
  SubagentFailureCompletionSchema,
  SubagentRunTelemetrySchema,
  SubagentSuccessCompletionSchema,
} from "./orchestrator/subagent-handlers.js";
import { defineContract } from "./types.js";

// ===========================================================================
// Sessions domain
// ===========================================================================

// ---------------------------------------------------------------------------
// session.status (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.status` — Per-agent runtime stats (model, agent name, token / cost
 * totals, step counter). Handler: `session-handlers/session-read.ts`.
 *
 * Bespoke pre-Zod: none (handler defensively uses `_agentId ?? defaultAgentId`
 * and reads costTrackers / stepCounters maps with a fallback).
 *
 * Request: `{}` (the `_agentId` internal field is dispatcher-injected — NOT
 * declared in the contract).
 *
 * Response: `{ model, agentName, tokensUsed: { totalTokens, totalCost },
 * stepsExecuted, maxSteps }`. All numeric leaves are tight; the nested
 * `tokensUsed` object is tight.
 */
export const SessionStatusContract = defineContract({
  method: "session.status",
  request: z.object({}),
  response: z.object({
    model: z.string(),
    agentName: z.string(),
    tokensUsed: z.object({
      totalTokens: z.number(),
      totalCost: z.number(),
    }),
    stepsExecuted: z.number(),
    maxSteps: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// agents.list (admin)
// ---------------------------------------------------------------------------

/**
 * `agents.list` — Return the array of configured agent IDs. Implemented by
 * `session-handlers/session-read.ts` despite the method namespace. Admin-only.
 *
 * Bespoke pre-Zod: none.
 *
 * Request: `{}`.
 * Response: `{ agents: string[] }` (tight — primitive-leaf).
 */
export const AgentsListContract = defineContract({
  method: "agents.list",
  request: z.object({}),
  response: z.object({
    agents: z.array(z.string()),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// session.list (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.list` — Aggregated session list across SQLite + JSONL + workspace
 * sources, with optional recency + kind filters and sandboxed sub-agent
 * visibility. Agent-self RPC reads are scoped to the requested tenant and
 * agent. Handler: `session-handlers/session-list.ts`.
 *
 * Bespoke pre-Zod: none.
 *
 * Request: `{ tenant_id, agent_id, kind?, since_minutes? }`.
 *
 * Response: `{ sessions: SessionInfo[], total }`. Each `SessionInfo` is
 * tight-modeled (conversationRef / agentId / kind / optional authoritative
 * endpoint / counts / timestamps).
 * The handler derives `"sub-agent"` from parent metadata, `"group"` from a
 * shared endpoint-conversation partition, and `"dm"` otherwise. The contract
 * preserves the string shape rather than duplicating that domain classifier.
 */
export const SessionListContract = defineContract({
  method: "session.list",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    kind: z.string().optional(),
    since_minutes: z.number().optional(),
  }),
  response: z.object({
    sessions: z.array(z.object({
      conversationRef: z.string(),
      agentId: z.string(),
      kind: z.string(),
      endpoint: ChannelEndpointSchema.optional(),
      messageCount: z.number(),
      totalTokens: z.number(),
      updatedAt: z.number(),
      createdAt: z.number(),
    })),
    total: z.number(),
  }),
  // Agent-self read (classified "ungated" — read-only/lifecycle,
  // no in-handler admin check). rpc-scoped so an agent's own _agentId
  // rides it for self-scoping (the handler already filters to the caller's
  // sessions when _agentId is present) instead of being denied by the
  // deny-by-origin chokepoint. No cap required.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.search (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.search` — Full-text search over session messages with optional
 * scope filter (`user` / `assistant` / `tool` / `all`) and optional LLM
 * summarization of the top-5 matches. Recent-sessions mode when no query
 * is provided.
 * Handler: `session-handlers/session-list.ts`.
 *
 * Bespoke pre-Zod: none (handler defensively clamps `limit` to [1, 30]
 * for recent-mode and [1, 50] for search-mode).
 *
 * Request: `{ tenant_id, agent_id, query?, scope?, limit?, summarize? }`.
 *
 * Response: discriminated by `mode`:
 *   - `mode: "recent"` → `{ sessions: RecentSession[], total }` — recent
 *     sessions without query.
 *   - `mode: "search"` → `{ results: SearchResult[], total }` — matching
 *     results with snippet / score / timestamp; summary is optional.
 *
 * LOOSE-RECORD: response is a loose record because the two variants
 * carry disjoint top-level keys (`sessions + total` vs `results + total`).
 * Tight discriminated-union modeling would require pinning per-variant
 * field sets across daemon restarts on every CrossSessionSender shape addition.
 */
export const SessionSearchContract = defineContract({
  method: "session.search",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    query: z.string().optional(),
    scope: z.string().optional(),
    limit: z.number().optional(),
    summarize: z.boolean().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.history (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.history` — Paginated transcript + computed stats (token counts,
 * tool call counts, attachment markers). Falls back to JSONL workspace
 * file when SQLite doesn't have the session.
 * Handler: `session-handlers/session-read.ts`.
 *
 * Bespoke pre-Zod (no admin-gate — read-only):
 *   - Missing session in SQLite + workspace JSONL fallback miss →
 *     `"Session not found: <key>. Available session keys: ..."`.
 *
 * Request: `{ tenant_id, agent_id, conversation_ref, offset?, limit? }`.
 * Handler defaults offset=0, limit=20.
 *
 * Response: `{ session: SessionMeta, messages: Message[], total, offset,
 * limit, hasMore }`. `session` is tight-modeled to the handler's computed
 * statistics projection. `messages` is tight-modeled as
 * `{ role, content, timestamp, deliveryStatus? }`; the handler flattens
 * multi-part content to a string with attachment markers.
 */
export const SessionHistoryContract = defineContract({
  method: "session.history",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    conversation_ref: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  response: z.object({
    session: z.object({
      key: z.string(),
      agentId: z.string(),
      channelType: z.string(),
      endpoint: ChannelEndpointSchema.optional(),
      messageCount: z.number(),
      totalTokens: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      toolCalls: z.number(),
      compactions: z.number(),
      resetCount: z.number(),
      createdAt: z.number(),
      lastActiveAt: z.number(),
      label: z.string().optional(),
    }),
    messages: z.array(z.object({
      role: z.string(),
      content: z.string(),
      timestamp: z.number(),
      /** Derived delivery status. Outbound messages are "confirmed" iff no
       *  matching pending/in_flight/failed entry exists in the
       *  DeliveryQueuePort for the session's channelId + this message text;
       *  inbound (role "user") is always confirmed. Computed by the handler
       *  via DeliveryQueuePort join. The field is optional so existing RPC
       *  consumers that do not project it continue to validate. The MCP
       *  `resources/read` surface filters by `deliveryStatus === "confirmed"`
       *  to avoid exposing in-progress outbound messages to external MCP
       *  clients. */
      deliveryStatus: z.enum(["confirmed", "pending"]).optional(),
    })),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
    hasMore: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.send (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.send` — Send a message into another session under the
 * agent-to-agent policy and principal-isolation gates. Agent-origin calls are
 * confined to the caller's tenant and user. The target must be owned by the
 * same agent or be the exact child session delegated by that caller session.
 * Three delivery modes: `fire-and-forget`, `wait`, `ping-pong`.
 * Handler path: `packages/daemon/src/api/session-handlers/session-mutate.ts`.
 *
 * Bespoke pre-Zod:
 *   - `!deps.securityConfig.agentToAgent?.enabled` →
 *     `"Agent-to-agent messaging is disabled by policy. Enable
 *     security.agentToAgent.enabled in config."`
 *
 * Request: `{ tenant_id, agent_id, conversation_ref, text, mode?,
 * timeout_ms?, max_turns? }`. Agent-origin calls additionally require an
 * injected caller principal that agrees with request context; those internal
 * fields are not part of this contract.
 *
 * Response: LooseRecord at root. The handler delegates to
 * `crossSessionSender.send` whose return shape varies by mode (sync
 * response on `wait`/`ping-pong`, just `{ delivered }` on
 * `fire-and-forget`). Pinning the per-mode shape would re-encode
 * CrossSessionSender's return-shape matrix in the contract.
 */
export const SessionSendContract = defineContract({
  method: "session.send",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    conversation_ref: z.string(),
    text: z.string(),
    mode: z.string().optional(),
    timeout_ms: z.number().optional(),
    max_turns: z.number().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.spawn (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.spawn` — Start a background sub-agent run and return its run ID
 * immediately. Carries spawn-packet fields
 * (artifactRefs / objective / domainKnowledge / toolGroups /
 * includeParentHistory).
 * Handler: `session-handlers/session-mutate.ts`.
 *
 * Bespoke pre-Zod:
 *   - `!deps.securityConfig.agentToAgent?.enabled` →
 *     `"Agent-to-agent messaging is disabled by policy."`
 *
 * Request: `{ task, agent?, async?, max_steps?, model?, expected_outputs?,
 * artifact_refs?, objective?, domain_knowledge?, tool_groups?,
 * include_parent_history?, announce_channel_type?, announce_channel_id?,
 * worktree? }`. `worktree?` requests an isolated git worktree for the
 * child (auto-clean-if-unchanged + conservative orphan-sweep —
 * worktree-lifecycle.ts).
 *
 * The optional `async` request field is accepted, but there is no synchronous
 * execution path. Response: `{ runId, async: true, inProgress: true,
 * noteType: "background_running", queued?, deduped?, existingRunId?,
 * dedupAgeMs? }`.
 *
 * LOOSE-RECORD: response is loose at root — tight discriminated-union
 * modeling would require pinning the per-variant disjoint fields, and the
 * sub-agent runner's return shape is expected to grow as the spawn packet
 * surface evolves.
 */
export const SessionSpawnContract = defineContract({
  method: "session.spawn",
  request: z.object({
    task: z.string(),
    agent: z.string().optional(),
    async: z.boolean().optional(),
    max_steps: z.number().optional(),
    model: z.string().optional(),
    expected_outputs: z.array(z.string()).optional(),
    artifact_refs: z.array(z.string()).optional(),
    objective: z.string().optional(),
    domain_knowledge: z.array(z.string()).optional(),
    tool_groups: z.array(z.string()).optional(),
    required_tools: z.array(z.string()).optional(),
    include_parent_history: z.string().optional(),
    announce_channel_type: z.string().optional(),
    announce_channel_id: z.string().optional(),
    // Request an isolated git worktree for the child (its own working
    // tree on a fresh branch). The worktree is auto-cleaned ONLY if unchanged
    // (precise predicate: `status --porcelain` empty AND HEAD == base) and
    // orphans are conservatively swept — a dirty/ahead worktree is preserved.
    // See worktree-lifecycle.ts. (`--async` rides the already-async-only
    // spawn — `async` above is the existing flag, not a new path.)
    worktree: z.boolean().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.run_status (owner-scoped rpc/admin)
// ---------------------------------------------------------------------------

/**
 * `session.run_status` — Read a bounded, owner-authorized sub-agent run by runId,
 * including elapsed runtime, closed completion reason, and content-free
 * telemetry.
 * Handler: `session-handlers/session-read.ts` through the intrinsic status
 * projection.
 *
 * Missing and non-owned ids share the same authorization denial.
 *
 * Request: `{ run_id }`.
 *
 * Response is the content-bounded closed run-state union. Raw provider output,
 * task text, display session keys, and free-form error fields never cross this
 * status surface.
 *
 * The handler resolves exact caller or operator authority before reading the
 * run and strips bounded content fields for agent-origin callers.
 */
export const SessionRunStatusContract = defineContract({
  method: "session.run_status",
  request: z.strictObject({
    run_id: z.string().min(1).max(256),
  }),
  response: z.discriminatedUnion("status", [
    z.strictObject({
      runId: z.string().min(1).max(256),
      status: z.literal("queued"),
      agentId: z.string().min(1).max(256),
      queuedAt: z.number().int().nonnegative().safe(),
      runtimeMs: z.number().nonnegative().finite(),
    }),
    z.strictObject({
      runId: z.string().min(1).max(256),
      status: z.literal("running"),
      agentId: z.string().min(1).max(256),
      startedAt: z.number().int().nonnegative().safe(),
      runtimeMs: z.number().nonnegative().finite(),
    }),
    z.strictObject({
      runId: z.string().min(1).max(256),
      status: z.literal("completed"),
      agentId: z.string().min(1).max(256),
      startedAt: z.number().int().nonnegative().safe(),
      runtimeMs: z.number().nonnegative().finite(),
      completion: SubagentSuccessCompletionSchema,
      telemetry: SubagentRunTelemetrySchema,
    }),
    z.strictObject({
      runId: z.string().min(1).max(256),
      status: z.literal("failed"),
      agentId: z.string().min(1).max(256),
      startedAt: z.number().int().nonnegative().safe().optional(),
      runtimeMs: z.number().nonnegative().finite(),
      completion: SubagentFailureCompletionSchema,
      telemetry: SubagentRunTelemetrySchema.optional(),
    }),
  ]),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.delete (admin)
// ---------------------------------------------------------------------------

/**
 * `session.delete` — Archive and remove a session from the contract-bearing
 * store, clear approval and delivery-mirror state, and best-effort sever its
 * LCD and runtime transcripts. Admin-only.
 * Handler: `session-handlers/session-archive.ts`.
 *
 * Request: `{ tenant_id, agent_id, conversation_ref }`.
 *
 * Response: `{ conversationRef, deleted, transcript: { messages, metadata,
 * messageCount } }`. `transcript.messages` is loose-record-array
 * (raw stored messages preserved verbatim for archiving); `transcript.metadata`
 * is loose-record.
 */
export const SessionDeleteContract = defineContract({
  method: "session.delete",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    conversation_ref: z.string(),
  }),
  response: z.object({
    conversationRef: z.string(),
    deleted: z.literal(true),
    transcript: z.object({
      messages: z.array(z.record(z.string(), z.unknown())),
      metadata: z.record(z.string(), z.unknown()),
      messageCount: z.number(),
    }),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// session.reset (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.reset` — Clear working and runtime messages while preserving the
 * conversation identity. Agent-reachable and constrained to the exact
 * conversation partition. LCD history is intentionally left to
 * `session.reset_conversation`. Handler: `session-handlers/session-archive.ts`.
 *
 * Request: `{ tenant_id, agent_id, conversation_ref }`.
 * Response: `{ conversationRef, reset, previousMessageCount }`.
 */
export const SessionResetContract = defineContract({
  method: "session.reset",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    conversation_ref: z.string(),
  }),
  response: z.object({
    conversationRef: z.string(),
    reset: z.literal(true),
    previousMessageCount: z.number(),
  }),
  // Agent-reachable lifecycle op (classified "ungated"; NO
  // in-handler admin check, unlike session.delete/export/reset_conversation).
  // rpc-scoped so an agent can reset a session it operates on. No cap.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.export (admin)
// ---------------------------------------------------------------------------

/**
 * `session.export` — Full transcript dump including raw stored messages
 * and metadata. Admin-only, with contract scope and an in-handler trust check
 * providing defense in depth.
 * Handler: `session-handlers/session-archive.ts`.
 *
 * Request: `{ tenant_id, agent_id, conversation_ref }`.
 *
 * Response: `{ conversationRef, messages, metadata, messageCount, createdAt,
 * updatedAt }`. `messages` is loose-record-array (raw stored messages
 * preserved verbatim — provider-specific tool_use / image / audio shapes
 * pass through unchanged for archival fidelity). `metadata` is loose-record.
 */
export const SessionExportContract = defineContract({
  method: "session.export",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    conversation_ref: z.string(),
  }),
  response: z.object({
    conversationRef: z.string(),
    messages: z.array(z.record(z.string(), z.unknown())),
    metadata: z.record(z.string(), z.unknown()),
    messageCount: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// session.compact (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.compact` — Trigger session compaction (the actual summarization
 * is delegated; this handler only does the size accounting and returns the
 * planned operation). Agent-reachable and constrained to the exact conversation
 * partition. Handler: `session-handlers/session-mutate.ts`.
 *
 * Request: `{ tenant_id, agent_id, conversation_ref, instructions? }`.
 *
 * Response: `{ conversationRef, messageCount, estimatedTokens, compactionTriggered,
 * instructions: string | null }`. `compactionTriggered` is always `true`
 * (literal). `instructions` is z.nullable(z.string()) — handler returns
 * `instructions ?? null`.
 */
export const SessionCompactContract = defineContract({
  method: "session.compact",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    conversation_ref: z.string(),
    instructions: z.string().optional(),
  }),
  response: z.object({
    conversationRef: z.string(),
    messageCount: z.number(),
    estimatedTokens: z.number(),
    compactionTriggered: z.literal(true),
    instructions: z.nullable(z.string()),
  }),
  // Agent-reachable lifecycle op (classified "ungated"; NO
  // in-handler admin check). rpc-scoped so an agent can compact a
  // session it operates on. No cap.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.reset_conversation (admin)
// ---------------------------------------------------------------------------

/**
 * `session.reset_conversation` — Complete cross-mode forget for a session.
 * Clears the delivery mirror, LCD lossless-store history, daemon sessionStore
 * working transcript, and runtime session. After this, a follow-up turn has no
 * prior context in either engine mode.
 *
 * A LCD-only clear would provide no forget guarantee in pipeline mode —
 * both stores must be wiped together. Handler path:
 * session-archive.ts (bound in bindSessionArchiveHandlers).
 *
 * Admin-gated (defense-in-depth: contract scopes:["admin"] + in-handler
 * _trustLevel check). The operation is serialized against live ingest via
 * lcdStore.runOnConversation. Returns count-only — no message content is
 * returned or logged.
 *
 * `memory: true` additionally clears the conversation's RAG memories — the
 * GDPR / full-forget path. It deletes every memory row
 * matching `source_session_key` (BOTH paired-conversation AND lcd-distilled
 * episodic memories) for the (tenant, agent) scope, then unlinks them from
 * consolidated observations (orphan→delete, multi-source→keep). The response
 * then includes `memoriesDeleted` (the count). When the deployment has no
 * MemoryPort wired, `--memory` is honestly reported as ignored (a WARN) and
 * `memoriesDeleted` is omitted.
 *
 * `purge_derived: true` (opt-in, only meaningful with `memory: true`) escalates
 * to deleting EVERY consolidated observation derived from this session, even
 * those still corroborated by other sessions (nuclear forget — destructive).
 *
 * Best-effort on each layer:
 *   - If sessionStore has no entry for the session (e.g., dag conversation
 *     with LCD rows but no live session), `sessionMessagesCleared` is 0 and
 *     no error is raised.
 *   - If lcdStore returns 0 rows (e.g., pipeline-mode session with no LCD
 *     history), `lcdRowsDeleted` is 0 and no error is raised.
 *   - A RAG-memory delete failure is non-fatal — the LCD/sessionStore reset is
 *     preserved and the failure degrades to a WARN.
 *
 * Request: `{ tenant_id, agent_id, conversation_ref, memory?, purge_derived? }`.
 * Response: `{ conversationRef, lcdRowsDeleted, sessionMessagesCleared,
 * memoriesDeleted?, resolvedAgentId?, runtimeSessionDestroyed? }`.
 *
 * Schema uses the 12-shape allowlist: z.object, z.string, z.number,
 * z.boolean, z.optional (ASVS V5 / contract policy).
 */
export const SessionResetConversationContract = defineContract({
  method: "session.reset_conversation",
  request: z.object({
    tenant_id: z.string(),
    agent_id: z.string(),
    conversation_ref: z.string(),
    memory: z.boolean().optional(),
    purge_derived: z.boolean().optional(),
    // Admin-supplied tenant and agent authority is required for the exact
    // conversation partition being reset.
  }),
  response: z.object({
    conversationRef: z.string(),
    lcdRowsDeleted: z.number(),
    sessionMessagesCleared: z.number(),
    memoriesDeleted: z.number().optional(),
    // The agent the reset actually acted on (never a silent default).
    resolvedAgentId: z.string().optional(),
    // Without the runtime-layer destroy, the next turn re-ingests the
    // surviving pi session JSONL and resurrects the whole "forgotten"
    // conversation (lcd-ingest epoch rebase). True when the pi runtime
    // session was destroyed; false = the layer was unavailable and the
    // conversation may resurrect (WARN logged with the consequence).
    runtimeSessionDestroyed: z.boolean().optional(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// Aggregator
// ===========================================================================

/**
 * Tuple of every sessions-domain contract. The bidirectional architecture test
 * treats this as an unordered set; the order keeps status and messaging
 * operations ahead of lifecycle and administrator operations.
 */
export const SESSIONS_CONTRACTS = [
  // Agent-reachable RPC scope.
  SessionStatusContract,
  SessionSearchContract,
  SessionHistoryContract,
  SessionSendContract,
  SessionSpawnContract,
  SessionRunStatusContract,
  // Remaining lifecycle and administrator operations.
  AgentsListContract,
  SessionListContract,
  SessionDeleteContract,
  SessionResetContract,
  SessionExportContract,
  SessionCompactContract,
  // admin scope (session-archive.ts — complete cross-mode conversation reset)
  SessionResetConversationContract,
] as const;
