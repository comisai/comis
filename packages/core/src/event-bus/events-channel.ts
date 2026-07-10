// SPDX-License-Identifier: Apache-2.0
import type { SessionKey } from "../domain/session-key.js";
import type { ChannelCapability } from "../domain/channel-capability.js";

/**
 * ChannelEvents: Channel, queue, streaming, typing, autoreply, sendpolicy,
 * debounce, group history, followup, priority, elevated, retry, and ack events.
 *
 * Find events by prefix: channel:*, queue:*, streaming:*, typing:*, autoreply:*,
 * sendpolicy:*, debounce:*, grouphistory:*, followup:*, priority:*, elevated:*, retry:*, ack:*, steer:*
 */
export interface ChannelEvents {
  /** Channel adapter registered via ChannelRegistry */
  "channel:registered": {
    channelType: string;
    pluginId: string;
    capabilities: ChannelCapability;
    timestamp: number;
  };

  /** Channel adapter deregistered via ChannelRegistry */
  "channel:deregistered": {
    channelType: string;
    pluginId: string;
    timestamp: number;
  };

  /**
   * An inbound reaction-add captured on a
   * Discord/Slack/Telegram message. Emitted by the orchestrator channel-manager
   * via the optional adapter.onReaction fanout; the daemon (setup-
   * learning) subscribes and observes a `reaction`-source outcome IFF the
   * messageId maps to an agent-authored outbound trajectory (fail-
   * closed). The reactorId/emoji are UNTRUSTED inbound — no trust is asserted
   * here. Counts/ids/emoji ONLY — never message bodies or sender display names
   * (§2.7); the emoji is matched against a CLOSED reactionMap downstream
   * and never flows into a prompt.
   */
  "channel:reaction_received": {
    messageId: string;
    reactorId: string;
    emoji: string;
    channelType: string;
    channelId: string;
    timestamp: number;
  };

  /** Sender blocked by allowFrom filter before agent resolution */
  "sender:blocked": {
    channelType: string;
    senderId: string;
    channelId: string;
    timestamp: number;
  };

  /** Message enqueued in command queue */
  "queue:enqueued": {
    sessionKey: SessionKey;
    channelType: string;
    queueDepth: number;
    mode: string;
    timestamp: number;
  };

  /** Message dequeued and execution started */
  "queue:dequeued": {
    sessionKey: SessionKey;
    channelType: string;
    waitTimeMs: number;
    timestamp: number;
  };

  /** Queue overflow policy triggered */
  "queue:overflow": {
    sessionKey: SessionKey;
    channelType: string;
    policy: string;
    droppedCount: number;
    timestamp: number;
  };

  /** Messages coalesced in collect mode */
  "queue:coalesced": {
    sessionKey: SessionKey;
    channelType: string;
    messageCount: number;
    timestamp: number;
  };

  /** Block streaming: a block was sent to the channel */
  "streaming:block_sent": {
    channelId: string;
    chatId: string;
    blockIndex: number;
    totalBlocks: number;
    charCount: number;
    timestamp: number;
  };

  /** Typing indicator started for a channel/chat */
  "typing:started": {
    channelId: string;
    chatId: string;
    mode: string;
    timestamp: number;
  };

  /** Typing indicator stopped for a channel/chat */
  "typing:stopped": {
    channelId: string;
    chatId: string;
    durationMs: number;
    timestamp: number;
  };

  /** Auto-reply engine activated the agent pipeline */
  "autoreply:activated": {
    channelId: string;
    senderId: string;
    activationMode: string;
    reason: string;
    timestamp: number;
  };

  /** Auto-reply engine suppressed a group message (not activating agent) */
  "autoreply:suppressed": {
    channelId: string;
    senderId: string;
    reason: string;
    injectedAsHistory: boolean;
    timestamp: number;
  };

  /** Send policy allowed an outbound message */
  "sendpolicy:allowed": {
    channelId: string;
    channelType: string;
    chatType?: string;
    reason: string;
    timestamp: number;
  };

  /** Send policy denied an outbound message */
  "sendpolicy:denied": {
    channelId: string;
    channelType: string;
    chatType?: string;
    reason: string;
    timestamp: number;
  };

  /** Per-session send override changed */
  "sendpolicy:override_changed": {
    sessionKey: SessionKey;
    override: string;
    changedBy: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Debounce events
  // -------------------------------------------------------------------------

  /** Message buffered by ingress debounce (waiting for window to expire) */
  "debounce:buffered": {
    sessionKey: SessionKey;
    channelType: string;
    bufferedCount: number;
    windowMs: number;
    timestamp: number;
  };

  /** Debounce window expired -- buffered messages flushed to queue */
  "debounce:flushed": {
    sessionKey: SessionKey;
    channelType: string;
    messageCount: number;
    trigger: "timer" | "overflow" | "shutdown";
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Group history and follow-up events
  // -------------------------------------------------------------------------

  /** Group history context injected into agent prompt */
  "grouphistory:injected": {
    sessionKey: string;
    channelType: string;
    messageCount: number;
    charCount: number;
    timestamp: number;
  };

  /** Follow-up agent run enqueued after tool/compaction trigger */
  "followup:enqueued": {
    sessionKey: string;
    channelType: string;
    reason: "tool_result" | "compaction";
    chainId: string;
    chainDepth: number;
    timestamp: number;
  };

  /** Follow-up chain depth limit reached (no more follow-ups) */
  "followup:depth_exceeded": {
    sessionKey: string;
    chainId: string;
    maxDepth: number;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Elevated reply events
  // -------------------------------------------------------------------------

  /** Elevated model route selected based on sender trust */
  "elevated:model_routed": {
    sessionKey: string;
    senderTrustLevel: string;
    modelRoute: string;
    agentId: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Retry engine events (message delivery resilience)
  // -------------------------------------------------------------------------

  /** Message delivery retry attempted */
  "retry:attempted": {
    channelId: string;
    chatId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
    timestamp: number;
  };

  /** Message delivery retry exhausted (all attempts failed) */
  "retry:exhausted": {
    channelId: string;
    chatId: string;
    totalAttempts: number;
    finalError: string;
    timestamp: number;
  };

  /** Markdown fallback triggered (parse error -> plain text) */
  "retry:markdown_fallback": {
    channelId: string;
    chatId: string;
    originalParseMode: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Ack reaction events
  // -------------------------------------------------------------------------

  /** Ack reaction sent to acknowledge message processing started */
  "ack:reaction_sent": {
    channelId: string;
    channelType: string;
    messageId: string;
    emoji: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Steer lifecycle events
  // -------------------------------------------------------------------------

  /** SDK session.steer() successfully injected a mid-stream message */
  "steer:injected": {
    sessionKey: SessionKey;
    channelType: string;
    agentId: string;
    timestamp: number;
  };

  /** Steer rejected: session is not streaming or is compacting */
  "steer:rejected": {
    sessionKey: SessionKey;
    channelType: string;
    agentId: string;
    reason: "not_streaming" | "compacting" | "no_active_run";
    timestamp: number;
  };

  /** Message queued as follow-up because steer was not possible */
  "steer:followup_queued": {
    sessionKey: SessionKey;
    channelType: string;
    agentId: string;
    reason: "not_streaming" | "compacting";
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Block coalescer events
  // -------------------------------------------------------------------------

  /** Coalesced block buffer flushed to delivery pipeline */
  "coalesce:flushed": {
    channelId: string;
    chatId: string;
    blockCount: number;
    charCount: number;
    trigger: "size" | "idle" | "boundary" | "end_of_response";
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Unified delivery events
  // -------------------------------------------------------------------------

  /** Emitted per chunk sent through deliverToChannel. */
  "delivery:chunk_sent": {
    channelId: string;
    channelType: string;
    chunkIndex: number;
    totalChunks: number;
    charCount: number;
    ok: boolean;
    retried: boolean;
    timestamp: number;
  };

  /** Emitted when a full deliverToChannel call completes. */
  "delivery:complete": {
    channelId: string;
    channelType: string;
    totalChunks: number;
    deliveredChunks: number;
    failedChunks: number;
    totalChars: number;
    durationMs: number;
    origin: string;
    strategy?: "all-or-abort" | "best-effort";
    timestamp: number;
  };

  /** Emitted when delivery is aborted (e.g., via AbortSignal). Also emitted by
   *  the orchestrator delivery stage when an already-aborted execution signal
   *  made the block pacer skip EVERY block without reaching deliverToChannel —
   *  the trajectory otherwise records nothing for a turn whose reply was never
   *  sent (`chunksDelivered: 0`, `reason` = the abort reason). */
  "delivery:aborted": {
    channelId: string;
    channelType: string;
    reason: string;
    chunksDelivered: number;
    totalChunks: number;
    durationMs: number;
    origin: string;
    timestamp: number;
  };

  /**
   * The per-turn activity coordinator dispatched `renderer.finalize` — the
   * decision that paints the activity surface's TERMINAL state (the kept
   * "❌ {errorKind}" pill, the deleted scaffold, the silent no-op). Content-free:
   * a closed outcome kind + the closed ErrorKind + a fixed named-constant
   * `reason` + the strategy name. `reclassified` marks the failed-event
   * reclassify (a delivered success flipped to success_with_recovered_failures
   * because a tool step failed mid-turn but the answer still landed) so the
   * pill's terminal fate is explainable from the trajectory alone instead of
   * coordinator source-reading.
   */
  "activity:turn_finalized": {
    sessionKey: string;
    agentId: string;
    channelType: string;
    /** The renderer strategy that painted the surface (EditPlace / AppendOnly / …). */
    strategy: string;
    /** The EFFECTIVE outcome kind dispatched to the renderer. */
    outcome: "success" | "success_with_recovered_failures" | "failure" | "silent" | "aborted";
    errorKind?: string;
    /** The fixed one-line human reason for a resource abort, when present. */
    reason?: string;
    /** True when an observed failed event flipped a delivered success to
     *  success_with_recovered_failures. */
    reclassified: boolean;
    /** How many observed events had status "failed" during the turn. */
    failedEventCount: number;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Delivery queue events
  // -------------------------------------------------------------------------

  /** Outbound chunk persisted in delivery queue before send attempt. */
  "delivery:enqueued": {
    entryId: string;
    channelId: string;
    channelType: string;
    origin: string;
    timestamp: number;
  };

  /** Queue entry acknowledged after successful platform delivery. */
  "delivery:acked": {
    entryId: string;
    channelId: string;
    channelType: string;
    messageId: string;
    durationMs: number;
    timestamp: number;
  };

  /**
   * A minted agent-reply
   * messageId was bound to its trajectory scope on the PRIMARY inbound-reply
   * (direct-ack) path — the positive proof that the reaction->trajectory
   * binding fired. Emitted right after `recordOutboundMessage` in the
   * fail-closed branch (a successful ack with a non-null traceId AND agentId),
   * so a later reaction map-miss is one-call diagnosable: a `delivery:reply_bound`
   * for the messageId means the bind fired (a subsequent miss is an eviction,
   * not a never-bound), and its absence means the bind never fired. Shares the
   * `messageId` with the `delivery:acked` event emitted on the same chunk, so
   * the attribution is reconstructable from the event trail. COUNTS/IDS/closed-
   * scalars ONLY — never a message body or a secret (§2.7); the
   * `agentId` is the REAL agent partition (never the tenantId).
   */
  "delivery:reply_bound": {
    messageId: string;
    channelId: string;
    channelType: string;
    traceId: string;
    agentId: string;
    timestamp: number;
  };

  /** Queue entry nacked for transient failure -- scheduled for retry. */
  "delivery:nacked": {
    entryId: string;
    channelId: string;
    channelType: string;
    error: string;
    attemptCount: number;
    nextRetryAt: number;
    timestamp: number;
  };

  /** Queue entry permanently failed -- no more retries. */
  "delivery:failed": {
    entryId: string;
    channelId: string;
    channelType: string;
    error: string;
    reason: "permanent_error" | "retries_exhausted";
    timestamp: number;
  };

  /** Delivery queue drain cycle completed. */
  "delivery:queue_drained": {
    entriesAttempted: number;
    entriesDelivered: number;
    entriesFailed: number;
    durationMs: number;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Channel health monitoring events
  // -------------------------------------------------------------------------

  /** Channel health state transition detected by the health monitor. */
  "channel:health_changed": {
    channelType: string;
    previousState: string;
    currentState: string;
    connectionMode: "socket" | "polling" | "webhook";
    error: string | null;
    lastMessageAt: number | null;
    timestamp: number;
  };

  /** Channel health check probe completed. */
  "channel:health_check": {
    channelType: string;
    state: string;
    responseTimeMs: number;
    timestamp: number;
  };

  /**
   * A webhook channel has received no inbound activity for longer than its
   * configured missed-inbound threshold. Raised by the daemon liveness timer
   * (independent of the stale-reap-exempt health monitor). Content-free —
   * labels, counts, and timestamps only, never message bodies.
   */
  "channel:inbound_silent": {
    channelType: string;
    lastInboundAt: number | null;
    silentForMs: number;
    thresholdMs: number;
    timestamp: number;
  };

  /**
   * An inbound activity was REJECTED at a channel gateway ingress auth gate
   * (a missing bearer pre-gate, or a signed-token validation failure) before
   * any body parse or adapter dispatch. Raised by the ingress through an
   * injected content-free hook so a forged / expired / wrong-audience /
   * missing-token FLOOD against the public messaging endpoint is COUNTABLE by
   * the fleet lens instead of living only in a raw WARN. Content-free by
   * construction: the closed `reason` class + the channel label ONLY — never
   * the bearer token, the Authorization header, or the request body (§2.7 and
   * the opaque-401 contract: the forged material is counted without being
   * echoed). Daemon-global — no agentId/sessionKey.
   */
  "channel:ingress_auth_rejected": {
    channelType: string;
    reason: "missing_bearer" | "invalid_token";
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Delivery hook events
  // -------------------------------------------------------------------------

  /** Delivery cancelled by a before_delivery hook. */
  "delivery:hook_cancelled": {
    channelId: string;
    channelType: string;
    reason: string;
    origin: string;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Sub-agent proxy typing events
  // -------------------------------------------------------------------------

  /** Typing proxy started for a delegated sub-agent run on the parent channel. */
  "typing:proxy_start": {
    runId: string;
    channelType: string;
    channelId: string;
    parentSessionKey: string;
    agentId: string;
    /** Optional thread ID for forum topic routing from requesterOrigin. */
    threadId?: string;
    timestamp: number;
  };

  /** Typing proxy stopped for a delegated sub-agent run. */
  "typing:proxy_stop": {
    runId: string;
    channelType: string;
    channelId: string;
    reason: "completed" | "failed" | "killed" | "ttl_expired" | "ghost_sweep" | "watchdog_timeout";
    durationMs: number;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Dedup events
  // -------------------------------------------------------------------------

  /** Duplicate inbound message detected within dedup window */
  "dedup:duplicate_inbound": {
    messageId:   string;
    channelType: string;
    chatId:      string;
    firstSeenAt: number;
    duplicateAt: number;
    deltaMs:     number;
    source:      "queue" | "channel" | "pipeline";
  };

}
