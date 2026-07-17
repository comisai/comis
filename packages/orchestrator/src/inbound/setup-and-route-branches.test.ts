// SPDX-License-Identifier: Apache-2.0
/**
 * Branch coverage for setup-and-route.ts.
 *
 * Covers the typing-mode matrix and the routing matrix through the
 * setupAndRoute() call signature.
 *
 * @module
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  ChannelPort,
  NormalizedMessage,
  SessionKey,
  DeliveryService,
} from "@comis/core";
import { QueueConfigSchema, runWithContext, TypedEventBus } from "@comis/core";
import type { AgentExecutor } from "@comis/agent";
import { ok } from "@comis/shared";

import { setupAndRoute, type SetupAndRouteDeps } from "./setup-and-route.js";
import { createCommandQueue } from "../queue/command-queue.js";
import type { SourceTerminalScope } from "../source-message-terminal.js";

// ---------------------------------------------------------------------------
// Helpers (union of the two source-test helper sets; the route-side adapter
// + msg + sessionKey factories are the more complete versions and subsume
// the setup-side equivalents.)
// ---------------------------------------------------------------------------

function makeAdapter(channelType = "telegram"): ChannelPort {
  return {
    channelId: "adapter-1",
    channelType,
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-r1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    reactToMessage: vi.fn(async () => ok(undefined)),
    removeReaction: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    fetchMessages: vi.fn(async () => ok([])),
    sendAttachment: vi.fn(async () => ok({ kind: "tracked" as const, messageId: "att-1" })),
    platformAction: vi.fn(async () => ok(undefined)),
  };
}

function makeMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: { telegramMessageId: 42, telegramChatType: "private" },
    ...overrides,
  };
}

function makeSessionKey(): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId: "chat-1",
    peerId: "user-1",
  };
}

function makeFakeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async () =>
      ok({
        ok: true,
        totalChunks: 1,
        deliveredChunks: 1,
        failedChunks: 0,
        chunks: [],
        totalChars: 0,
      }),
    ),
    // DeliveryService provides drainInFlight(). Default fake returns empty
    // drain telemetry; tests that exercise drain semantics override this field.
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function makeExecutor(): AgentExecutor {
  return {
    execute: vi.fn(async () => ({
      response: "ok",
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      tokensUsed: { input: 0, output: 0, total: 0 },
      cost: { total: 0 },
      stepsExecuted: 0,
      finishReason: "stop" as const,
    })),
  } as unknown as AgentExecutor;
}

function makeMinimalDeps(overrides?: Partial<SetupAndRouteDeps>): SetupAndRouteDeps {
  const eventBus = {
    emit: vi.fn(() => true),
    emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus: eventBus as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any,
    deliveryService: makeFakeDeliveryService(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as SetupAndRouteDeps;
}

// ===========================================================================
// SETUP-SIDE: Typing controller branches
// (preserved verbatim from inbound-setup-branches.test.ts, with calls
// retargeted to setupAndRoute and the route-side deps stubbed via the
// shared makeMinimalDeps factory above)
// ===========================================================================

// "setupInboundExecution ack reaction dispatch" describe block deleted:
// ackReactionConfig deps slot removed from ChannelManagerDeps /
// InboundPipelineDeps / SetupDeps. The ack-reaction-fire-and-forget code path
// in inbound-setup.ts is gone; lifecycle reactor handles ack reactions when
// enabled (production absent-mode).

describe("setupAndRoute typing controller behavior", () => {
  it("forces typingMode 'never' on IRC channel even when streamingConfig default is thinking", async () => {
    // Pass no streamingConfig — resolveStreamingConfig falls back to typingMode: "thinking" default
    const eventBus = {
      emit: vi.fn(() => true),
      emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const deps = makeMinimalDeps({ eventBus: eventBus as never });
    const adapter = makeAdapter("irc");

    await setupAndRoute(
      deps,
      adapter,
      makeMsg({ channelType: "irc" }),
      makeMsg({ channelType: "irc" }),
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    // Typing controller never started -> no typing:started event emitted
    const typingEmits = eventBus.emit.mock.calls.filter(
      (call) => call[0] === "typing:started",
    );
    expect(typingEmits.length).toBe(0);
  });

  it("forces typingMode 'never' on Echo channel even when streamingConfig default is thinking", async () => {
    const eventBus = {
      emit: vi.fn(() => true),
      emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const deps = makeMinimalDeps({ eventBus: eventBus as never });
    const adapter = makeAdapter("echo");

    await setupAndRoute(
      deps,
      adapter,
      makeMsg({ channelType: "echo" }),
      makeMsg({ channelType: "echo" }),
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    const typingEmits = eventBus.emit.mock.calls.filter(
      (call) => call[0] === "typing:started",
    );
    expect(typingEmits.length).toBe(0);
  });

  it("suppresses typing controller on heartbeat-originated messages", async () => {
    const eventBus = {
      emit: vi.fn(() => true),
      emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const deps = makeMinimalDeps({ eventBus: eventBus as never });
    const adapter = makeAdapter("telegram");

    await setupAndRoute(
      deps,
      adapter,
      makeMsg({ metadata: { isHeartbeat: true } }),
      makeMsg({ metadata: { isHeartbeat: true } }),
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    const typingEmits = eventBus.emit.mock.calls.filter(
      (call) => call[0] === "typing:started",
    );
    expect(typingEmits.length).toBe(0);
  });

  it("starts typing immediately when typingMode is 'instant'", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("typing:started", () => {
      throw new Error("typing observer failed");
    });
    eventBus.on("typing:started", laterObserver);
    // Stub commandQueue with no-op enqueue so routing short-circuits at the
    // queue-mediated path; the setup-side typing assertion is what matters here.
    const noopEnqueue = vi.fn(async () => ok(undefined));
    const deps = makeMinimalDeps({
      eventBus,
      commandQueue: { enqueue: noopEnqueue } as never,
      streamingConfig: {
        defaultMode: "instant",
        perChannel: {
          telegram: {
            typingMode: "instant",
            typingRefreshMs: 4000,
            typingCircuitBreakerThreshold: 3,
            typingTtlMs: 30000,
          },
        },
      } as never,
    });
    const adapter = makeAdapter("telegram");

    await setupAndRoute(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(laterObserver).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "instant" }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "typing:started",
        firstListenerIndex: 0,
      }),
      "Observational event subscriber failed",
    );
  });

  it("suppresses typing in group chat when bot is not mentioned", async () => {
    const eventBus = {
      emit: vi.fn(() => true),
      emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const deps = makeMinimalDeps({ eventBus: eventBus as never });
    const adapter = makeAdapter("telegram");

    await setupAndRoute(
      deps,
      adapter,
      makeMsg({ metadata: { telegramChatType: "group", isBotMentioned: false } }),
      makeMsg({ metadata: { telegramChatType: "group", isBotMentioned: false } }),
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    const typingEmits = eventBus.emit.mock.calls.filter(
      (call) => call[0] === "typing:started",
    );
    expect(typingEmits.length).toBe(0);
  });

  it("enables typing in group chat when bot is mentioned (instant mode emits typing:started)", async () => {
    const eventBus = {
      emit: vi.fn(() => true),
      emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    // Stub commandQueue with no-op enqueue so routing short-circuits at the
    // queue-mediated path; the setup-side typing assertion is what matters here.
    const noopEnqueue = vi.fn(async () => ok(undefined));
    const deps = makeMinimalDeps({
      eventBus: eventBus as never,
      commandQueue: { enqueue: noopEnqueue } as never,
      streamingConfig: {
        defaultMode: "instant",
        perChannel: {
          telegram: {
            typingMode: "instant",
            typingRefreshMs: 4000,
            typingCircuitBreakerThreshold: 3,
            typingTtlMs: 30000,
          },
        },
      } as never,
    });
    const adapter = makeAdapter("telegram");

    await setupAndRoute(
      deps,
      adapter,
      makeMsg({
        metadata: { telegramChatType: "group", isBotMentioned: true },
      }),
      makeMsg({
        metadata: { telegramChatType: "group", isBotMentioned: true },
      }),
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    // Mentioned in group + instant mode -> typing:started should be emitted
    expect(eventBus.emitSafely).toHaveBeenCalledWith(
      "typing:started",
      expect.objectContaining({ mode: "instant" }),
    );
  });
});

// ===========================================================================
// ROUTE-SIDE: Steer + follow-up routing branches
// (preserved verbatim from inbound-route-branches.test.ts, with calls
// retargeted to setupAndRoute; setup-side deps default to undefined
// streamingConfig so typing path is a no-op for these assertions)
// ===========================================================================

// "routeInboundMessage debounce buffer gate" + "routeInboundMessage group history
// injection" describe blocks deleted: debounceBuffer + groupHistoryBuffer +
// sessionLabelStore deps slots removed. Production absent-mode is direct
// routing through CommandQueue without coalescing or history injection.

describe("setupAndRoute steer+followup routing", () => {
  function makeRunHandle(
    overrides?: Partial<{
      isStreaming: boolean;
      isCompacting: boolean;
      steerThrows: boolean;
      followUpThrows: boolean;
    }>,
  ): {
    isStreaming: () => boolean;
    isCompacting: () => boolean;
    steer: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    abort: () => Promise<void>;
  } {
    const o = overrides ?? {};
    return {
      isStreaming: vi.fn(() => o.isStreaming ?? true),
      isCompacting: vi.fn(() => o.isCompacting ?? false),
      steer: vi.fn(
        o.steerThrows
          ? async () => {
              throw new Error("steer failed");
            }
          : async () => undefined,
      ),
      followUp: vi.fn(
        o.followUpThrows
          ? async () => {
              throw new Error("followup failed");
            }
          : async () => undefined,
      ),
      abort: vi.fn(async () => undefined),
    };
  }

  it("injects via steer when session is streaming and not compacting", async () => {
    const runHandle = makeRunHandle({ isStreaming: true, isCompacting: false });
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => runHandle),
    };
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("steer:injected", () => {
      throw new Error("steer observer failed");
    });
    eventBus.on("steer:injected", laterObserver);
    const deps = makeMinimalDeps({
      sessionResolver: sessionResolver as never,
      eventBus,
      queueConfig: {
        defaultMode: "steer+followup",
        perChannel: {},
      } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(runHandle.steer).toHaveBeenCalledWith("hello");
    expect(laterObserver).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1" }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "steer:injected",
        firstListenerIndex: 0,
      }),
      "Observational event subscriber failed",
    );
    // followup must not be invoked after successful steer
    expect(runHandle.followUp).not.toHaveBeenCalled();
  });

  it("falls through to follow-up when steer throws an error", async () => {
    const runHandle = makeRunHandle({
      isStreaming: true,
      isCompacting: false,
      steerThrows: true,
    });
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => runHandle),
    };
    const deps = makeMinimalDeps({
      sessionResolver: sessionResolver as never,
      queueConfig: {
        defaultMode: "steer+followup",
        perChannel: {},
      } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(runHandle.steer).toHaveBeenCalledOnce();
    expect(runHandle.followUp).toHaveBeenCalledWith("hello");
  });

  it("sanitizes SDK steer failures before logging them", async () => {
    const credential = `xoxb-${"s".repeat(32)}`;
    const runHandle = makeRunHandle({ isStreaming: true, isCompacting: false });
    runHandle.steer.mockRejectedValueOnce(new Error(`steer failed ${credential}`));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    const deps = makeMinimalDeps({
      sessionResolver: {
        resolveActiveSession: vi.fn(() => runHandle),
      } as never,
      queueConfig: {
        defaultMode: "steer+followup",
        perChannel: {},
      } as never,
      logger: logger as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(String) }),
      "Steer injection failed",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(credential);
  });

  it("queues as follow-up immediately when session is compacting", async () => {
    const runHandle = makeRunHandle({ isStreaming: false, isCompacting: true });
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => runHandle),
    };
    const eventBus = {
      emit: vi.fn(() => true),
      emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const deps = makeMinimalDeps({
      sessionResolver: sessionResolver as never,
      eventBus: eventBus as never,
      queueConfig: {
        defaultMode: "steer+followup",
        perChannel: {},
      } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    // No steer when compacting
    expect(runHandle.steer).not.toHaveBeenCalled();
    // Direct follow-up
    expect(runHandle.followUp).toHaveBeenCalledOnce();
    expect(eventBus.emitSafely).toHaveBeenCalledWith(
      "steer:followup_queued",
      expect.objectContaining({ reason: "compacting" }),
    );
  });

  it("emits steer:rejected with not_streaming reason when session is idle", async () => {
    const runHandle = makeRunHandle({ isStreaming: false, isCompacting: false });
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => runHandle),
    };
    const eventBus = {
      emit: vi.fn(() => true),
      emitSafely: vi.fn(() => ({ hadListeners: false, failures: [] })),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const deps = makeMinimalDeps({
      sessionResolver: sessionResolver as never,
      eventBus: eventBus as never,
      queueConfig: {
        defaultMode: "steer+followup",
        perChannel: {},
      } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(eventBus.emitSafely).toHaveBeenCalledWith(
      "steer:rejected",
      expect.objectContaining({ reason: "not_streaming" }),
    );
    expect(runHandle.followUp).toHaveBeenCalledOnce();
  });

  it("falls through to command queue when followUp fails after steer rejection", async () => {
    const runHandle = makeRunHandle({
      isStreaming: false,
      isCompacting: false,
      followUpThrows: true,
    });
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => runHandle),
    };
    const enqueue = vi.fn(async () => ok(undefined));
    const commandQueue = { enqueue };
    const deps = makeMinimalDeps({
      sessionResolver: sessionResolver as never,
      commandQueue: commandQueue as never,
      queueConfig: {
        defaultMode: "steer+followup",
        perChannel: {},
      } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(runHandle.followUp).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("sanitizes SDK follow-up failures before logging them", async () => {
    const credential = `xoxb-${"f".repeat(32)}`;
    const runHandle = makeRunHandle({ isStreaming: false, isCompacting: false });
    runHandle.followUp.mockRejectedValueOnce(new Error(`follow-up failed ${credential}`));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    const enqueue = vi.fn(async () => ok(undefined));
    const deps = makeMinimalDeps({
      sessionResolver: {
        resolveActiveSession: vi.fn(() => runHandle),
      } as never,
      commandQueue: { enqueue } as never,
      queueConfig: {
        defaultMode: "steer+followup",
        perChannel: {},
      } as never,
      logger: logger as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(String) }),
      "Follow-up queue failed",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(credential);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("uses per-channel queue mode override when channel config sets non-steer mode", async () => {
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => null),
    };
    const enqueue = vi.fn(async () => ok(undefined));
    const deps = makeMinimalDeps({
      sessionResolver: sessionResolver as never,
      commandQueue: { enqueue } as never,
      queueConfig: {
        defaultMode: "steer+followup",
        perChannel: { telegram: { mode: "queue" } },
      } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    // With mode override to "queue", sessionResolver MUST NOT be queried
    expect(sessionResolver.resolveActiveSession).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// ROUTE-SIDE: Command queue routing
// ===========================================================================

describe("setupAndRoute command-queue routing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs warning when command queue rejects enqueue with overflow policy", async () => {
    const credential = `xoxb-${"q".repeat(32)}`;
    const enqueue = vi.fn(async () => ({
      ok: false as const,
      error: new Error(`Queue overflow ${credential}`),
    }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    const deps = makeMinimalDeps({
      commandQueue: { enqueue } as never,
      logger: logger as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await setupAndRoute(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.not.stringContaining(credential),
        hint: expect.stringContaining("command queue"),
      }),
      "Message enqueue failed",
    );
    expect(deps.eventBus.emitSafely).toHaveBeenCalledWith(
      "message:terminal",
      expect.objectContaining({
        channelType: "telegram",
        channelId: "chat-1",
        sourceMessageId: "msg-1",
        outcome: "error",
        reason: "queue_rejected",
      }),
    );
  });

  it("terminalizes work aborted before queued execution begins", async () => {
    const eventBus = makeMinimalDeps().eventBus;
    const executor = makeExecutor();
    const enqueue = vi.fn(async (
      _sessionKey: SessionKey,
      queuedMessage: NormalizedMessage,
      _channelType: string,
      handler: (
        messages: NormalizedMessage[],
        execution: {
          signal: AbortSignal;
          receivedAt: number;
          sourceTerminalScope: SourceTerminalScope;
        },
      ) => Promise<void>,
      sourceTerminalScope: SourceTerminalScope,
    ) => {
      const controller = new AbortController();
      controller.abort();
      await handler([queuedMessage], {
        signal: controller.signal,
        receivedAt: 750,
        sourceTerminalScope,
      });
      return ok(undefined);
    });
    const deps = makeMinimalDeps({
      commandQueue: { enqueue } as never,
      eventBus,
    });
    const msg = makeMsg({
      id: "00000000-0000-0000-0000-000000000401",
    });

    await setupAndRoute(
      deps,
      makeAdapter(),
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      executor,
      new Set(),
      new Map() as never,
      undefined,
    );

    expect(executor.execute).not.toHaveBeenCalled();
    expect(eventBus.emitSafely).toHaveBeenCalledWith(
      "message:terminal",
      expect.objectContaining({
        channelType: "telegram",
        channelId: "chat-1",
        sourceMessageId: msg.id,
        outcome: "aborted",
        reason: "execution_completed",
      }),
    );
  });

  it("does not republish a real queue shutdown rejection at the setup boundary", async () => {
    const eventBus = new TypedEventBus();
    const observed: Array<{ sourceMessageId: string; reason: string }> = [];
    eventBus.on("message:terminal", (event) => observed.push(event));
    let releaseActive!: () => void;
    const activeReleased = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let activeStarted!: () => void;
    const activeReady = new Promise<void>((resolve) => {
      activeStarted = resolve;
    });
    const commandQueue = createCommandQueue({
      eventBus,
      config: QueueConfigSchema.parse({
        defaultMode: "followup",
        maxConcurrentSessions: 1,
      }),
    });
    const sessionKey = makeSessionKey();
    const active = commandQueue.enqueue(
      sessionKey,
      makeMsg({ id: "00000000-0000-0000-0000-000000000411" }),
      "telegram",
      async () => {
        activeStarted();
        await activeReleased;
      },
    );
    await activeReady;
    const waitingMessage = makeMsg({
      id: "00000000-0000-0000-0000-000000000412",
    });
    const deps = makeMinimalDeps({ eventBus, commandQueue });

    const routed = setupAndRoute(
      deps,
      makeAdapter(),
      waitingMessage,
      waitingMessage,
      sessionKey,
      "agent-1",
      makeExecutor(),
      new Set(),
      new Map() as never,
      undefined,
    );
    await Promise.resolve();
    const shutdown = commandQueue.shutdown();
    releaseActive();
    await Promise.all([routed, shutdown, active]);

    expect(observed.filter((event) =>
      event.sourceMessageId === waitingMessage.id)).toEqual([
      expect.objectContaining({ reason: "queue_rejected" }),
    ]);
  });

  it("aborts the authoritative active SDK run when the queue cancels execution", async () => {
    let resolveExecutorStarted!: () => void;
    const executorStarted = new Promise<void>((resolve) => {
      resolveExecutorStarted = resolve;
    });
    let resolveExecutor!: () => void;
    const releaseExecutor = new Promise<void>((resolve) => {
      resolveExecutor = resolve;
    });
    const executor = makeExecutor();
    vi.mocked(executor.execute).mockImplementation(async () => {
      resolveExecutorStarted();
      await releaseExecutor;
      return {
        response: "ok",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    });
    const runHandle = {
      steer: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      abort: vi.fn(async () => {
        resolveExecutor();
      }),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
    };
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => runHandle),
    };
    const enqueue = vi.fn(async (
      _sessionKey: SessionKey,
      queuedMessage: NormalizedMessage,
      _channelType: string,
      handler: (
        messages: NormalizedMessage[],
        execution: {
          signal: AbortSignal;
          receivedAt: number;
          sourceTerminalScope: SourceTerminalScope;
        },
      ) => Promise<void>,
      sourceTerminalScope: SourceTerminalScope,
    ) => {
      const controller = new AbortController();
      const execution = handler([queuedMessage], {
        signal: controller.signal,
        receivedAt: 750,
        sourceTerminalScope,
      });
      await executorStarted;
      controller.abort();
      await execution;
      return ok(undefined);
    });
    const deps = makeMinimalDeps({
      commandQueue: { enqueue } as never,
      sessionResolver: sessionResolver as never,
    });

    await setupAndRoute(
      deps,
      makeAdapter(),
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      executor,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    );

    expect(sessionResolver.resolveActiveSession).toHaveBeenCalledWith({
      agentId: "agent-1",
      channelType: "telegram",
      channelId: "chat-1",
    });
    expect(runHandle.abort).toHaveBeenCalledOnce();
  });

  it("aborts after registration when prompt execution id differs from the request trace", async () => {
    const traceId = randomUUID();
    const promptExecutionId = randomUUID();
    const eventBus = new TypedEventBus();
    let resolveExecutorStarted!: () => void;
    const executorStarted = new Promise<void>((resolve) => {
      resolveExecutorStarted = resolve;
    });
    let resolveExecutor!: () => void;
    const releaseExecutor = new Promise<void>((resolve) => {
      resolveExecutor = resolve;
    });
    const executor = makeExecutor();
    vi.mocked(executor.execute).mockImplementation(async () => {
      resolveExecutorStarted();
      await releaseExecutor;
      return {
        response: "ok",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    });
    const runHandle = {
      steer: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      abort: vi.fn(async () => {
        resolveExecutor();
      }),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
    };
    const sessionResolver = {
      resolveActiveSession: vi.fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValue(runHandle),
    };
    const enqueue = vi.fn(async (
      _sessionKey: SessionKey,
      queuedMessage: NormalizedMessage,
      _channelType: string,
      handler: (
        messages: NormalizedMessage[],
        execution: {
          signal: AbortSignal;
          receivedAt: number;
          sourceTerminalScope: SourceTerminalScope;
        },
      ) => Promise<void>,
      sourceTerminalScope: SourceTerminalScope,
    ) => {
      const controller = new AbortController();
      const execution = handler([queuedMessage], {
        signal: controller.signal,
        receivedAt: 750,
        sourceTerminalScope,
      });
      await executorStarted;
      controller.abort();
      eventBus.emit("prompt:submitted", {
        agentId: "another-agent",
        sessionKey: "default:user-1:chat-1:peer:user-1",
        traceId: promptExecutionId,
        promptChars: 1,
        provider: "test",
        modelId: "test-model",
        messageCount: 1,
        systemDigest: "system-digest",
        messagesDigest: "messages-digest",
        timestamp: 800,
      });
      expect(sessionResolver.resolveActiveSession).toHaveBeenCalledOnce();
      eventBus.emit("prompt:submitted", {
        agentId: "agent-1",
        sessionKey: "default:user-1:chat-1:peer:user-1",
        traceId: promptExecutionId,
        promptChars: 1,
        provider: "test",
        modelId: "test-model",
        messageCount: 1,
        systemDigest: "system-digest",
        messagesDigest: "messages-digest",
        timestamp: 800,
      });
      resolveExecutor();
      await execution;
      return ok(undefined);
    });
    const deps = makeMinimalDeps({
      commandQueue: { enqueue } as never,
      sessionResolver: sessionResolver as never,
      eventBus,
    });

    await runWithContext({
      traceId,
      startedAt: 700,
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "admin",
    }, () => setupAndRoute(
      deps,
      makeAdapter(),
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      executor,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    ));

    expect(sessionResolver.resolveActiveSession).toHaveBeenCalledTimes(2);
    expect(runHandle.abort).toHaveBeenCalledOnce();
    expect(eventBus.listenerCount("prompt:submitted")).toBe(0);
  });

  it("uses channel ingress time for direct execution diagnostics without a queue", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const eventBus = makeMinimalDeps().eventBus;
    const executor = makeExecutor();
    vi.mocked(executor.execute).mockImplementation(async () => {
      vi.setSystemTime(1_100);
      return {
        response: "ok",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 1,
        finishReason: "stop" as const,
      };
    });
    const deliveryService = makeFakeDeliveryService();
    vi.mocked(deliveryService.deliverToChannel).mockImplementation(async () => {
      vi.setSystemTime(1_140);
      return ok({
        ok: true,
        totalChunks: 1,
        deliveredChunks: 1,
        failedChunks: 0,
        chunks: [],
        totalChars: 2,
      });
    });
    const deps = makeMinimalDeps({ eventBus, deliveryService });
    const ingressStartedAt = 800;

    await runWithContext({
      traceId: randomUUID(),
      startedAt: ingressStartedAt,
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "admin",
    }, () => setupAndRoute(
      deps,
      makeAdapter(),
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      executor,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
    ));

    expect(eventBus.emitSafely).toHaveBeenCalledWith(
      "diagnostic:message_processed",
      expect.objectContaining({
        receivedAt: ingressStartedAt,
        executionDurationMs: 100,
        deliveryDurationMs: 40,
        totalDurationMs: 340,
      }),
    );
  });
});
