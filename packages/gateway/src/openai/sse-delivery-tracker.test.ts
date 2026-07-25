// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { SSEStreamingApi } from "hono/streaming";
import {
  MAX_PENDING_SSE_CHARS,
  MAX_PENDING_SSE_EVENTS,
  createSseDeliveryTracker,
} from "./sse-delivery-tracker.js";

interface StreamHarness {
  stream: SSEStreamingApi;
  abort(): void;
  transportAbort: ReturnType<typeof vi.fn>;
  writeSSE: ReturnType<typeof vi.fn>;
}

function createStreamHarness(
  writeSSE: ReturnType<typeof vi.fn> = vi.fn(async () => undefined),
): StreamHarness {
  const abortListeners: Array<() => void> = [];
  const stream = {
    aborted: false,
    onAbort(listener: () => void): void {
      abortListeners.push(listener);
    },
    writeSSE,
  } as unknown as SSEStreamingApi;
  const transportAbort = vi.fn(() => {
    if (stream.aborted) return;
    stream.aborted = true;
    for (const listener of abortListeners) listener();
  });
  stream.abort = transportAbort;
  return {
    stream,
    abort(): void {
      stream.aborted = true;
      for (const listener of abortListeners) listener();
    },
    transportAbort,
    writeSSE,
  };
}

describe("SSE delivery tracker cancellation", () => {
  it("aborts execution and rejects every later delta after the client closes", async () => {
    const harness = createStreamHarness();
    const tracker = createSseDeliveryTracker(harness.stream);

    harness.abort();

    expect(tracker.signal.aborted).toBe(true);
    expect(tracker.enqueue("late-delta")).toBe(false);
    expect(await tracker.write("late-terminal")).toBe(false);
    expect(await tracker.drain()).toBe(false);
    expect(harness.writeSSE).not.toHaveBeenCalled();
  });

  it("binds the inbound request signal to the same execution cancellation", () => {
    const harness = createStreamHarness();
    const request = new AbortController();
    const tracker = createSseDeliveryTracker(harness.stream, request.signal);

    request.abort("client disconnected");

    expect(tracker.signal.aborted).toBe(true);
    expect(tracker.enqueue("late-delta")).toBe(false);
    expect(harness.transportAbort).toHaveBeenCalledOnce();
  });

  it("contains a synchronous stream writer failure as cancellation", async () => {
    const harness = createStreamHarness(vi.fn(() => {
      throw new Error("writer failed synchronously");
    }));
    const tracker = createSseDeliveryTracker(harness.stream);

    await expect(tracker.write("event")).resolves.toBe(false);
    expect(tracker.signal.aborted).toBe(true);
    expect(tracker.error).toBeInstanceOf(Error);
    expect(harness.transportAbort).toHaveBeenCalledOnce();
  });

  it("fails closed at a bounded pending-event backlog while one write is stalled", async () => {
    let releaseWrite!: () => void;
    const stalledWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const harness = createStreamHarness(vi.fn(() => stalledWrite));
    const tracker = createSseDeliveryTracker(harness.stream);

    expect(tracker.enqueue("in-flight")).toBe(true);
    await vi.waitFor(() => expect(harness.writeSSE).toHaveBeenCalledTimes(1));

    for (let index = 0; index < MAX_PENDING_SSE_EVENTS; index += 1) {
      expect(tracker.enqueue("x")).toBe(true);
    }
    expect(tracker.enqueue("overflow")).toBe(false);
    expect(tracker.signal.aborted).toBe(true);
    expect(tracker.error).toBeInstanceOf(Error);
    expect(harness.transportAbort).toHaveBeenCalledOnce();

    releaseWrite();
    await expect(tracker.drain()).resolves.toBe(false);
    expect(harness.writeSSE).toHaveBeenCalledTimes(1);
  });

  it("ends a stalled queue drain immediately when the client aborts", async () => {
    const neverDelivered = new Promise<void>(() => undefined);
    const harness = createStreamHarness(vi.fn(() => neverDelivered));
    const tracker = createSseDeliveryTracker(harness.stream);

    expect(tracker.enqueue("in-flight")).toBe(true);
    await vi.waitFor(() => expect(harness.writeSSE).toHaveBeenCalledTimes(1));
    const draining = tracker.drain();

    harness.abort();

    await expect(draining).resolves.toBe(false);
    expect(tracker.signal.aborted).toBe(true);
  });

  it("fails a stalled stream write after the bounded delivery deadline", async () => {
    const neverDelivered = new Promise<void>(() => undefined);
    const harness = createStreamHarness(vi.fn(() => neverDelivered));
    const tracker = createSseDeliveryTracker(
      harness.stream,
      undefined,
      { writeTimeoutMs: 5 },
    );

    const outcome = await Promise.race([
      tracker.write("stalled-event"),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 50);
      }),
    ]);

    expect(outcome).toBe(false);
    expect(tracker.signal.aborted).toBe(true);
    expect(tracker.error).toBeInstanceOf(Error);
    expect(harness.transportAbort).toHaveBeenCalledOnce();
  });

  it("settles a backpressured Hono writer by aborting its real transport", async () => {
    const { readable, writable } = new TransformStream();
    const stream = new SSEStreamingApi(writable, readable);
    const tracker = createSseDeliveryTracker(
      stream,
      undefined,
      { writeTimeoutMs: 5 },
    );

    await expect(tracker.write("buffered-first-event")).resolves.toBe(true);
    await expect(tracker.write("backpressured-second-event")).resolves.toBe(false);

    expect(stream.aborted).toBe(true);
    expect(tracker.signal.aborted).toBe(true);
    tracker.dispose();
  });

  it("fails closed when pending character storage reaches its independent bound", async () => {
    let releaseWrite!: () => void;
    const stalledWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const harness = createStreamHarness(vi.fn(() => stalledWrite));
    const tracker = createSseDeliveryTracker(harness.stream);

    expect(tracker.enqueue("in-flight")).toBe(true);
    await vi.waitFor(() => expect(harness.writeSSE).toHaveBeenCalledTimes(1));
    expect(tracker.enqueue("x".repeat(MAX_PENDING_SSE_CHARS))).toBe(true);
    expect(tracker.enqueue("x")).toBe(false);
    expect(harness.transportAbort).toHaveBeenCalledOnce();

    releaseWrite();
    await expect(tracker.drain()).resolves.toBe(false);
  });

  it("seals the delta producer before draining without blocking terminal writes", async () => {
    const harness = createStreamHarness();
    const tracker = createSseDeliveryTracker(harness.stream);

    expect(tracker.enqueue("accepted-delta")).toBe(true);
    tracker.sealQueue();
    expect(tracker.enqueue("late-delta")).toBe(false);
    await expect(tracker.drain()).resolves.toBe(true);
    await expect(tracker.write("terminal")).resolves.toBe(true);

    expect(harness.writeSSE.mock.calls.map((call) => call[0])).toEqual([
      { data: "accepted-delta" },
      { data: "terminal" },
    ]);
  });

  it("removes the request abort listener when a successful stream is disposed", () => {
    const harness = createStreamHarness();
    const request = new AbortController();
    const removeEventListener = vi.spyOn(request.signal, "removeEventListener");
    const tracker = createSseDeliveryTracker(harness.stream, request.signal);

    tracker.dispose();
    request.abort("after response completion");

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(tracker.signal.aborted).toBe(false);
    expect(harness.transportAbort).not.toHaveBeenCalled();
  });

  it("aborts the transport when disposed while a queued write is still pending", async () => {
    const neverDelivered = new Promise<void>(() => undefined);
    const harness = createStreamHarness(vi.fn(() => neverDelivered));
    const tracker = createSseDeliveryTracker(harness.stream);

    expect(tracker.enqueue("in-flight")).toBe(true);
    await vi.waitFor(() => expect(harness.writeSSE).toHaveBeenCalledOnce());

    tracker.dispose();

    expect(tracker.signal.aborted).toBe(true);
    expect(harness.transportAbort).toHaveBeenCalledOnce();
    await expect(tracker.drain()).resolves.toBe(false);
  });

  it("clears the write deadline timer after a successful delivery", async () => {
    vi.useFakeTimers();
    try {
      const harness = createStreamHarness();
      const tracker = createSseDeliveryTracker(harness.stream);

      await expect(tracker.write("delivered")).resolves.toBe(true);
      tracker.dispose();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
