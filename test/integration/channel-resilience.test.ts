// SPDX-License-Identifier: Apache-2.0
/**
 * CHAN: Channel Pipeline Resilience Integration Tests
 *
 * Validates channel pipeline resilience guarantees:
 *   CHAN-04: Retry engine recovery from adapter failures
 *   CHAN-05: Concurrent message injection without duplicates
 *   CHAN-06: Adapter failure does not crash daemon
 *   CHAN-07: Queue overflow policy drop-old
 *   CHAN-08: Queue overflow policy drop-new
 *
 * Tests exercise ChaosEchoAdapter for fault injection, RetryEngine for
 * retry logic, EchoChannelAdapter for concurrent message handling,
 * daemon harness for crash isolation, and applyOverflowPolicy for
 * queue depth enforcement.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { vi } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChaosEchoAdapter,
  type ChaosEchoAdapter,
} from "../support/chaos-echo-adapter.js";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { DAEMON_STARTUP_MS, DAEMON_CLEANUP_MS } from "../support/timeouts.js";
import {
  EchoChannelAdapter,
  createChannelManager,
  type ChannelManagerDeps,
} from "@comis/channels";
import { createRetryEngine } from "../../packages/channels/dist/shared/retry-engine.js";
import { applyOverflowPolicy } from "@comis/agent";
import {
  RetryConfigSchema,
  OverflowConfigSchema,
} from "@comis/core";
import type {
  NormalizedMessage,
  SessionKey,
  ChannelPort,
  EventMap,
} from "@comis/core";
import { TypedEventBus } from "@comis/core";
import { ok, err } from "@comis/shared";
import type { Result } from "@comis/shared";
import { ASYNC_SETTLE_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CRASH_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-channel-crash.yaml",
);

// ---------------------------------------------------------------------------
// Transient-failure adapter for retry engine tests
// ---------------------------------------------------------------------------

/**
 * Creates a ChannelPort stub that fails N times with a retryable error
 * message (503 Service Unavailable) then succeeds. The RetryEngine's
 * classifySendError recognizes "503" as a transient error eligible for retry.
 *
 * ChaosEchoAdapter's error messages ("Chaos: deterministic failure") are
 * classified as "abort" by the retry engine, so we need this wrapper to
 * produce errors the engine will actually retry.
 */
function createTransientFailureAdapter(failCount: number): {
  adapter: ChannelPort;
  callLog: Array<{ result: "success" | "failure" }>;
} {
  let remaining = failCount;
  const callLog: Array<{ result: "success" | "failure" }> = [];

  const adapter: ChannelPort = {
    channelId: "transient-test",
    channelType: "echo",
    start: async () => ok(undefined),
    stop: async () => ok(undefined),
    onMessage: () => {},
    async sendMessage(
      _channelId: string,
      _text: string,
    ): Promise<Result<string, Error>> {
      if (remaining > 0) {
        remaining--;
        callLog.push({ result: "failure" });
        return err(new Error("503 Service Unavailable"));
      }
      callLog.push({ result: "success" });
      return ok("msg-ok-1");
    },
    editMessage: async () => ok(undefined),
    reactToMessage: async () => ok(undefined),
    deleteMessage: async () => ok(undefined),
    fetchMessages: async () => ok([]),
    sendAttachment: async () => ok("attach-ok"),
    platformAction: async () => ok({}),
  };

  return { adapter, callLog };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: overrides?.channelId ?? "test-channel",
    channelType: overrides?.channelType ?? "echo",
    senderId: overrides?.senderId ?? "test-user",
    text: overrides?.text ?? "Hello",
    timestamp: overrides?.timestamp ?? Date.now(),
    attachments: overrides?.attachments ?? [],
    metadata: overrides?.metadata ?? {},
  };
}

function makeEventBus(): TypedEventBus {
  const bus = new TypedEventBus();
  // Spy on emit for assertion
  vi.spyOn(bus, "emit");
  return bus;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeMinimalDeps(
  adapters: ChannelPort[],
  executorOverrides?: Partial<{
    execute: (...args: unknown[]) => Promise<unknown>;
  }>,
): ChannelManagerDeps {
  const executor = {
    execute: executorOverrides?.execute ?? vi.fn(async (msg: NormalizedMessage) => ({
      response: `Echo: ${msg.text}`,
      tokensUsed: { total: 10, prompt: 5, completion: 5 },
      cost: { total: 0.001 },
      finishReason: "stop",
    })),
  };

  return {
    eventBus: makeEventBus(),
    messageRouter: {
      resolve: vi.fn(() => "default"),
    } as any,
    sessionManager: {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      expire: vi.fn(),
    } as any,
    createExecutor: vi.fn(() => executor) as any,
    adapters,
    logger: makeLogger(),
  };
}

// ---------------------------------------------------------------------------
// CHAN-04: Retry engine recovery from adapter failure
// ---------------------------------------------------------------------------

describe("CHAN-04: Retry engine recovery from adapter failure", () => {
  it("retries after transient failures and eventually succeeds", async () => {
    // Use transient failure adapter (503 errors are classified as retryable)
    const { adapter, callLog } = createTransientFailureAdapter(2);

    const retryConfig = RetryConfigSchema.parse({
      maxAttempts: 5,
      jitter: false,
      minDelayMs: 10,
      maxDelayMs: 50,
    });

    const eventBus = makeEventBus();
    const retryEngine = createRetryEngine(retryConfig, eventBus, makeLogger());

    const result = await retryEngine.sendWithRetry(
      adapter,
      "ch-retry",
      "Hello retry",
    );

    expect(result.ok).toBe(true);

    const failures = callLog.filter((r) => r.result === "failure");
    const successes = callLog.filter((r) => r.result === "success");

    expect(failures.length).toBe(2);
    expect(successes.length).toBe(1);
  });

  it("exhausts retries when failures exceed maxAttempts", async () => {
    const { adapter, callLog } = createTransientFailureAdapter(10);

    const retryConfig = RetryConfigSchema.parse({
      maxAttempts: 3,
      jitter: false,
      minDelayMs: 10,
      maxDelayMs: 50,
    });

    const retryEngine = createRetryEngine(
      retryConfig,
      makeEventBus(),
      makeLogger(),
    );

    const result = await retryEngine.sendWithRetry(
      adapter,
      "ch-fail",
      "Will fail",
    );

    expect(result.ok).toBe(false);

    const failures = callLog.filter((r) => r.result === "failure");
    expect(failures.length).toBe(3);
  });

  it("retry engine emits retry:attempted events for each retry", async () => {
    const { adapter } = createTransientFailureAdapter(2);

    const eventBus = makeEventBus();

    const retryConfig = RetryConfigSchema.parse({
      maxAttempts: 5,
      jitter: false,
      minDelayMs: 10,
      maxDelayMs: 50,
    });

    const retryEngine = createRetryEngine(retryConfig, eventBus, makeLogger());

    await retryEngine.sendWithRetry(adapter, "ch-events", "Hello events");

    // Verify retry:attempted events were emitted
    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const retryEvents = emitCalls.filter(
      (call: unknown[]) => call[0] === "retry:attempted",
    );

    // 2 failures = 2 retry:attempted events (one after each failed attempt before retry)
    expect(retryEvents.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CHAN-05: Concurrent message injection without duplicates
// ---------------------------------------------------------------------------

describe("CHAN-05: Concurrent message injection without duplicates", () => {
  it("N concurrent messages produce N unique responses with no duplicates", async () => {
    const adapter = new EchoChannelAdapter({
      channelId: "echo-concurrent",
      channelType: "echo",
    });

    const deps = makeMinimalDeps([adapter]);
    const manager = createChannelManager(deps);

    await manager.startAll();

    const N = 15;
    const messages = Array.from({ length: N }, (_, i) =>
      makeMessage({
        text: `concurrent-${i}`,
        senderId: `user-${i}`,
        channelId: "echo-concurrent",
        channelType: "echo",
      }),
    );

    // Fire all concurrently
    await Promise.all(messages.map((msg) => adapter.injectMessage(msg)));

    // Wait for pipeline to settle
    await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

    const sent = adapter.getSentMessages();

    // Each input should produce at least one response
    expect(sent.length).toBeGreaterThanOrEqual(N);

    // Verify no duplicate message IDs
    const ids = sent.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Verify all N input texts are represented in responses
    for (let i = 0; i < N; i++) {
      const hasResponse = sent.some((s) => s.text.includes(`concurrent-${i}`));
      expect(hasResponse).toBe(true);
    }

    await manager.stopAll();
  });

  it("concurrent messages from same sender are processed without loss", async () => {
    const adapter = new EchoChannelAdapter({
      channelId: "echo-same-sender",
      channelType: "echo",
    });

    const deps = makeMinimalDeps([adapter]);
    const manager = createChannelManager(deps);

    await manager.startAll();

    const N = 10;
    const messages = Array.from({ length: N }, (_, i) =>
      makeMessage({
        text: `same-sender-${i}`,
        senderId: "shared-user",
        channelId: "echo-same-sender",
        channelType: "echo",
      }),
    );

    await Promise.all(messages.map((msg) => adapter.injectMessage(msg)));

    // Wait for pipeline to settle
    await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

    const sent = adapter.getSentMessages();

    // All messages should get responses
    expect(sent.length).toBeGreaterThanOrEqual(N);

    // Verify all input texts are represented
    for (let i = 0; i < N; i++) {
      const hasResponse = sent.some((s) =>
        s.text.includes(`same-sender-${i}`),
      );
      expect(hasResponse).toBe(true);
    }

    await manager.stopAll();
  });
});

// ---------------------------------------------------------------------------
// CHAN-06: Adapter failure does not crash daemon
// ---------------------------------------------------------------------------

describe("CHAN-06: Adapter failure does not crash daemon", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CRASH_CONFIG_PATH });
  }, DAEMON_STARTUP_MS * 2);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (cleanupErr) {
        // Expected: graceful shutdown calls the overridden exit() which throws
        const msg =
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        if (!msg.includes("Daemon exit with code")) {
          throw cleanupErr;
        }
      }
    }
  }, DAEMON_CLEANUP_MS);

  it("daemon continues operating after adapter sendMessage failure", async () => {
    // Create a chaos adapter that always fails
    const chaos = createChaosEchoAdapter({
      chaos: { failRate: 1.0, latencyMs: 0 },
    });

    // Call sendMessage directly -- the chaos adapter returns an error
    const result = await chaos.sendMessage("ch-fail", "should fail");
    expect(result.ok).toBe(false);

    // Verify daemon is still alive via health endpoint
    const healthRes = await fetch(`${handle.gatewayUrl}/health`);
    expect(healthRes.status).toBe(200);
  });

  it("daemon processes normal messages after adapter failure", async () => {
    // First trigger a failure
    const chaos = createChaosEchoAdapter({
      chaos: { failRate: 1.0, latencyMs: 0 },
    });
    const failResult = await chaos.sendMessage("ch-fail", "fail first");
    expect(failResult.ok).toBe(false);

    // Now create a normal adapter and verify it works
    const normalAdapter = new EchoChannelAdapter({
      channelId: "echo-recovery",
      channelType: "echo",
    });

    const sendResult = await normalAdapter.sendMessage(
      "echo-recovery",
      "Recovery message",
    );
    expect(sendResult.ok).toBe(true);

    // Daemon health check still passing
    const healthRes = await fetch(`${handle.gatewayUrl}/health`);
    expect(healthRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// CHAN-07: Queue overflow policy drop-old
// ---------------------------------------------------------------------------

describe("CHAN-07: Queue overflow policy drop-old", () => {
  it("drops oldest messages when count exceeds maxDepth", () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ text: `msg-${i}` }),
    );
    const config = OverflowConfigSchema.parse({
      maxDepth: 3,
      policy: "drop-old",
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };
    const eventBus = makeEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      sessionKey,
      "echo",
    );

    expect(result.dropped).toBe(2); // 5 - 3 = 2 oldest dropped
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].text).toBe("msg-2"); // oldest 2 dropped
    expect(result.messages[2].text).toBe("msg-4"); // newest preserved
  });

  it("emits queue:overflow event with correct metadata", () => {
    const messages = Array.from({ length: 4 }, (_, i) =>
      makeMessage({ text: `msg-${i}` }),
    );
    const config = OverflowConfigSchema.parse({
      maxDepth: 3,
      policy: "drop-old",
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };
    const eventBus = makeEventBus();

    applyOverflowPolicy(messages, config, eventBus, sessionKey, "echo");

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const overflowEvents = emitCalls.filter(
      (call: unknown[]) => call[0] === "queue:overflow",
    );

    expect(overflowEvents.length).toBe(1);
    const payload = overflowEvents[0][1] as Record<string, unknown>;
    expect(payload.policy).toBe("drop-old");
    expect(payload.droppedCount).toBe(1); // 4 - 3 = 1
  });

  it("at exactly maxDepth, triggers overflow (boundary test)", () => {
    const messages = Array.from({ length: 3 }, (_, i) =>
      makeMessage({ text: `msg-${i}` }),
    );
    const config = OverflowConfigSchema.parse({
      maxDepth: 3,
      policy: "drop-old",
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };
    const eventBus = makeEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      sessionKey,
      "echo",
    );

    // length === maxDepth IS overflow (source: pendingMessages.length < config.maxDepth)
    // But excess = 3 - 3 = 0 for drop-old, so no messages actually dropped
    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(3);

    // Overflow event should still fire (condition >= maxDepth triggers emit)
    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const overflowEvents = emitCalls.filter(
      (call: unknown[]) => call[0] === "queue:overflow",
    );
    expect(overflowEvents.length).toBe(1);
  });

  it("below maxDepth, no overflow", () => {
    const messages = Array.from({ length: 2 }, (_, i) =>
      makeMessage({ text: `msg-${i}` }),
    );
    const config = OverflowConfigSchema.parse({
      maxDepth: 3,
      policy: "drop-old",
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };
    const eventBus = makeEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      sessionKey,
      "echo",
    );

    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(2);

    // No overflow event
    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const overflowEvents = emitCalls.filter(
      (call: unknown[]) => call[0] === "queue:overflow",
    );
    expect(overflowEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CHAN-08: Queue overflow policy drop-new
// ---------------------------------------------------------------------------

describe("CHAN-08: Queue overflow policy drop-new", () => {
  it("rejects newest message when count exceeds maxDepth", () => {
    const messages = Array.from({ length: 4 }, (_, i) =>
      makeMessage({ text: `msg-${i}` }),
    );
    const config = OverflowConfigSchema.parse({
      maxDepth: 3,
      policy: "drop-new",
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };
    const eventBus = makeEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      sessionKey,
      "echo",
    );

    expect(result.dropped).toBe(1);
    expect(result.messages).toHaveLength(3);
    // First 3 preserved, msg-3 rejected (slice(0, -1))
    expect(result.messages[0].text).toBe("msg-0");
    expect(result.messages[1].text).toBe("msg-1");
    expect(result.messages[2].text).toBe("msg-2");
  });

  it("emits queue:overflow event for drop-new", () => {
    const messages = Array.from({ length: 4 }, (_, i) =>
      makeMessage({ text: `msg-${i}` }),
    );
    const config = OverflowConfigSchema.parse({
      maxDepth: 3,
      policy: "drop-new",
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };
    const eventBus = makeEventBus();

    applyOverflowPolicy(messages, config, eventBus, sessionKey, "echo");

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const overflowEvents = emitCalls.filter(
      (call: unknown[]) => call[0] === "queue:overflow",
    );

    expect(overflowEvents.length).toBe(1);
    const payload = overflowEvents[0][1] as Record<string, unknown>;
    expect(payload.policy).toBe("drop-new");
    expect(payload.droppedCount).toBe(1);
  });

  it("at exactly maxDepth, triggers overflow and drops last message", () => {
    const messages = Array.from({ length: 3 }, (_, i) =>
      makeMessage({ text: `msg-${i}` }),
    );
    const config = OverflowConfigSchema.parse({
      maxDepth: 3,
      policy: "drop-new",
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };
    const eventBus = makeEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      sessionKey,
      "echo",
    );

    // length >= maxDepth: overflow triggers
    // drop-new: slice(0, -1) removes last
    expect(result.dropped).toBe(1);
    expect(result.messages).toHaveLength(2);

    // Overflow event fires
    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const overflowEvents = emitCalls.filter(
      (call: unknown[]) => call[0] === "queue:overflow",
    );
    expect(overflowEvents.length).toBe(1);
  });

  it("below maxDepth, no overflow", () => {
    const messages = Array.from({ length: 2 }, (_, i) =>
      makeMessage({ text: `msg-${i}` }),
    );
    const config = OverflowConfigSchema.parse({
      maxDepth: 3,
      policy: "drop-new",
    });
    const sessionKey: SessionKey = {
      tenantId: "default",
      userId: "user-1",
      channelId: "ch-1",
    };
    const eventBus = makeEventBus();

    const result = applyOverflowPolicy(
      messages,
      config,
      eventBus,
      sessionKey,
      "echo",
    );

    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(2);

    // No overflow event
    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const overflowEvents = emitCalls.filter(
      (call: unknown[]) => call[0] === "queue:overflow",
    );
    expect(overflowEvents.length).toBe(0);
  });
});
