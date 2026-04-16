/**
 * Announcement batcher for coalescing near-simultaneous sub-agent completions.
 * When multiple sub-agents complete within seconds of each other for the same
 * parent session, the batcher debounces and combines their announcements into a
 * single batched LLM execution -- reducing N sequential parent calls to 1.
 * Single completions with no siblings deliver after the debounce timer with
 * original text unmodified (no batching overhead).
 * @module
 */

import { parseFormattedSessionKey, type SessionKey } from "@comis/core";
import { withTimeout } from "@comis/shared";
import { ANNOUNCE_PARENT_TIMEOUT_MS } from "./sub-agent-runner.js";

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
    }): void;
  };
}

export interface AnnouncementBatcher {
  enqueue(params: QueuedAnnouncement): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly pending: number;
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

export function createAnnouncementBatcher(deps: AnnouncementBatcherDeps): AnnouncementBatcher {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const queues = new Map<string, QueuedAnnouncement[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // -------------------------------------------------------------------------
  // Internal delivery
  // -------------------------------------------------------------------------

  async function deliverBatch(key: string): Promise<void> {
    timers.delete(key);
    const items = queues.get(key);
    queues.delete(key);

    if (!items || items.length === 0) return;

    const first = items[0]!;

    try {
      const parsedKey = parseFormattedSessionKey(first.callerSessionKey);
      if (!parsedKey) {
        deps.logger?.warn(
          { batchKey: key, callerSessionKey: first.callerSessionKey, errorKind: "internal", hint: "Invalid parent session key in batched announcement; batch dropped" },
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
            "announceToParent",
          );
          return;
        } catch (err) {
          // Batch state fields in timeout WARN for diagnostics
          deps.logger?.warn(
            { batchKey: key, err, batchSize: 1, itemsDelivered: 0, itemsRemaining: 1, isPartialDelivery: false, errorKind: "internal", hint: "Parent session injection failed/timed out; falling back to direct send" },
            "Announcement single-item delivery failed",
          );
          try {
            await deps.sendToChannel(first.announceChannelType, first.announceChannelId, sanitizeForUser(first.announcementText));
          } catch (sendErr) {
            deps.logger?.warn(
              { batchKey: key, runId: first.runId, err: sendErr, errorKind: "network", hint: "Single-item fallback direct send failed" },
              "Single-item batcher fallback delivery failed",
            );
            // Persist to DLQ on single-item fallback delivery failure
            if (deps.deadLetterQueue) {
              deps.deadLetterQueue.enqueue({
                announcementText: sanitizeForUser(first.announcementText),
                channelType: first.announceChannelType,
                channelId: first.announceChannelId,
                runId: first.runId,
                failedAt: Date.now(),
                attemptCount: 0,
                lastError: sendErr instanceof Error ? sendErr.message : String(sendErr),
              });
            }
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
          "announceToParent",
        );
      } catch (err) {
        deps.logger?.warn(
          { batchKey: key, batchSize: items.length, itemsDelivered: 0, itemsRemaining: items.length, isPartialDelivery: false, err, errorKind: "internal", hint: "Parent session injection failed/timed out; falling back to direct send" },
          "Announcement batched delivery failed",
        );
        // Fallback: deliver each item individually via direct channel send
        let fallbackDelivered = 0;
        for (const item of items) {
          await deps.sendToChannel(item.announceChannelType, item.announceChannelId, sanitizeForUser(item.announcementText)).then(() => {
            fallbackDelivered++;
          }).catch((sendErr) => {
            deps.logger?.warn(
              { batchKey: key, runId: item.runId, batchSize: items.length, itemsDelivered: fallbackDelivered, itemsRemaining: items.length - fallbackDelivered, isPartialDelivery: fallbackDelivered > 0, err: sendErr, errorKind: "network", hint: "Fallback direct send also failed for batch item" },
              "Batch item fallback delivery failed",
            );
            // Persist to DLQ on fallback delivery failure
            if (deps.deadLetterQueue) {
              deps.deadLetterQueue.enqueue({
                announcementText: sanitizeForUser(item.announcementText),
                channelType: item.announceChannelType,
                channelId: item.announceChannelId,
                runId: item.runId,
                failedAt: Date.now(),
                attemptCount: 0,
                lastError: sendErr instanceof Error ? sendErr.message : String(sendErr),
              });
            }
          });
        }
      }
    } catch (err) {
      deps.logger?.warn(
        { batchKey: key, batchSize: items.length, err, errorKind: "internal", hint: "Batch announcement delivery failed; individual results are logged separately" },
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
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
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
      clearTimeout(timer);
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
  };
}
