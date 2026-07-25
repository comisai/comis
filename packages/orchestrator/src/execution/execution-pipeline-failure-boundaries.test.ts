// SPDX-License-Identifier: Apache-2.0
import type {
  ActivityStreamPort,
  ChannelPort,
  DeliveryService,
  NormalizedMessage,
  PerChannelStreamingConfig,
  SessionKey,
  TurnOutcome,
} from "@comis/core";
import { TypedEventBus } from "@comis/core";
import type { AgentExecutor } from "@comis/agent";
import type {
  SendOverrideStore,
  TypingLifecycleController,
} from "@comis/channels";
import { ok } from "@comis/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const voiceBoundary = vi.hoisted(() => ({
  rejectWith: undefined as Error | undefined,
  resolveWith: undefined as
    | {
        voiceSent: true;
        receipt: { kind: "tracked"; messageId: string };
      }
    | undefined,
}));

vi.mock("@comis/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/channels")>();
  return {
    ...actual,
    executeVoiceResponse: vi.fn((...args: Parameters<typeof actual.executeVoiceResponse>) => {
      if (voiceBoundary.rejectWith !== undefined) {
        return Promise.reject(voiceBoundary.rejectWith);
      }
      if (voiceBoundary.resolveWith !== undefined) {
        return Promise.resolve({ ok: true as const, value: voiceBoundary.resolveWith });
      }
      return actual.executeVoiceResponse(...args);
    }),
  };
});
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import type { ActivityTurnCoordinator } from "./activity-turn-coordinator.js";
import {
  executeAndDeliver,
  type ExecutionPipelineDeps,
} from "./execution-pipeline.js";

function makeMessage(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000901",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "Exercise the failure boundary",
    timestamp: 1_000,
    attachments: [],
    metadata: {},
  };
}

function makeSessionKey(): SessionKey {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    channelId: "chat-1",
  };
}

function makeAdapter(overrides: Partial<ChannelPort> = {}): ChannelPort {
  return {
    channelId: "telegram-adapter",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    sendMessage: vi.fn(async () => ok("platform-message-1")),
    sendAttachment: vi.fn(async () =>
      ok({ kind: "tracked" as const, messageId: "attachment-message-1" })
    ),
    ...overrides,
  } as unknown as ChannelPort;
}

function makeExecutor(): AgentExecutor {
  return {
    execute: vi.fn(async () => ({
      response: "Delivered response",
      sessionKey: makeSessionKey(),
      tokensUsed: { input: 80, output: 40, total: 120 },
      cost: { total: 0.012 },
      stepsExecuted: 7,
      llmCalls: 3,
      finishReason: "stop" as const,
    })),
  } as unknown as AgentExecutor;
}

function makeDeliveryService(
  deliverToChannel: DeliveryService["deliverToChannel"] = vi.fn(async () =>
    ok({
      chunks: [{
        status: "accepted" as const,
        messageId: "platform-message-1",
        charCount: 18,
        retried: false,
      }],
      totalChars: 18,
      platform: {
        status: "accepted" as const,
        deliveredChunks: 1,
        settledAtMs: 2_000,
        lastMessageId: "platform-message-1",
      },
      queueDisposition: "settled" as const,
    })
  ),
): DeliveryService {
  return {
    deliverToChannel,
    drainInFlight: vi.fn(async () => ({
      drained: 0,
      remaining: 0,
      durationMs: 0,
    })),
  };
}

function makeStreamingConfig(): PerChannelStreamingConfig {
  return {
    enabled: true,
    chunkMode: "paragraph",
    chunkMinChars: 100,
    deliveryTiming: {
      mode: "custom",
      minMs: 0,
      maxMs: 0,
      jitterMs: 0,
      firstBlockDelayMs: 0,
    },
    coalescer: {
      minChars: 0,
      maxChars: 500,
      idleMs: 1_500,
      codeBlockPolicy: "standalone",
      adaptiveIdle: false,
    },
    typingMode: "thinking",
    typingRefreshMs: 6_000,
    typingCircuitBreakerThreshold: 3,
    typingTtlMs: 60_000,
    useMarkdownIR: true,
    tableMode: "code",
    replyMode: "first",
  };
}

function makeSendOverrides(): SendOverrideStore {
  return {
    get: vi.fn(() => "inherit"),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function makeCoordinator(overrides: Partial<ActivityTurnCoordinator> = {}): ActivityTurnCoordinator {
  return {
    start: vi.fn(),
    finalize: vi.fn(async (_outcome: TurnOutcome) => undefined),
    dispose: vi.fn(),
    counters: vi.fn(() => ({
      toolStarted: 0,
      toolCompleted: 0,
      toolFailed: 0,
      modelStarted: 0,
      modelCompleted: 0,
      modelFailed: 0,
      renderApply: 0,
      renderError: 0,
      deleteGated: 0,
      deleteApplied: 0,
      turnDurationMs: 0,
      circuitBreakerTripped: 0,
    })),
    ...overrides,
  };
}

function makeTypingLifecycle(overrides: Partial<TypingLifecycleController> = {}): TypingLifecycleController {
  let active = false;
  let startedAt = 0;
  const controller = {
    start: vi.fn(() => {
      active = true;
      startedAt = 2_000;
    }),
    stop: vi.fn(() => {
      active = false;
    }),
    refreshTtl: vi.fn(),
    get isActive() { return active; },
    get startedAt() { return startedAt; },
    get isSealed() { return false; },
  };
  return {
    controller,
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    dispose: vi.fn(() => controller.stop()),
    ...overrides,
  };
}

interface HarnessOverrides extends Partial<ExecutionPipelineDeps> {
  eventBus?: TypedEventBus;
}

function makeHarness(overrides: HarnessOverrides = {}) {
  const eventBus = overrides.eventBus ?? new TypedEventBus();
  const emitSpy = vi.spyOn(eventBus, "emitSafely");
  const logger = createMockLogger();
  const deps: ExecutionPipelineDeps = {
    eventBus,
    logger,
    clock: createFakeClock(2_000),
    deliveryService: makeDeliveryService(),
    ...overrides,
  };
  return { deps, emitSpy, eventBus, logger };
}

async function run(
  deps: ExecutionPipelineDeps,
  options: {
    adapter?: ChannelPort;
    executor?: AgentExecutor;
    typingLifecycle?: TypingLifecycleController;
  } = {},
): Promise<void> {
  const message = makeMessage();
  await executeAndDeliver(
    deps,
    options.adapter ?? makeAdapter(),
    message,
    message,
    options.executor ?? makeExecutor(),
    makeSessionKey(),
    "agent-1",
    makeStreamingConfig(),
    new Set(),
    makeSendOverrides(),
    options.typingLifecycle,
  );
}

function diagnosticCalls(emitSpy: ReturnType<typeof vi.spyOn>) {
  return emitSpy.mock.calls.filter(([event]) => event === "diagnostic:message_processed");
}

function expectKnownDeliveryFailure(emitSpy: ReturnType<typeof vi.spyOn>, errorKind: string): void {
  const calls = diagnosticCalls(emitSpy);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[1]).toMatchObject({
    status: "error",
    failureStage: "delivery",
    errorKind,
    tokensUsed: 120,
    cost: 0.012,
    finishReason: "stop",
    toolCalls: 7,
    llmCalls: 3,
  });
}

afterEach(() => {
  voiceBoundary.rejectWith = undefined;
  voiceBoundary.resolveWith = undefined;
});

describe("execution pipeline rejection diagnostics", () => {
  it("records exact usage when response parsing rejects after execution", async () => {
    const primary = new Error("parser boundary failed");
    const { deps, emitSpy } = makeHarness({
      parseOutboundMedia: vi.fn(() => {
        throw primary;
      }),
      outboundMediaFetch: vi.fn(),
    });

    await expect(run(deps)).rejects.toBe(primary);

    expectKnownDeliveryFailure(emitSpy, "internal");
  });

  it("contains a rejected outbound media fetch as a platform delivery failure", async () => {
    const primary = new Error("media transport rejected");
    const { deps, emitSpy } = makeHarness({
      parseOutboundMedia: vi.fn(() => ({ text: "", mediaUrls: ["https://example.com/image.png"] })),
      outboundMediaFetch: vi.fn(async () => {
        throw primary;
      }),
    });

    await run(deps);

    expectKnownDeliveryFailure(emitSpy, "platform");
  });

  it("records exact usage when the delivery service rejects", async () => {
    const primary = new Error("platform send rejected");
    const deliveryService = makeDeliveryService(vi.fn(async () => {
      throw primary;
    }));
    const { deps, emitSpy } = makeHarness({ deliveryService });

    await expect(run(deps)).rejects.toBe(primary);

    expectKnownDeliveryFailure(emitSpy, "platform");
  });

  it("records exact usage when voice synthesis unexpectedly rejects", async () => {
    const primary = new Error("voice synthesis rejected");
    voiceBoundary.rejectWith = primary;
    const { deps, emitSpy } = makeHarness({
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await expect(run(deps)).rejects.toBe(primary);

    expectKnownDeliveryFailure(emitSpy, "internal");
  });

  it("uses a classified platform error from a rejected voice attachment send", async () => {
    const primary = Object.assign(new Error("voice attachment send rejected"), {
      errorKind: "platform" as const,
    });
    voiceBoundary.rejectWith = primary;
    const { deps, emitSpy } = makeHarness({
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await expect(run(deps)).rejects.toBe(primary);

    expectKnownDeliveryFailure(emitSpy, "platform");
  });

  it("preserves every closed error kind carried by a rejected boundary error", async () => {
    const primary = Object.assign(new Error("voice provider authorization rejected"), {
      errorKind: "auth" as const,
    });
    voiceBoundary.rejectWith = primary;
    const { deps, emitSpy } = makeHarness({
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await expect(run(deps)).rejects.toBe(primary);

    expectKnownDeliveryFailure(emitSpy, "auth");
  });

  it("contains a message-sent subscriber failure after delivery and reaches later observers", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("message:sent", () => {
      throw new Error("message-sent subscriber failed");
    });
    eventBus.on("message:sent", laterObserver);
    const deliveryService = makeDeliveryService();
    const { deps, emitSpy, logger } = makeHarness({ eventBus, deliveryService });

    await expect(run(deps)).resolves.toBeUndefined();

    expect(deliveryService.deliverToChannel).toHaveBeenCalledOnce();
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({ status: "success" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "message:sent",
        firstListenerIndex: 0,
        errorKind: "internal",
        hint: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it("contains a streaming-block subscriber failure after send and reaches later observers", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("streaming:block_sent", () => {
      throw new Error("streaming subscriber failed");
    });
    eventBus.on("streaming:block_sent", laterObserver);
    const deliveryService = makeDeliveryService();
    const { deps, emitSpy, logger } = makeHarness({ eventBus, deliveryService });

    await expect(run(deps)).resolves.toBeUndefined();

    expect(deliveryService.deliverToChannel).toHaveBeenCalledOnce();
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({ status: "success" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "streaming:block_sent",
        firstListenerIndex: 0,
        errorKind: "internal",
        hint: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it("contains a voice message-sent subscriber failure after attachment delivery", async () => {
    voiceBoundary.resolveWith = {
      voiceSent: true,
      receipt: { kind: "tracked", messageId: "voice-message-1" },
    };
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("message:sent", () => {
      throw new Error("voice lifecycle subscriber failed");
    });
    eventBus.on("message:sent", laterObserver);
    const deliveryService = makeDeliveryService();
    const { deps, emitSpy, logger } = makeHarness({
      eventBus,
      deliveryService,
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await expect(run(deps)).resolves.toBeUndefined();

    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({ status: "success" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "message:sent", firstListenerIndex: 0 }),
      expect.any(String),
    );
  });

  it("contains a media-only message-sent subscriber failure after attachment delivery", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("message:sent", () => {
      throw new Error("media lifecycle subscriber failed");
    });
    eventBus.on("message:sent", laterObserver);
    const deliveryService = makeDeliveryService();
    const adapter = makeAdapter();
    const { deps, emitSpy, logger } = makeHarness({
      eventBus,
      deliveryService,
      parseOutboundMedia: vi.fn(() => ({
        text: "",
        mediaUrls: ["https://example.com/image.png"],
      })),
      outboundMediaFetch: vi.fn(async () => ok({
        buffer: Buffer.from("image"),
        mimeType: "image/png",
      })),
    });

    await expect(run(deps, { adapter })).resolves.toBeUndefined();

    expect(adapter.sendAttachment).toHaveBeenCalledOnce();
    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({ status: "success" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "message:sent", firstListenerIndex: 0 }),
      expect.any(String),
    );
  });

  it("emits the lifecycle diagnostic before awaiting coordinator finalization", async () => {
    const order: string[] = [];
    const eventBus = new TypedEventBus();
    eventBus.on("diagnostic:message_processed", () => {
      order.push("diagnostic");
    });
    const coordinator = makeCoordinator({
      finalize: vi.fn(async () => {
        order.push("finalize");
      }),
    });
    const { deps } = makeHarness({
      eventBus,
      activityStreamPort: {} as ActivityStreamPort,
      coordinatorFactory: () => coordinator,
    });

    await run(deps);

    expect(order).toEqual(["diagnostic", "finalize"]);
  });

  it("contains coordinator finalization rejection after authoritative delivery", async () => {
    const rendererFailure = new Error("custom coordinator rejected");
    const coordinator = makeCoordinator({
      finalize: vi.fn(async () => {
        throw rendererFailure;
      }),
    });
    const { deps, emitSpy, logger } = makeHarness({
      activityStreamPort: {} as ActivityStreamPort,
      coordinatorFactory: () => coordinator,
    });

    await expect(run(deps)).resolves.toBeUndefined();

    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({
      status: "success",
      tokensUsed: 120,
      cost: 0.012,
      toolCalls: 7,
      llmCalls: 3,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupStep: "coordinator_finalize",
        hint: expect.any(String),
        errorKind: "internal",
      }),
      expect.any(String),
    );
  });

  it("contains message and diagnostic subscriber failures after delivery", async () => {
    const observabilityFailure = new Error("diagnostic subscriber failed");
    const eventBus = new TypedEventBus();
    eventBus.on("message:sent", () => {
      throw new Error("message-sent subscriber failed");
    });
    eventBus.on("diagnostic:message_processed", () => {
      throw observabilityFailure;
    });
    const { deps, emitSpy, logger } = makeHarness({ eventBus });

    await expect(run(deps)).resolves.toBeUndefined();

    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "message:sent" }),
      expect.any(String),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "diagnostic:message_processed",
        hint: expect.any(String),
        errorKind: "internal",
      }),
      expect.any(String),
    );
  });

  it("contains a diagnostic subscriber failure after successful delivery", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("diagnostic:message_processed", async () => {
      await Promise.resolve();
      throw new Error("diagnostic subscriber failed");
    });
    eventBus.on("diagnostic:message_processed", laterObserver);
    const deliveryService = makeDeliveryService();
    const { deps, emitSpy, logger } = makeHarness({ eventBus, deliveryService });

    await expect(run(deps)).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deliveryService.deliverToChannel).toHaveBeenCalledOnce();
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "diagnostic:message_processed" }),
      expect.any(String),
    );
  });

  it("contains a response-filter subscriber failure and preserves suppression", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("response:filtered", () => {
      throw new Error("filter subscriber failed");
    });
    eventBus.on("response:filtered", laterObserver);
    const deliveryService = makeDeliveryService();
    const executor = makeExecutor();
    vi.mocked(executor.execute).mockResolvedValue({
      response: "NO_REPLY",
      sessionKey: makeSessionKey(),
      tokensUsed: { input: 80, output: 40, total: 120 },
      cost: { total: 0.012 },
      stepsExecuted: 7,
      llmCalls: 3,
      finishReason: "stop" as const,
    });
    const { deps, emitSpy, logger } = makeHarness({ eventBus, deliveryService });

    await expect(run(deps, { executor })).resolves.toBeUndefined();

    expect(deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({ status: "filtered" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "response:filtered", firstListenerIndex: 0 }),
      expect.any(String),
    );
  });
});

describe("execution pipeline acquisition and cleanup failures", () => {
  it("emits one unknown-count diagnostic when tool assembly rejects", async () => {
    const primary = new Error("tool assembly rejected");
    const typingLifecycle = makeTypingLifecycle();
    const { deps, emitSpy } = makeHarness({
      assembleToolsForAgent: vi.fn(async () => {
        throw primary;
      }),
    });

    await expect(run(deps, { typingLifecycle })).rejects.toBe(primary);

    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "execution",
      errorKind: "internal",
      tokensUsed: 0,
      cost: 0,
      finishReason: "error",
      toolCalls: null,
      llmCalls: null,
    });
    expect(typingLifecycle.dispose).toHaveBeenCalledOnce();
  });

  it("disposes an acquired coordinator when its start method throws", async () => {
    const primary = new Error("coordinator start failed");
    const coordinator = makeCoordinator({
      start: vi.fn(() => {
        throw primary;
      }),
    });
    const { deps, emitSpy } = makeHarness({
      activityStreamPort: {} as ActivityStreamPort,
      coordinatorFactory: () => coordinator,
    });

    await expect(run(deps)).rejects.toBe(primary);

    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "execution",
      errorKind: "internal",
      toolCalls: null,
      llmCalls: null,
    });
    expect(coordinator.dispose).toHaveBeenCalledOnce();
  });

  it("emits one unknown-count diagnostic when coordinator construction throws", async () => {
    const primary = new Error("coordinator factory failed");
    const { deps, emitSpy } = makeHarness({
      activityStreamPort: {} as ActivityStreamPort,
      coordinatorFactory: () => {
        throw primary;
      },
    });

    await expect(run(deps)).rejects.toBe(primary);

    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "execution",
      errorKind: "internal",
      tokensUsed: 0,
      cost: 0,
      toolCalls: null,
      llmCalls: null,
    });
  });

  it("isolates every cleanup step without reclassifying delivered success", async () => {
    const credential = `xoxb-${"d".repeat(32)}`;
    const eventBus = new TypedEventBus();
    const originalOff = eventBus.off.bind(eventBus);
    let offCalls = 0;
    vi.spyOn(eventBus, "off").mockImplementation(((event, handler) => {
      offCalls++;
      if (offCalls === 1) throw new Error(`execution cleanup failed ${credential}`);
      return originalOff(event, handler);
    }) as typeof eventBus.off);
    eventBus.on("typing:stopped", () => {
      throw new Error("typing stop subscriber failed");
    });
    const coordinator = makeCoordinator({
      dispose: vi.fn(() => {
        throw new Error(`coordinator dispose failed ${credential}`);
      }),
    });
    const typingLifecycle = makeTypingLifecycle({
      dispose: vi.fn(() => {
        throw new Error(`typing dispose failed ${credential}`);
      }),
    });
    const deliveryService = makeDeliveryService();
    const { deps, emitSpy, logger } = makeHarness({
      eventBus,
      deliveryService,
      activityStreamPort: {} as ActivityStreamPort,
      coordinatorFactory: () => coordinator,
    });

    await expect(run(deps, { typingLifecycle })).resolves.toBeUndefined();

    expect(deliveryService.deliverToChannel).toHaveBeenCalledOnce();
    expect(diagnosticCalls(emitSpy)).toHaveLength(1);
    expect(diagnosticCalls(emitSpy)[0]?.[1]).toMatchObject({ status: "success" });
    expect(coordinator.dispose).toHaveBeenCalledOnce();
    expect(typingLifecycle.dispose).toHaveBeenCalledOnce();
    expect(emitSpy).toHaveBeenCalledWith(
      "typing:stopped",
      expect.objectContaining({ channelId: "telegram-adapter", chatId: "chat-1" }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupStep: "coordinator_dispose" }),
      expect.any(String),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupStep: "execution_cleanup" }),
      expect.any(String),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupStep: "typing_dispose" }),
      expect.any(String),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "typing:stopped", firstListenerIndex: 0 }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(credential);
  });

  it("preserves the primary delivery rejection when cleanup also fails", async () => {
    const primary = new Error("delivery rejected first");
    const coordinator = makeCoordinator({
      dispose: vi.fn(() => {
        throw new Error("secondary cleanup failure");
      }),
    });
    const { deps, emitSpy } = makeHarness({
      deliveryService: makeDeliveryService(vi.fn(async () => {
        throw primary;
      })),
      activityStreamPort: {} as ActivityStreamPort,
      coordinatorFactory: () => coordinator,
    });

    await expect(run(deps)).rejects.toBe(primary);

    expectKnownDeliveryFailure(emitSpy, "platform");
  });

  it("preserves the primary delivery rejection when failure finalization also rejects", async () => {
    const primary = new Error("delivery rejected first");
    const finalizeFailure = new Error("failure renderer also rejected");
    const coordinator = makeCoordinator({
      finalize: vi.fn(async () => {
        throw finalizeFailure;
      }),
    });
    const { deps, emitSpy, logger } = makeHarness({
      deliveryService: makeDeliveryService(vi.fn(async () => {
        throw primary;
      })),
      activityStreamPort: {} as ActivityStreamPort,
      coordinatorFactory: () => coordinator,
    });

    await expect(run(deps)).rejects.toBe(primary);

    expectKnownDeliveryFailure(emitSpy, "platform");
    expect(coordinator.finalize).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupStep: "coordinator_finalize" }),
      expect.any(String),
    );
  });
});
