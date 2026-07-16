// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";

import { runWithContext } from "../context/context.js";
import { TypedEventBus } from "../event-bus/bus.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import type { ComisLogger } from "../logging/log-fields.js";
import type { ProductionActivityRecorderPort } from "../ports/activity-recorder.js";
import { createNoOpDeliveryQueue } from "./no-op-delivery-queue.js";
import type { RetryEngine } from "./retry-engine.js";
import { createActivityRecordingAdapter } from "./activity-recording-delivery-adapter.js";
import { createDeliveryService } from "./delivery-service.js";
import type { DeliveryAdapter } from "./types.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

function makeHooks(): HookRunner {
  return {
    runBeforeDelivery: vi.fn().mockResolvedValue({}),
    runAfterDelivery: vi.fn().mockResolvedValue(undefined),
  } as unknown as HookRunner;
}

function makeLogger(): ComisLogger {
  const logger = {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
  vi.mocked(logger.child).mockReturnValue(logger);
  return logger;
}

function makeRecorder(): ProductionActivityRecorderPort {
  let sequence = 0;
  return {
    recordInboundChannelActivity: vi.fn(),
    beginDeliveryPlatformAttempt: vi.fn().mockImplementation(async (input) => {
      sequence += 1;
      return ok({
        recordId: `record:${sequence}`,
        sequence,
        recordHash: String(sequence).padStart(64, "0"),
        attemptId: "550e8400-e29b-41d4-a716-446655440001",
        settlementCapability: "A".repeat(43),
        traceId: input.traceId,
        occurredAtMs: input.occurredAtMs,
      });
    }),
    finishDeliveryPlatformAttempt: vi.fn().mockImplementation(async () => {
      sequence += 1;
      return ok({
        recordId: `record:${sequence}`,
        sequence,
        recordHash: String(sequence).padStart(64, "0"),
      });
    }),
    exportEvidence: vi.fn(),
    inspect: vi.fn(),
    close: vi.fn(),
  };
}

describe("DeliveryService prospective activity recording", () => {
  it("preserves the physical send when the recorder clock throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue(ok("platform-message"));
    const recorder = makeRecorder();
    const wrapped = createActivityRecordingAdapter({
      activityRecorder: recorder,
      clock: { now: () => { throw new Error("recorder clock failed"); } },
      logger: {
        ...makeLogger(),
        warn: () => { throw new Error("recorder warning failed"); },
        debug: () => { throw new Error("recorder debug failed"); },
      } as unknown as ComisLogger,
      eventBus: {
        emit: () => { throw new Error("recorder event failed"); },
      } as unknown as TypedEventBus,
      trackActivityRecording: () => { throw new Error("recorder tracking failed"); },
    }, {
      channelType: "echo",
      sendMessage,
    }, {
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      origin: "agent",
      chunkIndex: 0,
      totalChunks: 1,
    });

    await expect(wrapped.sendMessage("channel-a", "hello", {}))
      .resolves.toEqual(ok("platform-message"));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("channel-a", "hello", {});
  });

  it("preserves the physical send when recorder reporting and tracking throw", async () => {
    const sendMessage = vi.fn().mockResolvedValue(ok("platform-message"));
    const recorder = makeRecorder();
    vi.mocked(recorder.beginDeliveryPlatformAttempt).mockImplementation(() => {
      throw new Error("recorder invocation failed");
    });
    const wrapped = createActivityRecordingAdapter({
      activityRecorder: recorder,
      clock: { now: () => 100 },
      logger: {
        ...makeLogger(),
        warn: () => { throw new Error("recorder warning failed"); },
      } as unknown as ComisLogger,
      eventBus: {
        emit: () => { throw new Error("recorder event failed"); },
      } as unknown as TypedEventBus,
      trackActivityRecording: () => { throw new Error("recorder tracking failed"); },
    }, {
      channelType: "echo",
      sendMessage,
    }, {
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      origin: "agent",
      chunkIndex: 0,
      totalChunks: 1,
    });

    await expect(wrapped.sendMessage("channel-a", "hello", {}))
      .resolves.toEqual(ok("platform-message"));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("channel-a", "hello", {});
  });

  it("records the physical settlement timestamp before a delayed attempt receipt", async () => {
    let nowMs = 100;
    let releaseBegin: ((result: Awaited<ReturnType<
      ProductionActivityRecorderPort["beginDeliveryPlatformAttempt"]
    >>) => void) | undefined;
    const recorder = makeRecorder();
    vi.mocked(recorder.beginDeliveryPlatformAttempt).mockImplementation(() => new Promise((resolve) => {
      releaseBegin = resolve;
    }));
    const adapter: DeliveryAdapter = {
      channelType: "echo",
      sendMessage: vi.fn().mockImplementation(async () => {
        nowMs = 110;
        return ok("platform-message");
      }),
    };
    const service = createDeliveryService({
      hookRunner: makeHooks(),
      deliveryQueue: createNoOpDeliveryQueue(),
      logger: makeLogger(),
      clock: { now: () => nowMs },
      activityRecorder: recorder,
    });

    const delivered = await service.deliverToChannel(adapter, "channel-a", "hello");
    nowMs = 900;
    releaseBegin?.(ok({
      recordId: "record:00000000000000000001",
      sequence: 1,
      recordHash: "a".repeat(64),
      attemptId: "550e8400-e29b-41d4-a716-446655440001",
      settlementCapability: "A".repeat(43),
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      occurredAtMs: 100,
    }));
    await service.drainInFlight(5_000);

    expect(delivered.ok).toBe(true);
    expect(recorder.finishDeliveryPlatformAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAtMs: 110 }),
    );
  });

  it("reports an outcome gap when the settlement clock becomes unavailable", async () => {
    let clockReads = 0;
    const recorder = makeRecorder();
    const logger = makeLogger();
    const eventBus = new TypedEventBus();
    const gapHandler = vi.fn();
    eventBus.on("activity-recording:gap", gapHandler);
    const adapter: DeliveryAdapter = {
      channelType: "echo",
      sendMessage: vi.fn().mockResolvedValue(ok("platform-message")),
    };
    const service = createDeliveryService({
      hookRunner: makeHooks(),
      deliveryQueue: createNoOpDeliveryQueue(),
      logger,
      clock: {
        now: () => {
          clockReads += 1;
          if (clockReads === 1) return 100;
          throw new Error("settlement clock failed");
        },
      },
      eventBus,
      activityRecorder: recorder,
    });

    const delivered = await service.deliverToChannel(adapter, "channel-a", "hello");
    await service.drainInFlight(5_000);

    expect(delivered.ok).toBe(true);
    expect(recorder.finishDeliveryPlatformAttempt).not.toHaveBeenCalled();
    expect(gapHandler).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "delivery_platform_outcome",
      reason: "clock_unavailable",
      gapDurablyAccounted: false,
    }));
  });

  it("includes externally initiated recorder work in the shutdown drain", async () => {
    let resolveRecording: () => void = () => undefined;
    const recording = new Promise<void>((resolve) => { resolveRecording = resolve; });
    const service = createDeliveryService({
      hookRunner: makeHooks(),
      deliveryQueue: createNoOpDeliveryQueue(),
      logger: makeLogger(),
      clock: createFakeClock(1_700_000_000_000),
    });
    service.trackActivityRecording(recording);

    const drained = service.drainInFlight(5_000);
    await Promise.resolve();
    resolveRecording();

    await expect(drained).resolves.toEqual({
      drained: 1,
      remaining: 0,
      durationMs: expect.any(Number),
    });
  });

  it("records every physical retry attempt and links each outcome to its stable receipt", async () => {
    const recorder = makeRecorder();
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(err(new Error("temporary platform failure")))
      .mockResolvedValueOnce(ok("platform-message-2"));
    const adapter: DeliveryAdapter & { readonly channelId: string } = {
      channelId: "echo-recorder",
      channelType: "echo",
      sendMessage,
    };
    const retryEngine: RetryEngine = {
      async sendWithRetry(retryAdapter, channelId, text, options) {
        expect(retryAdapter.channelId).toBe("echo-recorder");
        const first = await retryAdapter.sendMessage(channelId, text, options);
        expect(first.ok).toBe(false);
        return retryAdapter.sendMessage(channelId, `${text}-retry`, options);
      },
    };
    const service = createDeliveryService({
      hookRunner: makeHooks(),
      deliveryQueue: createNoOpDeliveryQueue(),
      logger: makeLogger(),
      clock: createFakeClock(1_700_000_000_000),
      retryEngine,
      activityRecorder: recorder,
    });

    const result = await runWithContext({
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "default",
      startedAt: 1,
      trustLevel: "admin",
    }, () => service.deliverToChannel(adapter, "channel-a", "hello", { origin: "agent" }));

    expect(result.ok).toBe(true);
    expect(recorder.beginDeliveryPlatformAttempt).toHaveBeenCalledTimes(2);
    expect(recorder.finishDeliveryPlatformAttempt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recorder.beginDeliveryPlatformAttempt).mock.calls[1]![0].text).toContain("retry");
    expect(vi.mocked(recorder.finishDeliveryPlatformAttempt).mock.calls.map(([input]) => ({
      attemptRecordId: input.attempt.recordId,
      outcomeClass: input.outcomeClass,
    }))).toEqual([
      { attemptRecordId: "record:1", outcomeClass: "platform_error" },
      { attemptRecordId: "record:3", outcomeClass: "success" },
    ]);
  });

  it("reports a content-free gap while preserving a successful platform delivery", async () => {
    const privateError = "private-body-must-not-escape";
    const recorder = makeRecorder();
    vi.mocked(recorder.beginDeliveryPlatformAttempt).mockResolvedValue(err({
      reason: "storage_failed",
      sourceKind: "delivery_platform_attempt",
      gapDurablyAccounted: false,
      gapCount: 7,
      occurredAtMs: 123,
      errorKind: "resource",
      cause: new Error(privateError),
    }));
    const logger = makeLogger();
    const eventBus = new TypedEventBus();
    const gapHandler = vi.fn();
    eventBus.on("activity-recording:gap", gapHandler);
    const adapter: DeliveryAdapter = {
      channelType: "echo",
      sendMessage: vi.fn().mockResolvedValue(ok("platform-message")),
    };
    const service = createDeliveryService({
      hookRunner: makeHooks(),
      deliveryQueue: createNoOpDeliveryQueue(),
      logger,
      clock: createFakeClock(1_700_000_000_000),
      eventBus,
      activityRecorder: recorder,
    });

    const result = await service.deliverToChannel(adapter, "channel-a", "hello");

    expect(result.ok).toBe(true);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(gapHandler).toHaveBeenCalledWith({
      sourceKind: "delivery_platform_attempt",
      reason: "storage_failed",
      gapDurablyAccounted: false,
      gapCount: 7,
      errorKind: "resource",
      timestamp: 123,
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(privateError);
  });

  it("returns the physical send result when recorder begin or settlement never completes", async () => {
    const recorder = makeRecorder();
    vi.mocked(recorder.beginDeliveryPlatformAttempt).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const firstAdapter: DeliveryAdapter = {
      channelType: "echo",
      sendMessage: vi.fn().mockResolvedValue(ok("platform-first")),
    };
    const service = createDeliveryService({
      hookRunner: makeHooks(),
      deliveryQueue: createNoOpDeliveryQueue(),
      logger: makeLogger(),
      clock: createFakeClock(1_700_000_000_000),
      activityRecorder: recorder,
    });

    const first = await service.deliverToChannel(firstAdapter, "channel-a", "hello");

    expect(first.ok).toBe(true);
    vi.mocked(recorder.beginDeliveryPlatformAttempt).mockImplementationOnce(async (input) => ok({
      recordId: "record:00000000000000000001",
      sequence: 1,
      recordHash: "1".repeat(64),
      attemptId: "550e8400-e29b-41d4-a716-446655440001",
      settlementCapability: "B".repeat(43),
      traceId: input.traceId,
      occurredAtMs: input.occurredAtMs,
    }));
    vi.mocked(recorder.finishDeliveryPlatformAttempt).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const secondAdapter: DeliveryAdapter = {
      channelType: "echo",
      sendMessage: vi.fn().mockResolvedValue(ok("platform-second")),
    };

    const second = await service.deliverToChannel(secondAdapter, "channel-a", "hello again");

    expect(second.ok).toBe(true);
    expect(second.ok && second.value.deliveredChunks).toBe(1);
    expect(secondAdapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves the delivery path inert when no recorder is configured", async () => {
    const eventBus = new TypedEventBus();
    const gapHandler = vi.fn();
    eventBus.on("activity-recording:gap", gapHandler);
    const adapter: DeliveryAdapter = {
      channelType: "echo",
      sendMessage: vi.fn().mockResolvedValue(ok("platform-message")),
    };
    const service = createDeliveryService({
      hookRunner: makeHooks(),
      deliveryQueue: createNoOpDeliveryQueue(),
      logger: makeLogger(),
      clock: createFakeClock(1_700_000_000_000),
      eventBus,
    });

    const result = await service.deliverToChannel(adapter, "channel-a", "hello");

    expect(result.ok).toBe(true);
    expect(adapter.sendMessage).toHaveBeenCalledExactlyOnceWith("channel-a", "hello", {});
    expect(gapHandler).not.toHaveBeenCalled();
  });

  it("contains a malformed recorder result without changing physical delivery", async () => {
    const recorder = makeRecorder();
    vi.mocked(recorder.beginDeliveryPlatformAttempt).mockResolvedValueOnce(null as never);
    const eventBus = new TypedEventBus();
    const gapHandler = vi.fn();
    eventBus.on("activity-recording:gap", gapHandler);
    const adapter: DeliveryAdapter = {
      channelType: "echo",
      sendMessage: vi.fn().mockResolvedValue(ok("platform-message")),
    };
    const service = createDeliveryService({
      hookRunner: makeHooks(),
      deliveryQueue: createNoOpDeliveryQueue(),
      logger: makeLogger(),
      clock: createFakeClock(1_700_000_000_000),
      eventBus,
      activityRecorder: recorder,
    });

    const result = await service.deliverToChannel(adapter, "channel-a", "hello");

    expect(result.ok).toBe(true);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(gapHandler).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "delivery_platform_attempt",
      reason: "storage_failed",
      gapDurablyAccounted: false,
    }));
  });
});
