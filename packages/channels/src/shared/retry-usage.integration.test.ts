/**
 * Integration tests: Retry engine + Usage tracking + ARCH compliance.
 *
 * Validates end-to-end flows across package boundaries:
 * - Retry engine with real config, markdown fallback, block guard
 * - CostTracker aggregation and command handler formatting
 * - Zod validation at entry and SSRF guard compliance
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";
import type { ChannelPort, SendMessageOptions } from "@comis/core";
import { RetryConfigSchema, validateUrl } from "@comis/core";
import {
  createRetryEngine,
  createBlockRetryGuard,
} from "./retry-engine.js";
import { createCostTracker, createCommandHandler, parseSlashCommand } from "@comis/agent";
import type { CommandHandlerDeps } from "@comis/agent";
import type { SessionKey } from "@comis/core";
import { NormalizedMessageSchema } from "@comis/core";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
    channelId: "telegram-integration",
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

function makeSessionKey(): SessionKey {
  return { tenantId: "default", userId: "user-1", channelId: "chan-1" };
}

// ===========================================================================
// Group 1: Retry Engine Integration
// ===========================================================================

describe("integration: retry engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retry engine with real config defaults works end-to-end", async () => {
    // Parse RetryConfigSchema with empty object (all defaults)
    const config = RetryConfigSchema.parse({});
    expect(config.maxAttempts).toBe(3);
    expect(config.jitter).toBe(true);

    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    let callCount = 0;
    const adapter = makeAdapter(vi.fn(async () => {
      callCount++;
      if (callCount === 1) return err(new Error("503 Service Unavailable"));
      return ok("msg-ok");
    }));

    const promise = engine.sendWithRetry(adapter, "chat-1", "Hello integration");
    // Advance past backoff delay (minDelayMs=500 default, with jitter so 0-500)
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("msg-ok");
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("markdown fallback strips HTML tags and delivers plain text", async () => {
    const config = RetryConfigSchema.parse({ markdownFallback: true, jitter: false });
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    let callCount = 0;
    const adapter = makeAdapter(vi.fn(async (_cId: string, text: string, _opts?: SendMessageOptions) => {
      callCount++;
      if (callCount === 1) return err(new Error("Bad Request: can't parse entities"));
      // Second call should be plain text
      return ok("msg-plain");
    }));

    const options: SendMessageOptions = { parseMode: "HTML" };
    const result = await engine.sendWithRetry(
      adapter, "chat-1", "<b>bold</b> text", options,
    );

    expect(result.ok).toBe(true);

    // Verify second call received stripped text and no parseMode
    const secondCall = vi.mocked(adapter.sendMessage).mock.calls[1];
    expect(secondCall[1]).toBe("bold text"); // HTML tags stripped
    expect(secondCall[2]?.parseMode).toBeUndefined(); // parseMode removed

    // Verify markdown_fallback event emitted
    expect(eventBus.emit).toHaveBeenCalledWith(
      "retry:markdown_fallback",
      expect.objectContaining({ originalParseMode: "HTML" }),
    );
  });

  it("block retry guard aborts delivery after 2 consecutive block failures", () => {
    const guard = createBlockRetryGuard();

    // Block 0 succeeds
    guard.recordSuccess();
    expect(guard.shouldAbort).toBe(false);

    // Block 1 fails
    guard.recordFailure();
    expect(guard.shouldAbort).toBe(false);

    // Block 2 fails (consecutive)
    guard.recordFailure();
    expect(guard.shouldAbort).toBe(true);

    // Confirm block 2 would not be retried -- guard says abort
    // This is the circuit-breaker behavior: after 2 consecutive failures,
    // remaining blocks are skipped
  });

  it("retry engine does NOT retry 400 Bad Request errors", async () => {
    const config = RetryConfigSchema.parse({ jitter: false });
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    const adapter = makeAdapter(vi.fn(async () => err(new Error("400 Bad Request: invalid chatId"))));

    const result = await engine.sendWithRetry(adapter, "chat-1", "Hello");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("400 Bad Request: invalid chatId");
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1); // No retries
  });

  it("retry engine respects retry_after from error message", async () => {
    const config = RetryConfigSchema.parse({ jitter: false });
    const eventBus = makeEventBus();
    const engine = createRetryEngine(config, eventBus, makeLogger());

    let callCount = 0;
    const adapter = makeAdapter(vi.fn(async () => {
      callCount++;
      if (callCount === 1) return err(new Error("429 Too Many Requests: retry_after: 2"));
      return ok("msg-after-wait");
    }));

    const promise = engine.sendWithRetry(adapter, "chat-1", "Hello");
    // Advance past the retry_after delay (2 seconds = 2000ms)
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result.ok).toBe(true);
    // Verify the emitted delay is 2000ms (extracted from retry_after: 2)
    expect(eventBus.emit).toHaveBeenCalledWith(
      "retry:attempted",
      expect.objectContaining({ delayMs: 2000 }),
    );
  });
});

// ===========================================================================
// Group 2: Usage Tracking Pipeline
// ===========================================================================

describe("integration: usage tracking pipeline", () => {
  it("costTracker records sessionKey and provides getBySession aggregation", () => {
    const tracker = createCostTracker();

    // Record 3 entries with same sessionKey, different costs
    tracker.record("agent-1", "chan-1", "exec-1", {
      input: 100, output: 50, totalTokens: 150,
      cost: { input: 0.001, output: 0.0005, total: 0.0015 },
      sessionKey: "default:user-1:chan-1",
    });
    tracker.record("agent-1", "chan-1", "exec-2", {
      input: 200, output: 100, totalTokens: 300,
      cost: { input: 0.002, output: 0.001, total: 0.003 },
      sessionKey: "default:user-1:chan-1",
    });
    tracker.record("agent-1", "chan-1", "exec-3", {
      input: 50, output: 25, totalTokens: 75,
      cost: { input: 0.0005, output: 0.00025, total: 0.00075 },
      sessionKey: "default:user-1:chan-1",
    });

    const session = tracker.getBySession("default:user-1:chan-1");
    expect(session.totalTokens).toBe(525); // 150 + 300 + 75
    expect(session.totalCost).toBeCloseTo(0.00525, 5); // 0.0015 + 0.003 + 0.00075
  });

  it("getByProvider groups by provider/model with correct callCount", () => {
    const tracker = createCostTracker();

    // 2 calls to anthropic/claude-sonnet-4-5-20250929
    tracker.record("agent-1", "chan-1", "exec-1", {
      input: 100, output: 50, totalTokens: 150,
      cost: { input: 0.001, output: 0.0005, total: 0.0015 },
      provider: "anthropic", model: "claude-sonnet-4-5-20250929",
    });
    tracker.record("agent-1", "chan-1", "exec-2", {
      input: 200, output: 100, totalTokens: 300,
      cost: { input: 0.002, output: 0.001, total: 0.003 },
      provider: "anthropic", model: "claude-sonnet-4-5-20250929",
    });

    // 1 call to openai/gpt-4o
    tracker.record("agent-1", "chan-1", "exec-3", {
      input: 80, output: 40, totalTokens: 120,
      cost: { input: 0.001, output: 0.0004, total: 0.0014 },
      provider: "openai", model: "gpt-4o",
    });

    const providers = tracker.getByProvider();
    expect(providers).toHaveLength(2);

    // Sorted by totalCost descending
    const anthropic = providers.find(p => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.callCount).toBe(2);
    expect(anthropic!.totalTokens).toBe(450); // 150 + 300

    const openai = providers.find(p => p.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai!.callCount).toBe(1);
    expect(openai!.totalTokens).toBe(120);
  });

  it("/usage command formats provider breakdown correctly", () => {
    const deps: CommandHandlerDeps = {
      getSessionInfo: vi.fn().mockReturnValue({
        messageCount: 10,
        tokensUsed: { input: 1000, output: 500, total: 1500 },
      }),
      getAgentConfig: vi.fn().mockReturnValue({
        name: "TestBot", model: "claude-sonnet-4-5-20250929", provider: "anthropic", maxSteps: 10,
      }),
      destroySession: vi.fn(),
      getUsageBreakdown: () => [
        { provider: "anthropic", model: "claude-sonnet-4-5-20250929", totalTokens: 15000, totalCost: 0.045, callCount: 3 },
      ],
    };

    const handler = createCommandHandler(deps);
    const sessionKey = makeSessionKey();

    const parsed = parseSlashCommand("/usage");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("anthropic/claude-sonnet-4-5-20250929");
    expect(result.response).toContain("tokens");
    expect(result.response).toContain("$");
    expect(result.response).toContain("(3 calls)");
    // Verify .toFixed(4) precision
    expect(result.response).toContain("$0.0450");
  });

  it("/status includes cost when getSessionCost is provided", () => {
    const deps: CommandHandlerDeps = {
      getSessionInfo: vi.fn().mockReturnValue({
        messageCount: 10,
        tokensUsed: { input: 3000, output: 2000, total: 5000 },
      }),
      getAgentConfig: vi.fn().mockReturnValue({
        name: "TestBot", model: "claude-sonnet-4-5-20250929", provider: "anthropic", maxSteps: 10,
      }),
      destroySession: vi.fn(),
      getSessionCost: () => ({ totalTokens: 5000, totalCost: 0.015 }),
    };

    const handler = createCommandHandler(deps);
    const sessionKey = makeSessionKey();

    const parsed = parseSlashCommand("/status");
    const result = handler.handle(parsed, sessionKey);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Est. cost: $0.0150");
  });
});

// ===========================================================================
// Group 3: ARCH compliance
// ===========================================================================

describe("integration: ARCH compliance", () => {
  it("NormalizedMessage uses Zod schema validation at entry", () => {
    // Verify NormalizedMessageSchema enforces Zod validation
    // Valid message should parse
    const valid = NormalizedMessageSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      channelId: "chan-1",
      channelType: "telegram",
      senderId: "user-1",
      text: "Hello world",
      timestamp: Date.now(),
    });
    expect(valid.success).toBe(true);

    // Invalid message should fail Zod validation
    const invalid = NormalizedMessageSchema.safeParse({
      id: "not-a-uuid",
      channelId: "",
      channelType: "",
      senderId: "",
      text: "Hello",
      timestamp: -1,
    });
    expect(invalid.success).toBe(false);

    // Verify schema is strict (rejects unknown fields)
    const withExtra = NormalizedMessageSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      channelId: "chan-1",
      channelType: "telegram",
      senderId: "user-1",
      text: "Hello",
      timestamp: Date.now(),
      unknownField: "should fail",
    });
    expect(withExtra.success).toBe(false);
  });

  it("SSRF guard exists and blocks internal/metadata IPs", async () => {
    // Verify validateUrl is a function
    expect(typeof validateUrl).toBe("function");

    // Verify it blocks cloud metadata IPs (169.254.169.254)
    const metadataResult = await validateUrl("http://169.254.169.254/metadata");
    expect(metadataResult.ok).toBe(false);
    if (!metadataResult.ok) {
      expect(metadataResult.error.message).toMatch(/blocked/i);
    }

    // Verify it blocks loopback addresses
    const loopbackResult = await validateUrl("http://127.0.0.1/internal");
    expect(loopbackResult.ok).toBe(false);
    if (!loopbackResult.ok) {
      expect(loopbackResult.error.message).toMatch(/blocked/i);
    }

    // Verify it rejects invalid protocols
    const ftpResult = await validateUrl("ftp://example.com/file");
    expect(ftpResult.ok).toBe(false);
    if (!ftpResult.ok) {
      expect(ftpResult.error.message).toMatch(/blocked protocol/i);
    }
  });
});
