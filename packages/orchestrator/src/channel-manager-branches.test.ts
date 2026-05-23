// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for createChannelManager (channel-manager.ts).
 *
 * The existing channel-manager.test.ts exercises core paths (start/stop,
 * sendMessage, graph-report intercept). This file fills uncovered branches:
 * - channelRegistry-sourced adapters
 * - debounce flush handler routing (adapter lookup hit + miss)
 * - injectMessage adapter-not-found branch
 * - session:expired event listener side effects
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ChannelPort,
  NormalizedMessage,
  MessageHandler,
  DeliveryService,
  TypedEventBus,
} from "@comis/core";
import type { AgentExecutor, SessionLifecycle } from "@comis/agent";
import type { MessageRouter } from "./routing/message-router.js";
import { ok } from "@comis/shared";
import { createMockLogger } from "../../../test/support/mock-logger.js";
import {
  createChannelManager,
  type ChannelManagerDeps,
} from "./channel-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(
  overrides?: Partial<ChannelPort>,
): ChannelPort & { _handlers: MessageHandler[] } {
  const handlers: MessageHandler[] = [];
  return {
    _handlers: handlers,
    channelId: "telegram-123",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-99")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn((handler: MessageHandler) => {
      handlers.push(handler);
    }),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
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
    // channel-manager.stopAll() drains via
    // deps.deliveryService.drainInFlight(5000). Default fake returns empty
    // drain telemetry so this test suite's stopAll() exercises complete
    // cleanly when no sends are tracked.
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function makeRouter(): MessageRouter {
  return {
    resolve: vi.fn(() => "agent-default"),
  };
}

function makeSessionManager(): SessionLifecycle {
  return {
    loadOrCreate: vi.fn(() => []),
    save: vi.fn(),
    isExpired: vi.fn(() => false),
    expire: vi.fn(() => true),
    cleanStale: vi.fn(() => 0),
  };
}

function makeExecutor(): AgentExecutor {
  return {
    execute: vi.fn(async () => ({
      response: "ok",
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
      tokensUsed: { input: 0, output: 0, total: 0 },
      cost: { total: 0 },
      stepsExecuted: 0,
      finishReason: "stop" as const,
    })),
  } as unknown as AgentExecutor;
}

function makeEventBus(): TypedEventBus {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const eb = {
    emit: vi.fn((event: string, payload: unknown) => {
      const arr = listeners.get(event) ?? [];
      for (const fn of arr) {
        fn(payload);
      }
      return true;
    }),
    on: vi.fn((event: string, fn: (payload: unknown) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
      return eb;
    }),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return eb as any;
}

function makeDeps(overrides?: Partial<ChannelManagerDeps>): ChannelManagerDeps {
  return {
    eventBus: makeEventBus(),
    messageRouter: makeRouter(),
    sessionManager: makeSessionManager(),
    createExecutor: vi.fn(() => makeExecutor()),
    adapters: [],
    logger: createMockLogger(),
    deliveryService: makeFakeDeliveryService(),
    processInboundMessage: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// channelRegistry-sourced adapters
// ---------------------------------------------------------------------------

describe("createChannelManager channelRegistry plugins", () => {
  it("registers adapters from channelRegistry.getChannelPlugins() in addition to direct adapters", async () => {
    const directAdapter = makeAdapter({ channelType: "telegram" });
    const pluginAdapter = makeAdapter({
      channelType: "discord",
      channelId: "discord-456",
    });
    const channelRegistry = {
      getChannelPlugins: vi.fn(() => [{ adapter: pluginAdapter }]),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const deps = makeDeps({
      adapters: [directAdapter],
      channelRegistry,
    });
    const mgr = createChannelManager(deps);

    await mgr.startAll();

    expect(directAdapter.start).toHaveBeenCalledOnce();
    expect(pluginAdapter.start).toHaveBeenCalledOnce();
    expect(mgr.activeCount).toBe(2);
  });

  it("uses only channelRegistry plugins when adapters list is undefined", async () => {
    const pluginAdapter = makeAdapter({
      channelType: "slack",
      channelId: "slack-789",
    });
    const channelRegistry = {
      getChannelPlugins: vi.fn(() => [{ adapter: pluginAdapter }]),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const deps = makeDeps({
      adapters: undefined,
      channelRegistry,
    });
    const mgr = createChannelManager(deps);

    await mgr.startAll();

    expect(pluginAdapter.start).toHaveBeenCalledOnce();
    expect(mgr.activeCount).toBe(1);
  });

  it("calls stop() on channelRegistry plugins during stopAll", async () => {
    const pluginAdapter = makeAdapter({ channelType: "discord" });
    const channelRegistry = {
      getChannelPlugins: vi.fn(() => [{ adapter: pluginAdapter }]),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const deps = makeDeps({ adapters: [], channelRegistry });
    const mgr = createChannelManager(deps);

    await mgr.startAll();
    await mgr.stopAll();

    expect(pluginAdapter.stop).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// injectMessage adapter-not-found branch
// ---------------------------------------------------------------------------

describe("createChannelManager injectMessage early-exit branches", () => {
  it("warns and returns when adapter for channel type is not registered", async () => {
    const logger = createMockLogger();
    const processInboundMessage = vi.fn();
    const deps = makeDeps({
      adapters: [makeAdapter({ channelType: "telegram" })],
      logger,
      processInboundMessage,
    });
    const mgr = createChannelManager(deps);
    await mgr.startAll();

    await mgr.injectMessage("nonexistent-channel-type", {
      id: "msg-1",
      channelId: "c-1",
      channelType: "nonexistent-channel-type",
      senderId: "u-1",
      text: "hello",
      timestamp: 0,
      attachments: [],
      metadata: {},
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "nonexistent-channel-type",
        errorKind: "config",
      }),
      "Cannot inject message: adapter not found",
    );
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it("forwards injected message through processInboundMessage when adapter exists", async () => {
    const adapter = makeAdapter({ channelType: "telegram" });
    const processInboundMessage = vi.fn(async () => undefined);
    const onMessageReceived = vi.fn();
    const onMessageProcessed = vi.fn();
    const deps = makeDeps({
      adapters: [adapter],
      processInboundMessage,
      onMessageReceived,
      onMessageProcessed,
    });
    const mgr = createChannelManager(deps);
    await mgr.startAll();

    const msg: NormalizedMessage = {
      id: "msg-1",
      channelId: "c-1",
      channelType: "telegram",
      senderId: "u-1",
      text: "hello",
      timestamp: 0,
      attachments: [],
      metadata: {},
    };
    await mgr.injectMessage("telegram", msg);

    expect(onMessageReceived).toHaveBeenCalledWith(msg, "telegram");
    expect(processInboundMessage).toHaveBeenCalledOnce();
    expect(onMessageProcessed).toHaveBeenCalledWith(msg, "telegram");
  });

  it("intercepts injected graph:report button callback before forwarding to pipeline", async () => {
    const adapter = makeAdapter({ channelType: "telegram" });
    const processInboundMessage = vi.fn();
    const onGraphReportRequest = vi.fn(async () => undefined);
    const onMessageReceived = vi.fn();
    const deps = makeDeps({
      adapters: [adapter],
      processInboundMessage,
      onGraphReportRequest,
      onMessageReceived,
    });
    const mgr = createChannelManager(deps);
    await mgr.startAll();

    const msg: NormalizedMessage = {
      id: "msg-1",
      channelId: "c-1",
      channelType: "telegram",
      senderId: "u-1",
      text: "graph:report:graph-42",
      timestamp: 0,
      attachments: [],
      metadata: { isButtonCallback: true },
    };
    await mgr.injectMessage("telegram", msg);

    expect(onGraphReportRequest).toHaveBeenCalledWith(
      "graph-42",
      "telegram",
      "c-1",
      adapter,
      undefined,
    );
    expect(onMessageReceived).not.toHaveBeenCalled();
    expect(processInboundMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// stopAll() shutdown ordering
// ---------------------------------------------------------------------------
// debounceBuffer + groupHistoryBuffer + sessionLabelStore were removed from
// ChannelManagerDeps. The session:expired listener no longer clears those
// buffers (only sendOverrides), and the debounce flush handler registration
// was removed from startAll(). Tests covering those code paths are gone.

describe("createChannelManager stopAll shutdown ordering", () => {
  it("logs error when adapter.stop() fails but continues to next adapter", async () => {
    const logger = createMockLogger();
    const failingAdapter = makeAdapter({
      channelType: "telegram",
      stop: vi.fn(async () => ({
        ok: false as const,
        error: new Error("adapter-stop-failed"),
      })),
    });
    const successAdapter = makeAdapter({
      channelType: "discord",
      channelId: "discord-456",
    });
    const deps = makeDeps({
      adapters: [failingAdapter, successAdapter],
      logger,
    });
    const mgr = createChannelManager(deps);
    await mgr.startAll();
    await mgr.stopAll();

    expect(failingAdapter.stop).toHaveBeenCalled();
    expect(successAdapter.stop).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "internal",
        hint: expect.stringContaining("cleanup failed"),
      }),
      "Failed to stop adapter",
    );
  });
});
