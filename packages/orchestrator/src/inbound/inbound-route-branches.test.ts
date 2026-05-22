// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for routeInboundMessage (inbound-route.ts).
 *
 * The existing inbound-route.test.ts is a source-grep gate only. This file
 * exercises the runtime branches: debounce buffering, group history
 * injection, steer+followup routing, queue-mediated path, direct execution
 * fallback, and lane assignment.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ChannelPort,
  NormalizedMessage,
  SessionKey,
  DeliveryService,
} from "@comis/core";
import type { AgentExecutor } from "@comis/agent";
import { ok } from "@comis/shared";

import { routeInboundMessage } from "./inbound-route.js";
import type { RouteDeps } from "./inbound-route.js";

// ---------------------------------------------------------------------------
// Helpers
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
    sendAttachment: vi.fn(async () => ok("att-1")),
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
    metadata: { telegramMessageId: "42", telegramChatType: "private" },
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
    // TEST-PUB-01 (Plan 56-05): DeliveryService gained drainInFlight().
    // Default fake returns empty drain telemetry; tests that exercise drain
    // semantics override this field.
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

function makeMinimalDeps(overrides?: Partial<RouteDeps>): RouteDeps {
  const eventBus = {
    emit: vi.fn(() => true),
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
  } as RouteDeps;
}

// ---------------------------------------------------------------------------
// Debounce buffer gate
// ---------------------------------------------------------------------------

describe("routeInboundMessage debounce buffer gate", () => {
  it("buffers message for debounce when debounceBuffer is configured and msg is not debounced", async () => {
    const pushed: Array<unknown> = [];
    const debounceBuffer = {
      push: vi.fn((sk, m, ct) => {
        pushed.push({ sk, m, ct });
      }),
    };
    const deps = makeMinimalDeps({
      debounceBuffer: debounceBuffer as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg();

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    expect(debounceBuffer.push).toHaveBeenCalledOnce();
    expect(pushed[0]).toMatchObject({ ct: "telegram" });
  });

  it("bypasses debounce buffer when message is already marked debounced", async () => {
    const debounceBuffer = { push: vi.fn() };
    const enqueue = vi.fn(async () => ok(undefined));
    const deps = makeMinimalDeps({
      debounceBuffer: debounceBuffer as never,
      commandQueue: { enqueue } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ metadata: { isDebounced: true } });

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    expect(debounceBuffer.push).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Group history injection
// ---------------------------------------------------------------------------

describe("routeInboundMessage group history injection", () => {
  it("injects formatted group history into message text when buffer has prior history", async () => {
    const groupHistoryBuffer = {
      getFormatted: vi.fn(() => "[user-2]: prior message"),
      depth: vi.fn(() => 1),
      push: vi.fn(),
    };
    const eventBus = {
      emit: vi.fn(() => true),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const enqueue = vi.fn(async () => ok(undefined));
    const deps = makeMinimalDeps({
      groupHistoryBuffer: groupHistoryBuffer as never,
      eventBus: eventBus as never,
      commandQueue: { enqueue } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({
      metadata: { telegramChatType: "group" },
    });

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    expect(groupHistoryBuffer.getFormatted).toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "grouphistory:injected",
      expect.objectContaining({
        channelType: "telegram",
      }),
    );
  });

  it("skips history injection when buffer returns null and adapter is in a group", async () => {
    const groupHistoryBuffer = {
      getFormatted: vi.fn(() => null),
      depth: vi.fn(() => 0),
      push: vi.fn(),
    };
    const eventBus = {
      emit: vi.fn(() => true),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const enqueue = vi.fn(async () => ok(undefined));
    const deps = makeMinimalDeps({
      groupHistoryBuffer: groupHistoryBuffer as never,
      eventBus: eventBus as never,
      commandQueue: { enqueue } as never,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({
      metadata: { telegramChatType: "group" },
    });

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    // emit grouphistory:injected should NOT have fired (no history present)
    expect(
      eventBus.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === "grouphistory:injected",
      ).length,
    ).toBe(0);
    // But the current message MUST still be pushed for next time
    expect(groupHistoryBuffer.push).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Steer + follow-up routing — sessionResolver branch matrix
// ---------------------------------------------------------------------------

describe("routeInboundMessage steer+followup routing", () => {
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
    const eventBus = {
      emit: vi.fn(() => true),
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

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    expect(runHandle.steer).toHaveBeenCalledWith("hello");
    expect(eventBus.emit).toHaveBeenCalledWith(
      "steer:injected",
      expect.objectContaining({ agentId: "agent-1" }),
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

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    expect(runHandle.steer).toHaveBeenCalledOnce();
    expect(runHandle.followUp).toHaveBeenCalledWith("hello");
  });

  it("queues as follow-up immediately when session is compacting", async () => {
    const runHandle = makeRunHandle({ isStreaming: false, isCompacting: true });
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => runHandle),
    };
    const eventBus = {
      emit: vi.fn(() => true),
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

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    // No steer when compacting
    expect(runHandle.steer).not.toHaveBeenCalled();
    // Direct follow-up
    expect(runHandle.followUp).toHaveBeenCalledOnce();
    expect(eventBus.emit).toHaveBeenCalledWith(
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

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    expect(eventBus.emit).toHaveBeenCalledWith(
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

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    expect(runHandle.followUp).toHaveBeenCalledOnce();
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

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    // With mode override to "queue", sessionResolver MUST NOT be queried
    expect(sessionResolver.resolveActiveSession).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Command queue routing
// ---------------------------------------------------------------------------

describe("routeInboundMessage command-queue routing", () => {
  it("logs warning when command queue rejects enqueue with overflow policy", async () => {
    const enqueue = vi.fn(async () => ({
      ok: false as const,
      error: new Error("Queue overflow"),
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

    await routeInboundMessage(
      deps,
      adapter,
      msg,
      msg,
      makeSessionKey(),
      "agent-1",
      makeExecutor(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      new Set(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Map() as any,
      undefined,
      undefined,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "Queue overflow",
        hint: expect.stringContaining("command queue"),
      }),
      "Message enqueue failed",
    );
  });
});
