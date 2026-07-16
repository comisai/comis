// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { NormalizedMessage } from "@comis/core";
import { createFakeClock } from "../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../test/support/fake-timers.js";

import {
  createProductionActivityRecorderHandoff,
  type ActivityRecorderHandoffTransport,
} from "./production-activity-recorder-handoff.js";

class FakeTransport implements ActivityRecorderHandoffTransport {
  readonly sent: unknown[] = [];
  private readonly messageListeners: Array<(message: unknown) => void> = [];
  private readonly failureListeners: Array<(error: Error) => void> = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.push(listener);
  }

  onFailure(listener: (error: Error) => void): void {
    this.failureListeners.push(listener);
  }

  respond(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  fail(error: Error): void {
    for (const listener of this.failureListeners) listener(error);
  }

  terminate(): Promise<void> {
    return Promise.resolve();
  }

  unref(): void {}
}

function makeMessage(): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "chat_a",
    channelType: "telegram",
    senderId: "user_a",
    text: "private prompt",
    timestamp: 1_700_000_000_000,
    attachments: [],
    metadata: {},
  };
}

function requestId(transport: FakeTransport, index: number): string {
  return (transport.sent[index] as { readonly requestId: string }).requestId;
}

function makeHandoff(options: Parameters<typeof createProductionActivityRecorderHandoff>[0]) {
  const created = createProductionActivityRecorderHandoff({
    maxFrameBytes: 64 * 1024,
    ...options,
  } as Parameters<typeof createProductionActivityRecorderHandoff>[0]);
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  return created.value;
}

describe("production activity recorder bounded handoff", () => {
  it("rejects excess work immediately without dropping the accepted request", async () => {
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      capacity: 1,
      operationTimeoutMs: 1_000,
    });
    const first = recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_000, message: makeMessage(),
    });
    const excess = await recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_001, message: makeMessage(),
    });

    expect(!excess.ok && excess.error.reason).toBe("handoff_capacity_exceeded");
    expect(transport.sent).toHaveLength(1);
    transport.respond({
      kind: "response",
      requestId: requestId(transport, 0),
      result: { ok: true, value: { recordId: "record:00000000000000000001", sequence: 1, recordHash: "a".repeat(64) } },
    });
    expect((await first).ok).toBe(true);
  });

  it("contains timeout rejection throw and malformed response as typed runtime failures", async () => {
    const timers = createFakeTimers();
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers,
      capacity: 4,
      operationTimeoutMs: 50,
    });
    const timedOut = recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_000, message: makeMessage(),
    });
    timers.advance(50);
    const timeoutResult = await timedOut;
    expect(!timeoutResult.ok && timeoutResult.error.reason).toBe("handoff_timeout");
    expect(!timeoutResult.ok && timeoutResult.error.errorKind).toBe("timeout");

    const malformed = recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_001, message: makeMessage(),
    });
    transport.respond({ kind: "response", requestId: requestId(transport, 1), result: null });
    expect(!(await malformed).ok).toBe(true);

    const throwingTransport = new FakeTransport();
    throwingTransport.postMessage = () => { throw new Error("transport threw"); };
    const throwingRecorder = makeHandoff({
      transport: throwingTransport,
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      capacity: 1,
      operationTimeoutMs: 50,
    });
    expect((await throwingRecorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_002, message: makeMessage(),
    })).ok).toBe(false);
  });

  it("keeps timed-out frames charged to capacity until the worker acknowledges them", async () => {
    const timers = createFakeTimers();
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers,
      capacity: 1,
      operationTimeoutMs: 50,
    });
    const first = recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_000, message: makeMessage(),
    });
    timers.advance(50);
    expect(!((await first).ok)).toBe(true);

    const rejected = recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_001, message: makeMessage(),
    });
    expect(transport.sent).toHaveLength(1);
    expect(!((await rejected).ok)).toBe(true);

    transport.respond({
      kind: "response",
      requestId: requestId(transport, 0),
      result: {
        ok: true,
        value: {
          recordId: "record:00000000000000000001",
          sequence: 1,
          recordHash: "a".repeat(64),
        },
      },
    });
    const afterAcknowledgement = recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_002, message: makeMessage(),
    });
    expect(transport.sent).toHaveLength(2);
    transport.respond({
      kind: "response",
      requestId: requestId(transport, 1),
      result: {
        ok: true,
        value: {
          recordId: "record:00000000000000000002",
          sequence: 2,
          recordHash: "b".repeat(64),
        },
      },
    });
    expect((await afterAcknowledgement).ok).toBe(true);
  });

  it("rejects malformed inspection and close success payloads from the worker", async () => {
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      capacity: 2,
      operationTimeoutMs: 1_000,
    });
    const inspection = recorder.inspect();
    transport.respond({
      kind: "response",
      requestId: requestId(transport, 0),
      result: { ok: true, value: null },
    });
    expect((await inspection).ok).toBe(false);

    const closed = recorder.close();
    transport.respond({
      kind: "response",
      requestId: requestId(transport, 1),
      result: { ok: true, value: null },
    });
    expect((await closed).ok).toBe(false);
  });

  it("fails pending work when the isolated recorder transport exits", async () => {
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      capacity: 2,
      operationTimeoutMs: 1_000,
    });
    const pending = recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_000, message: makeMessage(),
    });

    transport.fail(new Error("worker exited"));

    const result = await pending;
    expect(!result.ok && result.error.reason).toBe("storage_failed");
    expect(!result.ok && result.error.gapDurablyAccounted).toBe(false);
  });

  it("latches transport failure and rejects later work without another handoff timeout", async () => {
    const timers = createFakeTimers();
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers,
      capacity: 2,
      operationTimeoutMs: 1_000,
    });
    transport.fail(new Error("worker exited"));

    const result = await recorder.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_000, message: makeMessage(),
    });

    expect(transport.sent).toHaveLength(0);
    expect(!result.ok && result.error.reason).toBe("storage_failed");
    expect(!result.ok && result.error.gapDurablyAccounted).toBe(false);
  });

  it("uses a bounded control frame to durably account an oversized request", async () => {
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      capacity: 2,
      operationTimeoutMs: 1_000,
      maxFrameBytes: 512,
    });

    const recorded = recorder.recordInboundChannelActivity({
      traceId: randomUUID(),
      occurredAtMs: 1_700_000_000_000,
      message: { ...makeMessage(), metadata: { oversized: "x".repeat(4_096) } },
    });
    expect(transport.sent).toHaveLength(1);
    const frame = transport.sent[0] as { readonly method?: unknown; readonly requestId: string };
    expect(frame.method).toBe("recordGap");
    transport.respond({
      kind: "response",
      requestId: frame.requestId,
      result: {
        ok: false,
        error: {
          sourceKind: "channel_inbound_normalized",
          reason: "payload_too_large",
          gapDurablyAccounted: true,
          gapCount: 1,
          occurredAtMs: 1_700_000_000_000,
          errorKind: "validation",
        },
      },
    });

    const result = await recorded;
    expect(!result.ok && result.error.gapDurablyAccounted).toBe(true);
    expect(!result.ok && result.error.gapCount).toBe(1);
  });

  it("preserves attempt authority when an oversized outcome becomes a gap", async () => {
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_100),
      timers: createFakeTimers(),
      capacity: 2,
      operationTimeoutMs: 1_000,
      maxFrameBytes: 1_500,
    });
    const attempt = {
      recordId: "record:00000000000000000001",
      sequence: 1,
      recordHash: "a".repeat(64),
      attemptId: "550e8400-e29b-41d4-a716-446655440001",
      settlementCapability: "A".repeat(43),
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      occurredAtMs: 1_700_000_000_000,
    };

    const recorded = recorder.finishDeliveryPlatformAttempt({
      attempt,
      occurredAtMs: 1_700_000_000_100,
      outcomeClass: "adapter_throw",
      error: { name: "Error", message: "x".repeat(4_096) },
    });
    expect(transport.sent).toHaveLength(1);
    const frame = transport.sent[0] as {
      readonly method?: unknown;
      readonly requestId: string;
      readonly input?: unknown;
    };
    expect(frame.method).toBe("recordGap");
    expect(frame.input).toEqual(expect.objectContaining({
      traceId: attempt.traceId,
      parentRecordId: attempt.recordId,
      settlement: attempt,
    }));
    transport.respond({
      kind: "response",
      requestId: frame.requestId,
      result: {
        ok: false,
        error: {
          sourceKind: "delivery_platform_outcome",
          reason: "payload_too_large",
          gapDurablyAccounted: true,
          gapCount: 1,
          occurredAtMs: 1_700_000_000_100,
          errorKind: "validation",
        },
      },
    });

    expect(!((await recorded).ok)).toBe(true);
  });

  it("keeps one heartbeat queued until acknowledgement and cancels it on close", async () => {
    const timers = createFakeTimers();
    const transport = new FakeTransport();
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers,
      capacity: 1,
      operationTimeoutMs: 5,
      heartbeatIntervalMs: 10,
    });

    timers.advance(30);
    expect(transport.sent).toHaveLength(1);
    transport.respond({
      kind: "response",
      requestId: requestId(transport, 0),
      result: { ok: true, value: undefined },
    });

    timers.advance(10);
    expect(transport.sent).toHaveLength(2);
    const closed = recorder.close();
    expect(transport.sent).toHaveLength(3);
    transport.respond({
      kind: "response",
      requestId: requestId(transport, 1),
      result: { ok: true, value: undefined },
    });
    transport.respond({
      kind: "response",
      requestId: requestId(transport, 2),
      result: { ok: true, value: undefined },
    });
    expect((await closed).ok).toBe(true);
    timers.advance(100);
    expect(transport.sent).toHaveLength(3);
  });

  it("awaits transport termination and maps its rejection into the close Result", async () => {
    const transport = new FakeTransport();
    let releaseTermination: (() => void) | undefined;
    const termination = new Promise<void>((resolve) => { releaseTermination = resolve; });
    transport.terminate = vi.fn(() => termination);
    const recorder = makeHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      capacity: 1,
      operationTimeoutMs: 1_000,
    });

    const closed = recorder.close();
    transport.respond({
      kind: "response",
      requestId: requestId(transport, 0),
      result: { ok: true, value: undefined },
    });
    let closeSettled = false;
    void closed.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseTermination?.();
    expect((await closed).ok).toBe(true);

    const rejectingTransport = new FakeTransport();
    rejectingTransport.terminate = vi.fn(async () => {
      throw new Error("termination failed");
    });
    const rejectingRecorder = makeHandoff({
      transport: rejectingTransport,
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      capacity: 1,
      operationTimeoutMs: 1_000,
    });
    const rejectedClose = rejectingRecorder.close();
    rejectingTransport.respond({
      kind: "response",
      requestId: requestId(rejectingTransport, 0),
      result: { ok: true, value: undefined },
    });
    await expect(rejectedClose).resolves.toMatchObject({ ok: false });
  });

  it("contains clock failures and still terminates the worker during close", async () => {
    const transport = new FakeTransport();
    transport.terminate = vi.fn(async () => {});
    const timers = createFakeTimers();
    const recorder = makeHandoff({
      transport,
      clock: { now: () => { throw new Error("clock failed"); } },
      timers,
      capacity: 1,
      operationTimeoutMs: 1_000,
      heartbeatIntervalMs: 10,
    });

    await expect(recorder.inspect()).resolves.toMatchObject({ ok: false });
    await expect(recorder.exportEvidence({ limit: 1 })).resolves.toMatchObject({ ok: false });
    expect(() => timers.advance(10)).not.toThrow();
    await expect(recorder.close()).resolves.toMatchObject({ ok: false });
    expect(transport.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects cyclic and accessor-backed frames before transport cloning", async () => {
    const transport = new FakeTransport();
    const created = createProductionActivityRecorderHandoff({
      transport,
      clock: createFakeClock(1_700_000_000_000),
      timers: createFakeTimers(),
      capacity: 4,
      operationTimeoutMs: 1_000,
      maxFrameBytes: 512,
    } as Parameters<typeof createProductionActivityRecorderHandoff>[0]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const cyclicMetadata: Record<string, unknown> = {};
    cyclicMetadata.self = cyclicMetadata;
    const cyclic = await created.value.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_001,
      message: { ...makeMessage(), metadata: cyclicMetadata },
    });
    expect(!cyclic.ok && cyclic.error.reason).toBe("payload_invalid");

    let getterCalls = 0;
    const accessorMetadata = Object.defineProperty({}, "privateValue", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      },
    });
    const accessor = await created.value.recordInboundChannelActivity({
      traceId: randomUUID(), occurredAtMs: 1_700_000_000_002,
      message: { ...makeMessage(), metadata: accessorMetadata },
    });
    expect(!accessor.ok && accessor.error.reason).toBe("payload_invalid");
    expect(getterCalls).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });
});
