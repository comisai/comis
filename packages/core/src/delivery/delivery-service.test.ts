// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createDeliveryService.
 *
 * The first top-level `describe` block ("createDeliveryService — factory
 * contract") is a 9-test smoke suite (lifecycle, hook invocation, traceId
 * propagation, suppressError preservation, closure capture).
 *
 * The second top-level `describe` block ("DeliveryService — full pipeline
 * behavior") covers the complete outbound pipeline (chunking, formatting,
 * queueing, retries, events). Each test calls
 * `deliver(service, adapter, ..., options)` where
 * `service: DeliveryService` is constructed via `makeDeliveryService(...)`
 * from `test/support/factories.ts`.
 *
 * The value-level helpers `resolveChunkLimit`, `computeQueueBackoff`, and
 * `QUEUE_BACKOFF_SCHEDULE_MS` live in `queue-backoff.ts`; their behaviour is
 * exercised implicitly via the pipeline tests below (chunk-limit defaults,
 * backoff scheduling on transient failures).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDeliveryService,
  type DeliveryServiceDeps,
  type DeliveryService,
} from "./delivery-service.js";
import * as secretEgressGuard from "../security/secret-egress-guard.js";
import { createNoOpDeliveryQueue } from "./no-op-delivery-queue.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import { runWithContext, tryGetContext } from "../context/context.js";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import type {
  DeliveryAdapter,
  DeliverToChannelOptions,
} from "./types.js";
import {
  AMBIGUOUS_SEND_OUTCOME_ERROR,
  EXPLICIT_SEND_REJECTION_ERROR,
  RETRY_EXHAUSTED_SEND_ERROR,
  type RetryEngine,
} from "./retry-engine.js";
import type { DeliveryQueuePort } from "../ports/delivery-queue.js";
import type { DeliveryAuthority } from "../ports/delivery-queue.js";
import type { ChannelEndpoint, ConversationRef } from "../domain/conversation-scope.js";
import type { ComisLogger } from "../logging/log-fields.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";
import { TypedEventBus } from "../event-bus/bus.js";

const TEST_CLOCK = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

/**
 * Build a no-op HookRunner with vi.fn() spies on every method. The fields
 * are typed via the `as unknown as HookRunner` escape hatch because the real
 * `HookRunner` interface has ~14 methods (including the gateway/session
 * hooks), and the smoke tests only exercise the delivery ones.
 */
function makeNoopHookRunner(
  overrides: Partial<HookRunner> = {},
): HookRunner {
  const noop = vi.fn().mockResolvedValue(undefined);
  const noopWithObject = vi.fn().mockResolvedValue({});
  const base = {
    runBeforeAgentStart: noop,
    runBeforeToolCall: noop,
    runToolResultPersist: vi.fn().mockReturnValue(undefined),
    runBeforeCompaction: noop,
    runBeforeDelivery: noopWithObject,
    runAgentEnd: noop,
    runAfterToolCall: noop,
    runAfterCompaction: noop,
    runAfterDelivery: noop,
    runSessionStart: noop,
    runSessionEnd: noop,
    runGatewayStart: noop,
    runGatewayStop: noop,
    ...overrides,
  };
  return base as unknown as HookRunner;
}

function makeAdapter(
  sendMessage: DeliveryAdapter["sendMessage"] = vi
    .fn()
    .mockResolvedValue(ok("msg-1")),
  channelType = "echo",
): DeliveryAdapter {
  return { sendMessage, channelType };
}

function makeDeps(
  overrides: Partial<DeliveryServiceDeps> = {},
): DeliveryServiceDeps {
  return {
    hookRunner: makeNoopHookRunner(),
    deliveryQueue: createNoOpDeliveryQueue(),
    logger: makeLogger(),
    clock: TEST_CLOCK,
    ...overrides,
  };
}

function makeDeliveryService(
  overrides: Partial<DeliveryServiceDeps> = {},
): DeliveryService {
  return createDeliveryService(makeDeps(overrides));
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

const TEST_DELIVERY_AUTHORITY = {
  tenantId: "tenant-test",
  agentId: "agent-test",
  conversationRef: `cv_${"A".repeat(43)}` as ConversationRef,
} satisfies DeliveryAuthority;

function deliver(
  service: DeliveryService,
  adapter: DeliveryAdapter,
  channelId: string,
  text: string,
  options: Partial<DeliverToChannelOptions> = {},
) {
  const context = tryGetContext();
  const authority = context?.agentId === undefined
    ? TEST_DELIVERY_AUTHORITY
    : {
        tenantId: context.tenantId,
        agentId: context.agentId,
        conversationRef: TEST_DELIVERY_AUTHORITY.conversationRef,
      };
  const destinationEndpoint: ChannelEndpoint = {
    channelType: adapter.channelType,
    channelInstanceId: "test-instance",
    conversationId: channelId,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    conversationKind: "direct",
  };
  return service.deliverToChannel(adapter, channelId, text, {
    completionMode: "settled",
    authority,
    destinationEndpoint,
    ...options,
  });
}

describe("createDeliveryService — factory contract (smoke-level)", () => {
  it("returns a DeliveryService with a deliverToChannel method", () => {
    const service: DeliveryService = createDeliveryService(makeDeps());
    expect(typeof service.deliverToChannel).toBe("function");
  });

  it("returned shape matches the deliverToChannel + drainInFlight interface", () => {
    const service = createDeliveryService(makeDeps());
    // The service exposes both `deliverToChannel` (per-call outbound
    // delivery) and `drainInFlight` (shutdown drain). Ordering is
    // factory-emission order — assert on the Set so iteration order is
    // irrelevant.
    expect(new Set(Object.keys(service))).toEqual(new Set(["deliverToChannel", "drainInFlight"]));
  });

  it("constructing the service does NOT call tryGetContext()", () => {
    // If construction touched AsyncLocalStorage outside a runWithContext frame,
    // tryGetContext() would return undefined (it's the non-throwing variant),
    // but a per-construction lookup would still surface as a side-effect we
    // can detect through the absence of any deps-method invocation. The
    // strongest assertion we can make without instrumenting the storage is
    // that construction with no context active does not throw.
    expect(() => createDeliveryService(makeDeps())).not.toThrow();
  });

  it("empty text returns a not-attempted error and does NOT invoke runBeforeDelivery", async () => {
    const runBeforeDelivery = vi.fn().mockResolvedValue({});
    const hookRunner = makeNoopHookRunner({ runBeforeDelivery });
    const service = createDeliveryService(makeDeps({ hookRunner }));
    const adapter = makeAdapter();
    const result = await deliver(service, adapter, "chat-1", "");
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "delivery_not_attempted", reason: "empty_text" },
    });
    // The empty-text branch runs BEFORE the hook block, so before_delivery
    // hooks never observe empty deliveries.
    expect(runBeforeDelivery).not.toHaveBeenCalled();
  });

  it("invokes runBeforeDelivery exactly once per call with non-empty text", async () => {
    const runBeforeDelivery = vi.fn().mockResolvedValue({});
    const hookRunner = makeNoopHookRunner({ runBeforeDelivery });
    const service = createDeliveryService(makeDeps({ hookRunner }));
    const adapter = makeAdapter();
    await deliver(service, adapter, "chat-1", "hi");
    expect(runBeforeDelivery).toHaveBeenCalledTimes(1);
  });

  it("cancel:true from runBeforeDelivery short-circuits — no send, no runAfterDelivery", async () => {
    const runBeforeDelivery = vi
      .fn()
      .mockResolvedValue({ cancel: true, cancelReason: "blocked-by-test" });
    const runAfterDelivery = vi.fn().mockResolvedValue(undefined);
    const hookRunner = makeNoopHookRunner({
      runBeforeDelivery,
      runAfterDelivery,
    });
    const adapter = makeAdapter();
    const service = createDeliveryService(makeDeps({ hookRunner }));
    const result = await deliver(service, adapter, "chat-1", "hi");
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(runAfterDelivery).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "delivery_not_attempted", reason: "hook_cancelled" },
    });
  });

  it("runAfterDelivery rejection does NOT corrupt the request (suppressError wrap preserved)", async () => {
    const runAfterDelivery = vi
      .fn()
      .mockRejectedValue(new Error("hook bug"));
    const hookRunner = makeNoopHookRunner({ runAfterDelivery });
    const service = createDeliveryService(makeDeps({ hookRunner }));
    const adapter = makeAdapter();
    const result = await deliver(service, adapter, "chat-1", "hi");
    // suppressError fires-and-forgets the rejection — give the microtask
    // queue a tick so the .catch() runs before the test ends (clean shutdown
    // / no unhandled rejection).
    await new Promise((r) => setImmediate(r));
    expect(result.ok).toBe(true);
  });

  it("traceId from tryGetContext() is passed to both hook contexts", async () => {
    const runBeforeDelivery = vi.fn().mockResolvedValue({});
    const runAfterDelivery = vi.fn().mockResolvedValue(undefined);
    const hookRunner = makeNoopHookRunner({
      runBeforeDelivery,
      runAfterDelivery,
    });
    const service = createDeliveryService(makeDeps({ hookRunner }));
    const adapter = makeAdapter();

    const TRACE_ID = "550e8400-e29b-41d4-a716-446655440000";
    await runWithContext(
      {
        traceId: TRACE_ID,
        userId: "user-1",
        sessionKey: "session-abc",
        tenantId: "tenant-x",
        startedAt: Date.now(),
        trustLevel: "admin",
      },
      async () => {
        await deliver(service, adapter, "chat-1", "hi");
      },
    );

    // before_delivery ctx (second arg of the call)
    const beforeCtxArg = runBeforeDelivery.mock.calls[0]?.[1];
    expect(beforeCtxArg).toMatchObject({
      sessionKey: "session-abc",
      traceId: TRACE_ID,
    });
    // after_delivery ctx (second arg of the call)
    await new Promise((r) => setImmediate(r));
    const afterCtxArg = runAfterDelivery.mock.calls[0]?.[1];
    expect(afterCtxArg).toMatchObject({
      sessionKey: "session-abc",
      traceId: TRACE_ID,
    });
  });

  it("deps captured in closure — subsequent calls reuse the same hookRunner reference", async () => {
    const deps = makeDeps();
    const service = createDeliveryService(deps);
    const adapter = makeAdapter();
    await deliver(service, adapter, "chat-1", "one");
    await deliver(service, adapter, "chat-2", "two");
    expect(deps.hookRunner.runBeforeDelivery).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Full pipeline behaviour
// =============================================================================
//
// Each test calls `await deliver(service, adapter, channelId, text,
// options)` where `service` is constructed via `makeDeliveryService(...)` in a
// describe-level `beforeEach` (DRY) or inline for special-case factory-deps
// tests. Construction-time deps (`{deliveryQueue, eventBus, retryEngine, ...}`)
// go into the `makeDeliveryService({...})` call. `abortSignal` rides on the
// per-call options channel (intersection type on the method signature — see
// DeliveryService in delivery-service.ts).
// =============================================================================

// ---------------------------------------------------------------------------
// Test helpers (local to this file's pipeline-behaviour describe)
// ---------------------------------------------------------------------------

function createMockAdapter(channelType = "telegram"): DeliveryAdapter & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    channelType,
    sendMessage: vi.fn().mockResolvedValue(ok("msg-id-123")),
  };
}

function createMockRetryEngine(): RetryEngine & { sendWithRetry: ReturnType<typeof vi.fn> } {
  return {
    sendWithRetry: vi.fn().mockResolvedValue(ok("msg-id-retry")),
  };
}

/** Generate a string of exact length. */
function makeText(length: number, char = "a"): string {
  return char.repeat(length);
}

/** Generate long markdown with paragraphs. */
function makeLongMarkdown(charTarget: number): string {
  const para = "This is a paragraph of markdown text for testing delivery chunking. It has enough content to be meaningful but not too long.";
  const parts: string[] = [];
  let total = 0;
  while (total < charTarget) {
    parts.push(para);
    total += para.length + 2; // +2 for \n\n separator
  }
  return parts.join("\n\n");
}

/** Mock DeliveryQueuePort with all methods spied. */
function createMockDeliveryQueue(): DeliveryQueuePort & {
  enqueue: ReturnType<typeof vi.fn>;
  enqueueInFlight: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  pendingEntries: ReturnType<typeof vi.fn>;
  unconfirmedEntries: ReturnType<typeof vi.fn>;
  pruneExpired: ReturnType<typeof vi.fn>;
  statusCounts: ReturnType<typeof vi.fn>;
  recoverInFlight: ReturnType<typeof vi.fn>;
} {
  return {
    enqueue: vi.fn().mockResolvedValue(ok("entry-uuid-1")),
    enqueueInFlight: vi.fn().mockResolvedValue(ok("entry-uuid-1")),
    claim: vi.fn().mockResolvedValue(ok(true)),
    ack: vi.fn().mockResolvedValue(ok(undefined)),
    nack: vi.fn().mockResolvedValue(ok(undefined)),
    fail: vi.fn().mockResolvedValue(ok(undefined)),
    pendingEntries: vi.fn().mockResolvedValue(ok([])),
    unconfirmedEntries: vi.fn().mockResolvedValue(ok([])),
    pruneExpired: vi.fn().mockResolvedValue(ok(0)),
    statusCounts: vi.fn().mockResolvedValue(
      ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 }),
    ),
    recoverInFlight: vi.fn().mockResolvedValue(ok(0)),
  };
}

describe("DeliveryService — full pipeline behavior", () => {
  describe("observational subscriber isolation", () => {
    it("preserves a successful receipt and reaches later delivery observers", async () => {
      const eventBus = new TypedEventBus();
      const logger = makeLogger();
      const queue = createMockDeliveryQueue();
      const laterAckObserver = vi.fn();
      const laterChunkObserver = vi.fn();
      const laterCompleteObserver = vi.fn();
      const observedEvents = [
        ["delivery:acked", laterAckObserver],
        ["delivery:chunk_sent", laterChunkObserver],
        ["delivery:complete", laterCompleteObserver],
      ] as const;
      for (const [event, laterObserver] of observedEvents) {
        eventBus.on(event, () => {
          throw new Error(`${event} subscriber failed`);
        });
        eventBus.on(event, laterObserver);
      }
      const service = createDeliveryService(makeDeps({
        deliveryQueue: queue,
        eventBus,
        logger,
      }));
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("platform-message-1"));

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({
          platform: { status: "accepted", deliveredChunks: 1 },
          chunks: [{ status: "accepted", messageId: "platform-message-1" }],
        });
      }
      expect(adapter.sendMessage).toHaveBeenCalledOnce();
      expect(laterAckObserver).toHaveBeenCalledOnce();
      expect(laterChunkObserver).toHaveBeenCalledOnce();
      expect(laterCompleteObserver).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "delivery:acked",
          subscriberFailurePhase: "sync",
          subscriberFailureCount: 1,
          firstListenerIndex: 0,
          errorKind: "internal",
          hint: expect.any(String),
        }),
        expect.any(String),
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
        "delivery:acked subscriber failed",
      );
    });

    it("logs a rejected async delivery subscriber without changing the receipt", async () => {
      const eventBus = new TypedEventBus();
      const logger = makeLogger();
      const laterObserver = vi.fn();
      eventBus.on("delivery:complete", async () => {
        await Promise.resolve();
        throw new Error("async completion observer failed");
      });
      eventBus.on("delivery:complete", laterObserver);
      const service = createDeliveryService(makeDeps({ eventBus, logger }));
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("platform-message-async"));

      const result = await deliver(service, adapter, "chat-1", "Hello");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(result.ok).toBe(true);
      expect(laterObserver).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "delivery:complete",
          subscriberFailurePhase: "async",
          subscriberFailureCount: 1,
          firstListenerIndex: 0,
          errorKind: "internal",
          hint: expect.any(String),
        }),
        "Observational event subscriber failed",
      );
    });

    it("contains outbound trajectory-binding failure after a successful send", async () => {
      const credential = `xoxb-${"b".repeat(32)}`;
      const eventBus = new TypedEventBus();
      const logger = makeLogger();
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("platform-message-2"));
      const recordOutboundMessage = vi.fn(() => {
        throw new Error(`trajectory binding failed ${credential}`);
      });
      const replyBoundObserver = vi.fn();
      eventBus.on("delivery:reply_bound", replyBoundObserver);
      const service = createDeliveryService(makeDeps({
        deliveryQueue: createMockDeliveryQueue(),
        eventBus,
        logger,
        recordOutboundMessage,
      }));

      const result = await runWithContext(
        {
          traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          tenantId: "tenant-1",
          userId: "user-1",
          agentId: "agent-1",
          startedAt: 1_000,
        },
        () => deliver(service, adapter, "chat-1", "Hello", { origin: "agent" }),
      );

      expect(result.ok).toBe(true);
      expect(adapter.sendMessage).toHaveBeenCalledOnce();
      expect(recordOutboundMessage).toHaveBeenCalledOnce();
      expect(replyBoundObserver).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "delivery-reply-bind",
          errorKind: "internal",
          hint: expect.any(String),
        }),
        expect.any(String),
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(credential);
    });
  });

  // -------------------------------------------------------------------------
  // Empty text
  // -------------------------------------------------------------------------

  describe("empty text handling", () => {
    let service: DeliveryService;
    beforeEach(() => {
      service = makeDeliveryService();
    });

    it("returns not-attempted for empty text", async () => {
      const adapter = createMockAdapter();
      const result = await deliver(service, adapter, "chat-1", "");

      expect(result).toMatchObject({
        ok: false,
        error: { kind: "delivery_not_attempted", reason: "empty_text" },
      });
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Single chunk delivery
  // -------------------------------------------------------------------------

  describe("single chunk delivery", () => {
    let service: DeliveryService;
    beforeEach(() => {
      service = makeDeliveryService();
    });

    it("delivers short text in a single chunk (telegram)", async () => {
      const adapter = createMockAdapter("telegram");
      const result = await deliver(service, adapter, "chat-1", "Hello **world**");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks).toHaveLength(1);
        expect(result.value.platform).toMatchObject({ status: "accepted", deliveredChunks: 1 });
      }
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("converts markdown to HTML for telegram before sending", async () => {
      const adapter = createMockAdapter("telegram");
      await deliver(service, adapter, "chat-1", "**bold text**");

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      // formatForChannel converts **bold** to <b>bold</b> for telegram
      expect(sentText).toContain("<b>");
      expect(sentText).toContain("bold text");
    });

    it("passes markdown through unchanged for discord", async () => {
      const adapter = createMockAdapter("discord");
      await deliver(service, adapter, "chat-1", "**bold text**");

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      expect(sentText).toContain("**bold text**");
    });

    it("renders mrkdwn for slack via IR pipeline (not passthrough)", async () => {
      const adapter = createMockAdapter("slack");
      await deliver(service, adapter, "chat-1", "**bold text**");

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      // Slack goes through formatForChannel -> IR renderer -> mrkdwn
      // Bold: **bold text** -> *bold text*
      expect(sentText).toContain("*bold text*");
      expect(sentText).not.toContain("**bold text**");
    });
  });

  // -------------------------------------------------------------------------
  // Chunking behavior
  // -------------------------------------------------------------------------

  describe("chunking behavior", () => {
    it("chunks long text at DEFAULT_CHUNK_LIMIT (4000) when no override", async () => {
      const service = makeDeliveryService();
      const adapter = createMockAdapter("telegram");
      const longText = makeLongMarkdown(10000);

      const result = await deliver(service, adapter, "chat-1", longText);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks.length).toBeGreaterThan(1);
        expect(adapter.sendMessage.mock.calls.length).toBeGreaterThan(1);
      }
    });

    it("uses maxCharsOverride when provided in deps", async () => {
      // maxCharsOverride is a DeliveryServiceDeps field (per-instance) — passed to makeDeliveryService.
      const service = makeDeliveryService({ maxCharsOverride: 150 });
      const adapter = createMockAdapter("discord");
      // Use short limit to force chunking on moderate text
      const text = makeLongMarkdown(500);

      const result = await deliver(service, adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks.length).toBeGreaterThan(1);
      }
    });

    it("does not chunk gateway messages", async () => {
      const service = makeDeliveryService();
      const adapter = createMockAdapter("gateway");
      const longText = makeLongMarkdown(10000);

      const result = await deliver(service, adapter, "chat-1", longText);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks).toHaveLength(1);
        expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // SendMessageOptions propagation
  // -------------------------------------------------------------------------

  describe("SendMessageOptions propagation", () => {
    let service: DeliveryService;
    beforeEach(() => {
      // maxCharsOverride per-instance to force multi-chunk in these tests
      service = makeDeliveryService({ maxCharsOverride: 150 });
    });

    it("attaches replyTo only to first chunk", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(500);

      await deliver(service, adapter, "chat-1", text, { replyTo: "msg-99" });

      const calls = adapter.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      // First call should have replyTo
      expect(calls[0][2]?.replyTo).toBe("msg-99");
      // Subsequent calls should NOT have replyTo
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i][2]?.replyTo).toBeUndefined();
      }
    });

    it("attaches threadId to all chunks", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(500);

      await deliver(service, adapter, "chat-1", text, { threadId: "thread-42" });

      const calls = adapter.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        expect(call[2]?.threadId).toBe("thread-42");
      }
    });

    it("attaches extra to all chunks", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(500);

      await deliver(
        service,
        adapter,
        "chat-1",
        text,
        { extra: { custom_field: "value" } },
      );

      const calls = adapter.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        expect(call[2]?.extra?.custom_field).toBe("value");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Retry behavior
  // -------------------------------------------------------------------------

  describe("retry behavior", () => {
    it("retries failed sends when retryEngine provided", async () => {
      const adapter = createMockAdapter("telegram");
      const retryEngine = createMockRetryEngine();
      const service = makeDeliveryService({ retryEngine });

      await deliver(service, adapter, "chat-1", "Hello");

      expect(retryEngine.sendWithRetry).toHaveBeenCalledTimes(1);
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("calls adapter.sendMessage directly without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService();

      await deliver(service, adapter, "chat-1", "Hello");

      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  describe("failure handling", () => {
    it("returns an unknown platform outcome when an unclassified send fails", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("Send failed")));
      const service = makeDeliveryService();

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true); // Result itself is ok (no exception)
      if (result.ok) {
        expect(result.value.platform).toMatchObject({
          status: "unknown",
          failedChunks: 1,
          deliveredChunks: 0,
        });
        expect(result.value.chunks[0]?.status).toBe("unknown");
        expect(result.value.chunks[0].error).toBeInstanceOf(Error);
      }
    });

    it("returns partial result when some chunks fail (first succeeds, second fails)", async () => {
      const adapter = createMockAdapter("discord");
      let callCount = 0;
      adapter.sendMessage.mockImplementation(async (): Promise<Result<string, Error>> => {
        callCount++;
        if (callCount === 1) return ok("msg-1");
        return err(new Error("400 Bad Request: chunk 2 rejected"));
      });
      const service = makeDeliveryService({ maxCharsOverride: 150 });

      const text = makeLongMarkdown(500);
      const result = await deliver(service, adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.platform.status).toBe("partial");
        expect(result.value.platform.deliveredChunks).toBeGreaterThanOrEqual(1);
        if (result.value.platform.status !== "partial") return;
        expect(result.value.platform.failedChunks).toBeGreaterThanOrEqual(1);
        // all-or-abort (default): aborted after first failure, but at least 2 chunks processed
        expect(result.value.chunks.length).toBeGreaterThan(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  describe("event emission", () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let service: DeliveryService;
    beforeEach(() => {
      eventBus = createMockEventBus();
      service = makeDeliveryService({ eventBus });
    });

    it("emits delivery:chunk_sent per chunk when eventBus provided", async () => {
      const adapter = createMockAdapter("telegram");

      await deliver(service, adapter, "chat-1", "Hello");

      const chunkEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:chunk_sent",
      );
      expect(chunkEvents.length).toBe(1);

      const payload = chunkEvents[0][1];
      expect(payload.channelId).toBe("chat-1");
      expect(payload.channelType).toBe("telegram");
      expect(payload.chunkIndex).toBe(0);
      expect(payload.totalChunks).toBe(1);
      expect(payload.status).toBe("accepted");
      expect(typeof payload.charCount).toBe("number");
      expect(typeof payload.timestamp).toBe("number");
    });

    it("emits delivery:complete with totals when eventBus provided", async () => {
      const adapter = createMockAdapter("telegram");

      await deliver(service, adapter, "chat-1", "Hello", { origin: "test" });

      const completeEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvents.length).toBe(1);

      const payload = completeEvents[0][1];
      expect(payload.channelId).toBe("chat-1");
      expect(payload.channelType).toBe("telegram");
      expect(payload.totalChunks).toBe(1);
      expect(payload.deliveredChunks).toBe(1);
      expect(payload.failedChunks).toBe(0);
      expect(typeof payload.totalChars).toBe("number");
      expect(typeof payload.durationMs).toBe("number");
      expect(payload.origin).toBe("test");
      expect(typeof payload.timestamp).toBe("number");
    });

    it("emits chunk_sent per chunk for multi-chunk delivery", async () => {
      const adapter = createMockAdapter("discord");
      // Override service for this test — small chunk limit
      const localService = makeDeliveryService({ eventBus, maxCharsOverride: 150 });
      const text = makeLongMarkdown(500);

      await deliver(localService, adapter, "chat-1", text);

      const chunkEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:chunk_sent",
      );
      expect(chunkEvents.length).toBeGreaterThan(1);

      // Verify chunk indices are sequential
      for (let i = 0; i < chunkEvents.length; i++) {
        expect(chunkEvents[i][1].chunkIndex).toBe(i);
      }
    });

    it("does not emit events when no eventBus provided", async () => {
      // Construct a separate service with no eventBus
      const localService = makeDeliveryService({ eventBus: undefined });
      const adapter = createMockAdapter("telegram");

      // Should not throw
      const result = await deliver(localService, adapter, "chat-1", "Hello");
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Skip options
  // -------------------------------------------------------------------------

  describe("skip options", () => {
    let service: DeliveryService;
    beforeEach(() => {
      service = makeDeliveryService();
    });

    it("respects skipFormat option (no formatForChannel call)", async () => {
      const adapter = createMockAdapter("telegram");
      // Send pre-formatted HTML directly
      const htmlText = "<b>Already formatted</b>";

      await deliver(service, adapter, "chat-1", htmlText, { skipFormat: true });

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      // Should pass through unchanged (not double-format)
      expect(sentText).toBe(htmlText);
    });

    it("respects skipChunking option (sends text as-is even if long)", async () => {
      const adapter = createMockAdapter("telegram");
      const longText = makeText(10000);

      await deliver(service, adapter, "chat-1", longText, {
        skipChunking: true,
        skipFormat: true,
      });

      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      expect(sentText.length).toBe(10000);
    });
  });

  // -------------------------------------------------------------------------
  // Return type
  // -------------------------------------------------------------------------

  describe("return type", () => {
    let service: DeliveryService;
    beforeEach(() => {
      service = makeDeliveryService();
    });

    it("returns Result<DeliveryResult, Error> (ok() wrapper)", async () => {
      const adapter = createMockAdapter("telegram");
      const result = await deliver(service, adapter, "chat-1", "Hello");

      // Result wrapper
      expect(result).toHaveProperty("ok");
      expect(result.ok).toBe(true);

      // DeliveryResult inside
      if (result.ok) {
        expect(result.value).toHaveProperty("platform");
        expect(result.value).toHaveProperty("queueDisposition");
        expect(result.value).toHaveProperty("chunks");
        expect(result.value).toHaveProperty("totalChars");
        expect(Array.isArray(result.value.chunks)).toBe(true);
      }
    });

    it("wraps unexpected errors in err() Result", async () => {
      const adapter = createMockAdapter("telegram");
      // Force an unexpected throw from sendMessage
      adapter.sendMessage.mockImplementation(() => {
        throw new Error("Unexpected crash");
      });

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("Unexpected crash");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Platform-specific chunking paths
  // -------------------------------------------------------------------------

  describe("platform-specific chunking", () => {
    let service: DeliveryService;
    beforeEach(() => {
      service = makeDeliveryService();
    });

    it("uses chunkBlocks for formatted telegram text", async () => {
      const adapter = createMockAdapter("telegram");
      const text = makeLongMarkdown(10000);

      const result = await deliver(service, adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should have chunked the HTML output
        expect(result.value.chunks.length).toBeGreaterThan(1);
      }
    });

    it("uses IR chunker for discord passthrough", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(10000);

      const result = await deliver(service, adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks.length).toBeGreaterThan(1);
        // Discord chunks should still contain markdown
        const firstChunkText = adapter.sendMessage.mock.calls[0][1] as string;
        // Should be raw text (not HTML-converted)
        expect(firstChunkText).not.toContain("<b>");
      }
    });

    it("uses IR chunker for slack passthrough", async () => {
      const adapter = createMockAdapter("slack");
      const text = makeLongMarkdown(10000);

      const result = await deliver(service, adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks.length).toBeGreaterThan(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // ChunkDeliveryResult tracking
  // -------------------------------------------------------------------------

  describe("ChunkDeliveryResult tracking", () => {
    it("tracks messageId on successful send", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("msg-abc-123"));
      const service = makeDeliveryService();

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].messageId).toBe("msg-abc-123");
        expect(result.value.chunks[0]?.status).toBe("accepted");
        expect(result.value.chunks[0].error).toBeUndefined();
      }
    });

    it("tracks error on failed send", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("API error")));
      const service = makeDeliveryService();

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0]?.status).toBe("unknown");
        expect(result.value.chunks[0].messageId).toBeUndefined();
        expect(result.value.chunks[0].error?.message).toBe("API error");
      }
    });

    it("tracks retried flag when retryEngine is used", async () => {
      const adapter = createMockAdapter("telegram");
      const retryEngine = createMockRetryEngine();
      const service = makeDeliveryService({ retryEngine });

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].retried).toBe(true);
      }
    });

    it("tracks retried=false without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService();

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].retried).toBe(false);
      }
    });

    it("reports charCount per chunk", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService();
      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].charCount).toBeGreaterThan(0);
        expect(result.value.totalChars).toBe(result.value.chunks[0].charCount);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Origin tracking
  // -------------------------------------------------------------------------

  describe("origin tracking", () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let service: DeliveryService;
    beforeEach(() => {
      eventBus = createMockEventBus();
      service = makeDeliveryService({ eventBus });
    });

    it("passes origin to delivery:complete event", async () => {
      const adapter = createMockAdapter("telegram");

      await deliver(service, adapter, "chat-1", "Hello", { origin: "announcement" });

      const completeEvent = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvent).toBeDefined();
      expect(completeEvent![1].origin).toBe("announcement");
    });

    it("defaults origin to unknown when not provided", async () => {
      const adapter = createMockAdapter("telegram");

      await deliver(service, adapter, "chat-1", "Hello", {
        completionMode: "deferred_retry",
      });

      const completeEvent = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvent![1].origin).toBe("unknown");
    });
  });

  // -------------------------------------------------------------------------
  // Queue integration
  // -------------------------------------------------------------------------

  describe("queue integration", () => {
    let queue: ReturnType<typeof createMockDeliveryQueue>;
    let eventBus: ReturnType<typeof createMockEventBus>;
    beforeEach(() => {
      queue = createMockDeliveryQueue();
      eventBus = createMockEventBus();
    });

    it("uses explicit delivery authority outside request context", async () => {
      const adapter = createMockAdapter("telegram");
      const service = createDeliveryService({
        ...makeDeps({ deliveryQueue: queue, eventBus }),
      } as DeliveryServiceDeps);

      await deliver(service, adapter, "chat-1", "Hello");

      expect(queue.enqueueInFlight.mock.calls[0]?.[0]).toMatchObject(TEST_DELIVERY_AUTHORITY);
    });

    it("rejects a destination snapshot that does not identify the requested channel", async () => {
      const adapter = createMockAdapter("telegram");
      const service = createDeliveryService(makeDeps({ deliveryQueue: queue, eventBus }));

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello", {
        completionMode: "settled",
        authority: TEST_DELIVERY_AUTHORITY,
        destinationEndpoint: {
          channelType: "telegram",
          channelInstanceId: "test-instance",
          conversationId: "different-chat",
          conversationKind: "direct",
        },
      });

      expect(adapter.sendMessage).toHaveBeenCalledOnce();
      expect(queue.enqueueInFlight).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          name: "DeliveryQueueTransitionError",
          failures: [{ transition: "enqueue_in_flight", deliveryId: null }],
        });
      }
    });

    it("calls enqueueInFlight before send and ack after successful send", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

      await deliver(service, adapter, "chat-1", "Hello", { origin: "test" });

      // enqueueInFlight called once (1 chunk); enqueue (pending insert) NOT called
      expect(queue.enqueueInFlight).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).not.toHaveBeenCalled();
      const enqueueArg = queue.enqueueInFlight.mock.calls[0][0];
      expect(enqueueArg.channelType).toBe("telegram");
      expect(enqueueArg.channelId).toBe("chat-1");
      expect(enqueueArg.origin).toBe("test");
      expect(enqueueArg.maxAttempts).toBe(5);
      expect(typeof enqueueArg.createdAt).toBe("number");
      expect(typeof enqueueArg.scheduledAt).toBe("number");
      expect(typeof enqueueArg.expireAt).toBe("number");

      // ack called once after successful send
      expect(queue.ack).toHaveBeenCalledTimes(1);
      expect(queue.ack).toHaveBeenCalledWith("entry-uuid-1", "msg-id-123");

      // nack and fail not called
      expect(queue.nack).not.toHaveBeenCalled();
      expect(queue.fail).not.toHaveBeenCalled();
    });

    it("persists the resolved agent in the queue authority column instead of options JSON", async () => {
      const adapter = createMockAdapter("telegram");
      // Construct via the SOURCE factory so the SUT reads the SAME source
      // AsyncLocalStorage module the test's runWithContext writes to (the dist-
      // backed makeDeliveryService would observe a different context instance).
      const service = createDeliveryService(makeDeps({ deliveryQueue: queue, eventBus }));

      // The agent's reply is produced INSIDE the agent's request context; the
      // ALS carries the resolved agentId. A NON-"default" agent (mldag) is the
      // common multi-agent case the tenantId fallback mis-attributes.
      await runWithContext(
        {
          traceId: "11111111-1111-4111-8111-111111111111",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      expect(queue.enqueueInFlight).toHaveBeenCalledTimes(1);
      const enqueueArg = queue.enqueueInFlight.mock.calls[0][0];
      const persistedOptions = JSON.parse(enqueueArg.optionsJson) as Record<string, unknown>;
      expect(enqueueArg.agentId).toBe("mldag");
      expect(persistedOptions.agentId).toBeUndefined();
    });

    it("does NOT leak agentId into the SendMessageOptions handed to the channel adapter (persistence-only metadata)", async () => {
      const adapter = createMockAdapter("telegram");
      const service = createDeliveryService(makeDeps({ deliveryQueue: queue, eventBus }));

      await runWithContext(
        {
          traceId: "22222222-2222-4222-8222-222222222222",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      // Structured queue authority must not ride into platform send options.
      const sendOpts = adapter.sendMessage.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
      expect(sendOpts?.agentId).toBeUndefined();
    });

    it("calls fail with permanent_error when send fails permanently", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("Bad Request: chat not found")));
      const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

      await deliver(service, adapter, "chat-1", "Hello", { completionMode: "deferred_retry" });

      expect(queue.fail).toHaveBeenCalledTimes(1);
      expect(queue.fail).toHaveBeenCalledWith(
        "entry-uuid-1",
        EXPLICIT_SEND_REJECTION_ERROR,
      );

      // Verify delivery:failed event emitted with permanent_error reason
      const failedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:failed",
      );
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0][1].reason).toBe("permanent_error");
      expect(failedEvents[0][1].entryId).toBe("entry-uuid-1");

      expect(queue.ack).not.toHaveBeenCalled();
      expect(queue.nack).not.toHaveBeenCalled();
    });

    it("calls fail with retries_exhausted when retryEngine exhausts retries", async () => {
      const adapter = createMockAdapter("telegram");
      const retryEngine = createMockRetryEngine();
      retryEngine.sendWithRetry.mockResolvedValue(err(new Error("429 Too Many Requests")));
      const service = makeDeliveryService({ deliveryQueue: queue, retryEngine, eventBus });

      await deliver(service, adapter, "chat-1", "Hello");

      expect(queue.fail).toHaveBeenCalledTimes(1);
      expect(queue.fail).toHaveBeenCalledWith(
        "entry-uuid-1",
        RETRY_EXHAUSTED_SEND_ERROR,
      );

      // Verify delivery:failed event emitted with retries_exhausted reason
      const failedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:failed",
      );
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0][1].reason).toBe("retries_exhausted");
    });

    it("parks an ambiguous send outcome without retrying when no retry engine is configured", async () => {
      const adapter = createMockAdapter("telegram");
      const credential = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
      adapter.sendMessage.mockResolvedValue(
        err(new Error(`500 Server Error ${credential}`)),
      );
      const service = createDeliveryService(makeDeps({ deliveryQueue: queue, eventBus }));

      await deliver(service, adapter, "chat-1", "Hello");

      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(queue.fail).toHaveBeenCalledWith(
        "entry-uuid-1",
        AMBIGUOUS_SEND_OUTCOME_ERROR,
      );
      expect(queue.nack).not.toHaveBeenCalled();

      const failedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:failed",
      );
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0][1]).toMatchObject({
        error: AMBIGUOUS_SEND_OUTCOME_ERROR,
        reason: "uncertain_outcome",
      });
      expect(JSON.stringify({
        failCalls: queue.fail.mock.calls,
        eventCalls: eventBus.emit.mock.calls,
      })).not.toContain(credential);

      expect(queue.ack).not.toHaveBeenCalled();
    });

    it("nacks an explicit rate-limit rejection for a later safe retry without a retry engine", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("429 Too Many Requests")));
      const service = createDeliveryService(makeDeps({ deliveryQueue: queue, eventBus }));

      await deliver(service, adapter, "chat-1", "Hello", {
        completionMode: "deferred_retry",
      });

      expect(queue.nack).toHaveBeenCalledTimes(1);
      expect(queue.nack).toHaveBeenCalledWith(
        "entry-uuid-1",
        EXPLICIT_SEND_REJECTION_ERROR,
        expect.any(Number),
      );
      expect(queue.fail).not.toHaveBeenCalled();
    });

    it("continues the platform send but reports enqueueInFlight durability failure", async () => {
      const adapter = createMockAdapter("telegram");
      queue.enqueueInFlight.mockResolvedValue(err(new Error("SQLite busy")));
      const service = makeDeliveryService({ deliveryQueue: queue });

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          kind: "queue_transition_failed",
          platformResult: {
            platform: { status: "accepted", deliveredChunks: 1 },
            queueDisposition: "transition_failed",
          },
        });
      }
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

      // ack/nack/fail not called because entryId is null (enqueueInFlight failed)
      expect(queue.ack).not.toHaveBeenCalled();
      expect(queue.nack).not.toHaveBeenCalled();
      expect(queue.fail).not.toHaveBeenCalled();
    });

    it("no-op delivery queue (default): no enqueued/nacked/failed events on happy path, but acked still fires", async () => {
      const adapter = createMockAdapter("telegram");
      // No deliveryQueue override → makeDeliveryService falls back to
      // createNoOpDeliveryQueue. The no-op queue is a real port impl
      // (it returns an entryId from enqueueInFlight and no-ops ack/nack/fail);
      // the pipeline therefore emits delivery:acked on success but no
      // delivery:enqueued/nacked/failed events (the queue itself doesn't emit
      // delivery:enqueued — SqliteDeliveryQueueAdapter is the sole source of
      // that signal, and the no-op variant has nothing persistent to enqueue).
      //
      // deliveryQueue is REQUIRED in DeliveryServiceDeps, so
      // "deliveryQueue absent → zero queue events" has no representable
      // code path. The assertion here: the no-op queue is benign — no
      // failure/retry signals leak through.
      const service = makeDeliveryService({ eventBus });

      const result = await deliver(service, adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);

      // delivery:enqueued, nacked, failed must NOT fire — happy path on no-op queue.
      const negativeEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "delivery:enqueued" ||
          call[0] === "delivery:nacked" ||
          call[0] === "delivery:failed",
      );
      expect(negativeEvents.length).toBe(0);
    });

    it("does not emit delivery:enqueued from this path (adapter is sole source) but still emits delivery:acked", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

      await deliver(service, adapter, "chat-1", "Hello", { origin: "pipeline" });

      // delivery:enqueued is not emitted by the delivery pipeline; the
      // SqliteDeliveryQueueAdapter emits it inside enqueueInFlight (single
      // source of truth). Our mock queue does not emit,
      // so eventBus sees zero delivery:enqueued events.
      const enqueuedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:enqueued",
      );
      expect(enqueuedEvents.length).toBe(0);

      // Check delivery:acked event -- still emitted by the pipeline
      const ackedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:acked",
      );
      expect(ackedEvents.length).toBe(1);
      expect(ackedEvents[0][1].entryId).toBe("entry-uuid-1");
      expect(ackedEvents[0][1].channelId).toBe("chat-1");
      expect(ackedEvents[0][1].channelType).toBe("telegram");
      expect(ackedEvents[0][1].messageId).toBe("msg-id-123");
      expect(typeof ackedEvents[0][1].durationMs).toBe("number");
    });

    // -----------------------------------------------------------------------
    // delivery-queue integration -- enqueueInFlight + no delivery:enqueued
    // -----------------------------------------------------------------------

    describe("delivery-queue integration", () => {
      it("calls enqueueInFlight (not enqueue) for channel-side sends", async () => {
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(ok("msg-1"));
        const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

        await deliver(service, adapter, "chat-1", "Hello", { origin: "test" });

        expect(queue.enqueueInFlight).toHaveBeenCalledTimes(1);
        expect(queue.enqueue).not.toHaveBeenCalled();
      });

      it("does NOT emit delivery:enqueued from the channel-side path (adapter is sole source)", async () => {
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(ok("msg-1"));
        const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

        await deliver(service, adapter, "chat-1", "Hello", { origin: "test" });

        const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c: unknown[]) => c[0] === "delivery:enqueued",
        );
        expect(emitCalls).toHaveLength(0);
      });

      it("captures entryId from enqueueInFlight for downstream ack", async () => {
        queue.enqueueInFlight.mockResolvedValue(ok("entry-42"));
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(ok("platform-msg-1"));
        const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

        await deliver(service, adapter, "chat-1", "Hello", { origin: "test" });

        expect(queue.ack).toHaveBeenCalledWith("entry-42", "platform-msg-1");
      });

      it("reports enqueueInFlight failure without hiding the successful platform send", async () => {
        queue.enqueueInFlight.mockResolvedValue(err(new Error("SQLite busy")));
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(ok("platform-msg-1"));
        const logger = makeLogger();
        const recordOutboundMessage = vi.fn();
        const service = createDeliveryService({
          ...makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage }),
          logger,
        } as DeliveryServiceDeps);

        const result = await runWithContext(
          {
            traceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            tenantId: "default",
            agentId: "agent-a",
            sessionKey: "default:user-a:chat-1",
            startedAt: Date.now(),
            trustLevel: "admin",
          },
          () => deliver(service, adapter, "chat-1", "Hello", { origin: "test" }),
        );

        expect(adapter.sendMessage).toHaveBeenCalledOnce();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toMatchObject({
            name: "DeliveryQueueTransitionError",
            kind: "queue_transition_failed",
            failures: [
              {
                transition: "enqueue_in_flight",
                deliveryId: null,
                errorKind: "dependency",
              },
            ],
            platformResult: {
              platform: { status: "accepted", deliveredChunks: 1 },
              queueDisposition: "transition_failed",
            },
          });
          const retained = result.error as Error & {
            failures?: readonly unknown[];
            platformResult?: { chunks: readonly unknown[] };
          };
          expect(Object.isFrozen(retained.failures)).toBe(true);
          expect(Object.isFrozen(retained.platformResult)).toBe(true);
          expect(Object.isFrozen(retained.platformResult?.chunks)).toBe(true);
        }
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            step: "delivery-queue-transition",
            transition: "enqueue_in_flight",
            deliveryId: null,
            channelType: "telegram",
            err: "SQLite busy",
            errorKind: "dependency",
            hint: expect.stringContaining("delivery queue"),
          }),
          "Delivery queue transition failed",
        );
        const transitionEvents = vi.mocked(eventBus.emit).mock.calls.filter(
          ([event]) => event === "delivery:queue_transition_failed",
        );
        expect(transitionEvents).toHaveLength(1);
        expect(transitionEvents[0]?.[1]).toEqual({
          deliveryId: null,
          transition: "enqueue_in_flight",
          errorKind: "dependency",
          channelId: "chat-1",
          channelType: "telegram",
          timestamp: expect.any(Number),
        });
        expect(JSON.stringify(transitionEvents[0]?.[1])).not.toContain("SQLite busy");
        expect(recordOutboundMessage).toHaveBeenCalledWith("platform-msg-1", expect.objectContaining({
          traceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          agentId: "agent-a",
        }));
      });

      it("reports ack failure without emitting ack while preserving the accurate platform-message binding", async () => {
        queue.ack.mockResolvedValue(err(new Error("ack write failed")));
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(ok("platform-msg-1"));
        const logger = makeLogger();
        const recordOutboundMessage = vi.fn();
        const service = createDeliveryService({
          ...makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage }),
          logger,
        } as DeliveryServiceDeps);

        const result = await runWithContext(
          {
            traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            tenantId: "default",
            agentId: "agent-a",
            sessionKey: "default:user-a:chat-1",
            startedAt: Date.now(),
            trustLevel: "admin",
          },
          () => deliver(service, adapter, "chat-1", "Hello", { origin: "agent" }),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toMatchObject({
            name: "DeliveryQueueTransitionError",
            failures: [
              {
                transition: "ack",
                deliveryId: "entry-uuid-1",
                errorKind: "dependency",
              },
            ],
            platformResult: {
              platform: { status: "accepted", deliveredChunks: 1 },
              queueDisposition: "transition_failed",
            },
          });
        }
        const eventNames = vi.mocked(eventBus.emit).mock.calls.map(([event]) => event);
        expect(eventNames).not.toContain("delivery:acked");
        expect(eventNames).toContain("delivery:reply_bound");
        expect(eventNames).toContain("delivery:queue_transition_failed");
        expect(recordOutboundMessage).toHaveBeenCalledWith("platform-msg-1", expect.objectContaining({
          traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agentId: "agent-a",
        }));
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            transition: "ack",
            deliveryId: "entry-uuid-1",
            errorKind: "dependency",
            hint: expect.stringContaining("delivery queue"),
          }),
          "Delivery queue transition failed",
        );
      });

      it("reports nack failure without emitting a nacked success state", async () => {
        queue.nack.mockResolvedValue(err(new Error("nack write failed")));
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(err(new Error("429 Too Many Requests")));
        const logger = makeLogger();
        const service = createDeliveryService({
          ...makeDeps({ deliveryQueue: queue, eventBus }),
          logger,
        } as DeliveryServiceDeps);

        const result = await deliver(service, adapter, "chat-1", "Hello", {
          completionMode: "deferred_retry",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toMatchObject({
            name: "DeliveryQueueTransitionError",
            failures: [
              {
                transition: "nack",
                deliveryId: "entry-uuid-1",
                errorKind: "dependency",
              },
            ],
            platformResult: {
              platform: { status: "rejected", deliveredChunks: 0, failedChunks: 1 },
              queueDisposition: "transition_failed",
            },
          });
        }
        const eventNames = vi.mocked(eventBus.emit).mock.calls.map(([event]) => event);
        expect(eventNames).not.toContain("delivery:nacked");
        expect(eventNames).toContain("delivery:queue_transition_failed");
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            transition: "nack",
            deliveryId: "entry-uuid-1",
            errorKind: "dependency",
          }),
          "Delivery queue transition failed",
        );
      });

      it("reports fail transition failure without emitting a failed success state", async () => {
        queue.fail.mockResolvedValue(err(new Error("fail write failed")));
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(err(new Error("Bad Request: chat not found")));
        const logger = makeLogger();
        const service = createDeliveryService({
          ...makeDeps({ deliveryQueue: queue, eventBus }),
          logger,
        } as DeliveryServiceDeps);

        const result = await deliver(service, adapter, "chat-1", "Hello");

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toMatchObject({
            name: "DeliveryQueueTransitionError",
            failures: [
              {
                transition: "fail",
                deliveryId: "entry-uuid-1",
                errorKind: "dependency",
              },
            ],
            platformResult: {
              platform: { status: "rejected", deliveredChunks: 0, failedChunks: 1 },
              queueDisposition: "transition_failed",
            },
          });
        }
        const eventNames = vi.mocked(eventBus.emit).mock.calls.map(([event]) => event);
        expect(eventNames).not.toContain("delivery:failed");
        expect(eventNames).toContain("delivery:queue_transition_failed");
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            transition: "fail",
            deliveryId: "entry-uuid-1",
            errorKind: "dependency",
          }),
          "Delivery queue transition failed",
        );
      });

      it("send proceeds even when enqueueInFlight fails (queue failure must not block delivery)", async () => {
        queue.enqueueInFlight.mockResolvedValue(err(new Error("DB locked")));
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(ok("msg-1"));
        const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

        const result = await deliver(service, adapter, "chat-1", "Hello", { origin: "test" });

        expect(adapter.sendMessage).toHaveBeenCalled();
        expect(result.ok).toBe(false);
        // ack must NOT be called because enqueueInFlight failed -- entryId is null.
        expect(queue.ack).not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Outbound → trajectory binding on the DIRECT ack path
  // -------------------------------------------------------------------------
  //
  // The reaction→trajectory binding (recordOutboundMessage) is also wired into
  // the recurring delivery-queue DRAIN (setup-delivery.ts:drainDeliveryQueue).
  // But the PRIMARY inbound-reply path — setup-and-route → executeAndDeliver →
  // execution-deliver → deliveryService.deliverToChannel — sends via THIS direct
  // ack path (enqueue in_flight → adapter.sendMessage → ack). If the direct ack
  // did not bind the minted reply id to the trajectory, a 👍 on a normal agent
  // reply would map-miss (no ReactionTrajectoryMap entry) and reactions would
  // never drive learning on the common path. These tests
  // assert the binding fires HERE, on the direct ack, with the SAME fail-closed
  // scope discipline the drain uses (agentId = the REAL agent, never tenantId;
  // a null traceId/agentId → no binding). Mirrors the queue-integration
  // pattern above: createDeliveryService(makeDeps(...)) from SOURCE so the SUT's
  // tryGetContext() reads the SAME source ALS the test's runWithContext writes.

  describe("outbound → trajectory binding on the direct ack path", () => {
    let queue: ReturnType<typeof createMockDeliveryQueue>;
    let eventBus: ReturnType<typeof createMockEventBus>;
    beforeEach(() => {
      queue = createMockDeliveryQueue();
      eventBus = createMockEventBus();
    });

    it("binds the minted reply messageId → trajectory scope on a successful direct send (the primary reply path)", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("reply-msg-101"));
      const recordOutboundMessage = vi.fn();
      const service = createDeliveryService(
        makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage }),
      );

      // The agent's reply is produced INSIDE the agent's request context; the
      // ALS carries the resolved agentId/traceId/tenantId. This is the common
      // single-user-DM reply the direct-ack bind exists for.
      await runWithContext(
        {
          traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      // The binding MUST fire on the direct ack path (the drain alone never sees
      // a direct-ack reply, so this is where the common path binds).
      expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
      const [boundMessageId, boundScope] = recordOutboundMessage.mock.calls[0];
      // The minted PLATFORM reply id (the same value the ack persisted) is the key.
      expect(boundMessageId).toBe("reply-msg-101");
      // The scope is the REAL agent's partition — never the tenantId-as-agentId.
      expect(boundScope).toMatchObject({
        traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tenantId: "default",
        agentId: "mldag",
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", // session identity falls back to the trajectory id (scope-consistent with the drain)
      });
    });

    it("fail-closed: does NOT bind when there is no request context (null traceId — a pre-executor / non-agent send)", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("reply-msg-202"));
      const recordOutboundMessage = vi.fn();
      const service = createDeliveryService(
        makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage }),
      );

      // No runWithContext → tryGetContext() is undefined → traceId is null. The
      // drain fails closed here (it would mis-attribute to the tenantId), so the
      // direct path must too: record NOTHING rather than bind a bad scope.
      await deliver(service, adapter, "chat-1", "system reply", { origin: "system" });

      expect(recordOutboundMessage).not.toHaveBeenCalled();
    });

    it("fail-closed: does NOT bind on a failed send (no minted messageId to attribute)", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("Bad Request: chat not found")));
      const recordOutboundMessage = vi.fn();
      const service = createDeliveryService(
        makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage }),
      );

      await runWithContext(
        {
          traceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      // The send failed → no platform messageId → nothing to bind (the binding
      // only fires on the successful ack branch, mirroring the drain).
      expect(recordOutboundMessage).not.toHaveBeenCalled();
    });

    it("binds once per chunk's successful ack — the LAST chunk's id is the reply the user reacts to (multi-chunk reply)", async () => {
      // A multi-chunk reply acks each chunk; the binding fires per successful
      // ack so the final chunk's id (the message a reaction targets) is bound.
      let n = 0;
      const adapter = createMockAdapter("discord");
      adapter.sendMessage.mockImplementation(async (): Promise<Result<string, Error>> => ok(`chunk-msg-${n++}`));
      const recordOutboundMessage = vi.fn();
      const service = createDeliveryService(
        makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage, maxCharsOverride: 150 }),
      );

      const text = makeLongMarkdown(500);
      await runWithContext(
        {
          traceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", text, { origin: "agent" });
        },
      );

      // One bind per delivered chunk; every bound id is a minted platform id, and
      // every scope carries the REAL agent (never the tenantId fallback).
      expect(recordOutboundMessage.mock.calls.length).toBe(adapter.sendMessage.mock.calls.length);
      expect(recordOutboundMessage.mock.calls.length).toBeGreaterThan(1);
      for (const [boundMessageId, boundScope] of recordOutboundMessage.mock.calls) {
        expect(boundMessageId).toMatch(/^chunk-msg-\d+$/);
        expect(boundScope.agentId).toBe("mldag");
        expect(boundScope.traceId).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
      }
    });
  });

  // -------------------------------------------------------------------------
  // The primary-path bind must be OBSERVABLE.
  // -------------------------------------------------------------------------
  //
  // The direct-ack bind above is SILENT — recordOutboundMessage is called but
  // nothing on the eventBus proves the bind fired. So when a reaction map-misses,
  // an operator cannot distinguish "bind never fired"
  // from "bound but the trajectory-map entry evicted" in one obs call. The
  // delivery service is logger-free (observability rides the eventBus), so the
  // bind emits a POSITIVE, counts-only `delivery:reply_bound` signal right after
  // the bind, in the SAME fail-closed branch (result.ok && traceId !== null &&
  // agentId !== null). The payload is ids/closed-scalars ONLY — never a body or a
  // secret (redaction discipline): { messageId, channelType,
  // channelId, traceId, agentId, timestamp }.

  describe("delivery:reply_bound observability event on the primary-path bind", () => {
    let queue: ReturnType<typeof createMockDeliveryQueue>;
    let eventBus: ReturnType<typeof createMockEventBus>;
    beforeEach(() => {
      queue = createMockDeliveryQueue();
      eventBus = createMockEventBus();
    });

    function replyBoundEvents(): unknown[][] {
      return (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:reply_bound",
      );
    }

    it("emits delivery:reply_bound (counts/ids only) immediately after a successful primary-path bind", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("reply-msg-301"));
      const recordOutboundMessage = vi.fn();
      const service = createDeliveryService(
        makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage }),
      );

      await runWithContext(
        {
          traceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      // The bind fired AND announced itself on the bus exactly once.
      expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
      const events = replyBoundEvents();
      expect(events.length).toBe(1);
      const payload = events[0]![1] as Record<string, unknown>;
      // Counts/ids/closed-scalars ONLY — correlatable with the delivery:acked
      // event (same messageId) so the attribution is reconstructable.
      expect(payload).toEqual({
        messageId: "reply-msg-301",
        channelType: "telegram",
        channelId: "chat-1",
        traceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        agentId: "mldag",
        timestamp: expect.any(Number),
      });
      // No body / text / secret keys leaked into the payload.
      expect(Object.keys(payload).sort()).toEqual(
        ["agentId", "channelId", "channelType", "messageId", "timestamp", "traceId"].sort(),
      );
    });

    it("fail-closed: does NOT emit delivery:reply_bound when there is no request context (null traceId)", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("reply-msg-302"));
      const recordOutboundMessage = vi.fn();
      const service = createDeliveryService(
        makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage }),
      );

      // No runWithContext → traceId is null → the bind fails closed, so the
      // observability event MUST fail closed too (no false "bind fired" signal).
      await deliver(service, adapter, "chat-1", "system reply", { origin: "system" });

      expect(recordOutboundMessage).not.toHaveBeenCalled();
      expect(replyBoundEvents()).toEqual([]);
    });

    it("fail-closed: does NOT emit delivery:reply_bound on a failed send (no minted messageId to attribute)", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("Bad Request: chat not found")));
      const recordOutboundMessage = vi.fn();
      const service = createDeliveryService(
        makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage }),
      );

      await runWithContext(
        {
          traceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      expect(recordOutboundMessage).not.toHaveBeenCalled();
      expect(replyBoundEvents()).toEqual([]);
    });

    it("byte-identity: does NOT emit delivery:reply_bound when learning is disabled (recordOutboundMessage undefined)", async () => {
      // When learning-outcome is off for every agent the binding callback is
      // undefined → there is nothing to bind and nothing to make observable, so
      // the disabled path stays byte-identical (zero extra event work).
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(ok("reply-msg-303"));
      const service = createDeliveryService(makeDeps({ deliveryQueue: queue, eventBus }));

      await runWithContext(
        {
          traceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      expect(replyBoundEvents()).toEqual([]);
    });

    it("multi-chunk: emits one delivery:reply_bound per bound chunk (parity with recordOutboundMessage)", async () => {
      let n = 0;
      const adapter = createMockAdapter("discord");
      adapter.sendMessage.mockImplementation(async (): Promise<Result<string, Error>> => ok(`chunk-msg-${n++}`));
      const recordOutboundMessage = vi.fn();
      const service = createDeliveryService(
        makeDeps({ deliveryQueue: queue, eventBus, recordOutboundMessage, maxCharsOverride: 150 }),
      );

      const text = makeLongMarkdown(500);
      await runWithContext(
        {
          traceId: "12121212-1212-4121-8121-121212121212",
          tenantId: "default",
          agentId: "mldag",
          sessionKey: "default:user-1:chat-1",
          startedAt: Date.now(),
          trustLevel: "admin",
        },
        async () => {
          await deliver(service, adapter, "chat-1", text, { origin: "agent" });
        },
      );

      const events = replyBoundEvents();
      // One observability event per bind, and the bind count is the delivered-chunk count.
      expect(events.length).toBe(recordOutboundMessage.mock.calls.length);
      expect(events.length).toBeGreaterThan(1);
      for (const ev of events) {
        const payload = ev[1] as Record<string, unknown>;
        expect(payload.channelType).toBe("discord");
        expect(payload.agentId).toBe("mldag");
        expect(payload.traceId).toBe("12121212-1212-4121-8121-121212121212");
        expect(payload.messageId).toMatch(/^chunk-msg-\d+$/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Abort signal
  // -------------------------------------------------------------------------

  describe("abort signal", () => {
    let queue: ReturnType<typeof createMockDeliveryQueue>;
    let eventBus: ReturnType<typeof createMockEventBus>;
    let service: DeliveryService;
    beforeEach(() => {
      queue = createMockDeliveryQueue();
      eventBus = createMockEventBus();
      // maxCharsOverride lives in deps; abortSignal rides on per-call options.
      service = makeDeliveryService({ deliveryQueue: queue, eventBus, maxCharsOverride: 100 });
    });

    it("stops before next chunk when signal is aborted", async () => {
      const abortController = new AbortController();
      const adapter = createMockAdapter("discord");
      let callCount = 0;
      adapter.sendMessage.mockImplementation(async (): Promise<Result<string, Error>> => {
        callCount++;
        // Abort after first successful send
        if (callCount === 1) {
          abortController.abort("User sent /stop");
        }
        return ok(`msg-${callCount}`);
      });

      // Create 3-chunk text with skipFormat + small limit
      const text = "A".repeat(101) + "\n\n" + "B".repeat(101) + "\n\n" + "C".repeat(101);

      await deliver(service, adapter, "chat-1", text, {
        skipFormat: true,
        abortSignal: abortController.signal,
      });

      // Only 1 sendMessage call (aborted before 2nd chunk)
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

      // delivery:aborted event emitted
      const abortedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:aborted",
      );
      expect(abortedEvents.length).toBe(1);
      expect(abortedEvents[0][1].chunksDelivered).toBe(1);
      expect(abortedEvents[0][1].reason).toBe("User sent /stop");
    });

    it("aborted delivery does not emit delivery:complete", async () => {
      const abortController = new AbortController();
      const adapter = createMockAdapter("discord");
      adapter.sendMessage.mockImplementation(async (): Promise<Result<string, Error>> => {
        abortController.abort("stop");
        return ok("msg-1");
      });

      const text = "A".repeat(101) + "\n\n" + "B".repeat(101);

      await deliver(service, adapter, "chat-1", text, {
        skipFormat: true,
        abortSignal: abortController.signal,
      });

      // delivery:complete should NOT be emitted
      const completeEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvents.length).toBe(0);

      // delivery:aborted SHOULD be emitted
      const abortedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:aborted",
      );
      expect(abortedEvents.length).toBe(1);
    });

    it("pre-aborted signal sends zero chunks", async () => {
      const adapter = createMockAdapter("telegram");

      await deliver(service, adapter, "chat-1", "Hello world", {
        abortSignal: AbortSignal.abort("pre-aborted"),
      });

      expect(adapter.sendMessage).not.toHaveBeenCalled();

      // delivery:aborted emitted with chunksDelivered=0
      const abortedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:aborted",
      );
      expect(abortedEvents.length).toBe(1);
      expect(abortedEvents[0][1].chunksDelivered).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Delivery strategy
  // -------------------------------------------------------------------------

  describe("delivery strategy", () => {
    function createMockQueue(): DeliveryQueuePort & {
      enqueue: ReturnType<typeof vi.fn>;
      enqueueInFlight: ReturnType<typeof vi.fn>;
      claim: ReturnType<typeof vi.fn>;
      ack: ReturnType<typeof vi.fn>;
      nack: ReturnType<typeof vi.fn>;
      fail: ReturnType<typeof vi.fn>;
      pendingEntries: ReturnType<typeof vi.fn>;
      pruneExpired: ReturnType<typeof vi.fn>;
      statusCounts: ReturnType<typeof vi.fn>;
      recoverInFlight: ReturnType<typeof vi.fn>;
    } {
      let entryCounter = 0;
      return {
        enqueue: vi.fn().mockImplementation(async () => ok(`entry-${++entryCounter}`)),
        enqueueInFlight: vi.fn().mockImplementation(async () => ok(`entry-${++entryCounter}`)),
        claim: vi.fn().mockResolvedValue(ok(true)),
        ack: vi.fn().mockResolvedValue(ok(undefined)),
        nack: vi.fn().mockResolvedValue(ok(undefined)),
        fail: vi.fn().mockResolvedValue(ok(undefined)),
        pendingEntries: vi.fn().mockResolvedValue(ok([])),
        pruneExpired: vi.fn().mockResolvedValue(ok(0)),
        statusCounts: vi.fn().mockResolvedValue(
          ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 }),
        ),
        recoverInFlight: vi.fn().mockResolvedValue(ok(0)),
      };
    }

    /**
     * Create an adapter where sendMessage fails on specific call indices.
     * callIndex is 0-based (0 = first call, 1 = second call, etc.)
     */
    function createFailingAdapter(failOnCalls: number[]): DeliveryAdapter & { sendMessage: ReturnType<typeof vi.fn> } {
      let callCount = 0;
      return {
        channelType: "discord",
        sendMessage: vi.fn().mockImplementation(async (): Promise<Result<string, Error>> => {
          const idx = callCount++;
          if (failOnCalls.includes(idx)) {
            return err(new Error(`400 Bad Request: chunk ${idx} rejected`));
          }
          return ok(`msg-${idx}`);
        }),
      };
    }

    // Generate text that produces exactly 3 chunks with maxCharsOverride=100 + skipFormat
    // Using simple repeated text ensures IR chunker splits at boundary
    const THREE_CHUNK_TEXT = "A".repeat(101) + "\n\n" + "B".repeat(101) + "\n\n" + "C".repeat(101);

    it("all-or-abort (default): stops after first chunk failure", async () => {
      // Fails on 2nd call (index 1)
      const adapter = createFailingAdapter([1]);
      const service = makeDeliveryService({ maxCharsOverride: 100 });

      const result = await deliver(service, adapter, "chat-1", THREE_CHUNK_TEXT, {
        skipFormat: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should have stopped after 2 calls (1 success + 1 fail), not 3
        expect(adapter.sendMessage.mock.calls.length).toBe(2);
        expect(result.value.platform.deliveredChunks).toBe(1);
        expect(result.value.platform.status).toBe("partial");
        if (result.value.platform.status !== "partial") return;
        expect(result.value.platform.failedChunks).toBe(1);
        // totalChunks in result reflects chunks actually processed, not total planned
        expect(result.value.chunks).toHaveLength(2);
      }
    });

    it("best-effort: continues past failed chunk", async () => {
      // Fails on 2nd call (index 1), succeeds on 1st and 3rd
      const adapter = createFailingAdapter([1]);
      const service = makeDeliveryService({ maxCharsOverride: 100 });

      const result = await deliver(service, adapter, "chat-1", THREE_CHUNK_TEXT, {
        skipFormat: true,
        strategy: "best-effort",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // All 3 chunks should have been attempted
        expect(adapter.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(result.value.platform.deliveredChunks).toBeGreaterThanOrEqual(2);
        expect(result.value.platform.status).toBe("partial");
        if (result.value.platform.status !== "partial") return;
        expect(result.value.platform.failedChunks).toBeGreaterThanOrEqual(1);
      }
    });

    it("best-effort: calls onChunkError for each failure", async () => {
      const adapter = createFailingAdapter([1]);
      const onChunkError = vi.fn();
      const service = makeDeliveryService({ maxCharsOverride: 100 });

      await deliver(service, adapter, "chat-1", THREE_CHUNK_TEXT, {
        skipFormat: true,
        strategy: "best-effort",
        onChunkError,
      });

      expect(onChunkError).toHaveBeenCalledTimes(1);
      const [error, chunkIndex, totalChunks] = onChunkError.mock.calls[0];
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("400 Bad Request: chunk 1 rejected");
      expect(chunkIndex).toBe(1);
      expect(typeof totalChunks).toBe("number");
      expect(totalChunks).toBeGreaterThanOrEqual(3);
    });

    it("best-effort: failed chunks use queue.fail not nack", async () => {
      const adapter = createFailingAdapter([1]);
      const queue = createMockQueue();
      const service = makeDeliveryService({ deliveryQueue: queue, maxCharsOverride: 100 });

      await deliver(service, adapter, "chat-1", THREE_CHUNK_TEXT, {
        skipFormat: true,
        strategy: "best-effort",
      });

      // fail() should have been called for the failed chunk
      expect(queue.fail).toHaveBeenCalled();
      // nack() should NOT have been called (best-effort uses fail, not nack)
      expect(queue.nack).not.toHaveBeenCalled();
    });

    it("delivery:complete event includes strategy field", async () => {
      const adapter = createMockAdapter("discord");
      const eventBus = createMockEventBus();
      const service = makeDeliveryService({ eventBus });

      // Test best-effort strategy
      await deliver(service, adapter, "chat-1", "Hello", {
        strategy: "best-effort",
      });

      const completeEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvents.length).toBe(1);
      expect(completeEvents[0][1].strategy).toBe("best-effort");
    });

    it("delivery:complete event has all-or-abort strategy by default", async () => {
      const adapter = createMockAdapter("discord");
      const eventBus = createMockEventBus();
      const service = makeDeliveryService({ eventBus });

      await deliver(service, adapter, "chat-1", "Hello");

      const completeEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvents.length).toBe(1);
      expect(completeEvents[0][1].strategy).toBe("all-or-abort");
    });
  });

  // -------------------------------------------------------------------------
  // drainInFlight (internal Set ownership)
  // -------------------------------------------------------------------------

  describe("DeliveryService.drainInFlight", () => {
    /**
     * Build a controllable adapter whose sendMessage returns a deferred
     * promise. `resolveAllSends()` settles every pending send with ok().
     * Used to exercise the in-flight tracker via the production
     * `deliverToChannel` surface — no test-only deps injection required.
     */
    function makeServiceWithControllableAdapter() {
      const pending: Array<(v: Result<string, Error>) => void> = [];
      const adapter: DeliveryAdapter = {
        channelType: "telegram",
        sendMessage: vi.fn().mockImplementation(
          () =>
            new Promise<Result<string, Error>>((resolve) => {
              pending.push(resolve);
            }),
        ),
      };
      const service = makeDeliveryService();
      return {
        service,
        adapter,
        resolveAllSends: () => {
          // Settle every pending promise with a successful Result.
          let resolve: ((v: Result<string, Error>) => void) | undefined;
          while ((resolve = pending.shift())) {
            resolve(ok("msg-stub"));
          }
        },
      };
    }

    it("resolves to zero counts when no sends are in flight", async () => {
      const service = makeDeliveryService();
      const result = await service.drainInFlight(5000);
      expect(result).toEqual({ drained: 0, remaining: 0, durationMs: 0 });
    });

    it("drains all in-flight sends when they complete before the deadline", async () => {
      const { service, adapter, resolveAllSends } = makeServiceWithControllableAdapter();
      const p1 = deliver(service, adapter, "chan", "hello 1");
      const p2 = deliver(service, adapter, "chan", "hello 2");

      // Yield microtasks so deliverToChannel reaches the inFlightSends.add(...)
      // line BEFORE we resolve adapter sends.
      await Promise.resolve();
      await Promise.resolve();

      // Resolve the underlying adapter sends; the in-flight Set drains via
      // sendPromise.finally(() => inFlightSends.delete(tracked)).
      resolveAllSends();
      const drainResult = await service.drainInFlight(5000);

      expect(drainResult.drained).toBe(2);
      expect(drainResult.remaining).toBe(0);
      expect(drainResult.durationMs).toBeLessThan(5000);
      // Sanity: the deliveries themselves settle.
      await Promise.all([p1, p2]);
    });

    it("returns remaining > 0 when a hung send exceeds the deadline", async () => {
      const { service, adapter, resolveAllSends } = makeServiceWithControllableAdapter();
      // Start a delivery and do NOT resolve the adapter — the underlying
      // sendMessage promise hangs, so the inFlightSends Set holds onto it.
      const _hung = deliver(service, adapter, "chan", "hung");
      void _hung;
      await Promise.resolve();
      await Promise.resolve();

      const drainResult = await service.drainInFlight(100);
      expect(drainResult.remaining).toBeGreaterThanOrEqual(1);
      // The deadline is 100ms, but `durationMs` is a wall-clock measurement
      // (systemNowMs() delta) of a `setTimeout(100)` race — under full-suite
      // parallel load the event loop is starved and the timer can fire a hair
      // early, measuring 99ms. The invariant we assert is "the drain took
      // ~the deadline" (it raced the timer, not the instant all-settled path),
      // not an exact wall-clock value, so we tolerate scheduler jitter: 100ms
      // ± ~10ms under load. (An exact `>= 100` assertion flakes under
      // full-suite load — do not tighten it back.)
      expect(drainResult.durationMs).toBeGreaterThanOrEqual(90);

      // Cleanup so the hung promise eventually resolves (don't leak).
      resolveAllSends();
    });

    it("permits subsequent deliverToChannel after drainInFlight resolves", async () => {
      const { service, adapter, resolveAllSends } = makeServiceWithControllableAdapter();
      const p1 = deliver(service, adapter, "chan", "first");
      await Promise.resolve();
      await Promise.resolve();
      resolveAllSends();
      await service.drainInFlight(5000);

      // Internal Set must be empty + reusable.
      const p2 = deliver(service, adapter, "chan", "second");
      await Promise.resolve();
      await Promise.resolve();
      resolveAllSends();
      await Promise.all([p1, p2]);

      const final = await service.drainInFlight(5000);
      expect(final.drained).toBe(0);
      expect(final.remaining).toBe(0);
    });

    it("does not create a secondary unhandled rejection when an adapter send rejects", async () => {
      const primary = new Error("adapter transport rejected");
      const adapter = makeAdapter(vi.fn().mockRejectedValue(primary), "telegram");
      const service = createDeliveryService(makeDeps());
      const unhandled: unknown[] = [];
      const captureUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", captureUnhandled);

      try {
        const result = await deliver(service, adapter, "chat-1", "hello");
        expect(result).toEqual(err(primary));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
        expect(await service.drainInFlight(100)).toEqual({
          drained: 0,
          remaining: 0,
          durationMs: 0,
        });
      } finally {
        process.off("unhandledRejection", captureUnhandled);
      }
    });

    it("createDeliveryService rejects an inFlightSends deps field at compile time", () => {
      // Type-level assertion via @ts-expect-error: DeliveryServiceDeps
      // does NOT declare inFlightSends. Tests that try to pass one must
      // fail at compile time. The runtime call still succeeds (extra
      // properties are erased at the structural-type seam), but the
      // @ts-expect-error directive is the load-bearing assertion.
      const deps = {
        hookRunner: makeNoopHookRunner(),
        deliveryQueue: createNoOpDeliveryQueue(),
        logger: makeLogger(),
      };
      const _service = createDeliveryService({
        ...deps,
        // @ts-expect-error — inFlightSends is not a valid DeliveryServiceDeps field
        inFlightSends: new Set<Promise<unknown>>(),
      });
      expect(_service).toBeDefined();
    });
  });
});

// =============================================================================
// Delivery egress scan
// =============================================================================
// These tests assert that deliverToChannel performs one-pass secret scrubbing
// on the assembled deliveryText BEFORE hooks and chunking.

describe("delivery egress scan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts bearer token before Telegram channel adapter receives text", async () => {
    const sendMessage = vi.fn().mockResolvedValue(ok("msg-telegram-1"));
    const adapter = makeAdapter(sendMessage, "telegram");
    const service = createDeliveryService(makeDeps());
    const rawToken = "Bearer hf_" + "a".repeat(44);
    await deliver(service, adapter, "chat-tg", `Here is your token: ${rawToken}`);
    expect(sendMessage).toHaveBeenCalled();
    const sentText: string = sendMessage.mock.calls[0]![1] as string;
    expect(sentText).not.toContain(rawToken);
    expect(sentText).toContain("[REDACTED]");
  });

  it("redacts bearer token before Discord channel adapter receives text", async () => {
    const sendMessage = vi.fn().mockResolvedValue(ok("msg-discord-1"));
    const adapter = makeAdapter(sendMessage, "discord");
    const service = createDeliveryService(makeDeps());
    const rawToken = "Bearer hf_" + "b".repeat(44);
    await deliver(service, adapter, "chat-dc", `Token value: ${rawToken} end`);
    expect(sendMessage).toHaveBeenCalled();
    const sentText: string = sendMessage.mock.calls[0]![1] as string;
    expect(sentText).not.toContain(rawToken);
    expect(sentText).toContain("[REDACTED]");
  });

  it("scan is executed ONCE before the chunk loop, not per-chunk on a large message", async () => {
    // Spy on the module-level scrubSecretsFromText — must be called exactly once
    // (before the chunk loop), not per-chunk.
    const spy = vi.spyOn(secretEgressGuard, "scrubSecretsFromText");
    const service = createDeliveryService(
      makeDeps({ maxCharsOverride: 500 }),
    );
    const adapter = makeAdapter(vi.fn().mockResolvedValue(ok("msg-chunk")), "telegram");
    // 10k chars triggers multiple chunks; scrub must be called only once.
    const longText = "a".repeat(10_000);
    await deliver(service, adapter, "chat-chunk", longText);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("large message (10k chars, no secrets) scrub completes under 5ms (pre-filter path)", async () => {
    // Verifies the cheap mightContainSecret pre-filter path.
    // Measures ONLY the scrubSecretsFromText call itself (not the whole
    // delivery pipeline) — the scrub must be near-zero on secret-free text.
    const longText = "x".repeat(10_000);
    const before = performance.now();
    const result = secretEgressGuard.scrubSecretsFromText(longText);
    const elapsed = performance.now() - before;
    // Secret-free text hits the mightContainSecret pre-filter and returns
    // immediately — must complete in under 5ms even at 10k chars.
    expect(result.redactions).toBe(0);
    expect(elapsed).toBeLessThan(5);
  });
});
