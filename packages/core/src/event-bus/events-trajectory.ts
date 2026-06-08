// SPDX-License-Identifier: Apache-2.0
/**
 * TrajectoryEvents: the trajectory-observability lifecycle events
 * (`prompt:*`, `session:*`, `memory:injected`, `tool:timeout`) consumed by the
 * trajectory event-bus bridge.
 *
 * Extracted from `events-agent.ts` (which crossed the file-size cap) into its
 * own domain interface, composed into `EventMap` (events.ts) exactly like the
 * other domain groups (AgentEvents / ChannelEvents / TerminalEvents / …). No
 * behavior change — the event names + payload shapes are byte-identical to
 * their prior declarations in `AgentEvents`.
 *
 * Subscribed via @comis/observability/trajectory/event-bus-bridge.ts. Each is
 * emitted at a single canonical site and consumed via the EventBus rather than
 * call-site instrumentation.
 *
 * @module
 */

export interface TrajectoryEvents {
  /**
   * Prompt assembly completed; the next pi-mono `agent_start` call will
   * submit this exact `(systemPrompt, messages)` pair to the model.
   * `systemDigest` and `messagesDigest` are sha256 over the canonical
   * `stableStringify` of the respective inputs — they line up with the
   * SystemPromptReport digest and the cache-trace artifact for
   * cross-correlation.
   *
   * Emit site: `packages/agent/src/executor/prompt-runner/prompt-runner.ts`
   * after `wrapEnvelope()` returns and before `runRetryLoop`.
   */
  "prompt:submitted": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    promptChars: number;
    provider: string;
    modelId: string;
    messageCount: number;
    systemDigest: string;
    messagesDigest: string;
    timestamp: number;
  };

  /**
   * Agent run started — emitted on pi-mono `agent_start` (first turn of
   * an execution). Distinct from `session:created` which fires on
   * sessionStore creation; this fires per execute() lifecycle (every
   * inbound message starts a new agent run).
   *
   * Emit site: `packages/agent/src/bridge/pi-event-bridge.ts`
   */
  "session:started": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    channelType: string;
    channelId: string;
    accountId?: string;
    timestamp: number;
  };

  /**
   * Agent run ended — emitted on pi-mono `agent_end`. Carries aggregated
   * turn / token totals for the run plus an `exitReason` discriminator.
   *
   * Emit site: `packages/agent/src/bridge/pi-event-bridge.ts`
   */
  "session:ended": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    totalTurns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    durationMs: number;
    exitReason: string;
    timestamp: number;
  };

  /**
   * Per-session health rollup emitted once at agent-end. Emit site:
   * packages/agent/src/executor/executor-post-execution.ts (D5/F2).
   *
   * `topErrorKinds` (keys ⊂ the closed `ErrorKind` union, capped at 3) and
   * `source` (provenance enum, mirroring the session-index SSOT) are carried
   * onto the event so they land in the persisted `obs_diagnostics` row and the
   * fleet aggregate (`aggregateSessionsInWindow`, Phase 159 A1/A2) can read them
   * without opening per-session `_session-metadata.json` files. Production emits
   * the constant `source: "runtime"`; tests inject `"test"` / `"bench"`.
   */
  "session:summary": {
    sessionKey: string;
    agentId: string;
    traceId: string;
    degraded: boolean;
    turnCount: number;
    costUsd: number;
    toolStats: Record<string, { ok: number; failed: number }>;
    breakerTripCount: number;
    topErrorKinds: Record<string, number>;
    source: "runtime" | "test" | "bench";
    timestamp: number;
  };

  /**
   * RAG memory was injected into the prompt for this turn. Fires only on
   * turns where the hybrid memory injector actually emitted at least one
   * section / inline string — no-injection turns produce no event.
   *
   * Emit site: `packages/agent/src/executor/prompt-assembly.ts`, after the
   * hybrid split. `charsInjected`/`hitCount` count RETRIEVED memory only
   * (inline + retrieved sections); the §7.3 temporal-guidance block is fixed
   * guidance text and is deliberately NOT tallied here.
   */
  "memory:injected": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    hitCount: number;
    charsInjected: number;
    trustTags: string[];
    /** Number of pinned entries prepended to the recall result (Step 0 of the
     *  recall pipeline). Zero when pinning is disabled or no pins exist — the
     *  default-off byte-identical path. Surfaced here so trajectory consumers
     *  can distinguish pinned-first from fused-recall injection budgets. */
    pinnedCount?: number;
    timestamp: number;
  };

  /**
   * Explicit tool-timeout signal. Fires alongside `tool:executed` with
   * `errorKind: "timeout"` for the SAME physical timeout — both events
   * share `toolCallId` so the trajectory consumer can dedupe (the
   * `tool:executed` emit carries the full result; this event makes the
   * timeout case enumerable for the architecture test).
   *
   * Dedup contract: downstream trajectory consumers see both
   * `tool.result` (from `tool:executed`) AND `tool.timeout` (from this
   * event) for any physical tool timeout. Both carry `toolCallId`; join
   * on that key to avoid double-counting.
   *
   * Emit site: `packages/agent/src/bridge/pi-event-bridge.ts` in the
   * `tool_execution_end` branch when `toolErrorKind === "timeout"`.
   */
  "tool:timeout": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    toolName: string;
    toolCallId?: string;
    timeoutMs: number;
    timestamp: number;
  };
}
