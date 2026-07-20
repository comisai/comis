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

import { conversationScopeToSessionKey, scrubSecretsFromText, toSafeErrorLogString, type ConversationLocator, type SessionKey, systemNowMs, systemSetTimeout, systemClearTimeout, systemScheduleTimeout } from "@comis/core";
import { err, fromPromise, ok, TimeoutError, withTimeout, type Result } from "@comis/shared";
import { createDeliveryDedup, type DeliveryDedup } from "@comis/agent";
import type { ChannelType } from "./announcement-dead-letter.js";
import type {
  AnnouncementOperationIdentity,
  CompletionAttachmentRef,
  SendGovernedCompletionAnnouncement,
} from "./announcement-outward-operation.js";

/** Hard timeout for the text-only parent candidate execution. A timeout leaves
 *  the durable decision reservation quarantined and never starts another path.
 *  Defined locally to avoid an orchestrator-to-agent dependency cycle and kept
 *  aligned with the public agent timeout. */
const ANNOUNCE_PARENT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface QueuedAnnouncement {
  announcementText: string;
  announceChannelType: ChannelType;
  announceChannelId: string;
  announceThreadId?: string;
  callerAgentId: string;
  callerSessionKey: string;
  /** Canonical parent conversation authority captured at spawn time. */
  callerConversation: ConversationLocator;
  /** Response locale resolved for the originating user turn. */
  resolvedLanguage?: string;
  runId: string;
  /** Idempotency key `${callerSessionKey}::${runId}`. Built once at the delivery entry; opaque here. Undefined for a top-level spawn (no callerSessionKey). */
  idempotencyKey?: string;
  attachments?: CompletionAttachmentRef[];
}

export interface AnnouncementBatcherDeps {
  announceToParent: (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    callerConversation: ConversationLocator,
    text: string,
    channelType: string,
    channelId: string,
    options?: { threadId?: string; resolvedLanguage?: string },
  ) => Promise<string | undefined>;
  sendToChannel: (channelType: string, channelId: string, text: string, options?: { threadId?: string; extra?: Record<string, unknown> }) => Promise<boolean>;
  logger?: {
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  debounceMs?: number;
  /** Durable decision reservation and failed-delivery quarantine. */
  deadLetterQueue?: {
    enqueue(entry: {
      announcementText: string;
      channelType: ChannelType;
      channelId: string;
      /** Framework-authenticated owner of the persisted outward operation. */
      agentId: string;
      runId: string;
      failedAt: number;
      attemptCount: number;
      lastError?: string;
      threadId?: string;
      /** Idempotency key `${callerSessionKey}::${runId}`, carried onto the dead-letter entry. */
      idempotencyKey?: string;
      rootRunId?: string;
      stepIndex?: number;
    }): Promise<Result<void, Error>>;
    reserveDecision(entry: {
      idempotencyKey: string;
      agentId: string;
      runId: string;
      announcementText: string;
      channelType: ChannelType;
      channelId: string;
      failedAt: number;
      threadId?: string;
    }): Promise<Result<{ created: boolean }, Error>>;
    resolveDecision(
      idempotencyKey: string,
      outcome: "receipt_committed" | "no_reply",
    ): Promise<Result<boolean, Error>>;
  };
  /** Durable single-attempt sender for the irreversible final delivery. */
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
  /**
   * Shared, BOUNDED delivered-key store. When injected by the
   * daemon wiring, the SAME instance is also handed to the no-batcher success
   * branches (`deliverAnnouncement`) and the failure path / DLQ recovery, so
   * every completion-delivery surface dedups against one set. Absent → the
   * batcher owns an internal bounded dedup (still capped — never leaks).
   */
  deliveryDedup?: DeliveryDedup;
}

export interface AnnouncementBatcher {
  enqueue(params: QueuedAnnouncement): Promise<Result<"queued" | "retained", Error>>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  readonly pending: number;
  /** Has this idempotency key already been delivered (success-path dedup)? Shared with the failure path. */
  hasDelivered(key: string): boolean;
  /** Mark an idempotency key delivered. Caller marks ONLY after a successful send (never before the await) so a transient retry is preserved. */
  markDelivered(key: string): void;
  /**
   * Is this idempotency key still OWNED by the announcement pipeline — queued
   * awaiting flush, mid-admission, or retained-uncertain? While true, the
   * failure sweep must not send its own notice for the key (the enqueued
   * completion announcement is the one message the recipient gets), closing
   * the shutdown race where a notice fired for an enqueued-but-unflushed run.
   */
  hasPending?(key: string): boolean;
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
  const deliveryTails = new Map<string, Promise<void>>();
  const pendingAdmissions = new Set<Promise<Result<"queued" | "retained", Error>>>();
  // Keys whose enqueue admission has not yet settled — consulted by hasPending
  // alongside the materialized queues so the failure sweep never fires inside
  // the admission await window.
  const admissionKeys = new Set<string>();
  const admittedDecisionKeys = new Set<string>();
  let accepting = true;
  let shutdownPromise: Promise<void> | undefined;
  // Idempotency keys whose delivery has SUCCEEDED. In-memory floor
  // (the documented at-least-once-across-restart boundary — the DLQ bounds
  // cross-restart re-delivery by runId/attemptCount/maxAgeMs). Marked ONLY on a
  // successful send so a transient failure can still be retried.
  // BOUNDED (FIFO) so it never leaks for the daemon lifetime — uses the
  // injected shared dedup when present (the no-batcher success
  // branches + DLQ recovery mark the SAME set), else an internal bounded one.
  const deliveredKeys: DeliveryDedup = deps.deliveryDedup ?? createDeliveryDedup();
  // A timed-out parent execution or an unconfirmed platform attempt remains
  // reserved. Retrying such a key automatically could duplicate an accepted
  // side effect whose completion was not observed.
  const retainedKeys = createDeliveryDedup();

  /** Mark a delivered item's key (no-op for undefined-keyed / top-level spawns). Call ONLY after a successful send. */
  function markDeliveredIfKeyed(item: QueuedAnnouncement): void {
    if (item.idempotencyKey) deliveredKeys.mark(item.idempotencyKey);
  }

  /**
   * Make exactly one final platform attempt. DeliveryService owns any retry
   * policy below this boundary; an opaque throw or false result is uncertain
   * and must not be repeated here.
   */
  async function sendOnce(
    item: QueuedAnnouncement,
    text: string,
    attachment?: CompletionAttachmentRef,
    partId?: string,
  ): Promise<{
    delivered: boolean;
    lastError?: string;
    identity?: AnnouncementOperationIdentity;
  }> {
    if (deps.sendGovernedAnnouncement) {
      const boundary = await fromPromise(deps.sendGovernedAnnouncement({
        agentId: item.callerAgentId,
        callerSessionKey: item.callerSessionKey,
        callerConversation: item.callerConversation,
        runId: item.runId,
        channelType: item.announceChannelType,
        channelId: item.announceChannelId,
        text,
        ...(partId ? { partId } : {}),
        ...(attachment ? { attachment } : {}),
        ...(item.announceThreadId ? { options: { threadId: item.announceThreadId } } : {}),
      }));
      if (!boundary.ok || !boundary.value.ok) {
        return { delivered: false, lastError: "governed announcement boundary failed" };
      }
      const outcome = boundary.value.value;
      if (outcome.delivered) {
        return { delivered: true, identity: outcome.identity };
      }
      return {
        delivered: false,
        lastError: outcome.failure,
        ...(outcome.identity ? { identity: outcome.identity } : {}),
      };
    }

    const attemptDirect = async (): Promise<{
      delivered: boolean;
      lastError?: string;
    }> => {
      const boundary = await fromPromise(deps.sendToChannel(
        item.announceChannelType,
        item.announceChannelId,
        text,
        item.announceThreadId ? { threadId: item.announceThreadId } : undefined,
      ));
      if (!boundary.ok) {
        return {
          delivered: false,
          lastError: toSafeErrorLogString(boundary.error),
        };
      }
      if (!boundary.value) {
        return {
          delivered: false,
          lastError: "sendToChannel returned false",
        };
      }
      return { delivered: true };
    };

    const firstAttempt = await attemptDirect();
    return firstAttempt.delivered
      ? { delivered: true }
      : {
          delivered: false,
          lastError: firstAttempt.lastError ?? "direct channel send failed",
        };
  }

  // -------------------------------------------------------------------------
  // Internal delivery
  // -------------------------------------------------------------------------

  function markItemsDelivered(items: readonly QueuedAnnouncement[]): void {
    for (const item of items) {
      markDeliveredIfKeyed(item);
      if (item.idempotencyKey) admittedDecisionKeys.delete(item.idempotencyKey);
    }
  }

  function retainItems(items: readonly QueuedAnnouncement[]): void {
    for (const item of items) {
      if (item.idempotencyKey) retainedKeys.mark(item.idempotencyKey);
      if (item.idempotencyKey) admittedDecisionKeys.delete(item.idempotencyKey);
    }
  }

  async function resolveDecisions(
    items: readonly QueuedAnnouncement[],
    outcome: "receipt_committed" | "no_reply",
  ): Promise<void> {
    const resolveDecision = deps.deadLetterQueue?.resolveDecision;
    if (!resolveDecision) return;
    for (const item of items) {
      if (!item.idempotencyKey) continue;
      const boundary = await fromPromise(resolveDecision(item.idempotencyKey, outcome));
      if (boundary.ok && boundary.value.ok) continue;
      deps.logger?.warn(
        {
          runId: item.runId,
          errorKind: "resource" as const,
          hint: "Repair decision-quarantine storage; the safe retained row suppresses replay",
        },
        "Announcement decision reservation could not be resolved",
      );
    }
  }

  async function sendFinal(
    key: string,
    items: readonly QueuedAnnouncement[],
    text: string,
  ): Promise<boolean> {
    const first = items[0]!;
    const attachments = items.flatMap((item) =>
      (item.attachments ?? []).map((attachment, index) => ({ item, attachment, index })),
    );
    const operations: Array<{
      item: QueuedAnnouncement;
      text: string;
      attachment?: CompletionAttachmentRef;
      partId?: string;
    }> = attachments.length === 0
      ? [{ item: first, text }]
      : items.length === 1
        ? attachments.map((entry, index) => ({
            ...entry,
            text: index === 0 ? text : "",
            partId: `attachment:${entry.index}`,
          }))
        : [
            { item: first, text, partId: "summary" },
            ...attachments.map((entry) => ({
              ...entry,
              text: "",
              partId: `attachment:${entry.index}`,
            })),
          ];

    let failure: { lastError?: string; identity?: AnnouncementOperationIdentity } | undefined;
    for (const operation of operations) {
      const outcome = await sendOnce(
        operation.item,
        operation.text,
        operation.attachment,
        operation.partId,
      );
      if (!outcome.delivered) {
        failure = outcome;
        break;
      }
    }
    if (failure === undefined) {
      await resolveDecisions(items, "receipt_committed");
      markItemsDelivered(items);
      return true;
    }

    retainItems(items);
    deps.logger?.warn(
      {
        batchKey: key,
        runId: first.runId,
        batchSize: items.length,
        errorKind: "network" as const,
        hint: "Inspect the retained announcement operation before any retry",
      },
      "Announcement final delivery was not confirmed",
    );
    if (attachments.length > 0) return false;
    if (!deps.deadLetterQueue) return false;
    const queued = await deps.deadLetterQueue.enqueue({
      announcementText: text,
      channelType: first.announceChannelType,
      channelId: first.announceChannelId,
      agentId: first.callerAgentId,
      runId: first.runId,
      failedAt: systemNowMs(),
      attemptCount: 0,
      ...(failure.lastError ? { lastError: failure.lastError } : {}),
      ...(first.announceThreadId ? { threadId: first.announceThreadId } : {}),
      idempotencyKey: first.idempotencyKey,
      ...(failure.identity ? {
        rootRunId: failure.identity.rootRunId,
        stepIndex: failure.identity.stepIndex,
      } : {}),
    });
    if (!queued?.ok) {
      deps.logger?.warn(
        {
          batchKey: key,
          runId: first.runId,
          errorKind: "resource" as const,
          hint: "Repair dead-letter storage before retrying or claiming the announcement was retained",
        },
        "Announcement dead-letter persistence failed",
      );
    }
    return false;
  }

  async function deliverQueuedBatch(key: string): Promise<void> {
    timers.delete(key);
    const queued = queues.get(key);
    queues.delete(key);

    if (!queued || queued.length === 0) return;

    // Idempotency dedup: drop items whose key is already delivered (handles a
    // rapid re-enqueue inside the same debounce window) AND collapse same-key
    // duplicates within this batch (keep the first). undefined-keyed items are
    // never deduped — every top-level-spawn delivery proceeds.
    const seen = new Set<string>();
    const items: QueuedAnnouncement[] = [];
    for (const item of queued) {
      const k = item.idempotencyKey;
      if (k !== undefined) {
        if (deliveredKeys.has(k) || retainedKeys.has(k) || seen.has(k)) {
          deps.logger?.debug(
            { runId: item.runId, hint: "duplicate or retained delivery suppressed" },
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
      const projectedKey = conversationScopeToSessionKey(first.callerConversation.conversationScope);
      if (!projectedKey.ok) {
        deps.logger?.warn(
          { batchKey: key, errorKind: "internal" as const, hint: "Invalid canonical parent conversation in batched announcement; batch dropped" },
          "Announcement batch delivery failed: invalid conversation authority",
        );
        return;
      }

      const parentInput = items.length === 1
        ? first.announcementText
        : (() => {
            const taskSections = items.map((item, idx) => {
              const stripped = stripSystemPrefix(item.announcementText);
              return `### Task ${idx + 1}\n${stripped}`;
            }).join("\n\n");
            return `[System Message]\n${items.length} background tasks have completed.\n\n---\n\n${taskSections}\n\n---\n\nReview these completed tasks and summarize the results for the user in your own voice. If no user notification is needed, respond with NO_REPLY.`;
          })();
      const parentOptions = first.announceThreadId || first.resolvedLanguage
        ? {
            ...(first.announceThreadId ? { threadId: first.announceThreadId } : {}),
            ...(first.resolvedLanguage ? { resolvedLanguage: first.resolvedLanguage } : {}),
          }
        : undefined;
      try {
        const candidate = await withTimeout(
          deps.announceToParent(
            first.callerAgentId,
            projectedKey.value,
            first.callerConversation,
            parentInput,
            first.announceChannelType,
            first.announceChannelId,
            parentOptions,
          ),
          ANNOUNCE_PARENT_TIMEOUT_MS,
          systemScheduleTimeout,
          "announceToParent",
        );
        if (candidate === undefined) {
          if (items.some((item) => (item.attachments?.length ?? 0) > 0)) {
            await sendFinal(key, items, "");
            return;
          }
          await resolveDecisions(items, "no_reply");
          markItemsDelivered(items);
          return;
        }
        const scrubbedCandidate = scrubSecretsFromText(candidate);
        if (scrubbedCandidate.redactions > 0) {
          deps.logger?.warn(
            {
              batchKey: key,
              batchSize: items.length,
              redactions: scrubbedCandidate.redactions,
              errorKind: "internal" as const,
              hint: "Secret found in rewritten announcement — redacted before delivery",
            },
            "Egress guard: rewritten announcement scrubbed",
          );
        }
        await sendFinal(key, items, scrubbedCandidate.text);
      } catch (err) {
        retainItems(items);
        deps.logger?.warn(
          {
            batchKey: key,
            batchSize: items.length,
            err: toSafeErrorLogString(err),
            errorKind: err instanceof TimeoutError ? "timeout" as const : "internal" as const,
            hint: "Inspect the quarantined parent decision before deciding whether to retry",
          },
          "Announcement parent execution ended without a safe delivery decision",
        );
        return;
      }
    } catch (err) {
      deps.logger?.warn(
        { batchKey: key, batchSize: items.length, err: toSafeErrorLogString(err), errorKind: "internal" as const, hint: "Batch announcement delivery failed; individual results are logged separately" },
        "Announcement batch delivery error",
      );
    }
  }

  function deliverBatch(key: string): Promise<void> {
    const prior = deliveryTails.get(key) ?? Promise.resolve();
    const next = prior.then(() => deliverQueuedBatch(key));
    const settled: Promise<void> = next.finally(() => {
      if (deliveryTails.get(key) === settled) deliveryTails.delete(key);
    });
    deliveryTails.set(key, settled);
    return settled;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async function enqueueAccepted(
    params: QueuedAnnouncement,
  ): Promise<Result<"queued" | "retained", Error>> {
    const idempotencyKey = params.idempotencyKey;
    if (idempotencyKey && (deliveredKeys.has(idempotencyKey) || retainedKeys.has(idempotencyKey))) {
      return ok("retained");
    }

    const reserveDecision = deps.deadLetterQueue?.reserveDecision;
    if (deps.sendGovernedAnnouncement && (!idempotencyKey || !reserveDecision)) {
      deps.logger?.warn(
        {
          runId: params.runId,
          errorKind: "precondition" as const,
          hint: "Wire durable keyed decision reservations before enabling governed parent rewriting",
        },
        "Governed announcement decision cannot be reserved",
      );
      return err(new Error("Governed announcement decision reservation unavailable"));
    }
    if (deps.sendGovernedAnnouncement && idempotencyKey && reserveDecision) {
      const boundary = await fromPromise(reserveDecision({
        idempotencyKey,
        agentId: params.callerAgentId,
        runId: params.runId,
        announcementText: params.announcementText,
        channelType: params.announceChannelType,
        channelId: params.announceChannelId,
        failedAt: systemNowMs(),
        ...(params.announceThreadId ? { threadId: params.announceThreadId } : {}),
      }));
      if (!boundary.ok) {
        deps.logger?.warn(
          {
            runId: params.runId,
            err: toSafeErrorLogString(boundary.error),
            errorKind: "resource" as const,
            hint: "Restore decision-quarantine storage before retrying the same completion",
          },
          "Announcement decision reservation failed",
        );
        return err(boundary.error);
      }
      if (!boundary.value.ok) {
        deps.logger?.warn(
          {
            runId: params.runId,
            err: toSafeErrorLogString(boundary.value.error),
            errorKind: "resource" as const,
            hint: "Restore decision-quarantine storage before retrying the same completion",
          },
          "Announcement decision reservation failed",
        );
        return err(boundary.value.error);
      }
      if (!boundary.value.value.created) {
        if (!admittedDecisionKeys.has(idempotencyKey)) retainedKeys.mark(idempotencyKey);
        deps.logger?.debug(
          { runId: params.runId, hint: "durable decision reservation already retained" },
          "Announcement dedup no-op",
        );
        return ok("retained");
      }
      admittedDecisionKeys.add(idempotencyKey);
    }

    const batchKey = JSON.stringify([
      params.callerAgentId,
      params.callerSessionKey,
      params.announceChannelType,
      params.announceChannelId,
      params.announceThreadId ?? null,
      params.resolvedLanguage ?? null,
    ]);

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
      {
        batchKey,
        queueSize: queue.length,
        runId: params.runId,
        resolvedLanguage: params.resolvedLanguage ?? "unset",
      },
      "Announcement enqueued for batching",
    );
    return ok("queued");
  }

  function enqueue(
    params: QueuedAnnouncement,
  ): Promise<Result<"queued" | "retained", Error>> {
    if (!accepting) {
      return Promise.resolve(err(new Error("Announcement batcher is shutting down")));
    }
    const admission = enqueueAccepted(params);
    pendingAdmissions.add(admission);
    // Track the key across the async admission so hasPending covers the
    // window where the item is neither in `queues` yet nor rejected — the
    // failure sweep may run concurrently with a governed admission await.
    if (params.idempotencyKey) admissionKeys.add(params.idempotencyKey);
    const settleAdmission = (): void => {
      pendingAdmissions.delete(admission);
      if (params.idempotencyKey) admissionKeys.delete(params.idempotencyKey);
    };
    void admission.then(settleAdmission, settleAdmission);
    return admission;
  }

  async function flush(): Promise<void> {
    await Promise.allSettled([...pendingAdmissions]);
    // Clear all debounce timers
    for (const timer of timers.values()) {
      systemClearTimeout(timer);
    }
    timers.clear();

    // Deliver all pending batches
    const keys = [...queues.keys()];
    await Promise.allSettled(keys.map((key) => deliverBatch(key)));
    await Promise.allSettled([...deliveryTails.values()]);
  }

  async function performShutdown(): Promise<void> {
    await flush();
    queues.clear();
    timers.clear();
    deliveryTails.clear();
    admittedDecisionKeys.clear();
  }

  function shutdown(): Promise<void> {
    accepting = false;
    shutdownPromise ??= performShutdown();
    return shutdownPromise;
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
      deliveredKeys.mark(key);
    },
    hasPending: (key: string) => {
      if (admissionKeys.has(key)) return true;
      for (const queue of queues.values()) {
        if (queue.some((item) => item.idempotencyKey === key)) return true;
      }
      // A retained-uncertain key (accepted side effect whose completion was
      // not observed) is still owned by the announcement pipeline — a failure
      // notice on top of it could duplicate a message the user already got.
      // A DELIVERED key is deliberately NOT pending: hasDelivered covers it.
      return retainedKeys.has(key) && !deliveredKeys.has(key);
    },
  };
}
