// SPDX-License-Identifier: Apache-2.0
/**
 * Announcement batcher for coalescing near-simultaneous sub-agent completions.
 * When multiple sub-agents complete within seconds of each other for the same
 * parent session, the batcher debounces and combines their announcements into a
 * single batched LLM execution -- reducing N sequential parent calls to 1.
 * Single completions with no siblings deliver after the debounce timer with
 * original text unmodified (no batching overhead).
 * @module
 */

import { parseFormattedSessionKey, type SessionKey, type TypedEventBus, systemNowMs, systemSetTimeout, systemClearTimeout, systemScheduleTimeout } from "@comis/core";
import { withTimeout } from "@comis/shared";

/** Hard timeout for announceToParent calls (300 seconds / 5 minutes).
 *  Parent agents may call slow tools (image generation at 120s, web search, etc.)
 *  in response to announcements. 30s caused premature fallback + duplicate delivery.
 *  Inlined locally (rather than imported from packages/daemon/src/sub-agent-runner.ts)
 *  to avoid an orchestrator -> daemon back-edge; the daemon-side constant
 *  remains the canonical export for daemon consumers. */
const ANNOUNCE_PARENT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface QueuedAnnouncement {
  announcementText: string;
  announceChannelType: string;
  announceChannelId: string;
  callerAgentId: string;
  callerSessionKey: string;
  runId: string;
  /** Idempotency key `${callerSessionKey}::${runId}` (DELIVERY-01). Built once at the delivery entry; opaque here. Undefined for a top-level spawn (no callerSessionKey). */
  idempotencyKey?: string;
}

export interface AnnouncementBatcherDeps {
  announceToParent: (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    text: string,
    channelType: string,
    channelId: string,
  ) => Promise<void>;
  sendToChannel: (channelType: string, channelId: string, text: string, options?: { extra?: Record<string, unknown> }) => Promise<boolean>;
  logger?: {
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  debounceMs?: number;
  /** Optional dead-letter queue for persisting fallback delivery failures */
  deadLetterQueue?: {
    enqueue(entry: {
      announcementText: string;
      channelType: string;
      channelId: string;
      runId: string;
      failedAt: number;
      attemptCount: number;
      lastError?: string;
      /** Idempotency key `${callerSessionKey}::${runId}` (DELIVERY-01), carried onto the dead-letter entry. */
      idempotencyKey?: string;
    }): void;
  };
  // -------------------------------------------------------------------------
  // DELIVERY-02 self-healing retry (all OPTIONAL — injected from the daemon
  // wiring via DI; absent → the fallback stays single-attempt-then-DLQ as
  // before, so existing construction/tests are byte-identical).
  // -------------------------------------------------------------------------
  /**
   * Classify a fallback delivery failure as transient (retryable) or permanent.
   * Narrow structural return so the orchestrator does NOT import the agent type;
   * the daemon wiring binds `@comis/agent`'s `classifyErrorContext(msg, "failed")`.
   */
  classifyErrorContext?: (errorMessage: string) => { retryable: boolean };
  /** Pure exponential backoff (ms) for retry `attempt` (1-based). Injected from `@comis/daemon`'s `computeRetryBackoff` (orchestrator cannot import daemon). */
  computeRetryBackoff?: (attempt: number) => number;
  /** Max retry attempts for a transient failure before dead-lettering (default 3). From `security.agentToAgent.delivery.maxRetries`. */
  maxRetries?: number;
  /** Typed event bus for the counts/ids-only delivery_retried / delivery_deadlettered events (§2.7). */
  eventBus?: Pick<TypedEventBus, "emit">;
}

export interface AnnouncementBatcher {
  enqueue(params: QueuedAnnouncement): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly pending: number;
  /** DELIVERY-01: has this idempotency key already been delivered (success-path dedup)? Shared with the failure path in Plan 03 (D-SHAREDDEDUP). */
  hasDelivered(key: string): boolean;
  /** DELIVERY-01: mark an idempotency key delivered. Caller marks ONLY after a successful send (never before the await) so a transient retry is preserved. */
  markDelivered(key: string): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the `[System Message]\n` prefix and trailing LLM instruction line
 * from announcement text, leaving only the task-specific content.
 */
function stripSystemPrefix(text: string): string {
  let result = text;

  // Strip [System Message] prefix
  if (result.startsWith("[System Message]\n")) {
    result = result.slice("[System Message]\n".length);
  }

  // Strip trailing instruction line
  const marker = "Inform the user about this completed background task.";
  const idx = result.lastIndexOf(marker);
  if (idx !== -1) {
    result = result.slice(0, idx).trimEnd();
  }

  return result;
}

/**
 * Sanitize announcement text for direct user delivery (fallback path).
 * Extracts human-readable content (Summary or Result sections) and strips
 * internal metadata (session keys, file paths, condensation stats, subagent
 * markers, runtime stats). Returns a safe generic message if no extractable
 * content is found.
 * Used only in fallback `sendToChannel` calls -- the `announceToParent` path
 * goes through the LLM which can filter metadata itself.
 */
export function sanitizeForUser(text: string): string {
  const GENERIC_FALLBACK =
    "A background task completed but the result could not be delivered properly. Please ask me to check on it.";

  // First strip system prefix and trailing instruction (shared cleanup)
  const stripped = stripSystemPrefix(text);

  // Try to extract "Summary:" content
  const summaryMatch = stripped.match(/(?:^|\n)Summary:\s*([\s\S]*?)(?=\n---|\n###|\n\[Subagent Result|$)/i);
  let extracted = summaryMatch?.[1]?.trim();

  // If no Summary found, try "Result:" content
  if (!extracted) {
    const resultMatch = stripped.match(/(?:^|\n)Result:\s*([\s\S]*?)(?=\n---|\n###|\n\[Subagent Result|$)/i);
    extracted = resultMatch?.[1]?.trim();
  }

  // If neither found, return generic fallback
  if (!extracted) {
    return GENERIC_FALLBACK;
  }

  // Strip internal metadata patterns from extracted text
  let sanitized = extracted;

  // [Subagent Result: ...] markers
  sanitized = sanitized.replace(/\[Subagent Result:[^\]]*\]/g, "");

  // Session keys (e.g., default:user1:channel:123)
  sanitized = sanitized.replace(/\b\w+:\w+:[a-z_-]+:\d+\b/g, "");

  // File paths (starting with / or ~)
  sanitized = sanitized.replace(/(?:\/[\w./-]+|~\/[\w./-]+)/g, "");

  // Runtime stats lines (Runtime: ... | Steps: ... | Tokens:)
  sanitized = sanitized.replace(/Runtime:.*\|.*Steps:.*\|.*Tokens:[^\n]*/g, "");

  // Token counts/costs (Tokens: 500 ... Cost: $0.0050)
  sanitized = sanitized.replace(/Tokens:\s*\d+.*Cost:\s*\$[\d.]+/g, "");

  // Condensation stats (e.g., "150->50 messages" or "condensed 150 to 50")
  sanitized = sanitized.replace(/\d+\u2192\d+\s*messages/g, "");
  sanitized = sanitized.replace(/condensed\s+\d+\s+to\s+\d+/gi, "");

  // Clean up: collapse multiple whitespace/newlines and trim
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ").trim();

  return sanitized || GENERIC_FALLBACK;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 2000;
/** Default transient-retry cap when `deps.maxRetries` is not injected (matches `security.agentToAgent.delivery.maxRetries` default). */
const DEFAULT_MAX_RETRIES = 3;

export function createAnnouncementBatcher(deps: AnnouncementBatcherDeps): AnnouncementBatcher {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const queues = new Map<string, QueuedAnnouncement[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // DELIVERY-01: idempotency keys whose delivery has SUCCEEDED. In-memory floor
  // (the documented at-least-once-across-restart boundary — the DLQ bounds
  // cross-restart re-delivery by runId/attemptCount/maxAgeMs). Marked ONLY on a
  // successful send (Pitfall 3) so a transient failure can still be retried.
  const deliveredKeys = new Set<string>();

  /** DELIVERY-01: mark a delivered item's key (no-op for undefined-keyed / top-level spawns). Call ONLY after a successful send. */
  function markDeliveredIfKeyed(item: QueuedAnnouncement): void {
    if (item.idempotencyKey) deliveredKeys.add(item.idempotencyKey);
  }

  /** AGENTS §2.2: no raw setTimeout — sleep via the sanctioned systemScheduleTimeout. */
  function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      systemScheduleTimeout(resolve, ms);
    });
  }

  /**
   * DELIVERY-02: send `text` to the item's announce channel, self-healing
   * transient failures. Used per-item in BOTH the single-item and the
   * multi-item-batch fallback branches. Returns true on success (and marks the
   * key delivered), false on terminal failure (the caller enqueues the DLQ).
   *
   * - No `classifyErrorContext` injected → legacy single-attempt: try once,
   *   return false on throw (byte-identical to pre-DELIVERY-02).
   * - Classified PERMANENT → emit delivery_deadlettered{transient:false,attempt:0},
   *   return false immediately (zero retries).
   * - Classified TRANSIENT → retry up to maxRetries with computeRetryBackoff
   *   backoff, emitting delivery_retried per attempt; on success mark + return
   *   true; on exhaustion emit delivery_deadlettered{transient:true} + return false.
   *
   * `text` is the already-sanitized announcement (scrubbed by the caller before
   * the first attempt) — retries reuse it; the scrub is never bypassed (T-171-07).
   *
   * Returns `{ delivered, lastError }` — on terminal failure the caller enqueues
   * the DLQ and uses `lastError` for the entry's diagnostic field.
   */
  async function sendWithRetry(item: QueuedAnnouncement, text: string): Promise<{ delivered: boolean; lastError?: string }> {
    let lastError: string;
    try {
      await deps.sendToChannel(item.announceChannelType, item.announceChannelId, text);
      markDeliveredIfKeyed(item);
      return { delivered: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // No classifier injected → legacy single-attempt path (caller → DLQ).
      if (!deps.classifyErrorContext) return { delivered: false, lastError };

      const { retryable } = deps.classifyErrorContext(lastError);
      if (!retryable) {
        deps.eventBus?.emit("subagent:delivery_deadlettered", {
          runId: item.runId,
          channelType: item.announceChannelType,
          attempt: 0,
          transient: false,
          timestamp: systemNowMs(),
        });
        return { delivered: false, lastError };
      }

      const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await sleep(deps.computeRetryBackoff?.(attempt) ?? 0);
        deps.eventBus?.emit("subagent:delivery_retried", {
          runId: item.runId,
          channelType: item.announceChannelType,
          attempt,
          transient: true,
          timestamp: systemNowMs(),
        });
        try {
          await deps.sendToChannel(item.announceChannelType, item.announceChannelId, text);
          markDeliveredIfKeyed(item);
          return { delivered: true };
        } catch (retryErr) {
          lastError = retryErr instanceof Error ? retryErr.message : String(retryErr);
          // keep retrying until the cap, then fall through to dead-letter
        }
      }

      // Transient but exhausted → dead-letter.
      deps.eventBus?.emit("subagent:delivery_deadlettered", {
        runId: item.runId,
        channelType: item.announceChannelType,
        attempt: maxRetries,
        transient: true,
        timestamp: systemNowMs(),
      });
      return { delivered: false, lastError };
    }
  }

  // -------------------------------------------------------------------------
  // Internal delivery
  // -------------------------------------------------------------------------

  async function deliverBatch(key: string): Promise<void> {
    timers.delete(key);
    const queued = queues.get(key);
    queues.delete(key);

    if (!queued || queued.length === 0) return;

    // DELIVERY-01 dedup: drop items whose key is already delivered (handles a
    // rapid re-enqueue inside the same debounce window) AND collapse same-key
    // duplicates within this batch (keep the first). undefined-keyed items are
    // never deduped — every top-level-spawn delivery proceeds.
    const seen = new Set<string>();
    const items: QueuedAnnouncement[] = [];
    for (const item of queued) {
      const k = item.idempotencyKey;
      if (k !== undefined) {
        if (deliveredKeys.has(k) || seen.has(k)) {
          deps.logger?.debug(
            { runId: item.runId, hint: "duplicate delivery suppressed" },
            "Announcement dedup no-op",
          );
          continue;
        }
        seen.add(k);
      }
      items.push(item);
    }

    if (items.length === 0) return;

    const first = items[0]!;

    try {
      const parsedKey = parseFormattedSessionKey(first.callerSessionKey);
      if (!parsedKey) {
        deps.logger?.warn(
          { batchKey: key, callerSessionKey: first.callerSessionKey, errorKind: "internal" as const, hint: "Invalid parent session key in batched announcement; batch dropped" },
          "Announcement batch delivery failed: invalid session key",
        );
        return;
      }

      if (items.length === 1) {
        // Single item -- deliver with original text unmodified
        try {
          await withTimeout(
            deps.announceToParent(
              first.callerAgentId,
              parsedKey,
              first.announcementText,
              first.announceChannelType,
              first.announceChannelId,
            ),
            ANNOUNCE_PARENT_TIMEOUT_MS,
            systemScheduleTimeout,
            "announceToParent",
          );
          markDeliveredIfKeyed(first); // DELIVERY-01: mark on success only
          return;
        } catch (err) {
          // Batch state fields in timeout WARN for diagnostics
          deps.logger?.warn(
            { batchKey: key, err, batchSize: 1, itemsDelivered: 0, itemsRemaining: 1, isPartialDelivery: false, errorKind: "internal" as const, hint: "Parent session injection failed/timed out; falling back to direct send" },
            "Announcement single-item delivery failed",
          );
          // DELIVERY-02: self-healing fallback — transient retries with backoff,
          // permanent dead-letters immediately. Scrub the text ONCE, reuse on retries.
          const sanitizedText = sanitizeForUser(first.announcementText);
          const { delivered, lastError } = await sendWithRetry(first, sanitizedText);
          if (!delivered && deps.deadLetterQueue) {
            deps.logger?.warn(
              { batchKey: key, runId: first.runId, errorKind: "network" as const, hint: "Single-item fallback direct send failed after retry/classify; dead-lettering" },
              "Single-item batcher fallback delivery failed",
            );
            deps.deadLetterQueue.enqueue({
              announcementText: sanitizedText,
              channelType: first.announceChannelType,
              channelId: first.announceChannelId,
              runId: first.runId,
              failedAt: systemNowMs(),
              attemptCount: 0,
              ...(lastError ? { lastError } : {}),
              idempotencyKey: first.idempotencyKey, // DELIVERY-01
            });
          }
          return;
        }
      }

      // Multiple items -- build combined message
      const taskSections = items.map((item, idx) => {
        const stripped = stripSystemPrefix(item.announcementText);
        return `### Task ${idx + 1}\n${stripped}`;
      }).join("\n\n");

      const combinedText =
        `[System Message]\n` +
        `${items.length} background tasks have completed.\n\n` +
        `---\n\n` +
        `${taskSections}\n\n` +
        `---\n\n` +
        `Review these completed tasks and summarize the results for the user in your own voice. If no user notification is needed, respond with NO_REPLY.`;

      try {
        await withTimeout(
          deps.announceToParent(
            first.callerAgentId,
            parsedKey,
            combinedText,
            first.announceChannelType,
            first.announceChannelId,
          ),
          ANNOUNCE_PARENT_TIMEOUT_MS,
          systemScheduleTimeout,
          "announceToParent",
        );
        // DELIVERY-01: the combined announce delivered all batch items at once.
        for (const item of items) markDeliveredIfKeyed(item);
      } catch (err) {
        deps.logger?.warn(
          { batchKey: key, batchSize: items.length, itemsDelivered: 0, itemsRemaining: items.length, isPartialDelivery: false, err, errorKind: "internal" as const, hint: "Parent session injection failed/timed out; falling back to direct send" },
          "Announcement batched delivery failed",
        );
        // Fallback: deliver each item individually via direct channel send.
        // DELIVERY-02: each item self-heals through sendWithRetry (transient →
        // retry-with-backoff; permanent → immediate dead-letter) — the SAME
        // retry/classify logic as the single-item branch, applied per item.
        let fallbackDelivered = 0;
        for (const item of items) {
          // Scrub ONCE per item, reuse on retries (T-171-07 — never bypass the scrub).
          const sanitizedText = sanitizeForUser(item.announcementText);
          const { delivered, lastError } = await sendWithRetry(item, sanitizedText);
          if (delivered) {
            fallbackDelivered++;
            continue;
          }
          deps.logger?.warn(
            { batchKey: key, runId: item.runId, batchSize: items.length, itemsDelivered: fallbackDelivered, itemsRemaining: items.length - fallbackDelivered, isPartialDelivery: fallbackDelivered > 0, errorKind: "network" as const, hint: "Fallback direct send failed for batch item after retry/classify; dead-lettering" },
            "Batch item fallback delivery failed",
          );
          if (deps.deadLetterQueue) {
            deps.deadLetterQueue.enqueue({
              announcementText: sanitizedText,
              channelType: item.announceChannelType,
              channelId: item.announceChannelId,
              runId: item.runId,
              failedAt: systemNowMs(),
              attemptCount: 0,
              ...(lastError ? { lastError } : {}),
              idempotencyKey: item.idempotencyKey, // DELIVERY-01
            });
          }
        }
      }
    } catch (err) {
      deps.logger?.warn(
        { batchKey: key, batchSize: items.length, err, errorKind: "internal" as const, hint: "Batch announcement delivery failed; individual results are logged separately" },
        "Announcement batch delivery error",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function enqueue(params: QueuedAnnouncement): void {
    const batchKey = `${params.callerAgentId}:${params.callerSessionKey}`;

    let queue = queues.get(batchKey);
    if (!queue) {
      queue = [];
      queues.set(batchKey, queue);
    }
    queue.push(params);

    // Clear existing debounce timer and reset
    const existingTimer = timers.get(batchKey);
    if (existingTimer !== undefined) {
      systemClearTimeout(existingTimer);
    }

    const timer = systemSetTimeout(() => {
      void deliverBatch(batchKey);
    }, debounceMs);

    // Allow process to exit even with pending timers
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    timers.set(batchKey, timer);

    deps.logger?.debug(
      { batchKey, queueSize: queue.length, runId: params.runId },
      "Announcement enqueued for batching",
    );
  }

  async function flush(): Promise<void> {
    // Clear all debounce timers
    for (const timer of timers.values()) {
      systemClearTimeout(timer);
    }
    timers.clear();

    // Deliver all pending batches
    const keys = [...queues.keys()];
    await Promise.allSettled(keys.map((key) => deliverBatch(key)));
  }

  async function shutdown(): Promise<void> {
    await flush();
    queues.clear();
    timers.clear();
  }

  return {
    enqueue,
    flush,
    shutdown,
    get pending() {
      let count = 0;
      for (const queue of queues.values()) {
        count += queue.length;
      }
      return count;
    },
    hasDelivered: (key: string) => deliveredKeys.has(key),
    markDelivered: (key: string) => {
      deliveredKeys.add(key);
    },
  };
}
