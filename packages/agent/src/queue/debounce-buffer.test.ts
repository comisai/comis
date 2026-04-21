// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createDebounceBuffer } from "./debounce-buffer.js";
import type { DebounceBuffer } from "./debounce-buffer.js";
import type { NormalizedMessage, SessionKey, TypedEventBus, DebounceBufferConfig } from "@comis/core";

/** Typed flush callback signature for the debounce buffer. */
type FlushCallback = (sessionKey: SessionKey, messages: NormalizedMessage[], channelType: string) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionKey(userId = "u1", channelId = "c1"): SessionKey {
  return { tenantId: "default", userId, channelId };
}

function makeMessage(text: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: crypto.randomUUID(),
    channelId: "c1",
    channelType: "telegram",
    senderId: "u1",
    text,
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as TypedEventBus;
}

function makeConfig(overrides: Partial<DebounceBufferConfig> = {}): DebounceBufferConfig {
  return {
    windowMs: 500,
    maxBufferedMessages: 10,
    firstMessageImmediate: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDebounceBuffer", () => {
  let buffer: DebounceBuffer;
  let eventBus: TypedEventBus;
  let flushSpy: Mock<FlushCallback>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = makeEventBus();
    flushSpy = vi.fn<FlushCallback>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Flushes single message after window expires
  it("flushes single message after window expires", () => {
    const config = makeConfig({ firstMessageImmediate: false });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();
    const msg = makeMessage("hello");
    buffer.push(sk, msg, "telegram");

    expect(flushSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(flushSpy).toHaveBeenCalledTimes(1);
    // Receives coalesced array with single message (single message passes through unchanged)
    expect(flushSpy).toHaveBeenCalledWith(sk, [msg], "telegram");
  });

  // 2. Coalesces multiple messages within window
  it("coalesces multiple messages within window", () => {
    const config = makeConfig({ firstMessageImmediate: false });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();
    const msg1 = makeMessage("hello");
    const msg2 = makeMessage("world");
    const msg3 = makeMessage("!");

    buffer.push(sk, msg1, "telegram");
    buffer.push(sk, msg2, "telegram");
    buffer.push(sk, msg3, "telegram");

    vi.advanceTimersByTime(500);

    expect(flushSpy).toHaveBeenCalledTimes(1);
    // Should receive a single coalesced message (array of 1 coalesced NormalizedMessage)
    const flushedMessages = flushSpy.mock.calls[0]![1] as NormalizedMessage[];
    expect(flushedMessages).toHaveLength(1);
    // Coalesced text includes all 3 messages
    expect(flushedMessages[0]!.text).toContain("[Message 1]");
    expect(flushedMessages[0]!.text).toContain("[Message 2]");
    expect(flushedMessages[0]!.text).toContain("[Message 3]");
  });

  // 3. firstMessageImmediate bypasses debounce for first message
  it("firstMessageImmediate bypasses debounce for first message", () => {
    const config = makeConfig({ firstMessageImmediate: true });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();
    const msg1 = makeMessage("first");
    const msg2 = makeMessage("second");

    // First message: immediate flush
    buffer.push(sk, msg1, "telegram");
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledWith(sk, [msg1], "telegram");

    // Second message: buffered (creates new entry since first was immediately flushed)
    // With firstMessageImmediate, the first in each burst is immediate
    // After the first flush, there's no entry in the map, so the second message
    // is also treated as a "first" message and flushed immediately
    buffer.push(sk, msg2, "telegram");
    expect(flushSpy).toHaveBeenCalledTimes(2);
  });

  // 4. firstMessageImmediate=false buffers all messages
  it("firstMessageImmediate=false buffers all messages", () => {
    const config = makeConfig({ firstMessageImmediate: false });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();
    const msg = makeMessage("hello");

    buffer.push(sk, msg, "telegram");

    // Not flushed immediately
    expect(flushSpy).not.toHaveBeenCalled();

    // Only after timer
    vi.advanceTimersByTime(500);
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  // 5. maxBufferedMessages forces flush on overflow
  it("maxBufferedMessages forces flush on overflow", () => {
    const config = makeConfig({ firstMessageImmediate: false, maxBufferedMessages: 3 });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();

    buffer.push(sk, makeMessage("1"), "telegram");
    buffer.push(sk, makeMessage("2"), "telegram");
    expect(flushSpy).not.toHaveBeenCalled();

    buffer.push(sk, makeMessage("3"), "telegram");

    // Should have been force-flushed due to overflow
    expect(flushSpy).toHaveBeenCalledTimes(1);
    const flushedMessages = flushSpy.mock.calls[0]![1] as NormalizedMessage[];
    expect(flushedMessages).toHaveLength(1); // Coalesced into 1
    expect(flushedMessages[0]!.text).toContain("[Message 1]");
    expect(flushedMessages[0]!.text).toContain("[Message 3]");
  });

  // 6. Resets debounce timer on each push
  it("resets debounce timer on each push", () => {
    const config = makeConfig({ firstMessageImmediate: false, windowMs: 1000 });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();

    buffer.push(sk, makeMessage("a"), "telegram");

    // Advance 500ms (half window)
    vi.advanceTimersByTime(500);
    expect(flushSpy).not.toHaveBeenCalled();

    // Push another message, resetting the timer
    buffer.push(sk, makeMessage("b"), "telegram");

    // Advance another 500ms (original window would have expired, but timer was reset)
    vi.advanceTimersByTime(500);
    expect(flushSpy).not.toHaveBeenCalled();

    // Advance to full window from last push (500ms more)
    vi.advanceTimersByTime(500);
    expect(flushSpy).toHaveBeenCalledTimes(1);

    // Both messages coalesced
    const flushedMessages = flushSpy.mock.calls[0]![1] as NormalizedMessage[];
    expect(flushedMessages).toHaveLength(1);
    expect(flushedMessages[0]!.text).toContain("[Message 1]");
    expect(flushedMessages[0]!.text).toContain("[Message 2]");
  });

  // 7. Shutdown flushes all pending buffers
  it("shutdown flushes all pending buffers", () => {
    const config = makeConfig({ firstMessageImmediate: false });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const skA = makeSessionKey("userA", "c1");
    const skB = makeSessionKey("userB", "c2");

    buffer.push(skA, makeMessage("from A"), "telegram");
    buffer.push(skB, makeMessage("from B"), "discord");

    expect(flushSpy).not.toHaveBeenCalled();

    buffer.shutdown();

    expect(flushSpy).toHaveBeenCalledTimes(2);
  });

  // 8. Emits debounce:buffered event on push
  it("emits debounce:buffered event on push", () => {
    const config = makeConfig({ firstMessageImmediate: false });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();
    buffer.push(sk, makeMessage("test"), "telegram");

    expect(eventBus.emit).toHaveBeenCalledWith("debounce:buffered", expect.objectContaining({
      sessionKey: sk,
      channelType: "telegram",
      bufferedCount: 1,
      windowMs: 500,
    }));
  });

  // 9. Emits debounce:flushed event on flush
  it("emits debounce:flushed event on flush", () => {
    const config = makeConfig({ firstMessageImmediate: false });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();
    buffer.push(sk, makeMessage("test"), "telegram");

    vi.advanceTimersByTime(500);

    expect(eventBus.emit).toHaveBeenCalledWith("debounce:flushed", expect.objectContaining({
      sessionKey: sk,
      channelType: "telegram",
      messageCount: 1,
      trigger: "timer",
    }));
  });

  // 10. Independent sessions have independent timers
  it("independent sessions have independent timers", () => {
    const config = makeConfig({ firstMessageImmediate: false, windowMs: 1000 });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const skA = makeSessionKey("userA", "c1");
    const skB = makeSessionKey("userB", "c2");

    buffer.push(skA, makeMessage("A1"), "telegram");

    // Advance 500ms, then push to session B
    vi.advanceTimersByTime(500);
    buffer.push(skB, makeMessage("B1"), "discord");

    // Advance 500ms more -- session A timer expires (1000ms total), session B still pending
    vi.advanceTimersByTime(500);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy.mock.calls[0]![0]).toEqual(skA);

    // Advance 500ms more -- session B timer expires (1000ms from push)
    vi.advanceTimersByTime(500);
    expect(flushSpy).toHaveBeenCalledTimes(2);
    expect(flushSpy.mock.calls[1]![0]).toEqual(skB);
  });

  // Bonus: clear() removes a specific session's buffer
  it("clear() cancels timer and drops messages for a session", () => {
    const config = makeConfig({ firstMessageImmediate: false });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();
    buffer.push(sk, makeMessage("test"), "telegram");

    buffer.clear(sk);

    vi.advanceTimersByTime(500);

    // Should NOT have been flushed
    expect(flushSpy).not.toHaveBeenCalled();
  });

  // Bonus: push after shutdown is ignored
  it("rejects pushes after shutdown", () => {
    const config = makeConfig({ firstMessageImmediate: true });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    buffer.shutdown();

    buffer.push(makeSessionKey(), makeMessage("ignored"), "telegram");
    expect(flushSpy).not.toHaveBeenCalled();
  });

  // Bonus: overflow emits debounce:flushed with trigger "overflow"
  it("overflow emits debounce:flushed with overflow trigger", () => {
    const config = makeConfig({ firstMessageImmediate: false, maxBufferedMessages: 2 });
    buffer = createDebounceBuffer({ config, eventBus });
    buffer.onFlush(flushSpy);

    const sk = makeSessionKey();
    buffer.push(sk, makeMessage("1"), "telegram");
    buffer.push(sk, makeMessage("2"), "telegram");

    expect(eventBus.emit).toHaveBeenCalledWith("debounce:flushed", expect.objectContaining({
      trigger: "overflow",
      messageCount: 2,
    }));
  });
});
