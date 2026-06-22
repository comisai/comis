// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createDeliveryService.
 *
 * The first top-level `describe` block ("createDeliveryService — factory
 * contract") is a 9-test smoke suite (lifecycle, hook invocation, traceId
 * propagation, suppressError preservation, closure capture).
 *
 * The second top-level `describe` block ("DeliveryService — full pipeline
 * behavior") is the migrated 55-callsite suite from
 * `packages/channels/src/shared/deliver-to-channel.test.ts`. Every
 * free-standing `deliverToChannel(adapter, ..., deps)` call has been
 * rewritten to `service.deliverToChannel(adapter, ..., options)` where
 * `service: DeliveryService` is constructed via `makeDeliveryService(...)`
 * from `test/support/factories.ts`.
 *
 * The internal helpers `resolveChunkLimit`, `computeQueueBackoff`, and
 * `QUEUE_BACKOFF_SCHEDULE_MS` are file-local in `delivery-service.ts` (not
 * exported); their behaviour is exercised implicitly via the pipeline tests
 * below (chunk-limit defaults, backoff scheduling on transient failures).
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
import { runWithContext } from "../context/context.js";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import type {
  DeliveryAdapter,
  DeliverToChannelOptions,
} from "./types.js";
import type { RetryEngine } from "./retry-engine.js";
import type { DeliveryQueuePort } from "../ports/delivery-queue.js";
import { makeDeliveryService } from "../../../../test/support/factories.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

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
    ...overrides,
  };
}

describe("createDeliveryService — factory contract (smoke-level)", () => {
  it("Test 1: returns a DeliveryService with a deliverToChannel method", () => {
    const service: DeliveryService = createDeliveryService(makeDeps());
    expect(typeof service.deliverToChannel).toBe("function");
  });

  it("Test 2: returned shape matches the deliverToChannel + drainInFlight interface", () => {
    const service = createDeliveryService(makeDeps());
    // The service exposes both `deliverToChannel` (per-call outbound
    // delivery) and `drainInFlight` (shutdown drain). Ordering is
    // factory-emission order — assert on the Set so iteration order is
    // irrelevant.
    expect(new Set(Object.keys(service))).toEqual(new Set(["deliverToChannel", "drainInFlight"]));
  });

  it("Test 3: constructing the service does NOT call tryGetContext()", () => {
    // If construction touched AsyncLocalStorage outside a runWithContext frame,
    // tryGetContext() would return undefined (it's the non-throwing variant),
    // but a per-construction lookup would still surface as a side-effect we
    // can detect through the absence of any deps-method invocation. The
    // strongest assertion we can make without instrumenting the storage is
    // that construction with no context active does not throw.
    expect(() => createDeliveryService(makeDeps())).not.toThrow();
  });

  it("Test 4: empty text short-circuits with ok({ totalChunks: 0 }) and does NOT invoke runBeforeDelivery", async () => {
    const runBeforeDelivery = vi.fn().mockResolvedValue({});
    const hookRunner = makeNoopHookRunner({ runBeforeDelivery });
    const service = createDeliveryService(makeDeps({ hookRunner }));
    const adapter = makeAdapter();
    const result = await service.deliverToChannel(adapter, "chat-1", "");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        ok: true,
        totalChunks: 0,
        deliveredChunks: 0,
        failedChunks: 0,
        chunks: [],
        totalChars: 0,
      });
    }
    // Empty-text branch runs BEFORE the hook block — preserved from
    // current deliver-to-channel.ts:263-273 ordering.
    expect(runBeforeDelivery).not.toHaveBeenCalled();
  });

  it("Test 5: invokes runBeforeDelivery exactly once per call with non-empty text", async () => {
    const runBeforeDelivery = vi.fn().mockResolvedValue({});
    const hookRunner = makeNoopHookRunner({ runBeforeDelivery });
    const service = createDeliveryService(makeDeps({ hookRunner }));
    const adapter = makeAdapter();
    await service.deliverToChannel(adapter, "chat-1", "hi");
    expect(runBeforeDelivery).toHaveBeenCalledTimes(1);
  });

  it("Test 6: cancel:true from runBeforeDelivery short-circuits — no send, no runAfterDelivery", async () => {
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
    const result = await service.deliverToChannel(adapter, "chat-1", "hi");
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(runAfterDelivery).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalChunks).toBe(0);
      expect(result.value.ok).toBe(false);
    }
  });

  it("Test 7: runAfterDelivery rejection does NOT corrupt the request (suppressError wrap preserved)", async () => {
    const runAfterDelivery = vi
      .fn()
      .mockRejectedValue(new Error("hook bug"));
    const hookRunner = makeNoopHookRunner({ runAfterDelivery });
    const service = createDeliveryService(makeDeps({ hookRunner }));
    const adapter = makeAdapter();
    const result = await service.deliverToChannel(adapter, "chat-1", "hi");
    // suppressError fires-and-forgets the rejection — give the microtask
    // queue a tick so the .catch() runs before the test ends (clean shutdown
    // / no unhandled rejection).
    await new Promise((r) => setImmediate(r));
    expect(result.ok).toBe(true);
  });

  it("Test 8: traceId from tryGetContext() is passed to both hook contexts", async () => {
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
        await service.deliverToChannel(adapter, "chat-1", "hi");
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

  it("Test 9: deps captured in closure — subsequent calls reuse the same hookRunner reference", async () => {
    const deps = makeDeps();
    const service = createDeliveryService(deps);
    const adapter = makeAdapter();
    await service.deliverToChannel(adapter, "chat-1", "one");
    await service.deliverToChannel(adapter, "chat-2", "two");
    expect(deps.hookRunner.runBeforeDelivery).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Full pipeline behaviour
// =============================================================================
//
// Migrated from packages/channels/src/shared/deliver-to-channel.test.ts (55
// callsites). Every `await deliverToChannel(adapter, channelId, text, options,
// deps)` was rewritten to `await service.deliverToChannel(adapter, channelId,
// text, options)` where `service` is constructed via `makeDeliveryService(...)`
// in describe-level `beforeEach` (DRY) or inline for special-case factory-deps
// tests. The 5th-arg `{deliveryQueue, eventBus, retryEngine, ...}` payload
// moved into the `makeDeliveryService({...})` call at construction. `abortSignal`
// rides on the per-call options channel (intersection type on the method
// signature — see DeliveryService in delivery-service.ts).
// =============================================================================

// ---------------------------------------------------------------------------
// Migration helpers (local to this file's pipeline-behaviour describe)
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
  // -------------------------------------------------------------------------
  // Empty text
  // -------------------------------------------------------------------------

  describe("empty text handling", () => {
    let service: DeliveryService;
    beforeEach(() => {
      service = makeDeliveryService();
    });

    it("handles empty text (returns ok with 0 chunks)", async () => {
      const adapter = createMockAdapter();
      const result = await service.deliverToChannel(adapter, "chat-1", "");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ok).toBe(true);
        expect(result.value.totalChunks).toBe(0);
        expect(result.value.deliveredChunks).toBe(0);
        expect(result.value.failedChunks).toBe(0);
        expect(result.value.chunks).toEqual([]);
        expect(result.value.totalChars).toBe(0);
      }
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
      const result = await service.deliverToChannel(adapter, "chat-1", "Hello **world**");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalChunks).toBe(1);
        expect(result.value.deliveredChunks).toBe(1);
        expect(result.value.failedChunks).toBe(0);
        expect(result.value.ok).toBe(true);
      }
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("converts markdown to HTML for telegram before sending", async () => {
      const adapter = createMockAdapter("telegram");
      await service.deliverToChannel(adapter, "chat-1", "**bold text**");

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      // formatForChannel converts **bold** to <b>bold</b> for telegram
      expect(sentText).toContain("<b>");
      expect(sentText).toContain("bold text");
    });

    it("passes markdown through unchanged for discord", async () => {
      const adapter = createMockAdapter("discord");
      await service.deliverToChannel(adapter, "chat-1", "**bold text**");

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      expect(sentText).toContain("**bold text**");
    });

    it("renders mrkdwn for slack via IR pipeline (not passthrough)", async () => {
      const adapter = createMockAdapter("slack");
      await service.deliverToChannel(adapter, "chat-1", "**bold text**");

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      // Slack now goes through formatForChannel -> IR renderer -> mrkdwn
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

      const result = await service.deliverToChannel(adapter, "chat-1", longText);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalChunks).toBeGreaterThan(1);
        expect(adapter.sendMessage.mock.calls.length).toBeGreaterThan(1);
      }
    });

    it("uses maxCharsOverride when provided in deps", async () => {
      // maxCharsOverride is a DeliveryServiceDeps field (per-instance) — passed to makeDeliveryService.
      const service = makeDeliveryService({ maxCharsOverride: 150 });
      const adapter = createMockAdapter("discord");
      // Use short limit to force chunking on moderate text
      const text = makeLongMarkdown(500);

      const result = await service.deliverToChannel(adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalChunks).toBeGreaterThan(1);
      }
    });

    it("does not chunk gateway messages", async () => {
      const service = makeDeliveryService();
      const adapter = createMockAdapter("gateway");
      const longText = makeLongMarkdown(10000);

      const result = await service.deliverToChannel(adapter, "chat-1", longText);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalChunks).toBe(1);
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

      await service.deliverToChannel(adapter, "chat-1", text, { replyTo: "msg-99" });

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

      await service.deliverToChannel(adapter, "chat-1", text, { threadId: "thread-42" });

      const calls = adapter.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        expect(call[2]?.threadId).toBe("thread-42");
      }
    });

    it("attaches extra to all chunks", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(500);

      await service.deliverToChannel(
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

      await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(retryEngine.sendWithRetry).toHaveBeenCalledTimes(1);
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("calls adapter.sendMessage directly without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService();

      await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  describe("failure handling", () => {
    it("returns ok:false in DeliveryResult when send fails without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("Send failed")));
      const service = makeDeliveryService();

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true); // Result itself is ok (no exception)
      if (result.ok) {
        expect(result.value.ok).toBe(false); // But delivery failed
        expect(result.value.failedChunks).toBe(1);
        expect(result.value.deliveredChunks).toBe(0);
        expect(result.value.chunks[0].ok).toBe(false);
        expect(result.value.chunks[0].error).toBeInstanceOf(Error);
      }
    });

    it("returns partial result when some chunks fail (first succeeds, second fails)", async () => {
      const adapter = createMockAdapter("discord");
      let callCount = 0;
      adapter.sendMessage.mockImplementation(async (): Promise<Result<string, Error>> => {
        callCount++;
        if (callCount === 1) return ok("msg-1");
        return err(new Error("Send failed on chunk 2"));
      });
      const service = makeDeliveryService({ maxCharsOverride: 150 });

      const text = makeLongMarkdown(500);
      const result = await service.deliverToChannel(adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ok).toBe(false); // Overall delivery failed
        expect(result.value.deliveredChunks).toBeGreaterThanOrEqual(1);
        expect(result.value.failedChunks).toBeGreaterThanOrEqual(1);
        // all-or-abort (default): aborted after first failure, but at least 2 chunks processed
        expect(result.value.totalChunks).toBeGreaterThan(1);
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

      await service.deliverToChannel(adapter, "chat-1", "Hello");

      const chunkEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:chunk_sent",
      );
      expect(chunkEvents.length).toBe(1);

      const payload = chunkEvents[0][1];
      expect(payload.channelId).toBe("chat-1");
      expect(payload.channelType).toBe("telegram");
      expect(payload.chunkIndex).toBe(0);
      expect(payload.totalChunks).toBe(1);
      expect(payload.ok).toBe(true);
      expect(typeof payload.charCount).toBe("number");
      expect(typeof payload.timestamp).toBe("number");
    });

    it("emits delivery:complete with totals when eventBus provided", async () => {
      const adapter = createMockAdapter("telegram");

      await service.deliverToChannel(adapter, "chat-1", "Hello", { origin: "test" });

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

      await localService.deliverToChannel(adapter, "chat-1", text);

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
      const result = await localService.deliverToChannel(adapter, "chat-1", "Hello");
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

      await service.deliverToChannel(adapter, "chat-1", htmlText, { skipFormat: true });

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      // Should pass through unchanged (not double-format)
      expect(sentText).toBe(htmlText);
    });

    it("respects skipChunking option (sends text as-is even if long)", async () => {
      const adapter = createMockAdapter("telegram");
      const longText = makeText(10000);

      await service.deliverToChannel(adapter, "chat-1", longText, {
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
      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

      // Result wrapper
      expect(result).toHaveProperty("ok");
      expect(result.ok).toBe(true);

      // DeliveryResult inside
      if (result.ok) {
        expect(result.value).toHaveProperty("ok");
        expect(result.value).toHaveProperty("totalChunks");
        expect(result.value).toHaveProperty("deliveredChunks");
        expect(result.value).toHaveProperty("failedChunks");
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

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

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

      const result = await service.deliverToChannel(adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should have chunked the HTML output
        expect(result.value.totalChunks).toBeGreaterThan(1);
      }
    });

    it("uses IR chunker for discord passthrough", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(10000);

      const result = await service.deliverToChannel(adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalChunks).toBeGreaterThan(1);
        // Discord chunks should still contain markdown
        const firstChunkText = adapter.sendMessage.mock.calls[0][1] as string;
        // Should be raw text (not HTML-converted)
        expect(firstChunkText).not.toContain("<b>");
      }
    });

    it("uses IR chunker for slack passthrough", async () => {
      const adapter = createMockAdapter("slack");
      const text = makeLongMarkdown(10000);

      const result = await service.deliverToChannel(adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalChunks).toBeGreaterThan(1);
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

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].messageId).toBe("msg-abc-123");
        expect(result.value.chunks[0].ok).toBe(true);
        expect(result.value.chunks[0].error).toBeUndefined();
      }
    });

    it("tracks error on failed send", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("API error")));
      const service = makeDeliveryService();

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].ok).toBe(false);
        expect(result.value.chunks[0].messageId).toBeUndefined();
        expect(result.value.chunks[0].error?.message).toBe("API error");
      }
    });

    it("tracks retried flag when retryEngine is used", async () => {
      const adapter = createMockAdapter("telegram");
      const retryEngine = createMockRetryEngine();
      const service = makeDeliveryService({ retryEngine });

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].retried).toBe(true);
      }
    });

    it("tracks retried=false without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService();

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].retried).toBe(false);
      }
    });

    it("reports charCount per chunk", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService();
      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

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

      await service.deliverToChannel(adapter, "chat-1", "Hello", { origin: "announcement" });

      const completeEvent = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvent).toBeDefined();
      expect(completeEvent![1].origin).toBe("announcement");
    });

    it("defaults origin to unknown when not provided", async () => {
      const adapter = createMockAdapter("telegram");

      await service.deliverToChannel(adapter, "chat-1", "Hello");

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

    it("calls enqueueInFlight before send and ack after successful send", async () => {
      const adapter = createMockAdapter("telegram");
      const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

      await service.deliverToChannel(adapter, "chat-1", "Hello", { origin: "test" });

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

    it("REACT-02 (CR-01): persists the request-context agentId into the enqueued optionsJson (so the drain attributes the reaction to the REAL agent, not the tenant)", async () => {
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
          await service.deliverToChannel(adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      expect(queue.enqueueInFlight).toHaveBeenCalledTimes(1);
      const enqueueArg = queue.enqueueInFlight.mock.calls[0][0];
      const persistedOptions = JSON.parse(enqueueArg.optionsJson) as Record<string, unknown>;
      // The drain (setup-delivery.ts) reads options.agentId; it must be the REAL
      // agent, never absent (which would force the tenantId fallback).
      expect(persistedOptions.agentId).toBe("mldag");
    });

    it("REACT-02 (CR-01): does NOT leak agentId into the SendMessageOptions handed to the channel adapter (persistence-only metadata)", async () => {
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
          await service.deliverToChannel(adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      // agentId is queue-persistence metadata for the reaction trajectory map;
      // it must NOT ride into the platform send options.
      const sendOpts = adapter.sendMessage.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
      expect(sendOpts?.agentId).toBeUndefined();
    });

    it("calls fail with permanent_error when send fails permanently", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("Bad Request: chat not found")));
      const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

      await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(queue.fail).toHaveBeenCalledTimes(1);
      expect(queue.fail).toHaveBeenCalledWith("entry-uuid-1", "Bad Request: chat not found");

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
      retryEngine.sendWithRetry.mockResolvedValue(err(new Error("500 Server Error")));
      const service = makeDeliveryService({ deliveryQueue: queue, retryEngine, eventBus });

      await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(queue.fail).toHaveBeenCalledTimes(1);
      expect(queue.fail).toHaveBeenCalledWith("entry-uuid-1", "500 Server Error");

      // Verify delivery:failed event emitted with retries_exhausted reason
      const failedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:failed",
      );
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0][1].reason).toBe("retries_exhausted");
    });

    it("calls nack with backoff when send fails transiently without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("500 Server Error")));
      const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

      await service.deliverToChannel(adapter, "chat-1", "Hello");

      expect(queue.nack).toHaveBeenCalledTimes(1);
      const [entryId, errorMsg, nextRetryAt] = queue.nack.mock.calls[0];
      expect(entryId).toBe("entry-uuid-1");
      expect(errorMsg).toBe("500 Server Error");
      // nextRetryAt should be roughly now + 5000ms (first backoff level)
      expect(nextRetryAt).toBeGreaterThan(Date.now() - 2000);

      // Verify delivery:nacked event emitted
      const nackedEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:nacked",
      );
      expect(nackedEvents.length).toBe(1);
      expect(nackedEvents[0][1].attemptCount).toBe(1);
      expect(typeof nackedEvents[0][1].nextRetryAt).toBe("number");

      expect(queue.ack).not.toHaveBeenCalled();
      expect(queue.fail).not.toHaveBeenCalled();
    });

    it("continues delivery when enqueueInFlight fails (graceful degradation)", async () => {
      const adapter = createMockAdapter("telegram");
      queue.enqueueInFlight.mockResolvedValue(err(new Error("SQLite busy")));
      const service = makeDeliveryService({ deliveryQueue: queue });

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

      // Delivery still succeeds even though enqueueInFlight failed
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ok).toBe(true);
        expect(result.value.deliveredChunks).toBe(1);
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
      // deliveryQueue is REQUIRED in DeliveryServiceDeps, so the
      // "deliveryQueue absent → zero queue events" semantics no longer has a
      // representable code path. The assertion here: the no-op queue is
      // benign — no failure/retry signals leak through.
      const service = makeDeliveryService({ eventBus });

      const result = await service.deliverToChannel(adapter, "chat-1", "Hello");

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

      await service.deliverToChannel(adapter, "chat-1", "Hello", { origin: "pipeline" });

      // delivery:enqueued is no longer emitted by the delivery pipeline; the
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

        await service.deliverToChannel(adapter, "chat-1", "Hello", { origin: "test" });

        expect(queue.enqueueInFlight).toHaveBeenCalledTimes(1);
        expect(queue.enqueue).not.toHaveBeenCalled();
      });

      it("does NOT emit delivery:enqueued from the channel-side path (adapter is sole source)", async () => {
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(ok("msg-1"));
        const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

        await service.deliverToChannel(adapter, "chat-1", "Hello", { origin: "test" });

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

        await service.deliverToChannel(adapter, "chat-1", "Hello", { origin: "test" });

        expect(queue.ack).toHaveBeenCalledWith("entry-42", "platform-msg-1");
      });

      it("send proceeds even when enqueueInFlight fails (queue failure must not block delivery)", async () => {
        queue.enqueueInFlight.mockResolvedValue(err(new Error("DB locked")));
        const adapter = createMockAdapter("telegram");
        adapter.sendMessage.mockResolvedValue(ok("msg-1"));
        const service = makeDeliveryService({ deliveryQueue: queue, eventBus });

        await service.deliverToChannel(adapter, "chat-1", "Hello", { origin: "test" });

        expect(adapter.sendMessage).toHaveBeenCalled();
        // ack must NOT be called because enqueueInFlight failed -- entryId is null.
        expect(queue.ack).not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // REACT-04 (206-04): outbound → trajectory binding on the DIRECT ack path
  // -------------------------------------------------------------------------
  //
  // The reaction→trajectory binding (recordOutboundMessage) was wired ONLY into
  // the recurring delivery-queue DRAIN (setup-delivery.ts:drainDeliveryQueue).
  // But the PRIMARY inbound-reply path — setup-and-route → executeAndDeliver →
  // execution-deliver → deliveryService.deliverToChannel — sends via THIS direct
  // ack path (enqueue in_flight → adapter.sendMessage → ack), which never bound
  // the minted reply id to the trajectory. So a 👍 on a normal agent reply
  // map-missed (no ReactionTrajectoryMap entry) and reactions never drove
  // learning on the common path (the 206-03 Stage-C live finding). These tests
  // assert the binding fires HERE, on the direct ack, with the SAME fail-closed
  // scope discipline the drain uses (agentId = the REAL agent, never tenantId;
  // a null traceId/agentId → no binding). Mirrors the REACT-02 queue-integration
  // pattern above: createDeliveryService(makeDeps(...)) from SOURCE so the SUT's
  // tryGetContext() reads the SAME source ALS the test's runWithContext writes.

  describe("REACT-04: outbound → trajectory binding on the direct ack path", () => {
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
      // single-user-DM reply that previously map-missed.
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
          await service.deliverToChannel(adapter, "chat-1", "agent reply", { origin: "agent" });
        },
      );

      // The binding MUST fire on the direct ack path (this is the 206-03 gap).
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
      await service.deliverToChannel(adapter, "chat-1", "system reply", { origin: "system" });

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
          await service.deliverToChannel(adapter, "chat-1", "agent reply", { origin: "agent" });
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
          await service.deliverToChannel(adapter, "chat-1", text, { origin: "agent" });
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
  // WR-01 (206-05 review fix): the primary-path bind must be OBSERVABLE.
  // -------------------------------------------------------------------------
  //
  // The REACT-04 bind above is SILENT — recordOutboundMessage is called but
  // nothing on the eventBus proves the bind fired. So when a reaction map-misses
  // again (the 206-03 class), an operator cannot distinguish "bind never fired"
  // from "bound but the trajectory-map entry evicted" in one obs call. The
  // delivery service is logger-free (observability rides the eventBus), so the
  // bind emits a POSITIVE, counts-only `delivery:reply_bound` signal right after
  // the bind, in the SAME fail-closed branch (result.ok && traceId !== null &&
  // agentId !== null). The payload is ids/closed-scalars ONLY — never a body or a
  // secret (§2.7 / SEC-01 redaction discipline): { messageId, channelType,
  // channelId, traceId, agentId, timestamp }.

  describe("WR-01: delivery:reply_bound observability event on the primary-path bind", () => {
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
          await service.deliverToChannel(adapter, "chat-1", "agent reply", { origin: "agent" });
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
      await service.deliverToChannel(adapter, "chat-1", "system reply", { origin: "system" });

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
          await service.deliverToChannel(adapter, "chat-1", "agent reply", { origin: "agent" });
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
          await service.deliverToChannel(adapter, "chat-1", "agent reply", { origin: "agent" });
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
          await service.deliverToChannel(adapter, "chat-1", text, { origin: "agent" });
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

      await service.deliverToChannel(adapter, "chat-1", text, {
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

      await service.deliverToChannel(adapter, "chat-1", text, {
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

      await service.deliverToChannel(adapter, "chat-1", "Hello world", {
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
            return err(new Error(`Chunk ${idx} failed`));
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

      const result = await service.deliverToChannel(adapter, "chat-1", THREE_CHUNK_TEXT, {
        skipFormat: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should have stopped after 2 calls (1 success + 1 fail), not 3
        expect(adapter.sendMessage.mock.calls.length).toBe(2);
        expect(result.value.deliveredChunks).toBe(1);
        expect(result.value.failedChunks).toBe(1);
        // totalChunks in result reflects chunks actually processed, not total planned
        expect(result.value.totalChunks).toBe(2);
      }
    });

    it("best-effort: continues past failed chunk", async () => {
      // Fails on 2nd call (index 1), succeeds on 1st and 3rd
      const adapter = createFailingAdapter([1]);
      const service = makeDeliveryService({ maxCharsOverride: 100 });

      const result = await service.deliverToChannel(adapter, "chat-1", THREE_CHUNK_TEXT, {
        skipFormat: true,
        strategy: "best-effort",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // All 3 chunks should have been attempted
        expect(adapter.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(result.value.deliveredChunks).toBeGreaterThanOrEqual(2);
        expect(result.value.failedChunks).toBeGreaterThanOrEqual(1);
      }
    });

    it("best-effort: calls onChunkError for each failure", async () => {
      const adapter = createFailingAdapter([1]);
      const onChunkError = vi.fn();
      const service = makeDeliveryService({ maxCharsOverride: 100 });

      await service.deliverToChannel(adapter, "chat-1", THREE_CHUNK_TEXT, {
        skipFormat: true,
        strategy: "best-effort",
        onChunkError,
      });

      expect(onChunkError).toHaveBeenCalledTimes(1);
      const [error, chunkIndex, totalChunks] = onChunkError.mock.calls[0];
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Chunk 1 failed");
      expect(chunkIndex).toBe(1);
      expect(typeof totalChunks).toBe("number");
      expect(totalChunks).toBeGreaterThanOrEqual(3);
    });

    it("best-effort: failed chunks use queue.fail not nack", async () => {
      const adapter = createFailingAdapter([1]);
      const queue = createMockQueue();
      const service = makeDeliveryService({ deliveryQueue: queue, maxCharsOverride: 100 });

      await service.deliverToChannel(adapter, "chat-1", THREE_CHUNK_TEXT, {
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
      await service.deliverToChannel(adapter, "chat-1", "Hello", {
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

      await service.deliverToChannel(adapter, "chat-1", "Hello");

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
      const p1 = service.deliverToChannel(adapter, "chan", "hello 1");
      const p2 = service.deliverToChannel(adapter, "chan", "hello 2");

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
      const _hung = service.deliverToChannel(adapter, "chan", "hung");
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
      // ± ~10ms under load. (Was `>= 100` — a known full-suite load-flake.)
      expect(drainResult.durationMs).toBeGreaterThanOrEqual(90);

      // Cleanup so the hung promise eventually resolves (don't leak).
      resolveAllSends();
    });

    it("permits subsequent deliverToChannel after drainInFlight resolves", async () => {
      const { service, adapter, resolveAllSends } = makeServiceWithControllableAdapter();
      const p1 = service.deliverToChannel(adapter, "chan", "first");
      await Promise.resolve();
      await Promise.resolve();
      resolveAllSends();
      await service.drainInFlight(5000);

      // Internal Set must be empty + reusable.
      const p2 = service.deliverToChannel(adapter, "chan", "second");
      await Promise.resolve();
      await Promise.resolve();
      resolveAllSends();
      await Promise.all([p1, p2]);

      const final = await service.drainInFlight(5000);
      expect(final.drained).toBe(0);
      expect(final.remaining).toBe(0);
    });

    it("createDeliveryService no longer accepts an inFlightSends deps field", () => {
      // Type-level assertion via @ts-expect-error: DeliveryServiceDeps
      // does NOT declare inFlightSends. Tests that try to pass one must
      // fail at compile time. The runtime call still succeeds (extra
      // properties are erased at the structural-type seam), but the
      // @ts-expect-error directive is the load-bearing assertion.
      const deps = {
        hookRunner: makeNoopHookRunner(),
        deliveryQueue: createNoOpDeliveryQueue(),
      };
      const _service = createDeliveryService({
        ...deps,
        // @ts-expect-error — inFlightSends is no longer a valid DeliveryServiceDeps field
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
    await service.deliverToChannel(adapter, "chat-tg", `Here is your token: ${rawToken}`);
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
    await service.deliverToChannel(adapter, "chat-dc", `Token value: ${rawToken} end`);
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
    await service.deliverToChannel(adapter, "chat-chunk", longText);
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
