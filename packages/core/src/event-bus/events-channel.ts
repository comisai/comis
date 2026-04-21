// SPDX-License-Identifier: Apache-2.0
import type { SessionKey } from "../domain/session-key.js";
import type { ChannelCapability } from "../ports/channel-plugin.js";

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
  // Priority queue and elevated reply events
  // -------------------------------------------------------------------------

  /** Message assigned to a priority lane */
  "priority:lane_assigned": {
    sessionKey: SessionKey;
    channelType: string;
    lane: string;
    reason: string;
    timestamp: number;
  };

  /** Task promoted from lower lane due to aging */
  "priority:aged_promotion": {
    sessionKey: string;
    fromLane: string;
    toLane: string;
    waitTimeMs: number;
    timestamp: number;
  };

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

  /** Emitted when delivery is aborted (e.g., via AbortSignal). */
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

}
