// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";

import {
  ActivityRecordingExactnessBlockerSchema,
  ActivityRecordingGapReasonSchema,
  ActivityRecordingRecordKindSchema,
  ActivityRecordingSourceKindSchema,
  type ActivityRecordingAttemptReceipt,
  type ActivityRecordingEvidenceExport,
  type ActivityRecordingEvidenceExportInput,
  type ActivityRecordingFailure,
  type ActivityRecordingInspection,
  type ActivityRecordingReceipt,
  type ActivityRecordingSourceKind,
  type BeginDeliveryPlatformAttemptInput,
  type ClockPort,
  type ErrorKind,
  type FinishDeliveryPlatformAttemptInput,
  type ProductionActivityRecorderPort,
  type RecordInboundChannelActivityInput,
  type TimerHandle,
  type TimerPort,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

import { preflightActivityRecordingWireValue } from "./production-activity-recorder-wire-boundary.js";

export interface ActivityRecorderHandoffTransport {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onFailure(listener: (error: Error) => void): void;
  terminate(): Promise<void>;
  unref(): void;
}

export interface ProductionActivityRecorderHandoffOptions {
  readonly transport: ActivityRecorderHandoffTransport;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly capacity: number;
  readonly operationTimeoutMs: number;
  /** Aggregate structured-clone byte ceiling for every worker frame. */
  readonly maxFrameBytes: number;
  /** Renew the isolated writer lease while the recorder is otherwise idle. */
  readonly heartbeatIntervalMs?: number;
}

type RecorderMethod =
  | "recordInboundChannelActivity"
  | "beginDeliveryPlatformAttempt"
  | "finishDeliveryPlatformAttempt"
  | "exportEvidence"
  | "inspect"
  | "heartbeat"
  | "close";

interface PendingRequest {
  readonly method: RecorderMethod;
  readonly sourceKind?: ActivityRecordingSourceKind;
  readonly occurredAtMs: number;
  readonly timer: TimerHandle;
  readonly resolve: (result: Result<unknown, unknown>) => void;
}

const ERROR_KINDS = new Set<ErrorKind>([
  "config", "network", "auth", "validation", "precondition", "timeout",
  "resource", "dependency", "internal", "platform", "sandbox_unavailable",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReceipt(value: unknown): value is ActivityRecordingReceipt {
  return isObject(value)
    && typeof value.recordId === "string"
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && typeof value.recordHash === "string" && /^[0-9a-f]{64}$/.test(value.recordHash);
}

function isAttemptReceipt(value: unknown): value is ActivityRecordingAttemptReceipt {
  if (!isObject(value) || !isReceipt(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.attemptId === "string"
    && typeof candidate.settlementCapability === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(candidate.settlementCapability)
    && typeof candidate.traceId === "string"
    && Number.isSafeInteger(candidate.occurredAtMs) && Number(candidate.occurredAtMs) >= 0;
}

function isInspection(value: unknown): value is ActivityRecordingInspection {
  if (!isObject(value) || !isObject(value.exactness)) return false;
  const exactness = value.exactness;
  return Number.isSafeInteger(value.headSequence) && Number(value.headSequence) >= 0
    && typeof value.headHash === "string" && /^[0-9a-f]{64}$/.test(value.headHash)
    && Number.isSafeInteger(value.recordCount) && value.recordCount === value.headSequence
    && Number.isSafeInteger(value.logicalBytes) && Number(value.logicalBytes) >= 0
    && Number.isSafeInteger(value.gapCount) && Number(value.gapCount) >= 0
    && typeof value.trustedHeadAnchor === "boolean"
    && exactness.eligible === false
    && Array.isArray(exactness.blockers)
    && exactness.blockers.every(
      (blocker) => ActivityRecordingExactnessBlockerSchema.safeParse(blocker).success,
    );
}

function isEvidenceRecord(value: unknown): boolean {
  return isObject(value)
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && typeof value.recordId === "string" && /^record:\d{20}$/.test(value.recordId)
    && ActivityRecordingRecordKindSchema.safeParse(value.kind).success
    && (value.traceId === null || typeof value.traceId === "string")
    && (value.parentRecordId === null || typeof value.parentRecordId === "string")
    && Number.isSafeInteger(value.occurredAtMs) && Number(value.occurredAtMs) >= 0
    && Number.isSafeInteger(value.payloadBytes) && Number(value.payloadBytes) >= 0
    && typeof value.previousHash === "string" && /^[0-9a-f]{64}$/.test(value.previousHash)
    && typeof value.recordHash === "string" && /^[0-9a-f]{64}$/.test(value.recordHash)
    && "payload" in value;
}

function isEvidenceExport(value: unknown): value is ActivityRecordingEvidenceExport {
  if (!isObject(value) || !Array.isArray(value.records) || !isInspection(value.inspection)) {
    return false;
  }
  return value.records.length <= 1_000
    && value.records.every(isEvidenceRecord)
    && Number.isSafeInteger(value.totalRecordCount) && Number(value.totalRecordCount) >= 0
    && Number.isSafeInteger(value.snapshotHeadSequence) && Number(value.snapshotHeadSequence) >= 0
    && value.totalRecordCount === value.snapshotHeadSequence
    && value.inspection.headSequence === value.snapshotHeadSequence
    && (value.nextAfterSequence === undefined
      || (Number.isSafeInteger(value.nextAfterSequence) && Number(value.nextAfterSequence) >= 0));
}

function isActivityFailure(value: unknown): value is Omit<ActivityRecordingFailure, "cause"> & {
  readonly cause?: unknown;
} {
  if (!isObject(value)) return false;
  return ActivityRecordingGapReasonSchema.safeParse(value.reason).success
    && ActivityRecordingSourceKindSchema.safeParse(value.sourceKind).success
    && typeof value.gapDurablyAccounted === "boolean"
    && Number.isSafeInteger(value.gapCount) && Number(value.gapCount) >= 0
    && Number.isSafeInteger(value.occurredAtMs) && Number(value.occurredAtMs) >= 0
    && typeof value.errorKind === "string" && ERROR_KINDS.has(value.errorKind as ErrorKind);
}

function runtimeFailure(input: {
  readonly sourceKind: ActivityRecordingSourceKind;
  readonly reason:
    | "clock_unavailable"
    | "handoff_capacity_exceeded"
    | "handoff_timeout"
    | "payload_invalid"
    | "payload_too_large"
    | "recorder_closed"
    | "storage_failed";
  readonly occurredAtMs: number;
  readonly cause: Error;
}): ActivityRecordingFailure {
  const errorKind: ErrorKind = input.reason === "handoff_timeout"
    ? "timeout"
    : input.reason === "payload_invalid" || input.reason === "payload_too_large"
      ? "validation"
      : input.reason === "clock_unavailable"
        ? "dependency"
    : input.reason === "recorder_closed"
      ? "precondition"
      : "resource";
  return {
    ...input,
    errorKind,
    gapDurablyAccounted: false,
    gapCount: 0,
  };
}

function genericError(value: unknown): Error {
  if (isObject(value) && typeof value.message === "string") return new Error(value.message);
  return new Error("Activity recorder worker returned an invalid failure");
}

/**
 * Bounded nonblocking request handoff. SQLite and encryption run behind the
 * transport; request paths only validate capacity, clone one frame, and return.
 */
export function createProductionActivityRecorderHandoff(
  options: ProductionActivityRecorderHandoffOptions,
): Result<ProductionActivityRecorderPort, Error> {
  if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
    return err(new Error("Activity recorder handoff capacity must be positive"));
  }
  if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs <= 0) {
    return err(new Error("Activity recorder handoff timeout must be positive"));
  }
  if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes <= 0) {
    return err(new Error("Activity recorder handoff frame limit must be positive"));
  }
  if (options.heartbeatIntervalMs !== undefined
    && (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs <= 0)) {
    return err(new Error("Activity recorder heartbeat interval must be positive"));
  }
  const pending = new Map<string, PendingRequest>();
  // A timed-out request is still physically queued until the worker responds
  // or the transport fails. Keep charging it to capacity across that interval.
  const outstanding = new Map<string, (() => void) | undefined>();
  let closed = false;
  let closePromise: Promise<Result<void, Error>> | undefined;
  let heartbeatTimer: TimerHandle | undefined;
  let heartbeatInFlight = false;

  function settlePending(requestId: string, result: Result<unknown, unknown>): void {
    const request = pending.get(requestId);
    if (request === undefined) return;
    pending.delete(requestId);
    request.timer.cancel();
    request.resolve(result);
  }

  function failPending(cause: Error): void {
    for (const [requestId, request] of pending) {
      const result = request.sourceKind === undefined
        ? err(cause)
        : err(runtimeFailure({
            sourceKind: request.sourceKind,
            reason: "storage_failed",
            occurredAtMs: request.occurredAtMs,
            cause,
          }));
      settlePending(requestId, result);
    }
    outstanding.clear();
  }

  options.transport.onMessage((message) => {
    if (!isObject(message) || message.kind !== "response" || typeof message.requestId !== "string") return;
    const acknowledged = outstanding.get(message.requestId);
    if (!outstanding.delete(message.requestId)) return;
    acknowledged?.();
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    const wire = message.result;
    if (!isObject(wire) || typeof wire.ok !== "boolean") {
      settlePending(message.requestId, request.sourceKind === undefined
        ? err(new Error("Activity recorder worker returned a malformed response"))
        : err(runtimeFailure({
            sourceKind: request.sourceKind,
            reason: "storage_failed",
            occurredAtMs: request.occurredAtMs,
            cause: new Error("Activity recorder worker returned a malformed response"),
          })));
      return;
    }
    if (!wire.ok) {
      if (request.sourceKind !== undefined && isActivityFailure(wire.error)) {
        settlePending(message.requestId, err({
          ...wire.error,
          cause: new Error("Activity recorder worker reported a typed failure"),
        }));
      } else {
        settlePending(message.requestId, err(genericError(wire.error)));
      }
      return;
    }
    if ((request.method === "recordInboundChannelActivity"
        || request.method === "finishDeliveryPlatformAttempt") && !isReceipt(wire.value)) {
      settlePending(message.requestId, err(runtimeFailure({
        sourceKind: request.sourceKind!,
        reason: "storage_failed",
        occurredAtMs: request.occurredAtMs,
        cause: new Error("Activity recorder worker returned a malformed receipt"),
      })));
      return;
    }
    if (request.method === "beginDeliveryPlatformAttempt" && !isAttemptReceipt(wire.value)) {
      settlePending(message.requestId, err(runtimeFailure({
        sourceKind: request.sourceKind!,
        reason: "storage_failed",
        occurredAtMs: request.occurredAtMs,
        cause: new Error("Activity recorder worker returned a malformed attempt authority"),
      })));
      return;
    }
    if (request.method === "inspect" && !isInspection(wire.value)) {
      settlePending(message.requestId, err(new Error(
        "Activity recorder worker returned a malformed inspection",
      )));
      return;
    }
    if (request.method === "exportEvidence" && !isEvidenceExport(wire.value)) {
      settlePending(message.requestId, err(new Error(
        "Activity recorder worker returned a malformed evidence page",
      )));
      return;
    }
    if ((request.method === "heartbeat" || request.method === "close")
      && wire.value !== undefined) {
      settlePending(message.requestId, err(new Error(
        "Activity recorder worker returned a malformed lifecycle acknowledgement",
      )));
      return;
    }
    settlePending(message.requestId, ok(wire.value));
  });
  options.transport.onFailure((error) => {
    heartbeatTimer?.cancel();
    failPending(new Error("Activity recorder worker became unavailable", { cause: error }));
  });
  options.transport.unref();

  function readClock(): Result<number, Error> {
    const read = tryCatch(() => options.clock.now());
    if (!read.ok) return read;
    return Number.isSafeInteger(read.value) && read.value >= 0
      ? read
      : err(new Error("Activity recorder clock returned an invalid timestamp"));
  }

  function request(
    method: RecorderMethod,
    input: unknown,
    sourceKind?: ActivityRecordingSourceKind,
    occurredAtMs?: number,
    bypassCapacity = false,
    onAcknowledged?: () => void,
  ): Promise<Result<unknown, unknown>> {
    const clock = readClock();
    if (!clock.ok) {
      onAcknowledged?.();
      return Promise.resolve(sourceKind === undefined
        ? err(clock.error)
        : err(runtimeFailure({
            sourceKind,
            reason: "clock_unavailable",
            occurredAtMs: occurredAtMs ?? 0,
            cause: clock.error,
          })));
    }
    const effectiveOccurredAtMs = occurredAtMs ?? clock.value;
    if (!bypassCapacity && outstanding.size >= options.capacity) {
      onAcknowledged?.();
      return Promise.resolve(sourceKind === undefined
        ? err(new Error("Activity recorder handoff capacity is exhausted"))
        : err(runtimeFailure({
            sourceKind,
            reason: "handoff_capacity_exceeded",
            occurredAtMs: effectiveOccurredAtMs,
            cause: new Error("Activity recorder handoff capacity is exhausted"),
          })));
    }
    const requestId = randomUUID();
    const frame = {
      kind: "request",
      requestId,
      method,
      input,
      nowMs: clock.value,
    };
    const bounded = preflightActivityRecordingWireValue(frame, options.maxFrameBytes);
    if (!bounded.ok) {
      onAcknowledged?.();
      return Promise.resolve(sourceKind === undefined
        ? err(bounded.error.cause)
        : err(runtimeFailure({
            sourceKind,
            reason: bounded.error.reason,
            occurredAtMs: effectiveOccurredAtMs,
            cause: bounded.error.cause,
          })));
    }
    return new Promise((resolve) => {
      const timer = options.timers.setTimeout(() => {
        const current = pending.get(requestId);
        if (current === undefined) return;
        const result = current.sourceKind === undefined
          ? err(new Error("Activity recorder worker operation timed out"))
          : err(runtimeFailure({
              sourceKind: current.sourceKind,
              reason: "handoff_timeout",
              occurredAtMs: current.occurredAtMs,
              cause: new Error("Activity recorder worker operation timed out"),
            }));
        settlePending(requestId, result);
      }, options.operationTimeoutMs);
      timer.unref();
      pending.set(requestId, {
        method, sourceKind, occurredAtMs: effectiveOccurredAtMs, timer, resolve,
      });
      outstanding.set(requestId, onAcknowledged);
      const posted = tryCatch(() => options.transport.postMessage(frame));
      if (!posted.ok) {
        outstanding.delete(requestId);
        onAcknowledged?.();
        const result = sourceKind === undefined
          ? err(posted.error)
          : err(runtimeFailure({
              sourceKind,
              reason: "storage_failed",
              occurredAtMs: effectiveOccurredAtMs,
              cause: posted.error,
            }));
        settlePending(requestId, result);
      }
    });
  }

  function rejectClosed<T>(
    sourceKind: ActivityRecordingSourceKind,
    occurredAtMs: number,
  ): Promise<Result<T, ActivityRecordingFailure>> {
    return Promise.resolve(err(runtimeFailure({
      sourceKind,
      reason: "recorder_closed",
      occurredAtMs,
      cause: new Error("Production activity recorder is closed"),
    })));
  }

  const recorder: ProductionActivityRecorderPort = {
    recordInboundChannelActivity(input: RecordInboundChannelActivityInput) {
      if (closed) return rejectClosed("channel_inbound_normalized", input.occurredAtMs);
      return request(
        "recordInboundChannelActivity", input, "channel_inbound_normalized", input.occurredAtMs,
      ) as Promise<Result<ActivityRecordingReceipt, ActivityRecordingFailure>>;
    },
    beginDeliveryPlatformAttempt(input: BeginDeliveryPlatformAttemptInput) {
      if (closed) return rejectClosed("delivery_platform_attempt", input.occurredAtMs);
      return request(
        "beginDeliveryPlatformAttempt", input, "delivery_platform_attempt", input.occurredAtMs,
      ) as Promise<Result<ActivityRecordingAttemptReceipt, ActivityRecordingFailure>>;
    },
    finishDeliveryPlatformAttempt(input: FinishDeliveryPlatformAttemptInput) {
      if (closed) return rejectClosed("delivery_platform_outcome", input.occurredAtMs);
      return request(
        "finishDeliveryPlatformAttempt", input, "delivery_platform_outcome", input.occurredAtMs,
      ) as Promise<Result<ActivityRecordingReceipt, ActivityRecordingFailure>>;
    },
    exportEvidence(input: ActivityRecordingEvidenceExportInput) {
      if (closed) return Promise.resolve(err(new Error("Production activity recorder is closed")));
      return request("exportEvidence", input) as Promise<Result<ActivityRecordingEvidenceExport, Error>>;
    },
    inspect() {
      if (closed) return Promise.resolve(err(new Error("Production activity recorder is closed")));
      return request("inspect", undefined) as Promise<Result<ActivityRecordingInspection, Error>>;
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      heartbeatTimer?.cancel();
      closePromise = (request("close", undefined, undefined, undefined, true) as Promise<Result<void, Error>>)
        .then(async (result) => {
          const invoked = tryCatch(() => options.transport.terminate());
          const terminated = invoked.ok ? await fromPromise(invoked.value) : invoked;
          if (!result.ok) return result;
          return terminated.ok ? ok(undefined) : err(terminated.error);
        });
      return closePromise;
    },
  };
  if (options.heartbeatIntervalMs !== undefined) {
    heartbeatTimer = options.timers.setInterval(() => {
      if (closed || heartbeatInFlight) return;
      heartbeatInFlight = true;
      void request(
        "heartbeat",
        undefined,
        undefined,
        undefined,
        true,
        () => { heartbeatInFlight = false; },
      );
    }, options.heartbeatIntervalMs);
    heartbeatTimer.unref();
  }
  return ok(Object.freeze(recorder));
}
