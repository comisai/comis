// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the command queue: session serialization, queue modes,
 * overflow integration, lifecycle methods, and lane cleanup.
 *
 * Uses real timers for concurrency tests (fake timers conflict with
 * PQueue's async scheduling). Uses vi.useFakeTimers() only for
 * cleanup/idle tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  NormalizedMessage,
  SessionKey,
  QueueConfig,
  TypedEventBus,
} from "@comis/core";
import { QueueConfigSchema, formatSessionKey } from "@comis/core";
import { createCommandQueue } from "./command-queue.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
function createDefaultConfig(
  overrides?: Partial<QueueConfig>,
): QueueConfig {
  return QueueConfigSchema.parse({
    cleanupIdleMs: 600_000, // 10 minutes default
    ...overrides,
  });
}

function createMockMessage(
  text: string,
  overrides?: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "test-channel",
    channelType: "telegram",
    senderId: "user1",
    text,
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SESSION_A: SessionKey = {
  tenantId: "default",
  userId: "user-a",
  channelId: "chan-1",
};

const SESSION_B: SessionKey = {
  tenantId: "default",
  userId: "user-b",
  channelId: "chan-2",
};

const SESSION_C: SessionKey = {
  tenantId: "default",
  userId: "user-c",
  channelId: "chan-3",
};

// ---------------------------------------------------------------------------
// Session serialization
// ---------------------------------------------------------------------------

describe("Session serialization", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("executes handlers sequentially within the same session", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const executionOrder: number[] = [];
    let activeCount = 0;
    let peakConcurrency = 0;

    const handler = (idx: number) => async () => {
      activeCount++;
      peakConcurrency = Math.max(peakConcurrency, activeCount);
      executionOrder.push(idx);
      await delay(30);
      activeCount--;
    };

    // Enqueue 3 messages to the same session concurrently
    const promises = [
      queue.enqueue(SESSION_A, createMockMessage("msg-1"), "telegram", handler(1)),
      queue.enqueue(SESSION_A, createMockMessage("msg-2"), "telegram", handler(2)),
      queue.enqueue(SESSION_A, createMockMessage("msg-3"), "telegram", handler(3)),
    ];

    await Promise.all(promises);
    await queue.shutdown();

    // Verify sequential execution (peak concurrency = 1)
    expect(peakConcurrency).toBe(1);
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it("executes handlers in parallel across different sessions", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    let activeCount = 0;
    let peakConcurrency = 0;
    const started: string[] = [];

    const handler = (label: string) => async () => {
      activeCount++;
      started.push(label);
      peakConcurrency = Math.max(peakConcurrency, activeCount);
      await delay(50);
      activeCount--;
    };

    // Enqueue to two different sessions simultaneously
    const promises = [
      queue.enqueue(SESSION_A, createMockMessage("a"), "telegram", handler("A")),
      queue.enqueue(SESSION_B, createMockMessage("b"), "telegram", handler("B")),
    ];

    await Promise.all(promises);
    await queue.shutdown();

    // Both should have started (parallel)
    expect(peakConcurrency).toBe(2);
  });

  it("respects global concurrency cap (maxConcurrentSessions)", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ maxConcurrentSessions: 2 });
    const queue = createCommandQueue({ eventBus, config });

    let activeCount = 0;
    let peakConcurrency = 0;

    const handler = async () => {
      activeCount++;
      peakConcurrency = Math.max(peakConcurrency, activeCount);
      await delay(80);
      activeCount--;
    };

    // Enqueue to 3 sessions -- only 2 should run concurrently
    const promises = [
      queue.enqueue(SESSION_A, createMockMessage("a"), "telegram", handler),
      queue.enqueue(SESSION_B, createMockMessage("b"), "telegram", handler),
      queue.enqueue(SESSION_C, createMockMessage("c"), "telegram", handler),
    ];

    await Promise.all(promises);
    await queue.shutdown();

    expect(peakConcurrency).toBe(2);
  });

  it("maintains FIFO order within a session", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const executionOrder: string[] = [];

    const handler = (msgs: NormalizedMessage[]) => async () => {
      executionOrder.push(msgs[0]!.text);
      await delay(10);
    };

    const promises = [];
    for (let i = 0; i < 5; i++) {
      const msg = createMockMessage(`msg-${i}`);
      promises.push(
        queue.enqueue(SESSION_A, msg, "telegram", handler([msg])),
      );
    }

    await Promise.all(promises);
    await queue.shutdown();

    expect(executionOrder).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Queue modes
// ---------------------------------------------------------------------------

describe("Queue modes", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("followup mode: each message gets its own handler call", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ defaultMode: "followup" });
    const queue = createCommandQueue({ eventBus, config });

    const calls: NormalizedMessage[][] = [];

    const handler = async (msgs: NormalizedMessage[]) => {
      calls.push(msgs);
      await delay(10);
    };

    await Promise.all([
      queue.enqueue(SESSION_A, createMockMessage("msg-1"), "telegram", handler),
      queue.enqueue(SESSION_A, createMockMessage("msg-2"), "telegram", handler),
      queue.enqueue(SESSION_A, createMockMessage("msg-3"), "telegram", handler),
    ]);

    await queue.shutdown();

    // Each message gets its own handler invocation
    expect(calls).toHaveLength(3);
    expect(calls[0]!).toHaveLength(1);
    expect(calls[0]![0]!.text).toBe("msg-1");
    expect(calls[1]![0]!.text).toBe("msg-2");
    expect(calls[2]![0]!.text).toBe("msg-3");
  });

  it("collect mode: accumulates messages during execution and coalesces", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ defaultMode: "collect" });
    const queue = createCommandQueue({ eventBus, config });

    const calls: NormalizedMessage[][] = [];
    let firstCallResolve: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallResolve = resolve;
    });

    let callCount = 0;
    const handler = async (msgs: NormalizedMessage[]) => {
      callCount++;
      calls.push(msgs);
      if (callCount === 1) {
        firstCallResolve!();
        // Simulate long execution so messages accumulate
        await delay(150);
      } else {
        await delay(10);
      }
    };

    // Enqueue msg-1 (idle lane -> executes immediately)
    const p1 = queue.enqueue(
      SESSION_A,
      createMockMessage("msg-1"),
      "telegram",
      handler,
    );

    // Wait for the first handler to start executing
    await firstCallStarted;

    // Enqueue msg-2 and msg-3 while handler is running
    queue.enqueue(
      SESSION_A,
      createMockMessage("msg-2"),
      "telegram",
      handler,
    );
    queue.enqueue(
      SESSION_A,
      createMockMessage("msg-3"),
      "telegram",
      handler,
    );

    await p1;
    await queue.drainAll();
    await queue.shutdown();

    // First call: msg-1 alone
    expect(calls[0]!).toHaveLength(1);
    expect(calls[0]![0]!.text).toBe("msg-1");

    // Second call: msg-2 + msg-3 coalesced into one message
    expect(calls).toHaveLength(2);
    expect(calls[1]!).toHaveLength(1);
    expect(calls[1]![0]!.text).toContain("[Message 1]:");
    expect(calls[1]![0]!.text).toContain("[Message 2]:");
  });

  it("steer mode: aborts current execution and coalesces pending messages", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ defaultMode: "steer" });
    const queue = createCommandQueue({ eventBus, config });

    const calls: NormalizedMessage[][] = [];
    let firstHandlerAborted = false;
    let firstCallResolve: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallResolve = resolve;
    });

    let callCount = 0;
    const handler = async (msgs: NormalizedMessage[]) => {
      callCount++;
      calls.push(msgs);
      if (callCount === 1) {
        firstCallResolve!();
        try {
          // Simulate long work that can be aborted
          await delay(500);
        } catch {
          firstHandlerAborted = true;
        }
      } else {
        await delay(10);
      }
    };

    // Enqueue msg-1 (idle lane -> executes immediately)
    const p1 = queue.enqueue(
      SESSION_A,
      createMockMessage("msg-1"),
      "telegram",
      handler,
    );

    // Wait for handler to start
    await firstCallStarted;

    // Enqueue msg-2 while handler is running -- this triggers abort
    queue.enqueue(
      SESSION_A,
      createMockMessage("msg-2"),
      "telegram",
      handler,
    );

    await p1;
    await queue.drainAll();
    await queue.shutdown();

    // The steer mode should have called the handler at least twice:
    // 1. First with msg-1 (which gets aborted)
    // 2. Second with coalesced msg-2
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]![0]!.text).toBe("msg-1");

    // Second call should be the coalesced message(s)
    const secondCall = calls[1]!;
    expect(secondCall).toHaveLength(1);
    expect(secondCall[0]!.text).toContain("msg-2");
  });

  it("collect mode with idle session: first message executes immediately", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ defaultMode: "collect" });
    const queue = createCommandQueue({ eventBus, config });

    const calls: NormalizedMessage[][] = [];
    const handler = async (msgs: NormalizedMessage[]) => {
      calls.push(msgs);
    };

    // Enqueue single message to idle lane
    await queue.enqueue(
      SESSION_A,
      createMockMessage("immediate"),
      "telegram",
      handler,
    );

    await queue.shutdown();

    // Should execute immediately (not wait for debounce)
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.text).toBe("immediate");
  });
});

// ---------------------------------------------------------------------------
// Overflow
// ---------------------------------------------------------------------------

describe("Overflow integration", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("emits overflow event when maxDepth is exceeded in collect mode", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig({
      defaultMode: "collect",
      defaultOverflow: { maxDepth: 3, policy: "drop-old" },
    });
    const queue = createCommandQueue({ eventBus, config });

    let firstCallResolve: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallResolve = resolve;
    });

    let isFirst = true;
    const handler = async () => {
      if (isFirst) {
        isFirst = false;
        firstCallResolve!();
        await delay(200);
      }
    };

    // First message starts executing
    const p1 = queue.enqueue(
      SESSION_A,
      createMockMessage("msg-1"),
      "telegram",
      handler,
    );

    await firstCallStarted;

    // Enqueue 5 more messages while first is executing
    for (let i = 2; i <= 6; i++) {
      queue.enqueue(
        SESSION_A,
        createMockMessage(`msg-${i}`),
        "telegram",
        handler,
      );
    }

    await p1;
    await queue.drainAll();
    await queue.shutdown();

    // Verify overflow event was emitted
    const overflowCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === "queue:overflow",
    );
    expect(overflowCalls.length).toBeGreaterThan(0);

    // Verify at least one overflow has droppedCount > 0
    const hasDrops = overflowCalls.some(
      (call: unknown[]) =>
        (call[1] as { droppedCount: number }).droppedCount > 0,
    );
    expect(hasDrops).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Queue lifecycle
// ---------------------------------------------------------------------------

describe("Queue lifecycle", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("getQueueDepth returns correct count", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    let firstCallResolve: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((resolve) => {
      firstCallResolve = resolve;
    });

    let isFirst = true;
    const handler = async () => {
      if (isFirst) {
        isFirst = false;
        firstCallResolve!();
        await delay(100);
      }
    };

    // Enqueue first (starts executing)
    queue.enqueue(SESSION_A, createMockMessage("msg-1"), "telegram", handler);

    await firstCallStarted;

    // Enqueue a second while first is running
    queue.enqueue(SESSION_A, createMockMessage("msg-2"), "telegram", handler);

    // At least one should be queued/executing
    const depth = queue.getQueueDepth(SESSION_A);
    expect(depth).toBeGreaterThanOrEqual(1);

    await queue.drainAll();
    await queue.shutdown();
  });

  it("isProcessing returns true during execution and false after", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    let processingDuringExec = false;
    let handlerResolve: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerResolve = resolve;
    });

    const handler = async () => {
      handlerResolve!();
      processingDuringExec = queue.isProcessing(SESSION_A);
      await delay(30);
    };

    const p = queue.enqueue(
      SESSION_A,
      createMockMessage("msg"),
      "telegram",
      handler,
    );

    await handlerStarted;
    await p;

    expect(processingDuringExec).toBe(true);
    expect(queue.isProcessing(SESSION_A)).toBe(false);

    await queue.shutdown();
  });

  it("drain resolves only after all session tasks complete", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const completed: string[] = [];

    const handler = (label: string) => async () => {
      await delay(30);
      completed.push(label);
    };

    // Enqueue 3 messages (don't await the enqueue result)
    queue.enqueue(SESSION_A, createMockMessage("1"), "telegram", handler("1"));
    queue.enqueue(SESSION_A, createMockMessage("2"), "telegram", handler("2"));
    queue.enqueue(SESSION_A, createMockMessage("3"), "telegram", handler("3"));

    // drain should wait until all are done
    await queue.drain(SESSION_A);

    expect(completed).toEqual(["1", "2", "3"]);

    await queue.shutdown();
  });

  it("drainAll resolves after all sessions complete", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const completed: string[] = [];

    const handler = (label: string) => async () => {
      await delay(30);
      completed.push(label);
    };

    queue.enqueue(SESSION_A, createMockMessage("a1"), "telegram", handler("a1"));
    queue.enqueue(SESSION_B, createMockMessage("b1"), "telegram", handler("b1"));

    await queue.drainAll();

    expect(completed).toContain("a1");
    expect(completed).toContain("b1");

    await queue.shutdown();
  });

  it("shutdown rejects new enqueue calls with err()", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    await queue.shutdown();

    const result = await queue.enqueue(
      SESSION_A,
      createMockMessage("after-shutdown"),
      "telegram",
      async () => {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("shut down");
    }
  });

  it("lane cleanup removes idle lanes after configured timeout", async () => {
    vi.useFakeTimers();

    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ cleanupIdleMs: 100 });
    const queue = createCommandQueue({ eventBus, config });

    // Enqueue and let it complete
    const handler = async () => {};

    // Use real execution by advancing timers
    const p = queue.enqueue(
      SESSION_A,
      createMockMessage("msg"),
      "telegram",
      handler,
    );

    // Advance timers to let the handler run
    await vi.advanceTimersByTimeAsync(10);
    await p;

    // Verify lane exists
    const statsBefore = queue.getStats();
    expect(statsBefore.activeLanes).toBe(1);

    // Advance past cleanup interval
    await vi.advanceTimersByTimeAsync(200);

    // Lane should be cleaned up
    const statsAfter = queue.getStats();
    expect(statsAfter.activeLanes).toBe(0);

    await queue.shutdown();

    vi.useRealTimers();
  });

  it("getStats returns accurate counts", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    let handlerResolve: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerResolve = resolve;
    });

    const handler = async () => {
      handlerResolve!();
      await delay(100);
    };

    // Start execution on session A
    const p = queue.enqueue(
      SESSION_A,
      createMockMessage("msg"),
      "telegram",
      handler,
    );

    await handlerStarted;

    const stats = queue.getStats();
    expect(stats.activeLanes).toBe(1);
    expect(stats.totalExecuting).toBe(1);
    // totalPending includes in-flight (pending in PQueue terms)
    expect(stats.totalPending).toBeGreaterThanOrEqual(1);

    await p;
    await queue.shutdown();
  });

  it("getQueueDepth returns 0 for unknown session", () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const depth = queue.getQueueDepth({
      tenantId: "default",
      userId: "unknown",
      channelId: "unknown",
    });

    expect(depth).toBe(0);

    // Synchronous shutdown is fine since nothing was enqueued
    void queue.shutdown();
  });

  it("isProcessing returns false for unknown session", () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const processing = queue.isProcessing({
      tenantId: "default",
      userId: "unknown",
      channelId: "unknown",
    });

    expect(processing).toBe(false);

    void queue.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Logger lifecycle tracing
// ---------------------------------------------------------------------------

describe("Logger lifecycle tracing", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("emits DEBUG on enqueue when logger provided", async () => {
    const { createMockLogger } = await import("../../../../test/support/mock-logger.js");
    const logger = createMockLogger();
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config, logger });

    await queue.enqueue(SESSION_A, createMockMessage("msg-1"), "telegram", async () => {});

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "telegram" }),
      expect.any(String),
    );

    await queue.shutdown();
  });

  it("emits DEBUG on shutdown with activeLanes count", async () => {
    const { createMockLogger } = await import("../../../../test/support/mock-logger.js");
    const logger = createMockLogger();
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config, logger });

    await queue.shutdown();

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ activeLanes: expect.any(Number) }),
      "Command queue shutting down",
    );
  });
});

// ---------------------------------------------------------------------------
// touchLane (graph parent session keepalive)
// ---------------------------------------------------------------------------

describe("touchLane (graph parent session keepalive)", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("prevents idle cleanup by refreshing lane lastActivityMs", async () => {
    vi.useFakeTimers();

    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ cleanupIdleMs: 100 });
    const queue = createCommandQueue({ eventBus, config });

    // Enqueue and let it complete to create a lane
    const handler = async () => {};
    const p = queue.enqueue(SESSION_A, createMockMessage("msg"), "telegram", handler);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    // Verify lane exists
    expect(queue.getStats().activeLanes).toBe(1);

    // Advance to just before cleanup threshold
    await vi.advanceTimersByTimeAsync(80);

    // Touch the lane to refresh its TTL
    queue.touchLane(formatSessionKey(SESSION_A));

    // Advance past original cleanup time (total now > cleanupIdleMs from initial creation)
    await vi.advanceTimersByTimeAsync(80);

    // Lane should still exist because touchLane refreshed lastActivityMs
    expect(queue.getStats().activeLanes).toBe(1);

    // Advance past the cleanup threshold from the touch time
    await vi.advanceTimersByTimeAsync(100);

    // Now the lane should be cleaned up
    expect(queue.getStats().activeLanes).toBe(0);

    await queue.shutdown();
    vi.useRealTimers();
  });

  it("is a no-op for unknown session keys (no crash, no new lane)", () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    // Should not throw
    queue.touchLane("nonexistent-session-key");

    // Should not create a lane
    expect(queue.getStats().activeLanes).toBe(0);

    void queue.shutdown();
  });

  it("is a no-op for a lane that was already reaped", async () => {
    vi.useFakeTimers();

    const eventBus = createMockEventBus();
    const config = createDefaultConfig({ cleanupIdleMs: 100 });
    const queue = createCommandQueue({ eventBus, config });

    // Create and complete a lane
    const handler = async () => {};
    const p = queue.enqueue(SESSION_A, createMockMessage("msg"), "telegram", handler);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(queue.getStats().activeLanes).toBe(1);

    // Let cleanup reap the lane
    await vi.advanceTimersByTimeAsync(200);
    expect(queue.getStats().activeLanes).toBe(0);

    // Touch after reap -- should not throw or create new lane
    queue.touchLane(formatSessionKey(SESSION_A));
    expect(queue.getStats().activeLanes).toBe(0);

    await queue.shutdown();
    vi.useRealTimers();
  });
});
