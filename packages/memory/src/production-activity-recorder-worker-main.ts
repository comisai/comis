// SPDX-License-Identifier: Apache-2.0
import { parentPort, workerData } from "node:worker_threads";

import type {
  ActivityRecordingFailure,
  ActivityRecordingSourceKind,
} from "@comis/core";
import { err, fromPromise, tryCatch, type Result } from "@comis/shared";
import { createActivityRecordingCrypto } from "@comis/observability";

import {
  openSqliteProductionActivityRecorder,
  type ActivityRecorderLimits,
} from "./production-activity-recorder.js";
import type { RuntimeProductionActivityRecorder } from "./production-activity-recorder-support.js";
import { preflightActivityRecordingWireValue } from "./production-activity-recorder-wire-boundary.js";

interface WorkerOptions {
  readonly version: 1;
  readonly dbPath: string;
  readonly masterKey: Uint8Array;
  readonly limits: ActivityRecorderLimits;
  readonly initialNowMs: number;
  readonly writerLeaseMs: number;
  readonly maxFrameBytes: number;
  readonly streamId?: string;
}

type RecorderMethod =
  | "recordInboundChannelActivity"
  | "beginDeliveryPlatformAttempt"
  | "finishDeliveryPlatformAttempt"
  | "exportEvidence"
  | "inspect"
  | "heartbeat"
  | "close";

interface RequestFrame {
  readonly kind: "request";
  readonly requestId: string;
  readonly method: RecorderMethod;
  readonly input: unknown;
  readonly nowMs: number;
}

function isWorkerOptions(value: unknown): value is WorkerOptions {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkerOptions>;
  return candidate.version === 1
    && typeof candidate.dbPath === "string"
    && candidate.masterKey instanceof Uint8Array
    && typeof candidate.limits === "object" && candidate.limits !== null
    && Number.isSafeInteger(candidate.initialNowMs) && Number(candidate.initialNowMs) >= 0
    && Number.isSafeInteger(candidate.writerLeaseMs) && Number(candidate.writerLeaseMs) > 0
    && Number.isSafeInteger(candidate.maxFrameBytes) && Number(candidate.maxFrameBytes) > 0
    && (candidate.streamId === undefined || typeof candidate.streamId === "string");
}

function isRequestFrame(value: unknown): value is RequestFrame {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RequestFrame>;
  return candidate.kind === "request"
    && typeof candidate.requestId === "string"
    && (candidate.method === "recordInboundChannelActivity"
      || candidate.method === "beginDeliveryPlatformAttempt"
      || candidate.method === "finishDeliveryPlatformAttempt"
      || candidate.method === "exportEvidence"
      || candidate.method === "inspect"
      || candidate.method === "heartbeat"
      || candidate.method === "close")
    && Number.isSafeInteger(candidate.nowMs) && Number(candidate.nowMs) >= 0;
}

function isActivityFailure(value: unknown): value is ActivityRecordingFailure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ActivityRecordingFailure>;
  return typeof candidate.reason === "string"
    && typeof candidate.sourceKind === "string"
    && typeof candidate.gapDurablyAccounted === "boolean"
    && typeof candidate.errorKind === "string";
}

function wireResult(result: Result<unknown, unknown>): unknown {
  if (result.ok) return { ok: true, value: result.value };
  if (isActivityFailure(result.error)) {
    const { cause: _cause, ...safeFailure } = result.error;
    return { ok: false, error: safeFailure };
  }
  return {
    ok: false,
    error: {
      message: result.error instanceof Error
        ? result.error.message
        : "Activity recorder worker operation failed",
    },
  };
}

function isSingleRecordEvidencePage(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  return (input as { readonly limit?: unknown }).limit === 1;
}

function invoke(
  recorder: RuntimeProductionActivityRecorder,
  frame: RequestFrame,
): Promise<Result<unknown, unknown>> {
  switch (frame.method) {
    case "recordInboundChannelActivity":
      return recorder.recordInboundChannelActivity(frame.input as never);
    case "beginDeliveryPlatformAttempt":
      return recorder.beginDeliveryPlatformAttempt(frame.input as never);
    case "finishDeliveryPlatformAttempt":
      return recorder.finishDeliveryPlatformAttempt(frame.input as never);
    case "exportEvidence":
      if (!isSingleRecordEvidencePage(frame.input)) {
        return Promise.resolve(err(new Error(
          "Worker evidence export requires single-record cursor pages",
        )));
      }
      return recorder.exportEvidence(frame.input as never);
    case "inspect":
      return recorder.inspect();
    case "heartbeat":
      return recorder.heartbeat();
    case "close":
      return recorder.close();
  }
}

function post(message: unknown): void {
  parentPort?.postMessage(message);
}

function sourceKindForMethod(method: RecorderMethod): ActivityRecordingSourceKind | undefined {
  switch (method) {
    case "recordInboundChannelActivity": return "channel_inbound_normalized";
    case "beginDeliveryPlatformAttempt": return "delivery_platform_attempt";
    case "finishDeliveryPlatformAttempt": return "delivery_platform_outcome";
    case "exportEvidence":
    case "inspect":
    case "heartbeat":
    case "close":
      return undefined;
  }
}

function boundedResponse(frame: RequestFrame, result: Result<unknown, unknown>, maxBytes: number): unknown {
  const response = { kind: "response", requestId: frame.requestId, result: wireResult(result) };
  const bounded = preflightActivityRecordingWireValue(response, maxBytes);
  if (bounded.ok) return response;
  const sourceKind = sourceKindForMethod(frame.method);
  const overflow = sourceKind === undefined
    ? err(new Error("Activity recorder worker response exceeds its aggregate frame limit"))
    : err<ActivityRecordingFailure>({
        reason: bounded.error.reason,
        sourceKind,
        gapDurablyAccounted: false,
        gapCount: 0,
        occurredAtMs: frame.nowMs,
        errorKind: "validation",
        cause: bounded.error.cause,
      });
  return { kind: "response", requestId: frame.requestId, result: wireResult(overflow) };
}

function start(): void {
  const workerPort = parentPort;
  if (workerPort === null || !isWorkerOptions(workerData)) {
    post({ kind: "startup_error", message: "Activity recorder worker bootstrap data is invalid" });
    return;
  }
  let currentNowMs = workerData.initialNowMs;
  const key = Buffer.from(workerData.masterKey);
  workerData.masterKey.fill(0);
  const opened = openSqliteProductionActivityRecorder({
    dbPath: workerData.dbPath,
    crypto: createActivityRecordingCrypto(key),
    limits: workerData.limits,
    nowMs: () => currentNowMs,
    writerLeaseMs: workerData.writerLeaseMs,
    ...(workerData.streamId === undefined ? {} : { streamId: workerData.streamId }),
  });
  key.fill(0);
  if (!opened.ok) {
    post({ kind: "startup_error", message: opened.error.message });
    return;
  }
  const recorder = opened.value as RuntimeProductionActivityRecorder;
  post({ kind: "ready" });
  let queue = Promise.resolve();
  workerPort.on("message", (raw: unknown) => {
    queue = queue.then(async () => {
      if (!isRequestFrame(raw)) return;
      currentNowMs = raw.nowMs;
      const invoked = tryCatch(() => invoke(recorder, raw));
      const awaited = invoked.ok ? await fromPromise(invoked.value) : err(invoked.error);
      const result = awaited.ok ? awaited.value : err(awaited.error);
      post(boundedResponse(raw, result, workerData.maxFrameBytes));
      if (raw.method === "close") workerPort.close();
    });
  });
}

start();
