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

import {
  conversationScopeToSessionKey,
  scrubSecretsFromText,
  toSafeErrorLogString,
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
  systemScheduleTimeout,
  type CitationEvidence,
} from "@comis/core";
import { err, fromPromise, ok, TimeoutError, withTimeout, type Result } from "@comis/shared";
import {
  buildAnnouncementRewriteInput,
  createCompletionAnnouncementOperationPlan,
  createDeliveryDedup,
  enforceAnnouncementTerminalOutcome,
  type AnnouncementTerminalOutcome,
  type DeliveryDedup,
} from "@comis/agent";
import type {
  AnnouncementOperationIdentity,
  CompletionAttachmentRef,
  GovernedAnnouncementFailure,
} from "./announcement-outward-operation.js";
import {
  createAnnouncementReservationPlan,
  type AnnouncementBatchOperation,
} from "./announcement-batcher-reservations.js";
import type {
  AnnouncementBatcher,
  AnnouncementBatcherDeps,
  QueuedAnnouncement,
} from "./announcement-batcher-types.js";
export type {
  AnnouncementBatcher,
  AnnouncementBatcherDeps,
  QueuedAnnouncement,
} from "./announcement-batcher-types.js";

/** Hard timeout for the text-only parent candidate execution. A timeout leaves
 *  text-only results quarantined; verified attachments continue without a
 *  generated caption because no outward delivery has started at this stage.
 *  Defined locally to avoid an orchestrator-to-agent dependency cycle and kept
 *  aligned with the public agent timeout. */
const ANNOUNCE_PARENT_TIMEOUT_MS = 300_000;

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

function containsInternalAnnouncementEnvelope(text: string): boolean {
  return text.startsWith("[System Message]\n")
    || text.includes("Inform the user about this completed background task.")
    || /\[Subagent Result:/iu.test(text)
    || text.includes("Full result (drill in with read/grep/jq):");
}

/**
 * Sanitize announcement text for direct user delivery (fallback path).
 * Extracts human-readable content (Summary or Result sections) and strips
 * internal metadata (session keys, file paths, condensation stats, subagent
 * markers, runtime stats). Returns a safe generic message if no extractable
 * content is found.
 * Used for durable decision fallbacks and as the final egress guard when a
 * parent rewrite echoes the internal completion envelope.
 */
export function sanitizeForUser(text: string): string {
  const GENERIC_FALLBACK =
    "A background task completed but the result could not be delivered properly. Please ask me to check on it.";

  // First strip system prefix and trailing instruction (shared cleanup)
  const stripped = stripSystemPrefix(text);

  // Try to extract "Summary:" content
  let extracted = extractAnnouncementSection(stripped, "Summary:");

  // If no Summary found, try "Result:" content
  if (!extracted) {
    extracted = extractAnnouncementSection(stripped, "Result:");
  }

  // If neither found, return generic fallback
  if (!extracted) {
    return GENERIC_FALLBACK;
  }

  // Strip internal metadata patterns from extracted text
  let sanitized = extracted;

  // [Subagent Result: ...] markers
  sanitized = stripSubagentResultMarkers(sanitized);

  // Session keys (e.g., default:user1:channel:123)
  sanitized = sanitized.replace(/\b\w+:\w+:[a-z_-]+:\d+\b/g, "");

  // File paths (starting with / or ~)
  sanitized = sanitized.replace(/(?<![:/\\\w])(?:\/[\w./-]+|~\/[\w./-]+)/g, "");

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

function extractAnnouncementSection(text: string, label: string): string | undefined {
  const lower = text.toLowerCase();
  const lowerLabel = label.toLowerCase();
  let labelStart = lower.startsWith(lowerLabel) ? 0 : lower.indexOf(`\n${lowerLabel}`);
  if (labelStart === -1) return undefined;
  if (labelStart > 0) labelStart++;
  let contentStart = labelStart + label.length;
  while (contentStart < text.length && /\s/.test(text[contentStart]!)) contentStart++;
  const terminators = ["\n---", "\n###", "\n[subagent result"];
  let contentEnd = text.length;
  for (const terminator of terminators) {
    const found = lower.indexOf(terminator, contentStart);
    if (found !== -1 && found < contentEnd) contentEnd = found;
  }
  const content = text.slice(contentStart, contentEnd).trim();
  return content || undefined;
}

function stripSubagentResultMarkers(text: string): string {
  const lower = text.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = lower.indexOf("[subagent result:", cursor);
    if (start === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, start));
    const end = text.indexOf("]", start + 1);
    if (end === -1) break;
    cursor = end + 1;
  }
  return parts.join("");
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
  const admissionAbort = new AbortController();
  // Keys whose enqueue admission has not yet settled — consulted by hasPending
  // alongside the materialized queues so the failure sweep never fires inside
  // the admission await window.
  const admissionKeys = new Set<string>();
  const admittedDecisionKeys = new Map<string, readonly string[]>();
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
    completionKeys: readonly string[],
    attachment?: CompletionAttachmentRef,
    partId?: string,
  ): Promise<{
    delivered: boolean;
    terminalDecision?: boolean;
    lastError?: string;
    identity?: AnnouncementOperationIdentity;
    failure?: GovernedAnnouncementFailure;
    platformStatus?: "accepted" | "rejected" | "unknown";
  }> {
    if (deps.sendGovernedAnnouncement) {
      const boundary = await fromPromise(deps.sendGovernedAnnouncement({
        agentId: item.callerAgentId,
        callerSessionKey: item.callerSessionKey,
        callerConversation: item.callerConversation,
        destinationEndpoint: item.destinationEndpoint,
        runId: item.runId,
        channelType: item.announceChannelType,
        channelId: item.announceChannelId,
        text,
        completionKeys,
        signal: admissionAbort.signal,
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
      if ("terminalDecision" in outcome) {
        return { delivered: true, terminalDecision: true };
      }
      return {
        delivered: false,
        lastError: outcome.failure,
        failure: outcome.failure,
        ...(outcome.identity ? { identity: outcome.identity } : {}),
      };
    }

    if (deps.sendRecoverableAnnouncement) {
      const boundary = await fromPromise(deps.sendRecoverableAnnouncement({
        agentId: item.callerAgentId,
        callerSessionKey: item.callerSessionKey,
        callerConversation: item.callerConversation,
        destinationEndpoint: item.destinationEndpoint,
        runId: item.runId,
        channelType: item.announceChannelType,
        channelId: item.announceChannelId,
        text,
        completionKeys,
        signal: admissionAbort.signal,
        ...(partId ? { partId } : {}),
        ...(attachment ? { attachment } : {}),
        ...(item.announceThreadId ? { options: { threadId: item.announceThreadId } } : {}),
      }));
      if (!boundary.ok || !boundary.value.ok) {
        return {
          delivered: false,
          lastError: "recoverable announcement boundary failed",
          platformStatus: "unknown",
        };
      }
      const outcome = boundary.value.value;
      if (outcome.delivered) return { delivered: true, platformStatus: "accepted" };
      if ("terminalDecision" in outcome) {
        return { delivered: true, terminalDecision: true };
      }
      return {
        delivered: false,
        lastError: outcome.status === "rejected"
          ? "transport_rejected"
          : "outward_operation_unresolved",
        failure: outcome.status === "rejected"
          ? "transport_rejected"
          : "transport_uncertain",
        platformStatus: outcome.status,
      };
    }

    if (deps.sendToChannelWithReceipt) {
      const boundary = await fromPromise(deps.sendToChannelWithReceipt(
        item.announceChannelType,
        item.announceChannelId,
        text,
        item.announceThreadId ? { threadId: item.announceThreadId } : undefined,
      ));
      if (!boundary.ok || !boundary.value.ok) {
        return {
          delivered: false,
          lastError: "outward_operation_unresolved",
          failure: "transport_uncertain",
          platformStatus: "unknown",
        };
      }
      const outcome = boundary.value.value;
      return outcome.delivered
        ? { delivered: true, platformStatus: "accepted" }
        : {
            delivered: false,
            lastError: outcome.status === "rejected"
              ? "transport_rejected"
              : "outward_operation_unresolved",
            failure: outcome.status === "rejected"
              ? "transport_rejected"
              : "transport_uncertain",
            platformStatus: outcome.status,
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
  ): Promise<boolean> {
    return resolveDecisionKeys(
      items.flatMap((item) => item.idempotencyKey ? [item.idempotencyKey] : []),
      outcome,
      items[0]?.runId,
    );
  }

  async function resolveDecisionKeys(
    keys: readonly string[],
    outcome: "receipt_committed" | "no_reply",
    runId?: string,
  ): Promise<boolean> {
    const resolveDecision = deps.deadLetterQueue?.resolveDecision;
    if (!resolveDecision) return true;
    let resolved = true;
    for (const decisionKey of keys) {
      const boundary = await fromPromise(resolveDecision(decisionKey, outcome));
      if (boundary.ok && boundary.value.ok) continue;
      resolved = false;
      deps.logger?.warn(
        {
          ...(runId ? { runId } : {}),
          errorKind: "resource" as const,
          hint: "Repair decision-quarantine storage; the safe retained row suppresses replay",
        },
        "Announcement decision reservation could not be resolved",
      );
    }
    return resolved;
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
    const operationPlan = createCompletionAnnouncementOperationPlan(
      text,
      attachments.map((entry) => entry.attachment),
    );
    if (operationPlan.pathReplacements > 0) {
      deps.logger?.debug(
        {
          batchKey: key,
          runId: first.runId,
          replacements: operationPlan.pathReplacements,
          step: "completion-caption-egress",
        },
        "Attached file paths replaced before completion delivery",
      );
    }
    const operations: AnnouncementBatchOperation[] = operationPlan.operations.map((operation) => {
      const attachmentEntry = operation.attachmentIndex === undefined
        ? undefined
        : attachments[operation.attachmentIndex];
      return {
        item: attachmentEntry?.item ?? first,
        text: operation.text,
        completionItems: items,
        ...(attachmentEntry
          ? { partId: `attachment:${attachmentEntry.index}` }
          : operation.partId
            ? { partId: operation.partId }
            : {}),
        ...(operation.attachment ? { attachment: operation.attachment } : {}),
      };
    });

    const usesDurableAttempt = deps.sendGovernedAnnouncement !== undefined
      || deps.sendRecoverableAnnouncement !== undefined
      || deps.sendToChannelWithReceipt !== undefined;
    if (usesDurableAttempt) {
      const replaceDecisions = deps.deadLetterQueue?.replaceDecisions;
      const admittedReservationKeys = items.flatMap((item) =>
        item.idempotencyKey
          ? (admittedDecisionKeys.get(item.idempotencyKey) ?? [])
          : []);
      const reservationPlan = createAnnouncementReservationPlan(
        operations,
        admittedReservationKeys,
      );
      if (!replaceDecisions || !reservationPlan.ok) {
        retainItems(items);
        deps.logger?.warn(
          {
            batchKey: key,
            runId: first.runId,
            errorKind: "precondition" as const,
            hint: "Wire atomic operation reservations before governed completion delivery",
          },
          "Announcement operations could not be reserved",
        );
        return false;
      }
      const transitioned = await fromPromise(replaceDecisions(
        reservationPlan.value.expectedKeys,
        reservationPlan.value.reservations,
        admissionAbort.signal,
      ));
      if (!transitioned.ok || !transitioned.value.ok) {
        retainItems(items);
        deps.logger?.warn(
          {
            batchKey: key,
            runId: first.runId,
            errorKind: "resource" as const,
            hint: "Restore decision-quarantine storage before retrying the completion",
          },
          "Announcement operation reservations were not persisted",
        );
        return false;
      }
      if (!transitioned.value.value.created) {
        retainItems(items);
        return false;
      }
    }

    let failure: {
      lastError?: string;
      identity?: AnnouncementOperationIdentity;
      failure?: GovernedAnnouncementFailure;
    } | undefined;
    let failedOperationIndex = -1;
    for (const [operationIndex, operation] of operations.entries()) {
      if (
        !deps.sendGovernedAnnouncement
        && !deps.sendRecoverableAnnouncement
        && deps.sendToChannelWithReceipt
      ) {
        const reservationKey = operation.reservationKey;
        const beginDeliveryAttempt = deps.deadLetterQueue?.beginDeliveryAttempt;
        if (!reservationKey || !beginDeliveryAttempt) {
          failure = { lastError: "operation_retained", failure: "operation_retained" };
          failedOperationIndex = operationIndex;
          break;
        }
        const completionKeys = operation.completionItems.flatMap((item) =>
          item.idempotencyKey ? [item.idempotencyKey] : []);
        const claimed = await fromPromise(beginDeliveryAttempt({
          announcementText: operation.text,
          channelType: operation.item.announceChannelType,
          channelId: operation.item.announceChannelId,
          agentId: operation.item.callerAgentId,
          runId: operation.item.runId,
          sessionKey: operation.item.callerSessionKey,
          failedAt: systemNowMs(),
          attemptCount: 0,
          lastError: "outward_operation_in_flight",
          idempotencyKey: reservationKey,
          rootRunId: operation.item.reservationRootRunId
            ?? `announcement:${operation.item.callerSessionKey}`,
          completionKeys,
          deliveryAuthority: {
            tenantId: operation.item.callerConversation.conversationScope.tenantId,
            agentId: operation.item.callerAgentId,
            conversationRef: operation.item.callerConversation.conversationRef,
          },
          destinationEndpoint: operation.item.destinationEndpoint,
          ...(operation.item.announceThreadId
            ? { threadId: operation.item.announceThreadId }
            : {}),
          ...(operation.partId ? { partId: operation.partId } : {}),
        }, admissionAbort.signal));
        if (!claimed.ok || !claimed.value.ok) {
          failure = { lastError: "operation_retained", failure: "operation_retained" };
          failedOperationIndex = operationIndex;
          break;
        }
        if (claimed.value.value.terminalDecision !== undefined) continue;
        if (!claimed.value.value.claimed) {
          failure = { lastError: "operation_retained", failure: "operation_retained" };
          failedOperationIndex = operationIndex;
          break;
        }
      }
      const outcome = await sendOnce(
        operation.item,
        operation.text,
        operation.completionItems.flatMap((item) =>
          item.idempotencyKey ? [item.idempotencyKey] : []),
        operation.attachment,
        operation.partId,
      );
      if (!outcome.delivered) {
        if (
          !deps.sendGovernedAnnouncement
          && !deps.sendRecoverableAnnouncement
          && operation.reservationKey
        ) {
          await deps.deadLetterQueue?.settleDeliveryAttempt(
            operation.reservationKey,
            outcome.platformStatus ?? "unknown",
          );
        }
        failure = outcome;
        failedOperationIndex = operationIndex;
        break;
      }
      if (
        !deps.sendGovernedAnnouncement
        && !deps.sendRecoverableAnnouncement
        && operation.reservationKey
      ) {
        await deps.deadLetterQueue?.settleDeliveryAttempt(
          operation.reservationKey,
          "accepted",
        );
      }
      if (operation.reservationKey && !outcome.terminalDecision) {
        if (deps.sendGovernedAnnouncement) await resolveDecisionKeys(
          [operation.reservationKey],
          "receipt_committed",
          operation.item.runId,
        );
      }
    }
    if (failure === undefined) {
      if (!usesDurableAttempt) {
        await resolveDecisions(items, "receipt_committed");
      }
      markItemsDelivered(items);
      return true;
    }

    if (failure.failure === "operation_validation_blocked") {
      const operationsResolved = await resolveDecisionKeys(
        operations.slice(failedOperationIndex).flatMap((operation) =>
          operation.reservationKey ? [operation.reservationKey] : []),
        "no_reply",
        first.runId,
      );
      const decisionsResolved = deps.sendGovernedAnnouncement
        ? true
        : await resolveDecisions(items, "no_reply");
      if (!operationsResolved || !decisionsResolved) {
        retainItems(items);
        return false;
      }
      markItemsDelivered(items);
      deps.eventBus.emit("subagent:delivery_skipped", {
        runId: first.runId,
        agentId: first.callerAgentId,
        sessionKey: first.callerSessionKey,
        reason: "route_validation_failed",
        timestamp: systemNowMs(),
      });
      deps.logger?.warn(
        {
          batchKey: key,
          runId: first.runId,
          batchSize: items.length,
          failure: failure.failure,
          step: "completion-delivery-validation",
          errorKind: "validation" as const,
          hint: "Repair the captured caller authority or delivery payload before creating a distinct completion operation",
        },
        "Announcement rejected before delivery and removed from automatic replay",
      );
      return false;
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
    if (usesDurableAttempt || attachments.length > 0) return false;
    if (!deps.deadLetterQueue) return false;
    const failedCompletionKeys = items.flatMap((item) =>
      item.idempotencyKey ? [item.idempotencyKey] : []);
    const queued = await deps.deadLetterQueue.enqueue({
      announcementText: operationPlan.operations[0]?.text ?? "",
      channelType: first.announceChannelType,
      channelId: first.announceChannelId,
      agentId: first.callerAgentId,
      runId: first.runId,
      sessionKey: first.callerSessionKey,
      failedAt: systemNowMs(),
      attemptCount: 0,
      lastError: failure.lastError ?? "outward_operation_unresolved",
      ...(first.announceThreadId ? { threadId: first.announceThreadId } : {}),
      idempotencyKey: first.idempotencyKey,
      ...(failedCompletionKeys.length > 0 ? { completionKeys: failedCompletionKeys } : {}),
      ...(failure.identity ? {
        rootRunId: failure.identity.rootRunId,
        stepIndex: failure.identity.stepIndex,
      } : {}),
      deliveryAuthority: {
        tenantId: first.callerConversation.conversationScope.tenantId,
        agentId: first.callerAgentId,
        conversationRef: first.callerConversation.conversationRef,
      },
      destinationEndpoint: first.destinationEndpoint,
    }, admissionAbort.signal);
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

      const failedOutcome = items.find(
        (item): item is QueuedAnnouncement & {
          terminalOutcome: Extract<AnnouncementTerminalOutcome, { status: "failed" }>;
        } => item.terminalOutcome.status === "failed",
      )?.terminalOutcome;
      const warningOutcome = items.find(
        (item): item is QueuedAnnouncement & {
          terminalOutcome: Extract<AnnouncementTerminalOutcome, { status: "completed_with_warnings" }>;
        } => item.terminalOutcome.status === "completed_with_warnings",
      )?.terminalOutcome;
      const disclosureOutcome = failedOutcome ?? warningOutcome;
      const suppressEntireBatchText = disclosureOutcome === undefined
        && items.every((item) => item.suppressText === true);
      if (suppressEntireBatchText) {
        if (items.some((item) => (item.attachments?.length ?? 0) > 0)) {
          await sendFinal(key, items, "");
        } else {
          const resolved = await resolveDecisions(items, "no_reply");
          if (resolved) markItemsDelivered(items);
          else retainItems(items);
        }
        return;
      }
      const parentInput = items.length === 1
        ? buildAnnouncementRewriteInput(first.announcementText, first.terminalOutcome)
        : (() => {
            const taskSections = items.map((item, idx) => {
              const stripped = stripSystemPrefix(item.announcementText);
              return `### Task ${idx + 1}\n${stripped}`;
            }).join("\n\n");
            const base = `[System Message]\n${items.length} background tasks have completed.\n\n---\n\n${taskSections}\n\n---\n\nReview these completed tasks and summarize the results for the user in your own voice. If no user notification is needed, respond with NO_REPLY.`;
            return disclosureOutcome
              ? buildAnnouncementRewriteInput(base, disclosureOutcome)
              : base;
          })();
      const citationEvidenceItems = items.filter(
        (item) => item.citationEvidence !== undefined,
      );
      const combinedCitationEvidence: CitationEvidence | undefined =
        citationEvidenceItems.length === 0
          ? undefined
          : {
              kind: "web_fetch",
              urlDigests: [...new Set(
                citationEvidenceItems.flatMap(
                  (item) => item.citationEvidence?.urlDigests ?? [],
                ),
              )].slice(0, 100),
            };
      const parentOptions = first.announceThreadId || first.resolvedLanguage || combinedCitationEvidence
        ? {
            ...(first.announceThreadId ? { threadId: first.announceThreadId } : {}),
            ...(first.resolvedLanguage ? { resolvedLanguage: first.resolvedLanguage } : {}),
            ...(combinedCitationEvidence ? { citationEvidence: combinedCitationEvidence } : {}),
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
        if (candidate === undefined && disclosureOutcome === undefined) {
          if (items.some((item) => (item.attachments?.length ?? 0) > 0)) {
            await sendFinal(key, items, "");
            return;
          }
          const resolved = await resolveDecisions(items, "no_reply");
          if (resolved) markItemsDelivered(items);
          else retainItems(items);
          return;
        }
        const scrubbedCandidate = scrubSecretsFromText(candidate ?? "");
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
        const internalEnvelopeBlocked = containsInternalAnnouncementEnvelope(scrubbedCandidate.text);
        const egressCandidate = internalEnvelopeBlocked
          ? sanitizeForUser(scrubbedCandidate.text)
          : scrubbedCandidate.text;
        if (internalEnvelopeBlocked) {
          deps.logger?.warn(
            {
              batchKey: key,
              batchSize: items.length,
              runId: first.runId,
              step: "completion-envelope-egress",
              errorKind: "validation" as const,
              hint: "Inspect the parent completion rewrite; internal announcement metadata was replaced with its user-safe result section",
            },
            "Internal completion envelope blocked at channel egress",
          );
        }
        const disclosure = disclosureOutcome
          ? enforceAnnouncementTerminalOutcome(egressCandidate, disclosureOutcome)
          : { text: egressCandidate, corrected: false };
        if (disclosure.corrected) {
          deps.logger?.warn(
            {
              batchKey: key,
              batchSize: items.length,
              runId: first.runId,
              step: "completion-honesty",
              errorKind: "validation" as const,
              hint: "Inspect the parent announcement rewrite; the runtime appended the authoritative terminal disclosure",
            },
            "Background-task terminal disclosure omitted by parent rewrite",
          );
        }
        await sendFinal(key, items, disclosure.text ?? "");
      } catch (err) {
        if (items.some((item) => (item.attachments?.length ?? 0) > 0)) {
          deps.logger?.warn(
            {
              batchKey: key,
              batchSize: items.length,
              err: toSafeErrorLogString(err),
              errorKind: err instanceof TimeoutError ? "timeout" as const : "internal" as const,
              hint: "Inspect the parent rewrite failure; verified attachments continue without a generated caption",
            },
            "Announcement parent execution failed before attachment delivery",
          );
          await sendFinal(key, items, "");
          return;
        }
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
    const reservationRootRunId = params.reservationRootRunId;
    if (idempotencyKey && (deliveredKeys.has(idempotencyKey) || retainedKeys.has(idempotencyKey))) {
      return ok("retained");
    }
    if (
      (params.attachments?.length ?? 0) > 0
      && !deps.sendGovernedAnnouncement
      && !deps.sendRecoverableAnnouncement
    ) {
      deps.logger?.warn(
        {
          runId: params.runId,
          errorKind: "precondition" as const,
          hint: "Enable receipt-aware governed attachment delivery before retrying the completion",
        },
        "Generated completion file has no governed delivery boundary",
      );
      return err(new Error("Generated completion attachment delivery unavailable"));
    }

    const reserveDecision = deps.deadLetterQueue?.reserveDecision;
    const replaceDecisions = deps.deadLetterQueue?.replaceDecisions;
    const hasAttachments = (params.attachments?.length ?? 0) > 0;
    const usesDurableAttempt = deps.sendGovernedAnnouncement !== undefined
      || deps.sendRecoverableAnnouncement !== undefined
      || deps.sendToChannelWithReceipt !== undefined;
    if (
      usesDurableAttempt
      && (
        !idempotencyKey
        || (!hasAttachments && !reserveDecision)
        || (hasAttachments && !replaceDecisions)
      )
    ) {
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
    if (deps.sendGovernedAnnouncement && !reservationRootRunId) {
      deps.logger?.warn(
        {
          runId: params.runId,
          errorKind: "precondition" as const,
          hint: "Resolve a non-empty outward ledger root for the caller conversation before governed parent rewriting",
        },
        "Governed announcement has no adjudicable ledger root",
      );
      return err(new Error("Governed announcement ledger root unavailable"));
    }
    if (
      usesDurableAttempt
      && idempotencyKey
    ) {
      const safeFallback = sanitizeForUser(params.announcementText);
      const fallbackDisclosure = enforceAnnouncementTerminalOutcome(
        safeFallback,
        params.terminalOutcome,
      );
      const fallbackText = fallbackDisclosure.text ?? safeFallback;
      const attachmentPlanSource = createCompletionAnnouncementOperationPlan(
        params.suppressText ? "" : fallbackText,
        params.attachments ?? [],
      );
      const attachmentOperations: AnnouncementBatchOperation[] = hasAttachments
        ? attachmentPlanSource.operations.map((operation) => ({
            item: params,
            text: operation.text,
            completionItems: [params],
            ...(operation.partId ? { partId: operation.partId } : {}),
            ...(operation.attachment ? { attachment: operation.attachment } : {}),
          }))
        : [];
      const attachmentPlan = attachmentOperations.length > 0
        ? createAnnouncementReservationPlan(attachmentOperations)
        : undefined;
      if (attachmentPlan && !attachmentPlan.ok) return attachmentPlan;
      const boundary = await fromPromise(
        attachmentPlan?.ok && replaceDecisions
          ? replaceDecisions([], attachmentPlan.value.reservations, admissionAbort.signal)
          : reserveDecision!({
              idempotencyKey,
              agentId: params.callerAgentId,
              runId: params.runId,
              sessionKey: params.callerSessionKey,
              announcementText: fallbackText,
              channelType: params.announceChannelType,
              channelId: params.announceChannelId,
              failedAt: systemNowMs(),
              rootRunId: reservationRootRunId ?? `announcement:${params.callerSessionKey}`,
              deliveryAuthority: {
                tenantId: params.callerConversation.conversationScope.tenantId,
                agentId: params.callerAgentId,
                conversationRef: params.callerConversation.conversationRef,
              },
              destinationEndpoint: params.destinationEndpoint,
              completionKeys: [idempotencyKey],
              ...(params.announceThreadId ? { threadId: params.announceThreadId } : {}),
            }, admissionAbort.signal),
      );
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
      admittedDecisionKeys.set(
        idempotencyKey,
        attachmentPlan?.ok
          ? attachmentPlan.value.reservations.map((reservation) => reservation.idempotencyKey)
          : [idempotencyKey],
      );
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
    admissionAbort.abort();
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
