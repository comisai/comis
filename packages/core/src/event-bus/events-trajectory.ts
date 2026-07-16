// SPDX-License-Identifier: Apache-2.0
/**
 * TrajectoryEvents: the trajectory-observability lifecycle events
 * (`prompt:*`, `session:*`, `memory:injected`, `tool:timeout`) consumed by the
 * trajectory event-bus bridge, plus the content-free
 * `observability:trajectory_degraded` persistence-health signal.
 *
 * A standalone domain interface, composed into `EventMap` (events.ts) exactly
 * like the other domain groups (AgentEvents / ChannelEvents / TerminalEvents / …).
 *
 * Lifecycle members are subscribed via
 * @comis/observability/trajectory/event-bus-bridge.ts. The degradation member
 * is consumed by daemon diagnostic persistence because the failed recorder
 * cannot record its own failure. Each is emitted at a single canonical site.
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
   * Session trajectory started — emitted on the first pi-mono `agent_start`
   * for a logical session. The session-scoped registry suppresses later
   * turns and restores that latch from the durable trajectory after restart.
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
   * packages/agent/src/executor/executor-post-execution.ts.
   *
   * `topErrorKinds` (keys ⊂ the closed `ErrorKind` union, capped at 3) and
   * `source` (provenance enum, mirroring the session-index SSOT) are carried
   * onto the event so they land in the persisted `obs_diagnostics` row and the
   * fleet aggregate (`aggregateSessionsInWindow`) can read them
   * without opening per-session `_session-metadata.json` files. Production emits
   * the constant `source: "runtime"`; tests inject `"test"` / `"bench"`.
   *
   * `endReason` is the SAME mapped `SessionMetadata.sessionEnd.endReason` the
   * chokepoint derives ONCE via `END_REASON_MAP` (executor-post-execution.ts) and
   * co-persists onto `sessionEnd`. Carrying it here threads the NAMED degradation
   * cause (e.g. `context_exhausted` / `output_starved`, the named degradation
   * detectors) into the persisted row so `obs.fleet.health` can aggregate
   * `degradedByCause` from the rows alone — never opening per-session metadata. It
   * is a closed-set label (the endReason union), never free text.
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
    /** The mapped endReason (the named degradation cause) — closed-set label. */
    endReason: string;
    timestamp: number;
  };

  /**
   * The trajectory recorder could not safely resume an existing JSONL stream.
   * This is a content-free health signal: correlation identifiers plus closed
   * failure labels only. The operator-facing error stays on the structured ERROR;
   * no filesystem path, error message, or trajectory content rides this event.
   */
  "observability:trajectory_degraded": {
    agentId: string;
    sessionKey: string;
    traceId: string;
    reason: "resume_failed";
    failureKind:
      | "permission"
      | "confinement"
      | "symlink"
      | "non_regular"
      | "size_limit"
      | "invalid_jsonl"
      | "changed"
      | "io";
    timestamp: number;
  };

  /**
   * RAG memory was injected into the prompt for this turn. Fires only on
   * turns where the hybrid memory injector actually emitted at least one
   * section / inline string — no-injection turns produce no event.
   *
   * Emit site: `packages/agent/src/executor/prompt-assembly.ts`, after the
   * hybrid split. `charsInjected`/`hitCount` count RETRIEVED memory only
   * (inline + retrieved sections); the temporal-guidance block is fixed
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
