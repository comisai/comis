// SPDX-License-Identifier: Apache-2.0
/** Recorder-aware adapter used at the physical platform-send boundary. */
import { randomUUID } from "node:crypto";
import { err, fromPromise, ok, suppressError, tryCatch, type Result } from "@comis/shared";

import type { ActivityRecordingSourceKind } from "../domain/activity-recording.js";
import type { TypedEventBus } from "../event-bus/bus.js";
import type { ComisLogger } from "../logging/log-fields.js";
import type {
  ActivityRecordingFailure,
  ProductionActivityRecorderPort,
} from "../ports/activity-recorder.js";
import type { ClockPort } from "../ports/clock.js";
import type { DeliveryAdapter } from "./types.js";

export interface ActivityRecordingDeliveryDeps {
  readonly activityRecorder?: ProductionActivityRecorderPort;
  readonly eventBus?: TypedEventBus;
  readonly logger: ComisLogger;
  readonly clock: ClockPort;
  readonly trackActivityRecording?: (operation: Promise<unknown>) => void;
}

function reportFailure(
  deps: Pick<ActivityRecordingDeliveryDeps, "eventBus" | "logger">,
  failure: ActivityRecordingFailure,
): void {
  void tryCatch(() => deps.logger.warn({
    step: "activity-recording",
    sourceKind: failure.sourceKind,
    reason: failure.reason,
    gapDurablyAccounted: failure.gapDurablyAccounted,
    gapCount: failure.gapCount,
    errorKind: failure.errorKind,
    hint: "Restore activity recorder storage and key access before relying on prospective replay evidence",
  }, "Prospective activity recording gap detected"));
  void tryCatch(() => deps.eventBus?.emit("activity-recording:gap", {
    sourceKind: failure.sourceKind,
    reason: failure.reason,
    gapDurablyAccounted: failure.gapDurablyAccounted,
    gapCount: failure.gapCount,
    errorKind: failure.errorKind,
    timestamp: failure.occurredAtMs,
  }));
}

function unaccountedFailure(
  sourceKind: ActivityRecordingSourceKind,
  occurredAtMs: number,
  cause: Error,
): ActivityRecordingFailure {
  return {
    sourceKind,
    reason: "storage_failed",
    gapDurablyAccounted: false,
    gapCount: 0,
    occurredAtMs,
    errorKind: "resource",
    cause,
  };
}

function clockFailure(
  sourceKind: ActivityRecordingSourceKind,
  occurredAtMs: number,
  cause: Error,
): ActivityRecordingFailure {
  return {
    sourceKind,
    reason: "clock_unavailable",
    gapDurablyAccounted: false,
    gapCount: 0,
    occurredAtMs,
    errorKind: "dependency",
    cause,
  };
}

function readClock(clock: ClockPort): Result<number, Error> {
  const read = tryCatch(() => clock.now());
  if (!read.ok) return read;
  return Number.isSafeInteger(read.value) && read.value >= 0
    ? read
    : err(new Error("Activity recorder delivery clock returned an invalid timestamp"));
}

function isRecorderResult(value: unknown): value is Result<unknown, ActivityRecordingFailure> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown };
  return candidate.ok === true
    ? "value" in candidate
    : candidate.ok === false && "error" in candidate;
}

async function invokeRecorder<T>(
  sourceKind: ActivityRecordingSourceKind,
  occurredAtMs: number,
  operation: () => Promise<Result<T, ActivityRecordingFailure>>,
): Promise<Result<T, ActivityRecordingFailure>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(unaccountedFailure(sourceKind, occurredAtMs, invoked.error));
  const awaited = await fromPromise(invoked.value);
  if (!awaited.ok) return err(unaccountedFailure(sourceKind, occurredAtMs, awaited.error));
  return isRecorderResult(awaited.value)
    ? awaited.value as Result<T, ActivityRecordingFailure>
    : err(unaccountedFailure(
        sourceKind,
        occurredAtMs,
        new Error("Activity recorder returned a malformed result"),
      ));
}

/**
 * Decorate only the physical send call. RetryEngine therefore invokes this
 * wrapper once per real attempt, including modified markdown fallback text.
 */
export function createActivityRecordingAdapter(
  deps: ActivityRecordingDeliveryDeps,
  adapter: DeliveryAdapter,
  input: {
    readonly traceId: string | null;
    readonly origin: string;
    readonly chunkIndex: number;
    readonly totalChunks: number;
  },
): DeliveryAdapter {
  const recorder = deps.activityRecorder;
  if (recorder === undefined) return adapter;
  const traceId = input.traceId === null ? tryCatch(randomUUID) : ok(input.traceId);
  return {
    channelType: adapter.channelType,
    ...(adapter.channelId === undefined ? {} : { channelId: adapter.channelId }),
    async sendMessage(channelId, text, options) {
      const attemptClock = readClock(deps.clock);
      const attemptStartedAt = attemptClock.ok ? attemptClock.value : 0;
      const begunPromise = !traceId.ok
        ? Promise.resolve(err(unaccountedFailure(
            "delivery_platform_attempt", attemptStartedAt, traceId.error,
          )))
        : !attemptClock.ok
          ? Promise.resolve(err(clockFailure(
              "delivery_platform_attempt", attemptStartedAt, attemptClock.error,
            )))
          : invokeRecorder(
              "delivery_platform_attempt",
              attemptStartedAt,
              () => recorder.beginDeliveryPlatformAttempt({
                traceId: traceId.value,
                occurredAtMs: attemptStartedAt,
                channelType: adapter.channelType,
                channelId,
                text,
                options: options ?? {},
                origin: input.origin,
                chunkIndex: input.chunkIndex,
                totalChunks: input.totalChunks,
              }),
            );

      const called = tryCatch(() => adapter.sendMessage(channelId, text, options));
      const delivered = called.ok
        ? await fromPromise(called.value)
        : err(called.error);
      // Sample at the physical settlement boundary, before recorder latency can
      // reorder or inflate the encrypted outcome timestamp.
      const outcomeClock = readClock(deps.clock);
      const settled = begunPromise.then(async (begun) => {
        if (!begun.ok) {
          reportFailure(deps, begun.error);
          return;
        }
        if (!outcomeClock.ok) {
          reportFailure(deps, clockFailure(
            "delivery_platform_outcome",
            begun.value.occurredAtMs,
            outcomeClock.error,
          ));
          return;
        }
        const outcomeAt = outcomeClock.value;
        if (!delivered.ok) {
          const finished = await invokeRecorder(
            "delivery_platform_outcome",
            outcomeAt,
            () => recorder.finishDeliveryPlatformAttempt({
              attempt: begun.value,
              occurredAtMs: outcomeAt,
              outcomeClass: "adapter_throw",
              error: {
                name: delivered.error.name,
                message: delivered.error.message,
                stack: delivered.error.stack,
              },
            }),
          );
          if (!finished.ok) reportFailure(deps, finished.error);
          return;
        }
        const platformResult = delivered.value;
        const finishInput = platformResult.ok
          ? {
              attempt: begun.value,
              occurredAtMs: outcomeAt,
              outcomeClass: "success" as const,
              platformMessageId: platformResult.value,
            }
          : {
              attempt: begun.value,
              occurredAtMs: outcomeAt,
              outcomeClass: "platform_error" as const,
              error: {
                name: platformResult.error.name,
                message: platformResult.error.message,
                stack: platformResult.error.stack,
              },
            };
        const finished = await invokeRecorder(
          "delivery_platform_outcome",
          outcomeAt,
          () => recorder.finishDeliveryPlatformAttempt(finishInput),
        );
        if (!finished.ok) reportFailure(deps, finished.error);
      });
      void tryCatch(() => deps.trackActivityRecording?.(settled));
      suppressError(settled, "activity-recording-delivery-settlement", () => {
        void tryCatch(() => deps.logger.debug(
          { step: "activity-recording" },
          "Activity recording settlement task failed",
        ));
      });
      if (!delivered.ok) return Promise.reject(delivered.error);
      return delivered.value;
    },
  };
}
