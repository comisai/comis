// SPDX-License-Identifier: Apache-2.0
import { Worker } from "node:worker_threads";

import type {
  ClockPort,
  ProductionActivityRecorderPort,
  TimerHandle,
  TimerPort,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  createProductionActivityRecorderHandoff,
  type ActivityRecorderHandoffTransport,
} from "./production-activity-recorder-handoff.js";
import type { ActivityRecorderLimits } from "./production-activity-recorder.js";
import {
  DEFAULT_ACTIVITY_RECORDING_WRITER_LEASE_MS,
  validLimits,
} from "./production-activity-recorder-support.js";
import { activityRecordingWireFrameBytes } from "./production-activity-recorder-wire-boundary.js";

export interface OpenWorkerProductionActivityRecorderOptions {
  readonly dbPath: string;
  readonly masterKey: Buffer;
  readonly limits: ActivityRecorderLimits;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly handoffCapacity: number;
  readonly operationTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly streamId?: string;
  readonly writerLeaseMs?: number;
  readonly writerHeartbeatMs?: number;
}

function createWorkerTransport(worker: Worker): ActivityRecorderHandoffTransport {
  const messageListeners: Array<(message: unknown) => void> = [];
  const failureListeners: Array<(error: Error) => void> = [];
  let expectedExit = false;
  worker.on("message", (message: unknown) => {
    for (const listener of messageListeners) listener(message);
  });
  worker.on("error", (error) => {
    for (const listener of failureListeners) listener(error);
  });
  worker.on("exit", (code) => {
    if (expectedExit) return;
    const error = new Error(`Activity recorder worker exited with code ${code}`);
    for (const listener of failureListeners) listener(error);
  });
  return {
    postMessage: (message) => worker.postMessage(message),
    onMessage: (listener) => { messageListeners.push(listener); },
    onFailure: (listener) => { failureListeners.push(listener); },
    async terminate() {
      expectedExit = true;
      await worker.terminate();
    },
    unref: () => worker.unref(),
  };
}

function waitForWorkerReady(input: {
  readonly transport: ActivityRecorderHandoffTransport;
  readonly timers: TimerPort;
  readonly timeoutMs: number;
}): Promise<Result<void, Error>> {
  return new Promise((resolve) => {
    let settled = false;
    const timerRef: { current?: TimerHandle } = {};
    const settle = (result: Result<void, Error>) => {
      if (settled) return;
      settled = true;
      timerRef.current?.cancel();
      resolve(result);
    };
    input.transport.onMessage((message) => {
      if (typeof message !== "object" || message === null) return;
      const frame = message as { readonly kind?: unknown; readonly message?: unknown };
      if (frame.kind === "ready") settle(ok(undefined));
      if (frame.kind === "startup_error") {
        settle(err(new Error(typeof frame.message === "string"
          ? frame.message
          : "Activity recorder worker startup failed")));
      }
    });
    input.transport.onFailure((error) => settle(err(error)));
    timerRef.current = input.timers.setTimeout(() => {
      settle(err(new Error("Activity recorder worker startup timed out")));
    }, input.timeoutMs);
    if (settled) timerRef.current.cancel();
    timerRef.current.unref();
  });
}

/** Open the recorder in an isolated worker and fail closed until it verifies its chain. */
export async function openWorkerProductionActivityRecorder(
  options: OpenWorkerProductionActivityRecorderOptions,
): Promise<Result<ProductionActivityRecorderPort, Error>> {
  if (!Buffer.isBuffer(options.masterKey) || options.masterKey.length < 32) {
    return err(new Error("Activity recorder worker master key must be at least 32 bytes"));
  }
  if (!validLimits(options.limits)
    || !Number.isSafeInteger(options.handoffCapacity) || options.handoffCapacity <= 0
    || !Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs <= 0
    || !Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs <= 0) {
    return err(new Error("Activity recorder worker bounds are invalid"));
  }
  const busyTimeoutMs = options.limits.busyTimeoutMs ?? 5_000;
  const longestOperationMs = Math.max(options.operationTimeoutMs, busyTimeoutMs);
  if (longestOperationMs > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
    return err(new Error("Activity recorder worker lease timing is invalid"));
  }
  const frameLimit = activityRecordingWireFrameBytes(options.limits.maxPayloadBytes);
  if (!frameLimit.ok) return frameLimit;
  const minimumWriterLeaseMs = longestOperationMs * 4;
  const leaseFloor = Math.max(
    DEFAULT_ACTIVITY_RECORDING_WRITER_LEASE_MS,
    minimumWriterLeaseMs,
  );
  const writerLeaseMs = options.writerLeaseMs ?? leaseFloor;
  const writerHeartbeatMs = options.writerHeartbeatMs ?? Math.max(1, Math.floor(writerLeaseMs / 3));
  if (!Number.isSafeInteger(writerLeaseMs) || writerLeaseMs <= 0
    || !Number.isSafeInteger(writerHeartbeatMs) || writerHeartbeatMs <= 0
    || writerLeaseMs < minimumWriterLeaseMs
    || writerHeartbeatMs > Math.floor(writerLeaseMs / 2)) {
    return err(new Error("Activity recorder worker lease timing is invalid"));
  }
  const workerKey = Buffer.from(options.masterKey.subarray(0, 32));
  const spawned = tryCatch(() => new Worker(
    new URL("./production-activity-recorder-worker-main.js", import.meta.url),
    {
      // Node rejects --input-type when a worker has a file URL. Parents
      // launched through --eval may legitimately carry it in process.execArgv.
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: {
        version: 1,
        dbPath: options.dbPath,
        masterKey: workerKey,
        limits: options.limits,
        initialNowMs: options.clock.now(),
        writerLeaseMs,
        maxFrameBytes: frameLimit.value,
        ...(options.streamId === undefined ? {} : { streamId: options.streamId }),
      },
    },
  ));
  workerKey.fill(0);
  if (!spawned.ok) return spawned;
  const transport = createWorkerTransport(spawned.value);
  const ready = await waitForWorkerReady({
    transport,
    timers: options.timers,
    timeoutMs: options.startupTimeoutMs,
  });
  if (!ready.ok) {
    await transport.terminate();
    return ready;
  }
  const handoff = createProductionActivityRecorderHandoff({
    transport,
    clock: options.clock,
    timers: options.timers,
    capacity: options.handoffCapacity,
    operationTimeoutMs: options.operationTimeoutMs,
    maxFrameBytes: frameLimit.value,
    heartbeatIntervalMs: writerHeartbeatMs,
  });
  if (!handoff.ok) await transport.terminate();
  return handoff;
}
