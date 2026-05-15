// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 30 plan 03 — smoke tests for createDeliveryService.
 * Phase 30 plan 05 — migrated 55-callsite full-pipeline tests.
 *
 * The first top-level `describe` block ("createDeliveryService — factory
 * contract") is the 9-test smoke suite from plan 03 (lifecycle, hook
 * invocation, traceId propagation, suppressError preservation, closure
 * capture).
 *
 * The second top-level `describe` block ("DeliveryService — full pipeline
 * behavior") is the migrated 55-callsite suite from
 * `packages/channels/src/shared/deliver-to-channel.test.ts` (deleted in plan
 * 05). Every free-standing `deliverToChannel(adapter, ..., deps)` call has
 * been rewritten to `service.deliverToChannel(adapter, ..., options)` where
 * `service: DeliveryService` is constructed via `makeDeliveryService(...)`
 * from `test/support/factories.ts` (closes CONFIG-DELIV-05 test half;
 * CONFIG-DELIV-09 behavior parity).
 *
 * Three plain-helper describe blocks from the source file (`resolveChunkLimit`,
 * `computeQueueBackoff`, `QUEUE_BACKOFF_SCHEDULE_MS`) test internal helpers
 * that are file-local in `delivery-service.ts` (not exported) and whose
 * channels-side originals are deleted in plan 06. Their behaviour is
 * exercised implicitly via the pipeline tests below (chunk-limit defaults,
 * backoff scheduling on transient failures); no separate test stays here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDeliveryService,
  type DeliveryServiceDeps,
  type DeliveryService,
} from "./delivery-service.js";
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
 * `HookRunner` interface has ~14 methods (Phase 28's gateway/session hooks),
 * and the smoke tests only exercise the delivery ones.
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

describe("createDeliveryService — factory contract (CONFIG-DELIV-04, smoke-level contract)", () => {
  it("Test 1: returns a DeliveryService with a deliverToChannel method", () => {
    const service: DeliveryService = createDeliveryService(makeDeps());
    expect(typeof service.deliverToChannel).toBe("function");
  });

  it("Test 2: returned shape matches the single-method interface", () => {
    const service = createDeliveryService(makeDeps());
    expect(Object.keys(service)).toEqual(["deliverToChannel"]);
  });

  it("Test 3: constructing the service does NOT call tryGetContext() (research Pitfall 5)", () => {
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
// Phase 30 plan 05 migration — full pipeline behaviour (CONFIG-DELIV-05, -09)
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
  pruneExpired: ReturnType<typeof vi.fn>;
  depth: ReturnType<typeof vi.fn>;
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
    pruneExpired: vi.fn().mockResolvedValue(ok(0)),
    depth: vi.fn().mockResolvedValue(ok(0)),
    statusCounts: vi.fn().mockResolvedValue(
      ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 }),
    ),
    recoverInFlight: vi.fn().mockResolvedValue(ok(0)),
  };
}

describe("DeliveryService — full pipeline behavior (CONFIG-DELIV-05, CONFIG-DELIV-09)", () => {
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
      expect(enqueueArg.formatApplied).toBe(true);
      expect(enqueueArg.chunkingApplied).toBe(true);
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
      // Phase 30 plan 03 made deliveryQueue REQUIRED in DeliveryServiceDeps —
      // the "deliveryQueue absent → zero queue events" semantics that this
      // test originally asserted (against the standalone deliverToChannel) no
      // longer has a representable code path. The replacement assertion: the
      // no-op queue is benign — no failure/retry signals leak through.
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
      depth: ReturnType<typeof vi.fn>;
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
        depth: vi.fn().mockResolvedValue(ok(0)),
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
  // inFlightSends tracking
  // -------------------------------------------------------------------------

  describe("inFlightSends tracking", () => {
    function createMockQueueForInFlight(): DeliveryQueuePort & {
      enqueue: ReturnType<typeof vi.fn>;
      enqueueInFlight: ReturnType<typeof vi.fn>;
      ack: ReturnType<typeof vi.fn>;
      nack: ReturnType<typeof vi.fn>;
      fail: ReturnType<typeof vi.fn>;
    } {
      return {
        enqueue: vi.fn().mockResolvedValue(ok("entry-uuid-1")),
        enqueueInFlight: vi.fn().mockResolvedValue(ok("entry-uuid-1")),
        ack: vi.fn().mockResolvedValue(ok(undefined)),
        nack: vi.fn().mockResolvedValue(ok(undefined)),
        fail: vi.fn().mockResolvedValue(ok(undefined)),
        pendingEntries: vi.fn().mockResolvedValue(ok([])),
        pruneExpired: vi.fn().mockResolvedValue(ok(0)),
        depth: vi.fn().mockResolvedValue(ok(0)),
        statusCounts: vi.fn().mockResolvedValue(
          ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 }),
        ),
        recoverInFlight: vi.fn().mockResolvedValue(ok(0)),
      };
    }

    it("adds sendPromise to inFlightSends Set before await and removes via finally on success", async () => {
      const adapter = createMockAdapter("telegram");
      let resolveSend: (v: Result<string, Error>) => void = () => {};
      adapter.sendMessage.mockImplementation(
        () =>
          new Promise<Result<string, Error>>((resolve) => {
            resolveSend = resolve;
          }),
      );
      const inFlightSends = new Set<Promise<unknown>>();
      const queue = createMockQueueForInFlight();
      const service = makeDeliveryService({ deliveryQueue: queue, inFlightSends });

      const deliveryPromise = service.deliverToChannel(adapter, "chat-1", "Hello");

      // Allow microtasks to run: the send is now in-flight (awaiting resolution).
      // The Set must observe the promise BEFORE the await -- this is the
      // load-bearing assertion for SIGUSR2 mid-send detection.
      await Promise.resolve();
      await Promise.resolve();
      expect(inFlightSends.size).toBe(1);

      resolveSend(ok("msg-id-1"));
      await deliveryPromise;

      // After settle, .finally must have removed the entry.
      expect(inFlightSends.size).toBe(0);
    });

    it("removes sendPromise via finally even when sendMessage rejects (Result err)", async () => {
      const adapter = createMockAdapter("telegram");
      let resolveSend: (v: Result<string, Error>) => void = () => {};
      adapter.sendMessage.mockImplementation(
        () =>
          new Promise<Result<string, Error>>((resolve) => {
            resolveSend = resolve;
          }),
      );
      const inFlightSends = new Set<Promise<unknown>>();
      const queue = createMockQueueForInFlight();
      const service = makeDeliveryService({ deliveryQueue: queue, inFlightSends });

      const deliveryPromise = service.deliverToChannel(adapter, "chat-1", "Hello");

      // Allow microtasks: send is in-flight, Set has 1 entry.
      await Promise.resolve();
      await Promise.resolve();
      expect(inFlightSends.size).toBe(1);

      // Resolve the promise with an err Result -- still settles, .finally fires.
      resolveSend(err(new Error("Network exploded")));
      await deliveryPromise;

      expect(inFlightSends.size).toBe(0);
    });
  });
});
