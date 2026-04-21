// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import {
  deliverToChannel,
  resolveChunkLimit,
  computeQueueBackoff,
  QUEUE_BACKOFF_SCHEDULE_MS,
} from "./deliver-to-channel.js";
import type {
  DeliveryAdapter,
  DeliverToChannelOptions,
  DeliverToChannelDeps,
  DeliveryStrategy,
} from "./deliver-to-channel.js";
import type { RetryEngine } from "./retry-engine.js";
import type { DeliveryQueuePort } from "@comis/core";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// resolveChunkLimit
// ---------------------------------------------------------------------------

describe("resolveChunkLimit", () => {
  it("returns maxCharsOverride when provided", () => {
    expect(resolveChunkLimit(2000)).toBe(2000);
  });

  it("returns DEFAULT_CHUNK_LIMIT (4000) when no override", () => {
    expect(resolveChunkLimit()).toBe(4000);
    expect(resolveChunkLimit(undefined)).toBe(4000);
  });

  it("ignores zero or negative override", () => {
    expect(resolveChunkLimit(0)).toBe(4000);
    expect(resolveChunkLimit(-1)).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// deliverToChannel
// ---------------------------------------------------------------------------

describe("deliverToChannel", () => {
  // -------------------------------------------------------------------------
  // Empty text
  // -------------------------------------------------------------------------

  describe("empty text handling", () => {
    it("handles empty text (returns ok with 0 chunks)", async () => {
      const adapter = createMockAdapter();
      const result = await deliverToChannel(adapter, "chat-1", "");

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
    it("delivers short text in a single chunk (telegram)", async () => {
      const adapter = createMockAdapter("telegram");
      const result = await deliverToChannel(adapter, "chat-1", "Hello **world**");

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
      await deliverToChannel(adapter, "chat-1", "**bold text**");

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      // formatForChannel converts **bold** to <b>bold</b> for telegram
      expect(sentText).toContain("<b>");
      expect(sentText).toContain("bold text");
    });

    it("passes markdown through unchanged for discord", async () => {
      const adapter = createMockAdapter("discord");
      await deliverToChannel(adapter, "chat-1", "**bold text**");

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      expect(sentText).toContain("**bold text**");
    });

    it("renders mrkdwn for slack via IR pipeline (not passthrough)", async () => {
      const adapter = createMockAdapter("slack");
      await deliverToChannel(adapter, "chat-1", "**bold text**");

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
      const adapter = createMockAdapter("telegram");
      const longText = makeLongMarkdown(10000);

      const result = await deliverToChannel(adapter, "chat-1", longText);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalChunks).toBeGreaterThan(1);
        expect(adapter.sendMessage.mock.calls.length).toBeGreaterThan(1);
      }
    });

    it("uses maxCharsOverride when provided in deps", async () => {
      const adapter = createMockAdapter("discord");
      // Use short limit to force chunking on moderate text
      const text = makeLongMarkdown(500);

      const result = await deliverToChannel(adapter, "chat-1", text, undefined, {
        maxCharsOverride: 150,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalChunks).toBeGreaterThan(1);
      }
    });

    it("does not chunk gateway messages", async () => {
      const adapter = createMockAdapter("gateway");
      const longText = makeLongMarkdown(10000);

      const result = await deliverToChannel(adapter, "chat-1", longText);

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
    it("attaches replyTo only to first chunk", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(500);

      await deliverToChannel(adapter, "chat-1", text, { replyTo: "msg-99" }, {
        maxCharsOverride: 150,
      });

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

      await deliverToChannel(adapter, "chat-1", text, { threadId: "thread-42" }, {
        maxCharsOverride: 150,
      });

      const calls = adapter.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        expect(call[2]?.threadId).toBe("thread-42");
      }
    });

    it("attaches extra to all chunks", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(500);

      await deliverToChannel(
        adapter,
        "chat-1",
        text,
        { extra: { custom_field: "value" } },
        { maxCharsOverride: 150 },
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

      await deliverToChannel(adapter, "chat-1", "Hello", undefined, {
        retryEngine,
      });

      expect(retryEngine.sendWithRetry).toHaveBeenCalledTimes(1);
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("calls adapter.sendMessage directly without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");

      await deliverToChannel(adapter, "chat-1", "Hello");

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

      const result = await deliverToChannel(adapter, "chat-1", "Hello");

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

      const text = makeLongMarkdown(500);
      const result = await deliverToChannel(adapter, "chat-1", text, undefined, {
        maxCharsOverride: 150,
      });

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
    it("emits delivery:chunk_sent per chunk when eventBus provided", async () => {
      const adapter = createMockAdapter("telegram");
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", undefined, { eventBus });

      const chunkEvents = eventBus.emit.mock.calls.filter(
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
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", { origin: "test" }, { eventBus });

      const completeEvents = eventBus.emit.mock.calls.filter(
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
      const eventBus = createMockEventBus();
      const text = makeLongMarkdown(500);

      await deliverToChannel(adapter, "chat-1", text, undefined, {
        eventBus,
        maxCharsOverride: 150,
      });

      const chunkEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:chunk_sent",
      );
      expect(chunkEvents.length).toBeGreaterThan(1);

      // Verify chunk indices are sequential
      for (let i = 0; i < chunkEvents.length; i++) {
        expect(chunkEvents[i][1].chunkIndex).toBe(i);
      }
    });

    it("does not emit events when no eventBus provided", async () => {
      const adapter = createMockAdapter("telegram");

      // Should not throw
      const result = await deliverToChannel(adapter, "chat-1", "Hello");
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Skip options
  // -------------------------------------------------------------------------

  describe("skip options", () => {
    it("respects skipFormat option (no formatForChannel call)", async () => {
      const adapter = createMockAdapter("telegram");
      // Send pre-formatted HTML directly
      const htmlText = "<b>Already formatted</b>";

      await deliverToChannel(adapter, "chat-1", htmlText, { skipFormat: true });

      const sentText = adapter.sendMessage.mock.calls[0][1] as string;
      // Should pass through unchanged (not double-format)
      expect(sentText).toBe(htmlText);
    });

    it("respects skipChunking option (sends text as-is even if long)", async () => {
      const adapter = createMockAdapter("telegram");
      const longText = makeText(10000);

      await deliverToChannel(adapter, "chat-1", longText, {
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
    it("returns Result<DeliveryResult, Error> (ok() wrapper)", async () => {
      const adapter = createMockAdapter("telegram");
      const result = await deliverToChannel(adapter, "chat-1", "Hello");

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

      const result = await deliverToChannel(adapter, "chat-1", "Hello");

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
    it("uses chunkBlocks for formatted telegram text", async () => {
      const adapter = createMockAdapter("telegram");
      const text = makeLongMarkdown(10000);

      const result = await deliverToChannel(adapter, "chat-1", text);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should have chunked the HTML output
        expect(result.value.totalChunks).toBeGreaterThan(1);
      }
    });

    it("uses IR chunker for discord passthrough", async () => {
      const adapter = createMockAdapter("discord");
      const text = makeLongMarkdown(10000);

      const result = await deliverToChannel(adapter, "chat-1", text);

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

      const result = await deliverToChannel(adapter, "chat-1", text);

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

      const result = await deliverToChannel(adapter, "chat-1", "Hello");

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

      const result = await deliverToChannel(adapter, "chat-1", "Hello");

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

      const result = await deliverToChannel(adapter, "chat-1", "Hello", undefined, {
        retryEngine,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].retried).toBe(true);
      }
    });

    it("tracks retried=false without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");

      const result = await deliverToChannel(adapter, "chat-1", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chunks[0].retried).toBe(false);
      }
    });

    it("reports charCount per chunk", async () => {
      const adapter = createMockAdapter("telegram");
      const result = await deliverToChannel(adapter, "chat-1", "Hello");

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
    it("passes origin to delivery:complete event", async () => {
      const adapter = createMockAdapter("telegram");
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", { origin: "announcement" }, { eventBus });

      const completeEvent = eventBus.emit.mock.calls.find(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvent).toBeDefined();
      expect(completeEvent![1].origin).toBe("announcement");
    });

    it("defaults origin to unknown when not provided", async () => {
      const adapter = createMockAdapter("telegram");
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", undefined, { eventBus });

      const completeEvent = eventBus.emit.mock.calls.find(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvent![1].origin).toBe("unknown");
    });
  });

  // -------------------------------------------------------------------------
  // Queue integration
  // -------------------------------------------------------------------------

  describe("queue integration", () => {
    function createMockDeliveryQueue(): DeliveryQueuePort & {
      enqueue: ReturnType<typeof vi.fn>;
      ack: ReturnType<typeof vi.fn>;
      nack: ReturnType<typeof vi.fn>;
      fail: ReturnType<typeof vi.fn>;
      pendingEntries: ReturnType<typeof vi.fn>;
      pruneExpired: ReturnType<typeof vi.fn>;
      depth: ReturnType<typeof vi.fn>;
    } {
      return {
        enqueue: vi.fn().mockResolvedValue(ok("entry-uuid-1")),
        ack: vi.fn().mockResolvedValue(ok(undefined)),
        nack: vi.fn().mockResolvedValue(ok(undefined)),
        fail: vi.fn().mockResolvedValue(ok(undefined)),
        pendingEntries: vi.fn().mockResolvedValue(ok([])),
        pruneExpired: vi.fn().mockResolvedValue(ok(0)),
        depth: vi.fn().mockResolvedValue(ok(0)),
      };
    }

    it("calls enqueue before send and ack after successful send", async () => {
      const adapter = createMockAdapter("telegram");
      const queue = createMockDeliveryQueue();
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", { origin: "test" }, {
        deliveryQueue: queue,
        eventBus,
      });

      // enqueue called once (1 chunk)
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      const enqueueArg = queue.enqueue.mock.calls[0][0];
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
      const queue = createMockDeliveryQueue();
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", undefined, {
        deliveryQueue: queue,
        eventBus,
      });

      expect(queue.fail).toHaveBeenCalledTimes(1);
      expect(queue.fail).toHaveBeenCalledWith("entry-uuid-1", "Bad Request: chat not found");

      // Verify delivery:failed event emitted with permanent_error reason
      const failedEvents = eventBus.emit.mock.calls.filter(
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
      const queue = createMockDeliveryQueue();
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", undefined, {
        deliveryQueue: queue,
        retryEngine,
        eventBus,
      });

      expect(queue.fail).toHaveBeenCalledTimes(1);
      expect(queue.fail).toHaveBeenCalledWith("entry-uuid-1", "500 Server Error");

      // Verify delivery:failed event emitted with retries_exhausted reason
      const failedEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:failed",
      );
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0][1].reason).toBe("retries_exhausted");
    });

    it("calls nack with backoff when send fails transiently without retryEngine", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendMessage.mockResolvedValue(err(new Error("500 Server Error")));
      const queue = createMockDeliveryQueue();
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", undefined, {
        deliveryQueue: queue,
        eventBus,
      });

      expect(queue.nack).toHaveBeenCalledTimes(1);
      const [entryId, errorMsg, nextRetryAt] = queue.nack.mock.calls[0];
      expect(entryId).toBe("entry-uuid-1");
      expect(errorMsg).toBe("500 Server Error");
      // nextRetryAt should be roughly now + 5000ms (first backoff level)
      expect(nextRetryAt).toBeGreaterThan(Date.now() - 2000);

      // Verify delivery:nacked event emitted
      const nackedEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:nacked",
      );
      expect(nackedEvents.length).toBe(1);
      expect(nackedEvents[0][1].attemptCount).toBe(1);
      expect(typeof nackedEvents[0][1].nextRetryAt).toBe("number");

      expect(queue.ack).not.toHaveBeenCalled();
      expect(queue.fail).not.toHaveBeenCalled();
    });

    it("continues delivery when enqueue fails (graceful degradation)", async () => {
      const adapter = createMockAdapter("telegram");
      const queue = createMockDeliveryQueue();
      queue.enqueue.mockResolvedValue(err(new Error("SQLite busy")));

      const result = await deliverToChannel(adapter, "chat-1", "Hello", undefined, {
        deliveryQueue: queue,
      });

      // Delivery still succeeds even though enqueue failed
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ok).toBe(true);
        expect(result.value.deliveredChunks).toBe(1);
      }
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

      // ack/nack/fail not called because entryId is null (enqueue failed)
      expect(queue.ack).not.toHaveBeenCalled();
      expect(queue.nack).not.toHaveBeenCalled();
      expect(queue.fail).not.toHaveBeenCalled();
    });

    it("performs no queue operations when deliveryQueue not provided (backward compat)", async () => {
      const adapter = createMockAdapter("telegram");
      const eventBus = createMockEventBus();

      const result = await deliverToChannel(adapter, "chat-1", "Hello", undefined, {
        eventBus,
      });

      expect(result.ok).toBe(true);

      // No delivery:enqueued, delivery:acked, delivery:nacked, delivery:failed events
      const queueEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "delivery:enqueued" ||
          call[0] === "delivery:acked" ||
          call[0] === "delivery:nacked" ||
          call[0] === "delivery:failed",
      );
      expect(queueEvents.length).toBe(0);
    });

    it("emits delivery:enqueued and delivery:acked events when queue is active", async () => {
      const adapter = createMockAdapter("telegram");
      const queue = createMockDeliveryQueue();
      const eventBus = createMockEventBus();

      await deliverToChannel(adapter, "chat-1", "Hello", { origin: "pipeline" }, {
        deliveryQueue: queue,
        eventBus,
      });

      // Check delivery:enqueued event
      const enqueuedEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:enqueued",
      );
      expect(enqueuedEvents.length).toBe(1);
      expect(enqueuedEvents[0][1].entryId).toBe("entry-uuid-1");
      expect(enqueuedEvents[0][1].channelId).toBe("chat-1");
      expect(enqueuedEvents[0][1].channelType).toBe("telegram");
      expect(enqueuedEvents[0][1].origin).toBe("pipeline");

      // Check delivery:acked event
      const ackedEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:acked",
      );
      expect(ackedEvents.length).toBe(1);
      expect(ackedEvents[0][1].entryId).toBe("entry-uuid-1");
      expect(ackedEvents[0][1].channelId).toBe("chat-1");
      expect(ackedEvents[0][1].channelType).toBe("telegram");
      expect(ackedEvents[0][1].messageId).toBe("msg-id-123");
      expect(typeof ackedEvents[0][1].durationMs).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // Abort signal
  // -------------------------------------------------------------------------

  describe("abort signal", () => {
    function createMockDeliveryQueue(): DeliveryQueuePort & {
      enqueue: ReturnType<typeof vi.fn>;
      ack: ReturnType<typeof vi.fn>;
      nack: ReturnType<typeof vi.fn>;
      fail: ReturnType<typeof vi.fn>;
      pendingEntries: ReturnType<typeof vi.fn>;
      pruneExpired: ReturnType<typeof vi.fn>;
      depth: ReturnType<typeof vi.fn>;
    } {
      return {
        enqueue: vi.fn().mockResolvedValue(ok("entry-uuid-1")),
        ack: vi.fn().mockResolvedValue(ok(undefined)),
        nack: vi.fn().mockResolvedValue(ok(undefined)),
        fail: vi.fn().mockResolvedValue(ok(undefined)),
        pendingEntries: vi.fn().mockResolvedValue(ok([])),
        pruneExpired: vi.fn().mockResolvedValue(ok(0)),
        depth: vi.fn().mockResolvedValue(ok(0)),
      };
    }

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

      const eventBus = createMockEventBus();
      const queue = createMockDeliveryQueue();

      // Create 3-chunk text with skipFormat + small limit
      const text = "A".repeat(101) + "\n\n" + "B".repeat(101) + "\n\n" + "C".repeat(101);

      await deliverToChannel(adapter, "chat-1", text, {
        skipFormat: true,
      }, {
        eventBus,
        deliveryQueue: queue,
        abortSignal: abortController.signal,
        maxCharsOverride: 100,
      });

      // Only 1 sendMessage call (aborted before 2nd chunk)
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

      // delivery:aborted event emitted
      const abortedEvents = eventBus.emit.mock.calls.filter(
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

      const eventBus = createMockEventBus();
      const queue = createMockDeliveryQueue();

      const text = "A".repeat(101) + "\n\n" + "B".repeat(101);

      await deliverToChannel(adapter, "chat-1", text, {
        skipFormat: true,
      }, {
        eventBus,
        deliveryQueue: queue,
        abortSignal: abortController.signal,
        maxCharsOverride: 100,
      });

      // delivery:complete should NOT be emitted
      const completeEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:complete",
      );
      expect(completeEvents.length).toBe(0);

      // delivery:aborted SHOULD be emitted
      const abortedEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:aborted",
      );
      expect(abortedEvents.length).toBe(1);
    });

    it("pre-aborted signal sends zero chunks", async () => {
      const eventBus = createMockEventBus();
      const adapter = createMockAdapter("telegram");
      const queue = createMockDeliveryQueue();

      await deliverToChannel(adapter, "chat-1", "Hello world", undefined, {
        eventBus,
        deliveryQueue: queue,
        abortSignal: AbortSignal.abort("pre-aborted"),
      });

      expect(adapter.sendMessage).not.toHaveBeenCalled();

      // delivery:aborted emitted with chunksDelivered=0
      const abortedEvents = eventBus.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === "delivery:aborted",
      );
      expect(abortedEvents.length).toBe(1);
      expect(abortedEvents[0][1].chunksDelivered).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// computeQueueBackoff
// ---------------------------------------------------------------------------

describe("computeQueueBackoff", () => {
  it("returns first schedule value for attemptCount=0", () => {
    expect(computeQueueBackoff(0)).toBe(5_000);
  });

  it("returns second schedule value for attemptCount=1", () => {
    expect(computeQueueBackoff(1)).toBe(25_000);
  });

  it("returns third schedule value for attemptCount=2", () => {
    expect(computeQueueBackoff(2)).toBe(120_000);
  });

  it("clamps at last schedule value for high attempt counts", () => {
    expect(computeQueueBackoff(10)).toBe(600_000);
    expect(computeQueueBackoff(100)).toBe(600_000);
  });
});

// ---------------------------------------------------------------------------
// QUEUE_BACKOFF_SCHEDULE_MS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Delivery strategy
// ---------------------------------------------------------------------------

describe("delivery strategy", () => {
  function createMockQueue(): DeliveryQueuePort & {
    enqueue: ReturnType<typeof vi.fn>;
    ack: ReturnType<typeof vi.fn>;
    nack: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    pendingEntries: ReturnType<typeof vi.fn>;
    pruneExpired: ReturnType<typeof vi.fn>;
    depth: ReturnType<typeof vi.fn>;
  } {
    let entryCounter = 0;
    return {
      enqueue: vi.fn().mockImplementation(async () => ok(`entry-${++entryCounter}`)),
      ack: vi.fn().mockResolvedValue(ok(undefined)),
      nack: vi.fn().mockResolvedValue(ok(undefined)),
      fail: vi.fn().mockResolvedValue(ok(undefined)),
      pendingEntries: vi.fn().mockResolvedValue(ok([])),
      pruneExpired: vi.fn().mockResolvedValue(ok(0)),
      depth: vi.fn().mockResolvedValue(ok(0)),
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

    const result = await deliverToChannel(adapter, "chat-1", THREE_CHUNK_TEXT, {
      skipFormat: true,
    }, {
      maxCharsOverride: 100,
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

    const result = await deliverToChannel(adapter, "chat-1", THREE_CHUNK_TEXT, {
      skipFormat: true,
      strategy: "best-effort",
    }, {
      maxCharsOverride: 100,
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

    await deliverToChannel(adapter, "chat-1", THREE_CHUNK_TEXT, {
      skipFormat: true,
      strategy: "best-effort",
      onChunkError,
    }, {
      maxCharsOverride: 100,
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

    await deliverToChannel(adapter, "chat-1", THREE_CHUNK_TEXT, {
      skipFormat: true,
      strategy: "best-effort",
    }, {
      maxCharsOverride: 100,
      deliveryQueue: queue,
    });

    // fail() should have been called for the failed chunk
    expect(queue.fail).toHaveBeenCalled();
    // nack() should NOT have been called (best-effort uses fail, not nack)
    expect(queue.nack).not.toHaveBeenCalled();
  });

  it("delivery:complete event includes strategy field", async () => {
    const adapter = createMockAdapter("discord");
    const eventBus = createMockEventBus();

    // Test best-effort strategy
    await deliverToChannel(adapter, "chat-1", "Hello", {
      strategy: "best-effort",
    }, {
      eventBus,
    });

    const completeEvents = eventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "delivery:complete",
    );
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0][1].strategy).toBe("best-effort");
  });

  it("delivery:complete event has all-or-abort strategy by default", async () => {
    const adapter = createMockAdapter("discord");
    const eventBus = createMockEventBus();

    await deliverToChannel(adapter, "chat-1", "Hello", undefined, {
      eventBus,
    });

    const completeEvents = eventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "delivery:complete",
    );
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0][1].strategy).toBe("all-or-abort");
  });
});

describe("QUEUE_BACKOFF_SCHEDULE_MS", () => {
  it("has 5 entries", () => {
    expect(QUEUE_BACKOFF_SCHEDULE_MS).toHaveLength(5);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(QUEUE_BACKOFF_SCHEDULE_MS)).toBe(true);
  });

  it("values are in ascending order", () => {
    for (let i = 1; i < QUEUE_BACKOFF_SCHEDULE_MS.length; i++) {
      expect(QUEUE_BACKOFF_SCHEDULE_MS[i]).toBeGreaterThanOrEqual(QUEUE_BACKOFF_SCHEDULE_MS[i - 1]);
    }
  });
});
