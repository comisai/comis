// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelPort,
  DeliveryService,
  NormalizedMessage,
  SessionKey,
} from "@comis/core";
import {
  QueueConfigSchema,
  StreamingConfigSchema,
  TypedEventBus,
} from "@comis/core";
import type { AgentExecutor, RunHandle } from "@comis/agent";
import { ok } from "@comis/shared";

import { createCommandQueue } from "../queue/command-queue.js";
import {
  setupAndRoute,
  type SetupAndRouteDeps,
} from "./setup-and-route.js";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

function makeMessage(id: string): NormalizedMessage {
  return {
    id,
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: `message ${id}`,
    timestamp: Date.now(),
    attachments: [],
    metadata: {
      telegramMessageId: id,
      telegramChatType: "private",
    },
  };
}

function makeSessionKey(channelId = "chat-1"): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId,
    peerId: "user-1",
  };
}

function makeAdapter(): ChannelPort {
  return {
    channelId: "telegram-adapter",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("reply-1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    platformAction: vi.fn(async () => ok(undefined)),
  };
}

function makeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async () => ok({
      ok: true,
      totalChunks: 1,
      deliveredChunks: 1,
      failedChunks: 0,
      chunks: [{ index: 0, ok: true, messageId: "reply-1" }],
      totalChars: 2,
    })),
    drainInFlight: vi.fn(async () => ({
      drained: 0,
      remaining: 0,
      durationMs: 0,
    })),
  };
}

function makeExecutor(
  execute?: AgentExecutor["execute"],
): AgentExecutor {
  return {
    execute: execute ?? vi.fn(async () => ({
      response: "ok",
      sessionKey: makeSessionKey(),
      tokensUsed: { input: 0, output: 0, total: 0 },
      cost: { total: 0 },
      stepsExecuted: 0,
      llmCalls: 1,
      finishReason: "stop" as const,
    })),
  } as unknown as AgentExecutor;
}

const instantStreaming = StreamingConfigSchema.parse({
  defaultTypingMode: "instant",
  defaultDeliveryTiming: { mode: "off" },
  perChannel: {
    telegram: {
      typingMode: "instant",
      typingRefreshMs: 4_000,
      typingTtlMs: 30_000,
      deliveryTiming: { mode: "off" },
    },
  },
});

function makeDeps(
  overrides: Partial<SetupAndRouteDeps> = {},
): SetupAndRouteDeps {
  return {
    eventBus: new TypedEventBus(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as never,
    deliveryService: makeDeliveryService(),
    streamingConfig: instantStreaming,
    ...overrides,
  } as SetupAndRouteDeps;
}

async function route(
  deps: SetupAndRouteDeps,
  adapter: ChannelPort,
  executor: AgentExecutor,
  message: NormalizedMessage,
  sessionKey = makeSessionKey(),
): Promise<void> {
  await setupAndRoute(
    deps,
    adapter,
    message,
    message,
    sessionKey,
    "agent-1",
    executor,
    new Set(),
    new Map(),
    undefined,
  );
}

async function expectTypingToRemainStopped(adapter: ChannelPort): Promise<void> {
  await Promise.resolve();
  const callsAfterSettlement = vi.mocked(adapter.platformAction).mock.calls.length;
  await vi.advanceTimersByTimeAsync(8_001);
  expect(adapter.platformAction).toHaveBeenCalledTimes(callsAfterSettlement);
}

function makeRunHandle(
  streaming: boolean,
): RunHandle {
  return {
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    isStreaming: vi.fn(() => streaming),
    isCompacting: vi.fn(() => false),
  };
}

describe("setupAndRoute typing lifecycle ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_750_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops instant typing after successful SDK steer forwarding", async () => {
    const adapter = makeAdapter();
    const runHandle = makeRunHandle(true);
    const deps = makeDeps({
      queueConfig: QueueConfigSchema.parse({ defaultMode: "steer+followup" }),
      sessionResolver: {
        resolveActiveSession: vi.fn(() => runHandle),
      },
    });

    await route(deps, adapter, makeExecutor(), makeMessage("steer-source"));

    expect(runHandle.steer).toHaveBeenCalledOnce();
    await expectTypingToRemainStopped(adapter);
  });

  it("stops instant typing after successful SDK follow-up forwarding", async () => {
    const adapter = makeAdapter();
    const runHandle = makeRunHandle(false);
    const deps = makeDeps({
      queueConfig: QueueConfigSchema.parse({ defaultMode: "steer+followup" }),
      sessionResolver: {
        resolveActiveSession: vi.fn(() => runHandle),
      },
    });

    await route(deps, adapter, makeExecutor(), makeMessage("followup-source"));

    expect(runHandle.followUp).toHaveBeenCalledOnce();
    await expectTypingToRemainStopped(adapter);
  });

  it("stops instant typing when a shut-down real queue rejects enqueue", async () => {
    const queueConfig = QueueConfigSchema.parse({ defaultMode: "followup" });
    const commandQueue = createCommandQueue({
      eventBus: new TypedEventBus(),
      config: queueConfig,
    });
    await commandQueue.shutdown();
    const adapter = makeAdapter();
    const deps = makeDeps({ commandQueue, queueConfig });

    await route(deps, adapter, makeExecutor(), makeMessage("rejected-source"));

    await expectTypingToRemainStopped(adapter);
  });

  it("disposes every superseded typing owner after real collect coalescing", async () => {
    const queueConfig = QueueConfigSchema.parse({
      defaultMode: "collect",
      defaultOverflow: { maxDepth: 20, policy: "drop-new" },
    });
    const eventBus = new TypedEventBus();
    const commandQueue = createCommandQueue({ eventBus, config: queueConfig });
    const deps = makeDeps({ commandQueue, queueConfig, eventBus });
    const adapter = makeAdapter();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    let executionCount = 0;
    const executor = makeExecutor(vi.fn(async () => {
      executionCount++;
      if (executionCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return {
        response: "ok",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    }));

    const first = route(deps, adapter, executor, makeMessage("collect-1"));
    await firstStarted.promise;
    await route(deps, adapter, executor, makeMessage("collect-2"));
    await route(deps, adapter, executor, makeMessage("collect-3"));
    releaseFirst.resolve();
    await first;
    await commandQueue.drainAll();
    await commandQueue.shutdown();

    expect(executionCount).toBe(2);
    await expectTypingToRemainStopped(adapter);
  });

  it("disposes typing ownership for a real collect overflow drop", async () => {
    const queueConfig = QueueConfigSchema.parse({
      defaultMode: "collect",
      defaultOverflow: { maxDepth: 1, policy: "drop-new" },
    });
    const eventBus = new TypedEventBus();
    const commandQueue = createCommandQueue({ eventBus, config: queueConfig });
    const deps = makeDeps({ commandQueue, queueConfig, eventBus });
    const adapter = makeAdapter();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    let executionCount = 0;
    const executor = makeExecutor(vi.fn(async () => {
      executionCount++;
      if (executionCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return {
        response: "ok",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    }));

    const first = route(deps, adapter, executor, makeMessage("drop-1"));
    await firstStarted.promise;
    await route(deps, adapter, executor, makeMessage("drop-2"));
    await route(deps, adapter, executor, makeMessage("drop-3"));
    releaseFirst.resolve();
    await first;
    await commandQueue.drainAll();
    await commandQueue.shutdown();

    expect(executionCount).toBe(2);
    await expectTypingToRemainStopped(adapter);
  });

  it("disposes typing ownership for real queued work rejected by shutdown", async () => {
    const queueConfig = QueueConfigSchema.parse({
      defaultMode: "followup",
      maxConcurrentSessions: 1,
    });
    const eventBus = new TypedEventBus();
    const commandQueue = createCommandQueue({ eventBus, config: queueConfig });
    const deps = makeDeps({ commandQueue, queueConfig, eventBus });
    const adapter = makeAdapter();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    let executionCount = 0;
    const executor = makeExecutor(vi.fn(async () => {
      executionCount++;
      if (executionCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return {
        response: "ok",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    }));

    const first = route(deps, adapter, executor, makeMessage("shutdown-1"));
    await firstStarted.promise;
    const waiting = route(deps, adapter, executor, makeMessage("shutdown-2"));
    await Promise.resolve();
    expect(commandQueue.getQueueDepth(makeSessionKey())).toBe(2);

    const shutdown = commandQueue.shutdown();
    releaseFirst.resolve();
    await Promise.all([first, waiting, shutdown]);

    expect(executionCount).toBe(1);
    await expectTypingToRemainStopped(adapter);
  });

  it("force-stops active typing when bounded shutdown leaves execution running", async () => {
    const queueConfig = QueueConfigSchema.parse({ defaultMode: "followup" });
    const eventBus = new TypedEventBus();
    const terminalEvents: Array<{
      sourceMessageId: string;
      outcome: string;
      reason: string;
    }> = [];
    eventBus.on("message:terminal", (event) => terminalEvents.push(event));
    const commandQueue = createCommandQueue({ eventBus, config: queueConfig });
    const deps = makeDeps({ commandQueue, queueConfig, eventBus });
    const adapter = makeAdapter();
    const executionStarted = createDeferred();
    const releaseExecution = createDeferred();
    const message = makeMessage("active-shutdown-source");
    const executor = makeExecutor(vi.fn(async () => {
      executionStarted.resolve();
      await releaseExecution.promise;
      return {
        response: "ok",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    }));

    const activeRoute = route(deps, adapter, executor, message);
    await executionStarted.promise;
    const shutdown = commandQueue.shutdown();
    await vi.advanceTimersByTimeAsync(3_001);
    await shutdown;

    await expectTypingToRemainStopped(adapter);
    expect(terminalEvents).toEqual([
      expect.objectContaining({
        sourceMessageId: message.id,
        outcome: "aborted",
        reason: "queue_aborted",
      }),
    ]);

    releaseExecution.resolve();
    await activeRoute;
    await expectTypingToRemainStopped(adapter);
    expect(terminalEvents).toHaveLength(1);
    expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
  });

  it("bounds a hostile SDK abort promise so the real queue handler can settle", async () => {
    const queueConfig = QueueConfigSchema.parse({ defaultMode: "followup" });
    const eventBus = new TypedEventBus();
    const commandQueue = createCommandQueue({ eventBus, config: queueConfig });
    const executionStarted = createDeferred();
    const releaseExecution = createDeferred();
    const neverSettles = new Promise<void>(() => undefined);
    const runHandle = makeRunHandle(true);
    vi.mocked(runHandle.abort).mockReturnValue(neverSettles);
    const deps = makeDeps({
      commandQueue,
      queueConfig,
      eventBus,
      sessionResolver: {
        resolveActiveSession: vi.fn(() => runHandle),
      },
    });
    const executor = makeExecutor(vi.fn(async () => {
      executionStarted.resolve();
      await releaseExecution.promise;
      return {
        response: "ok",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    }));

    let routeSettled = false;
    const activeRoute = route(
      deps,
      makeAdapter(),
      executor,
      makeMessage("hostile-abort-source"),
    ).then(() => {
      routeSettled = true;
    });
    await executionStarted.promise;
    const shutdown = commandQueue.shutdown();
    releaseExecution.resolve();
    await vi.advanceTimersByTimeAsync(3_001);
    await Promise.resolve();

    expect(runHandle.abort).toHaveBeenCalledOnce();
    expect(routeSettled).toBe(true);
    await Promise.all([activeRoute, shutdown]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
