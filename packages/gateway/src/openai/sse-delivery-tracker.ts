// SPDX-License-Identifier: Apache-2.0
import { systemNowMs, systemScheduleTimeout } from "@comis/core";
import { tryCatch } from "@comis/shared";
import type { SSEStreamingApi } from "hono/streaming";

/** Maximum queued delta count behind the one in-flight SSE write. */
export const MAX_PENDING_SSE_EVENTS = 256;

/** Maximum queued delta characters behind the one in-flight SSE write. */
export const MAX_PENDING_SSE_CHARS = 1_000_000;

/** Maximum wall time allowed for one transport write before cancellation. */
export const DEFAULT_SSE_WRITE_TIMEOUT_MS = 30_000;

export interface SseDeliveryTrackerOptions {
  /** Per-write transport deadline; primarily configurable for deterministic tests. */
  writeTimeoutMs?: number;
}

/** Tracks ordered SSE writes and the cancellation signal Hono exposes. */
export interface SseDeliveryTracker {
  write(data: string): Promise<boolean>;
  enqueue(data: string): boolean;
  sealQueue(): void;
  drain(): Promise<boolean>;
  dispose(): void;
  readonly signal: AbortSignal;
  readonly failedAt: number | undefined;
  readonly error: unknown;
}

/** Create a per-response delivery tracker before the first stream write. */
export function createSseDeliveryTracker(
  stream: SSEStreamingApi,
  requestSignal?: AbortSignal,
  options: SseDeliveryTrackerOptions = {},
): SseDeliveryTracker {
  const requestedWriteTimeoutMs = options.writeTimeoutMs;
  const writeTimeoutMs = requestedWriteTimeoutMs !== undefined
    && Number.isSafeInteger(requestedWriteTimeoutMs)
    && requestedWriteTimeoutMs > 0
    ? requestedWriteTimeoutMs
    : DEFAULT_SSE_WRITE_TIMEOUT_MS;
  const executionAbort = new AbortController();
  let failedAt: number | undefined;
  let failure: unknown;
  let queueSealed = false;
  let queuedChars = 0;
  const queued: string[] = [];
  let pump: Promise<void> | undefined;
  let resolveFailure!: () => void;
  const failureObserved = new Promise<void>((resolve) => {
    resolveFailure = resolve;
  });
  let requestAbortListener: (() => void) | undefined;

  const releaseRequestAbortListener = (): void => {
    if (!requestSignal || !requestAbortListener) return;
    requestSignal.removeEventListener("abort", requestAbortListener);
    requestAbortListener = undefined;
  };

  const abortTransport = (): void => {
    if (stream.aborted) return;
    void tryCatch(() => stream.abort());
  };

  const markFailed = (error?: unknown): void => {
    if (failedAt !== undefined) {
      if (error !== undefined && failure === undefined) failure = error;
      return;
    }
    failedAt = systemNowMs();
    if (error !== undefined && failure === undefined) failure = error;
    queueSealed = true;
    queued.length = 0;
    queuedChars = 0;
    releaseRequestAbortListener();
    executionAbort.abort(error ?? "SSE delivery aborted");
    resolveFailure();
    // Hono's write promise can remain blocked behind transport backpressure even
    // after the internal execution signal is aborted. Abort the actual stream so
    // its reader is cancelled and the underlying writer can settle.
    abortTransport();
  };

  stream.onAbort(() => {
    markFailed();
  });
  if (requestSignal) {
    requestAbortListener = () => markFailed(new Error("Inbound HTTP request aborted"));
    requestSignal.addEventListener(
      "abort",
      requestAbortListener,
      { once: true },
    );
    if (requestSignal.aborted) markFailed(new Error("Inbound HTTP request aborted"));
  }
  if (stream.aborted) markFailed();

  const write = async (data: string): Promise<boolean> => {
    if (failedAt !== undefined) return false;
    const cancelWriteDeadline = systemScheduleTimeout(() => {
      markFailed(new Error("SSE transport write exceeded its bounded delivery deadline"));
    }, writeTimeoutMs);
    const attempt = Promise.resolve().then(
      () => stream.writeSSE({ data }),
    ).then(
      () => true,
      (error: unknown) => {
        markFailed(error);
        return false;
      },
    );
    let resolveAbort!: (delivered: false) => void;
    const aborted = new Promise<false>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = (): void => resolveAbort(false);
    executionAbort.signal.addEventListener("abort", onAbort, { once: true });
    if (executionAbort.signal.aborted) onAbort();
    let completed: boolean;
    try {
      completed = await Promise.race([
        attempt,
        aborted,
      ]);
    } finally {
      cancelWriteDeadline();
      executionAbort.signal.removeEventListener("abort", onAbort);
    }
    if (stream.aborted) markFailed();
    return completed && failedAt === undefined;
  };

  const pumpQueue = async (): Promise<void> => {
    while (queued.length > 0 && failedAt === undefined) {
      const next = queued.shift();
      if (next === undefined) return;
      queuedChars -= next.length;
      const delivered = await write(next);
      if (!delivered) return;
    }
  };

  const startPump = (): void => {
    if (pump !== undefined || queued.length === 0 || failedAt !== undefined) return;
    const activePump = pumpQueue();
    pump = activePump;
    void activePump.then(() => {
      if (pump === activePump) pump = undefined;
      startPump();
    });
  };

  const enqueue = (data: string): boolean => {
    if (queueSealed || failedAt !== undefined) return false;
    if (
      queued.length >= MAX_PENDING_SSE_EVENTS ||
      data.length > MAX_PENDING_SSE_CHARS - queuedChars
    ) {
      markFailed(new Error("SSE delivery backlog exceeded its bounded capacity"));
      return false;
    }
    queued.push(data);
    queuedChars += data.length;
    startPump();
    return true;
  };

  const drain = async (): Promise<boolean> => {
    while (pump !== undefined || queued.length > 0) {
      startPump();
      const activePump = pump;
      if (!activePump) break;
      await Promise.race([
        activePump,
        failureObserved,
      ]);
      if (failedAt !== undefined) return false;
    }
    if (stream.aborted) markFailed();
    return failedAt === undefined;
  };

  return {
    write,
    enqueue,
    sealQueue(): void { queueSealed = true; },
    drain,
    dispose(): void {
      if (failedAt === undefined && (pump !== undefined || queued.length > 0)) {
        markFailed(new Error("SSE delivery disposed with pending writes"));
        return;
      }
      queueSealed = true;
      queued.length = 0;
      queuedChars = 0;
      releaseRequestAbortListener();
    },
    signal: executionAbort.signal,
    get failedAt(): number | undefined { return failedAt; },
    get error(): unknown { return failure; },
  };
}
