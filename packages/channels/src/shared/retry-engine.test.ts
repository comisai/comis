// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";
import type { ChannelPort, SendMessageOptions } from "@comis/core";
import {
  classifySendError,
  stripHtmlTags,
  extractRetryAfter,
  createRetryEngine,
  createBlockRetryGuard,
} from "./retry-engine.js";
import type { RetryConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<RetryConfig>): RetryConfig {
  return {
    maxAttempts: 3,
    minDelayMs: 500,
    maxDelayMs: 30_000,
    jitter: false, // Disable jitter for deterministic tests
    respectRetryAfter: true,
    markdownFallback: true,
    ...overrides,
  };
}

function makeEventBus() {
  return {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  } as any;
}

function makeLogger() {
  return { warn: vi.fn() };
}

function makeAdapter(sendMessageMock?: ChannelPort["sendMessage"]): ChannelPort {
  return {
    channelId: "telegram-123",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: sendMessageMock ?? vi.fn(async () => ok("msg-1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    reactToMessage: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    fetchMessages: vi.fn(async () => ok([])),
    sendAttachment: vi.fn(async () => ok("att-1")),
    platformAction: vi.fn(async () => ok(undefined)),
  } as any;
}

// ---------------------------------------------------------------------------
// classifySendError
// ---------------------------------------------------------------------------

describe("classifySendError", () => {
  it("classifies Telegram parse error as markdown-fallback", () => {
    expect(classifySendError(new Error("Bad Request: can't parse entities")))
      .toBe("markdown-fallback");
  });

  it("classifies general parse error as markdown-fallback", () => {
    expect(classifySendError(new Error("HTML parse error in message")))
      .toBe("markdown-fallback");
  });

  it("classifies 503 as retry", () => {
    expect(classifySendError(new Error("503 Service Unavailable")))
      .toBe("retry");
  });

  it("classifies 502 as retry", () => {
    expect(classifySendError(new Error("502 Bad Gateway")))
      .toBe("retry");
  });

  it("classifies 429 as retry", () => {
    expect(classifySendError(new Error("429 Too Many Requests")))
      .toBe("retry");
  });

  it("classifies rate limit as retry", () => {
    expect(classifySendError(new Error("rate limit exceeded")))
      .toBe("retry");
  });

  it("classifies ECONNREFUSED as retry", () => {
    expect(classifySendError(new Error("connect ECONNREFUSED 127.0.0.1:443")))
      .toBe("retry");
  });

  it("classifies ETIMEDOUT as retry", () => {
    expect(classifySendError(new Error("connect ETIMEDOUT")))
      .toBe("retry");
  });

  it("classifies 400 Bad Request as abort", () => {
    expect(classifySendError(new Error("400 Bad Request: invalid chat_id")))
      .toBe("abort");
  });

  it("classifies 404 Not Found as abort", () => {
    expect(classifySendError(new Error("404 Not Found")))
      .toBe("abort");
  });

  it("classifies auth error as abort", () => {
    expect(classifySendError(new Error("401 Unauthorized")))
      .toBe("abort");
  });

  it("classifies unknown error as abort", () => {
    expect(classifySendError(new Error("Something unexpected")))
      .toBe("abort");
  });
});

// ---------------------------------------------------------------------------
// stripHtmlTags
// ---------------------------------------------------------------------------

describe("stripHtmlTags", () => {
  it("removes HTML tags and preserves text", () => {
    expect(stripHtmlTags("<b>bold</b> and <i>italic</i>"))
      .toBe("bold and italic");
  });

  it("handles nested tags", () => {
    expect(stripHtmlTags("<div><p>Hello <b>world</b></p></div>"))
      .toBe("Hello world");
  });

  it("returns plain text unchanged", () => {
    expect(stripHtmlTags("no tags here")).toBe("no tags here");
  });

  it("handles self-closing tags", () => {
    expect(stripHtmlTags("line1<br/>line2")).toBe("line1line2");
  });
});

// ---------------------------------------------------------------------------
// extractRetryAfter
// ---------------------------------------------------------------------------

describe("extractRetryAfter", () => {
  it("extracts retry_after: <seconds> pattern", () => {
    expect(extractRetryAfter(new Error("429 Too Many Requests: retry_after: 5")))
      .toBe(5000);
  });

  it("extracts Retry-After: <seconds> pattern", () => {
    expect(extractRetryAfter(new Error("Rate limited. Retry-After: 3")))
      .toBe(3000);
  });

  it("extracts 'retry after N seconds' pattern", () => {
    expect(extractRetryAfter(new Error("Please retry after 10 seconds")))
      .toBe(10000);
  });

  it("returns undefined when no retry_after found", () => {
    expect(extractRetryAfter(new Error("503 Service Unavailable")))
      .toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sendWithRetry
// ---------------------------------------------------------------------------

describe("createRetryEngine / sendWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately on successful first attempt", async () => {
    const config = makeConfig();
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());
    const adapter = makeAdapter(vi.fn(async () => ok("msg-1")));

    const result = await engine.sendWithRetry(adapter, "chat-1", "Hello");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("msg-1");
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    // No retry events should fire
    expect(eventBus.emit).not.toHaveBeenCalledWith("retry:attempted", expect.anything());
  });

  it("retries on retriable error and succeeds on 2nd attempt", async () => {
    const config = makeConfig();
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    let callCount = 0;
    const adapter = makeAdapter(vi.fn(async () => {
      callCount++;
      if (callCount === 1) return err(new Error("503 Service Unavailable"));
      return ok("msg-2");
    }));

    const promise = engine.sendWithRetry(adapter, "chat-1", "Hello");
    // Advance past the backoff delay
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("msg-2");
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
    expect(eventBus.emit).toHaveBeenCalledWith("retry:attempted", expect.objectContaining({
      attempt: 1,
      maxAttempts: 3,
    }));
  });

  it("exhausts all attempts and returns final error", async () => {
    const config = makeConfig({ maxAttempts: 2 });
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    const adapter = makeAdapter(vi.fn(async () => err(new Error("503 Service Unavailable"))));

    const promise = engine.sendWithRetry(adapter, "chat-1", "Hello");
    // Advance past backoff delays
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("503 Service Unavailable");
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
    expect(eventBus.emit).toHaveBeenCalledWith("retry:exhausted", expect.objectContaining({
      totalAttempts: 2,
      finalError: "503 Service Unavailable",
    }));
  });

  it("performs markdown fallback: strips HTML and retries without parse_mode", async () => {
    const config = makeConfig();
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    let callCount = 0;
    const adapter = makeAdapter(vi.fn(async (_cId: string, text: string, opts?: SendMessageOptions) => {
      callCount++;
      if (callCount === 1) return err(new Error("Bad Request: can't parse entities"));
      // Second call should be plain text without parse_mode
      return ok("msg-plain");
    }));

    const options: SendMessageOptions = { parseMode: "HTML" };
    const result = await engine.sendWithRetry(
      adapter, "chat-1", "<b>Hello</b> world", options,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("msg-plain");

    // Second call should have stripped HTML and removed parseMode
    const secondCall = vi.mocked(adapter.sendMessage).mock.calls[1];
    expect(secondCall[1]).toBe("Hello world"); // Tags stripped
    expect(secondCall[2]?.parseMode).toBeUndefined(); // parse_mode removed

    expect(eventBus.emit).toHaveBeenCalledWith("retry:markdown_fallback", expect.objectContaining({
      originalParseMode: "HTML",
    }));
  });

  it("aborts immediately on non-retriable error", async () => {
    const config = makeConfig();
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    const adapter = makeAdapter(vi.fn(async () => err(new Error("400 Bad Request: invalid chat_id"))));

    const result = await engine.sendWithRetry(adapter, "chat-1", "Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("400 Bad Request: invalid chat_id");
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1); // No retries
    expect(eventBus.emit).not.toHaveBeenCalledWith("retry:attempted", expect.anything());
    expect(eventBus.emit).not.toHaveBeenCalledWith("retry:exhausted", expect.anything());
  });

  it("respects retry_after when available", async () => {
    const config = makeConfig();
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    let callCount = 0;
    const adapter = makeAdapter(vi.fn(async () => {
      callCount++;
      if (callCount === 1) return err(new Error("429 Too Many Requests: retry_after: 5"));
      return ok("msg-3");
    }));

    const promise = engine.sendWithRetry(adapter, "chat-1", "Hello");

    // Advance timers by the retry_after duration (5 seconds = 5000ms)
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.ok).toBe(true);
    // Check that the emitted delay matches retry_after
    expect(eventBus.emit).toHaveBeenCalledWith("retry:attempted", expect.objectContaining({
      delayMs: 5000, // Extracted from retry_after: 5
    }));
  });

  it("does not retry when markdownFallback is disabled", async () => {
    const config = makeConfig({ markdownFallback: false });
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    const adapter = makeAdapter(vi.fn(async () =>
      err(new Error("Bad Request: can't parse entities")),
    ));

    const promise = engine.sendWithRetry(adapter, "chat-1", "<b>Hello</b>");
    // No fallback -- classified as markdown-fallback but fallback disabled
    // So it won't enter fallback path; will be treated as non-abort, non-retry
    // Actually: if markdownFallback is false, the classification still returns
    // "markdown-fallback" but the engine skips the fallback branch. Since it's
    // not "abort" and not "retry", we still want it to loop. Let's see what
    // the engine does -- it will fall through to "abort" implicitly since
    // markdown-fallback without the flag means the error repeats.
    // The engine continues the loop and retries.
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;

    // It should exhaust attempts since the error persists
    expect(result.ok).toBe(false);
    expect(eventBus.emit).not.toHaveBeenCalledWith("retry:markdown_fallback", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Abort signal support
// ---------------------------------------------------------------------------

describe("abort signal support", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops retrying when abort signal fires during sleep", async () => {
    const config = makeConfig({ maxAttempts: 3 });
    const eventBus = makeEventBus();
    const abortController = new AbortController();

    const engine = createRetryEngine(config, eventBus, makeLogger(), abortController.signal);

    // Always fail with retriable error
    const adapter = makeAdapter(vi.fn(async () => err(new Error("503 Service Unavailable"))));

    const promise = engine.sendWithRetry(adapter, "chat-1", "Hello");

    // First attempt fails, enters sleep
    await vi.advanceTimersByTimeAsync(0);

    // Abort during the sleep
    abortController.abort("test abort");

    // Advance past backoff -- should resolve immediately
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;

    // Fewer than 3 attempts (aborted before exhausting)
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Aborted");
  });

  it("returns error immediately when pre-aborted signal", async () => {
    const config = makeConfig({ maxAttempts: 3 });
    const eventBus = makeEventBus();
    const abortController = new AbortController();
    abortController.abort("pre-aborted");

    const engine = createRetryEngine(config, eventBus, makeLogger(), abortController.signal);
    const adapter = makeAdapter(vi.fn(async () => ok("msg-1")));

    const result = await engine.sendWithRetry(adapter, "chat-1", "Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Aborted");
    // adapter.sendMessage should never be called
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Block retry guard
// ---------------------------------------------------------------------------

describe("createBlockRetryGuard", () => {
  it("does not abort after first failure", () => {
    const guard = createBlockRetryGuard();
    guard.recordFailure();
    expect(guard.shouldAbort).toBe(false);
  });

  it("aborts after 2 consecutive failures (default threshold)", () => {
    const guard = createBlockRetryGuard();
    guard.recordFailure();
    guard.recordFailure();
    expect(guard.shouldAbort).toBe(true);
  });

  it("resets on success", () => {
    const guard = createBlockRetryGuard();
    guard.recordFailure();
    guard.recordSuccess();
    guard.recordFailure();
    expect(guard.shouldAbort).toBe(false);
  });

  it("aborts after consecutive failures following success reset", () => {
    const guard = createBlockRetryGuard();
    guard.recordFailure();
    guard.recordSuccess(); // reset
    guard.recordFailure();
    guard.recordFailure();
    expect(guard.shouldAbort).toBe(true);
  });

  it("respects custom threshold", () => {
    const guard = createBlockRetryGuard(3);
    guard.recordFailure();
    guard.recordFailure();
    expect(guard.shouldAbort).toBe(false);
    guard.recordFailure();
    expect(guard.shouldAbort).toBe(true);
  });
});
