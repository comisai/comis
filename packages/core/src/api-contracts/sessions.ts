// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions-domain RPC contracts. Mirrors the single daemon handler factory
 * file `packages/daemon/src/api/session-handlers.ts` that owns the
 * `SessionsApiDeps` cluster slice:
 *
 *   - `session-handlers.ts`  (12 methods — session.* + agents.list)
 *
 * **Scope assignments** (mirror `setup-gateway-api.ts` registrations):
 *
 *   session-handlers.ts (mixed rpc + admin scope groups):
 *
 *   rpc (setup-gateway-api.ts:136-145 — "Bridge session/cron methods"):
 *   - `session.send`        (rpc — agent-to-agent messaging)
 *   - `session.spawn`       (rpc — sub-agent spawn)
 *   - `session.status`      (rpc — read-only health/token check)
 *   - `session.history`     (rpc — read-only transcript)
 *   - `session.search`      (rpc — read-only full-text search)
 *   - `session.run_status`  (rpc — intrinsic registration via rpc-dispatch,
 *                                  same pattern as scheduler.wake / delivery.queue.status;
 *                                  no explicit setup-gateway-api.ts entry)
 *
 *   admin (setup-gateway-api.ts:203-207 — "Agent management admin"):
 *   - `agents.list`         (admin — fleet read; OWNED BY session-handlers.ts:272
 *                                    — the handler ownership is in
 *                                    session-handlers.ts even though the name
 *                                    suggests agents.ts, so the contract lives here)
 *
 *   admin (setup-gateway-api.ts:213-215 — "Session management admin"):
 *   - `session.list`        (admin — fleet read)
 *   - `session.delete`      (admin — destructive)
 *   - `session.reset`       (admin — destructive, preserves identity metadata)
 *   - `session.export`      (admin — full transcript dump)
 *   - `session.compact`     (admin — destructive summarization)
 *
 * **Loose-record use** (escape hatch). The transcript / messages surface
 * in session.* responses carries arbitrary message
 * payloads (provider-specific shapes — Anthropic / OpenAI / Google
 * differ on tool_use blocks, image parts, audio parts, etc.). Pinning
 * the per-message shape would re-encode the entire provider matrix in
 * the contract — the contract layer carries loose records here:
 *
 *   - `session.history.response.messages` — array of `{ role, content, timestamp }`
 *     where `content` is `z.string()` (the handler already projects multi-part
 *     content arrays into a flat string per message — handler:600-654).
 *   - `session.export.response.messages` — array of LooseRecord (raw stored
 *     messages, NOT projected — used for full transcript archiving with
 *     provider-specific shapes preserved).
 *   - `session.delete.response.transcript.messages` — same as session.export.
 *   - `session.send.response` — LooseRecord at root (delegates to
 *     `crossSessionSender.send` whose return shape varies by mode
 *     fire-and-forget / wait / ping-pong).
 *   - `session.search.response.results[]` — tight modeled (snippet / score /
 *     timestamp), but per-message text projection during search is loose.
 *   - `session.list.response.sessions[].metadata` — LooseRecord (carries
 *     `parentSessionKey` + `_workspaceJsonlPath` + arbitrary user-set
 *     metadata).
 *
 * Modelling these tighter would re-encode the entire SessionData /
 * MessageContent / CrossSessionSender surface in the contract — pinning
 * the wire format across daemon restarts on every provider SDK update.
 *
 * **TIGHT modeling preferred for primitive-leaf response shapes.**
 * session.status (tokensUsed/stepsExecuted/maxSteps numerics + agentName/model
 * strings), session.delete (sessionKey/deleted flag + transcript.messageCount),
 * session.reset (sessionKey/reset/previousMessageCount), session.compact
 * (sessionKey/messageCount/estimatedTokens/compactionTriggered/instructions
 * nullable), session.run_status (runId/status/agentId/task/sessionKey strings
 * + timestamps + tokensUsed/cost loose-records), session.spawn (4 response
 * variants — async-running, async-queued, sync-success, timeout — see
 * per-contract JSDoc for variant union).
 *
 * **Allowlist compliance.** All schemas use the 12-shape allowlist:
 * z.object, z.string, z.number, z.boolean, z.literal, z.array, z.optional,
 * z.nullable, z.record (loose-record value-type — used in 8 distinct
 * field positions). No refinements (`.url()`, `.regex()`, `.refine`,
 * `.transform`).
 *
 * **Single-scope invariant.** Every contract in this file has exactly ONE
 * scope (scopes.length === 1). Verified by an inline test in sessions.test.ts.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ===========================================================================
// session-handlers.ts (12 methods)
// ===========================================================================

// ---------------------------------------------------------------------------
// session.status (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.status` — Per-agent runtime stats (model, agent name, token / cost
 * totals, step counter). Handler path: session-handlers.ts:254-270.
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
 * `agents.list` — Return the array of configured agent IDs. Owned by
 * session-handlers.ts:272-274 (NOT agent-handlers.ts despite the name).
 * Admin-scoped per setup-gateway-api.ts:203-207.
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
// session.list (admin)
// ---------------------------------------------------------------------------

/**
 * `session.list` — Aggregated session list across SQLite + JSONL + workspace
 * sources, with optional recency + kind filters and sandboxed sub-agent
 * visibility. Admin-scoped per setup-gateway-api.ts:213-215.
 * Handler path: session-handlers.ts:276-366.
 *
 * Bespoke pre-Zod: none.
 *
 * Request: `{ kind?, since_minutes? }`. The dispatcher injects
 * `_callerMetadata`, `_callerSessionKey`, `_tenantId` AFTER the contract
 * parse — those are NOT modeled here. The handler reads them from
 * rawParams BEFORE strip.
 *
 * Response: `{ sessions: SessionInfo[], total }`. Each `SessionInfo` is
 * tight-modeled (sessionKey / agentId / userId / channelId / kind / counts /
 * timestamps). Three known kinds are produced by the handler: `"sub-agent"`
 * (when metadata.parentSessionKey is set), `"group"` (when guildId is in
 * the session key), `"dm"` (otherwise). The contract preserves the string
 * shape rather than an enum to allow future kinds without contract churn.
 */
export const SessionListContract = defineContract({
  method: "session.list",
  request: z.object({
    kind: z.string().optional(),
    since_minutes: z.number().optional(),
  }),
  response: z.object({
    sessions: z.array(z.object({
      sessionKey: z.string(),
      agentId: z.string(),
      userId: z.string(),
      channelId: z.string(),
      kind: z.string(),
      messageCount: z.number(),
      totalTokens: z.number(),
      updatedAt: z.number(),
      createdAt: z.number(),
    })),
    total: z.number(),
  }),
  // 210-GAP MD-01: agent-self read (classified "ungated" — read-only/lifecycle,
  // no in-handler admin check). Re-scoped admin→rpc so an agent's own _agentId
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
 * Handler path: session-handlers.ts:368-517.
 *
 * Bespoke pre-Zod: none (handler defensively clamps `limit` to [1, 30]
 * for recent-mode and [1, 50] for search-mode).
 *
 * Request: `{ query?, scope?, limit?, summarize? }`. `_agentId` internal is
 * dispatcher-injected for caller-scoping (the handler filters sessions to
 * those whose key prefix matches caller's agentId).
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
 * Handler path: session-handlers.ts:519-709.
 *
 * Bespoke pre-Zod (no admin-gate — read-only):
 *   - Missing session in SQLite + workspace JSONL fallback miss →
 *     `"Session not found: <key>. Available session keys: ..."`.
 *
 * Request: `{ session_key, offset?, limit? }`. Handler defaults offset=0,
 * limit=20.
 *
 * Response: `{ session: SessionMeta, messages: Message[], total, offset,
 * limit, hasMore }`. `session` is tight-modeled per the handler's
 * computed-stats projection (handler:683-697). `messages` is tight-modeled
 * `{ role, content, timestamp }` (the multi-part content array is flattened
 * to a string + attachment markers per handler:600-654).
 */
export const SessionHistoryContract = defineContract({
  method: "session.history",
  request: z.object({
    session_key: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  response: z.object({
    session: z.object({
      key: z.string(),
      agentId: z.string(),
      channelType: z.string(),
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
 * agent-to-agent policy gate. Three delivery modes: `fire-and-forget`,
 * `wait`, `ping-pong`.
 * Handler path: session-handlers.ts:711-730.
 *
 * Bespoke pre-Zod:
 *   - `!deps.securityConfig.agentToAgent?.enabled` →
 *     `"Agent-to-agent messaging is disabled by policy. Enable
 *     security.agentToAgent.enabled in config."`
 *
 * Request: `{ session_key, text, mode?, timeout_ms?, max_turns?, agent_id? }`.
 * The dispatcher injects `_callerSessionKey`, `_callerChannelType`,
 * `_callerChannelId` — NOT declared in the contract here.
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
    session_key: z.string(),
    text: z.string(),
    mode: z.string().optional(),
    timeout_ms: z.number().optional(),
    max_turns: z.number().optional(),
    agent_id: z.string().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.spawn (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.spawn` — Spawn a sub-agent run, either async (returns runId) or
 * sync (polls until complete or timeout). Carries spawn-packet fields
 * (artifactRefs / objective / domainKnowledge / toolGroups /
 * includeParentHistory).
 * Handler path: session-handlers.ts:732-857.
 *
 * Bespoke pre-Zod:
 *   - `!deps.securityConfig.agentToAgent?.enabled` →
 *     `"Agent-to-agent messaging is disabled by policy."`
 *
 * Request: `{ task, agent?, async?, max_steps?, model?, expected_outputs?,
 * artifact_refs?, objective?, domain_knowledge?, tool_groups?,
 * include_parent_history?, announce_channel_type?, announce_channel_id?,
 * worktree? }`. `worktree?` (WT-01) requests an isolated git worktree for the
 * child (auto-clean-if-unchanged + conservative orphan-sweep —
 * worktree-lifecycle.ts).
 *
 * Response has 4 variants discriminated by combination of fields:
 *   - sync-success: `{ sessionKey, response?, tokensUsed?, finishReason?,
 *     announced, taskDescription }`.
 *   - sync-timeout: `{ runId, async: true, note }`.
 *   - async-running: `{ runId, async: true }`.
 *   - async-queued: `{ runId, async: true, queued: true }`.
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
    // WT-01: request an isolated git worktree for the child (its own working
    // tree on a fresh branch). The worktree is auto-cleaned ONLY if unchanged
    // (precise predicate: `status --porcelain` empty AND HEAD == base) and
    // orphans are conservatively swept — a dirty/ahead worktree is preserved.
    // See worktree-lifecycle.ts. (WT-03: `--async` rides the already-async-only
    // spawn — `async` above is the existing flag, not a new path.)
    worktree: z.boolean().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.run_status (rpc)
// ---------------------------------------------------------------------------

/**
 * `session.run_status` — Poll a sub-agent run by runId. Returns full
 * run status including elapsed runtime, response/tokens/cost on completion,
 * or error message on failure.
 * Handler path: session-handlers.ts:859-877.
 *
 * Bespoke pre-Zod:
 *   - Unknown runId → `"Unknown run ID: <id>"`.
 *
 * Request: `{ run_id }`.
 *
 * Response: `{ runId, status, agentId, task, sessionKey, startedAt,
 * completedAt?, runtimeMs, response?, tokensUsed?, cost?, error? }`.
 * `runtimeMs` is computed (completedAt - startedAt OR Date.now() -
 * startedAt for still-running runs). `tokensUsed` and `cost` are
 * loose-records (provider-specific shapes — cost is `{ input, output,
 * total }` for some providers; runners may add cache fields).
 *
 * Intrinsic registration (no explicit setup-gateway-api.ts entry); same
 * pattern as scheduler.wake and delivery.queue.status. Scope: "rpc" per
 * the rpc-dispatch default.
 */
export const SessionRunStatusContract = defineContract({
  method: "session.run_status",
  request: z.object({
    run_id: z.string(),
  }),
  response: z.object({
    runId: z.string(),
    status: z.string(),
    agentId: z.string(),
    task: z.string(),
    sessionKey: z.string().optional(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
    runtimeMs: z.number(),
    response: z.string().optional(),
    tokensUsed: z.record(z.string(), z.unknown()).optional(),
    cost: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.delete (admin)
// ---------------------------------------------------------------------------

/**
 * `session.delete` — Remove a session from SQLite, archive its transcript,
 * and clear approval-cache entries. Admin-only.
 * Handler path: session-handlers.ts:879-902.
 *
 * Bespoke pre-Zod:
 *   - `_trustLevel !== "admin"` → `"Admin trust level required"`.
 *   - Missing `session_key` → `"Missing required parameter: session_key"`.
 *   - Unknown session → `"Session not found: <key>"`.
 *
 * Request: `{ session_key }`.
 *
 * Response: `{ sessionKey, deleted, transcript: { messages, metadata,
 * messageCount } }`. `transcript.messages` is loose-record-array
 * (raw stored messages preserved verbatim for archiving); `transcript.metadata`
 * is loose-record.
 */
export const SessionDeleteContract = defineContract({
  method: "session.delete",
  request: z.object({
    session_key: z.string(),
  }),
  response: z.object({
    sessionKey: z.string(),
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
// session.reset (admin)
// ---------------------------------------------------------------------------

/**
 * `session.reset` — Clear messages from a session while preserving its
 * identity metadata. Admin-only (registered admin scope per
 * setup-gateway-api.ts:213-215 — no in-handler admin check, the trust
 * gate is at the dispatcher).
 * Handler path: session-handlers.ts:904-920.
 *
 * Bespoke pre-Zod:
 *   - Missing `session_key` → `"Missing required parameter: session_key"`.
 *   - Unknown session → `"Session not found: <key>"`.
 *
 * Request: `{ session_key }`.
 * Response: `{ sessionKey, reset, previousMessageCount }`. Tight numeric leaf.
 */
export const SessionResetContract = defineContract({
  method: "session.reset",
  request: z.object({
    session_key: z.string(),
  }),
  response: z.object({
    sessionKey: z.string(),
    reset: z.literal(true),
    previousMessageCount: z.number(),
  }),
  // 210-GAP MD-01: agent-reachable lifecycle op (classified "ungated"; NO
  // in-handler admin check, unlike session.delete/export/reset_conversation).
  // Re-scoped admin→rpc so an agent can reset a session it operates on. No cap.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.export (admin)
// ---------------------------------------------------------------------------

/**
 * `session.export` — Full transcript dump including raw stored messages
 * and metadata. Admin-only (handler enforces admin trust check inline
 * AND registered admin-scope per setup-gateway-api.ts:213-215 —
 * defense-in-depth).
 * Handler path: session-handlers.ts:922-939.
 *
 * Bespoke pre-Zod:
 *   - `_trustLevel !== "admin"` → `"Admin trust level required"`.
 *   - Missing `session_key` → `"Missing required parameter: session_key"`.
 *   - Unknown session → `"Session not found: <key>"`.
 *
 * Request: `{ session_key }`.
 *
 * Response: `{ sessionKey, messages, metadata, messageCount, createdAt,
 * updatedAt }`. `messages` is loose-record-array (raw stored messages
 * preserved verbatim — provider-specific tool_use / image / audio shapes
 * pass through unchanged for archival fidelity). `metadata` is loose-record.
 */
export const SessionExportContract = defineContract({
  method: "session.export",
  request: z.object({
    session_key: z.string(),
  }),
  response: z.object({
    sessionKey: z.string(),
    messages: z.array(z.record(z.string(), z.unknown())),
    metadata: z.record(z.string(), z.unknown()),
    messageCount: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// session.compact (admin)
// ---------------------------------------------------------------------------

/**
 * `session.compact` — Trigger session compaction (the actual summarization
 * is delegated; this handler only does the size accounting and returns the
 * planned operation). Admin-scoped per setup-gateway-api.ts:213-215.
 * Handler path: session-handlers.ts:941-965.
 *
 * Bespoke pre-Zod:
 *   - Missing `session_key` AND no caller session → `"Missing required parameter:
 *     session_key"`.
 *   - Unknown session → `"Session not found: <key>"`.
 *
 * Request: `{ session_key?, instructions? }`. COMPACT-KEY (30uc-20260624):
 * `session_key` is OPTIONAL — omit it (or pass `"self"`/`"current"`) to compact
 * the CALLER's OWN session, resolved from the dispatcher-injected
 * `_callerSessionKey`, so an agent never constructs/guesses its own key.
 *
 * Response: `{ sessionKey, messageCount, estimatedTokens, compactionTriggered,
 * instructions: string | null }`. `compactionTriggered` is always `true`
 * (literal). `instructions` is z.nullable(z.string()) — handler returns
 * `instructions ?? null`.
 */
export const SessionCompactContract = defineContract({
  method: "session.compact",
  request: z.object({
    // OPTIONAL (COMPACT-KEY): omit or pass "self"/"current" to compact the
    // caller's own session via the injected _callerSessionKey.
    session_key: z.string().optional(),
    instructions: z.string().optional(),
  }),
  response: z.object({
    sessionKey: z.string(),
    messageCount: z.number(),
    estimatedTokens: z.number(),
    compactionTriggered: z.literal(true),
    instructions: z.nullable(z.string()),
  }),
  // 210-GAP MD-01: agent-reachable lifecycle op (classified "ungated"; NO
  // in-handler admin check). Re-scoped admin→rpc so an agent can compact a
  // session it operates on. No cap.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// session.reset_conversation (admin)
// ---------------------------------------------------------------------------

/**
 * `session.reset_conversation` — COMPLETE cross-mode forget for a session.
 * Clears BOTH the LCD lossless-store history AND the daemon sessionStore
 * working transcript (the JSONL-backed messages that feed `state.messages`
 * next turn). After this, a follow-up turn has NO prior context in both dag
 * mode (LCD empty) and pipeline mode (sessionStore empty → rehydrates empty).
 *
 * Supersedes the Phase 164-03 `context.reset_lcd` which cleared the LCD only
 * and therefore provided no forget guarantee in pipeline mode. Handler path:
 * session-archive.ts (bound in bindSessionArchiveHandlers).
 *
 * Admin-gated (defense-in-depth: contract scopes:["admin"] + in-handler
 * _trustLevel check). The operation is serialized against live ingest via
 * lcdStore.runOnConversation. Returns count-only — no message content is
 * returned or logged.
 *
 * `memory: true` additionally clears the conversation's RAG memories — the
 * GDPR / full-forget path (Phase 172-03 DIST-05). It deletes every memory row
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
 * Request: `{ session_key, memory?, purge_derived? }`.
 * Response: `{ sessionKey, lcdRowsDeleted, sessionMessagesCleared, memoriesDeleted?, runtimeSessionDestroyed? }`.
 *
 * Schema uses the 12-shape allowlist: z.object, z.string, z.number,
 * z.boolean, z.optional (ASVS V5 / contract policy).
 */
export const SessionResetConversationContract = defineContract({
  method: "session.reset_conversation",
  request: z.object({
    session_key: z.string(),
    memory: z.boolean().optional(),
    purge_derived: z.boolean().optional(),
    // TARGET-01: admin-supplied agent scope. This is an ADMIN RPC, so the caller is
    // trusted to name which agent's conversation to forget; absent, it falls back to
    // the default. Live finding 2026-06-13: a non-default agent's reset returned
    // lcdRowsDeleted:0 because the scope hardcoded the default agent (wrong scope).
    agentId: z.string().optional(),
  }),
  response: z.object({
    sessionKey: z.string(),
    lcdRowsDeleted: z.number(),
    sessionMessagesCleared: z.number(),
    memoriesDeleted: z.number().optional(),
    // TARGET-01: the agent the reset actually acted on (never a silent default).
    resolvedAgentId: z.string().optional(),
    // Live finding 2026-06-11: without the runtime-layer destroy the next
    // turn re-ingested the surviving pi session JSONL and resurrected the
    // whole "forgotten" conversation (lcd-ingest epoch rebase). True when the
    // pi runtime session was destroyed; false = the layer was unavailable and
    // the conversation may resurrect (WARN logged with the consequence).
    runtimeSessionDestroyed: z.boolean().optional(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// Aggregator
// ===========================================================================

/**
 * Tuple of every contract for the sessions umbrella (13 contracts spanning
 * the single `session-handlers.ts` factory file plus session-archive.ts).
 * The bidirectional 1:1 architecture test treats this as an unordered set;
 * the per-method order below mirrors `setup-gateway-api.ts` registration
 * order for documentation clarity (rpc group first, then admin group).
 */
export const SESSIONS_CONTRACTS = [
  // rpc scope (session-handlers.ts — registered at setup-gateway-api.ts:136-145
  // and intrinsic via rpc-dispatch for session.run_status)
  SessionStatusContract,
  SessionSearchContract,
  SessionHistoryContract,
  SessionSendContract,
  SessionSpawnContract,
  SessionRunStatusContract,
  // admin scope (session-handlers.ts — registered at setup-gateway-api.ts:213-215
  // for session.* + setup-gateway-api.ts:203-207 for agents.list)
  AgentsListContract,
  SessionListContract,
  SessionDeleteContract,
  SessionResetContract,
  SessionExportContract,
  SessionCompactContract,
  // admin scope (session-archive.ts — complete cross-mode conversation reset)
  SessionResetConversationContract,
] as const;
