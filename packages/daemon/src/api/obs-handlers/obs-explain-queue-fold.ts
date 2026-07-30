// SPDX-License-Identifier: Apache-2.0
/**
 * Content-free queue and steering timeline fold for `obs.explain`.
 *
 * @module
 */
import type { IncidentSignals } from "@comis/core";
import { asNumber, asString } from "./obs-explain-signals-fields.js";
import type { Acc } from "./obs-explain-signals-acc.js";

const QUEUE_TIMELINE_CAP = 20;
type QueueEntry = NonNullable<IncidentSignals["queueTimeline"]>[number];
type QueueMode = NonNullable<QueueEntry["mode"]>;
type SteerReason = NonNullable<QueueEntry["reason"]>;

function queueMode(value: unknown): QueueMode | undefined {
  const mode = asString(value);
  return mode === "followup"
    || mode === "collect"
    || mode === "steer"
    || mode === "steer+followup"
    ? mode
    : undefined;
}

function steerReason(value: unknown): SteerReason | undefined {
  const reason = asString(value);
  return reason === "not_streaming"
    || reason === "compacting"
    || reason === "no_active_run"
    ? reason
    : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const number = nonnegativeNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

function retain(acc: Pick<Acc, "queueTimeline">, entry: QueueEntry): void {
  acc.queueTimeline.push(entry);
  acc.queueTimeline.sort((a, b) => b.seq - a.seq);
  if (acc.queueTimeline.length > QUEUE_TIMELINE_CAP) {
    acc.queueTimeline.length = QUEUE_TIMELINE_CAP;
  }
}

/**
 * Fold a recognized queue event and return true. Malformed recognized events
 * are consumed without being surfaced; unrelated records return false.
 */
export function accumulateQueueRecord(
  acc: Pick<Acc, "queueTimeline">,
  type: string,
  seq: number | undefined,
  data: Record<string, unknown>,
): boolean {
  const channelType = asString(data.channelType);
  if (!type.startsWith("queue.")) return false;
  if (seq === undefined || channelType === undefined) return true;
  const base = { seq, channelType };

  switch (type) {
    case "queue.enqueued":
      retain(acc, {
        ...base,
        event: "enqueued",
        ...(nonnegativeInteger(data.queueDepth) !== undefined
          ? { queueDepth: nonnegativeInteger(data.queueDepth) }
          : {}),
        ...(queueMode(data.mode) !== undefined ? { mode: queueMode(data.mode) } : {}),
      });
      return true;
    case "queue.dequeued":
      retain(acc, {
        ...base,
        event: "dequeued",
        ...(nonnegativeNumber(data.waitTimeMs) !== undefined
          ? { waitTimeMs: nonnegativeNumber(data.waitTimeMs) }
          : {}),
      });
      return true;
    case "queue.overflow":
      retain(acc, {
        ...base,
        event: "overflow",
        ...(asString(data.policy) !== undefined ? { policy: asString(data.policy) } : {}),
        ...(nonnegativeInteger(data.droppedCount) !== undefined
          ? { droppedCount: nonnegativeInteger(data.droppedCount) }
          : {}),
      });
      return true;
    case "queue.coalesced":
      retain(acc, {
        ...base,
        event: "coalesced",
        ...(nonnegativeInteger(data.messageCount) !== undefined
          ? { messageCount: nonnegativeInteger(data.messageCount) }
          : {}),
      });
      return true;
    case "queue.steer_injected":
      retain(acc, { ...base, event: "steer_injected" });
      return true;
    case "queue.steer_rejected":
      retain(acc, {
        ...base,
        event: "steer_rejected",
        ...(steerReason(data.reason) !== undefined
          ? { reason: steerReason(data.reason) }
          : {}),
      });
      return true;
    case "queue.followup_queued":
      retain(acc, {
        ...base,
        event: "followup_queued",
        ...(steerReason(data.reason) !== undefined
          ? { reason: steerReason(data.reason) }
          : {}),
      });
      return true;
    default:
      return false;
  }
}
