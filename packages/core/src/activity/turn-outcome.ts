// SPDX-License-Identifier: Apache-2.0
/**
 * TurnOutcome + delivery receipts (spec §4.3).
 *
 * Pure TS interfaces and a discriminated union — no Zod runtime. The delivery
 * stage captures `deliveredAtMs` itself (the chunk schema carries no per-chunk
 * timestamp); both the success and failure branches have an explicit receipt
 * shape so the coordinator can reason about either cleanly.
 */
import type { Result } from "@comis/shared";
import type { ErrorKind } from "../logging/log-fields.js";
import type { ActivityEvent } from "./activity-event.js";

/**
 * Aggregated telemetry returned by the delivery stage when every chunk
 * was delivered successfully. `deliveredAtMs` is captured by
 * `deliverExecutionResponse` at the moment the last chunk's send-promise
 * resolves (§16.6). The chunk schema does NOT carry a per-chunk timestamp;
 * the delivery stage takes one once at end.
 */
export interface FinalDeliveryReceipt {
  ok: true;
  deliveredChunks: number;
  lastChunkMessageId: string;
  /** Epoch ms captured via ClockPort/systemNowMs immediately after the last chunk's send-promise resolved. */
  deliveredAtMs: number;
}

/**
 * Returned when at least one chunk failed to send. Preserves enough state
 * for the coordinator to: (a) classify the turn as `kind:"failure"`,
 * (b) decide whether to render a diagnostic line, (c) emit observability.
 */
export interface DeliveryFailureReceipt {
  ok: false;
  deliveredChunks: number;
  failedChunks: number;
  /** ErrorKind from the first failed chunk (or "platform" if unclassified). */
  errorKind: ErrorKind;
  /** Truncated message from the first failure (≤ 200 chars; redacted). */
  lastError: string;
  /** Monotonic ms when the failure was observed. */
  failedAtMs: number;
}

/**
 * The orchestrator's delivery stage now returns this Result. Previously
 * returned Promise<void>; §16.6 specifies the bridge change.
 */
export type DeliveryStageResult = Result<FinalDeliveryReceipt, DeliveryFailureReceipt>;

export type TurnOutcome =
  | { kind: "success"; trivial: boolean; delivery: FinalDeliveryReceipt }
  | { kind: "success_with_recovered_failures"; trivial: false;
      delivery: FinalDeliveryReceipt; recoveredFailures: readonly [ActivityEvent, ...ActivityEvent[]] }
  | { kind: "failure"; errorKind: ErrorKind; failedEvents: readonly ActivityEvent[];
      /** Present if delivery (not tool) was the failure source. */
      deliveryReceipt?: DeliveryFailureReceipt }
  | { kind: "silent"; reason: "SILENT" | "HEARTBEAT_OK" | "NO_REPLY" }
  | { kind: "aborted"; reason: "user_cancel" | "timeout" | "fatal" };

/**
 * Runtime guard enforcing the non-empty-tuple invariant of
 * `success_with_recovered_failures.recoveredFailures`. The tuple type proves
 * non-emptiness at compile time; this guard lets the caller build the tuple
 * from a `readonly ActivityEvent[]` at runtime without an unchecked cast.
 */
export function isNonEmptyEvents(
  events: readonly ActivityEvent[],
): events is readonly [ActivityEvent, ...ActivityEvent[]] {
  return events.length > 0;
}
