// SPDX-License-Identifier: Apache-2.0
import { err, type Result } from "@comis/shared";

import type {
  ActivityRecordingFailure,
  ActivityRecordingGapReason,
  ActivityRecordingReceipt,
  ActivityRecordingSourceKind,
} from "@comis/core";

import {
  type AppendRecordInput,
  type InternalAppendFailure,
  errorKindFor,
} from "./production-activity-recorder-support.js";

interface LossInput {
  readonly sourceKind: ActivityRecordingSourceKind;
  readonly reason: ActivityRecordingGapReason;
  readonly cause: Error;
  readonly traceId: string | null;
  readonly parentRecordId: string | null;
  readonly occurredAtMs: number;
}

interface CreateFailureAccountingOptions {
  readonly appendRecord: (
    input: AppendRecordInput,
  ) => Result<ActivityRecordingReceipt, InternalAppendFailure>;
  readonly currentGapCount: () => number;
}

export interface ActivityRecorderFailureAccounting {
  rejectWithoutGap(input: Omit<LossInput, "traceId" | "parentRecordId">): ActivityRecordingFailure;
  accountLoss(input: LossInput): ActivityRecordingFailure;
  appendOrAccount(
    sourceKind: ActivityRecordingSourceKind,
    input: AppendRecordInput,
  ): Result<ActivityRecordingReceipt, ActivityRecordingFailure>;
  closedFailure(
    sourceKind: ActivityRecordingSourceKind,
    occurredAtMs: number,
  ): ActivityRecordingFailure;
}

function isSettlementRejection(reason: ActivityRecordingGapReason): boolean {
  return reason === "causal_parent_invalid" ||
    reason === "attempt_already_settled" ||
    reason === "settlement_capability_invalid" ||
    reason === "trace_mismatch" ||
    reason === "timestamp_order_invalid" ||
    reason === "outcome_shape_invalid";
}

/** Centralizes durable gap accounting and content-free failure projection. */
export function createActivityRecorderFailureAccounting(
  options: CreateFailureAccountingOptions,
): ActivityRecorderFailureAccounting {
  function rejectWithoutGap(
    input: Omit<LossInput, "traceId" | "parentRecordId">,
  ): ActivityRecordingFailure {
    return {
      ...input,
      gapDurablyAccounted: false,
      gapCount: options.currentGapCount(),
      errorKind: errorKindFor(input.reason),
    };
  }

  function accountLoss(input: LossInput): ActivityRecordingFailure {
    const gap = options.appendRecord({
      kind: "gap",
      traceId: input.traceId,
      parentRecordId: input.parentRecordId,
      attemptId: null,
      capabilityDigest: null,
      occurredAtMs: input.occurredAtMs,
      payload: { reason: input.reason, sourceKind: input.sourceKind },
      useGapReserve: true,
    });
    return {
      reason: input.reason,
      sourceKind: input.sourceKind,
      gapDurablyAccounted: gap.ok,
      gapCount: options.currentGapCount(),
      occurredAtMs: input.occurredAtMs,
      errorKind: errorKindFor(input.reason),
      cause: input.cause,
    };
  }

  function appendOrAccount(
    sourceKind: ActivityRecordingSourceKind,
    input: AppendRecordInput,
  ): Result<ActivityRecordingReceipt, ActivityRecordingFailure> {
    const appended = options.appendRecord(input);
    if (appended.ok) return appended;
    if (
      appended.error.persistedReceipt !== undefined ||
      appended.error.reason === "head_anchor_conflict" ||
      appended.error.reason === "head_anchor_unavailable" ||
      isSettlementRejection(appended.error.reason)
    ) {
      return err({
        reason: appended.error.reason,
        sourceKind,
        gapDurablyAccounted: false,
        gapCount: options.currentGapCount(),
        occurredAtMs: input.occurredAtMs,
        errorKind: errorKindFor(appended.error.reason),
        cause: appended.error.cause,
      });
    }
    return err(accountLoss({
      sourceKind,
      reason: appended.error.reason,
      cause: appended.error.cause,
      traceId: input.traceId,
      parentRecordId: input.parentRecordId,
      occurredAtMs: input.occurredAtMs,
    }));
  }

  function closedFailure(
    sourceKind: ActivityRecordingSourceKind,
    occurredAtMs: number,
  ): ActivityRecordingFailure {
    return rejectWithoutGap({
      sourceKind,
      reason: "recorder_closed",
      occurredAtMs,
      cause: new Error("Production activity recorder is closed"),
    });
  }

  return Object.freeze({ rejectWithoutGap, accountLoss, appendOrAccount, closedFailure });
}
