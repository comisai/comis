/**
 * Session concurrency integration tests.
 *
 * Verifies four core concurrency behaviors:
 * - PQueue per-session serialization (same session messages are serialized)
 * - Parallel session execution via withSessionLock (different sessions run in parallel)
 * - Stale filesystem lock detection and recovery
 * - Graceful session deletion during active CommandQueue execution
 *
 * Uses REAL timers only -- PQueue uses internal timers for async scheduling
 * and vi.useFakeTimers() breaks PQueue's concurrency model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  NormalizedMessage,
  SessionKey,
  QueueConfig,
  TypedEventBus,
} from "@comis/core";
import { QueueConfigSchema } from "@comis/core";
import type { SessionStore, SessionData } from "@comis/memory";
import { createCommandQueue } from "../queue/command-queue.js";
import { withSessionLock } from "./session-write-lock.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Shared helpers
function createDefaultConfig(
  overrides?: Partial<QueueConfig>,
): QueueConfig {
  return QueueConfigSchema.parse({
    cleanupIdleMs: 600_000,
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
    channelType: "echo",
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

// ---------------------------------------------------------------------------
// Fake SessionStore (from session-lifecycle.test.ts pattern)
// ---------------------------------------------------------------------------

interface StoredSession {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function createFakeSessionStore(): SessionStore & {
  _sessions: Map<string, StoredSession>;
} {
  const sessions = new Map<string, StoredSession>();

  function keyStr(key: SessionKey): string {
    return `${key.tenantId}:${key.userId}:${key.channelId}`;
  }

  return {
    _sessions: sessions,

    save(key, messages, metadata) {
      const k = keyStr(key);
      const existing = sessions.get(k);
      const now = Date.now();
      sessions.set(k, {
        messages,
        metadata: metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    load(key): SessionData | undefined {
      const k = keyStr(key);
      const s = sessions.get(k);
      if (!s) return undefined;
      return {
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    },

    list(tenantId?) {
      const entries: Array<{ sessionKey: string; updatedAt: number }> = [];
      for (const [k, v] of sessions) {
        if (tenantId === undefined || k.startsWith(tenantId + ":")) {
          entries.push({ sessionKey: k, updatedAt: v.updatedAt });
        }
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    delete(key) {
      const k = keyStr(key);
      return sessions.delete(k);
    },

    deleteStale(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let deleted = 0;
      for (const [k, v] of sessions) {
        if (v.updatedAt < cutoff) {
          sessions.delete(k);
          deleted++;
        }
      }
      return deleted;
    },

    loadByFormattedKey(sessionKey: string): SessionData | undefined {
      const s = sessions.get(sessionKey);
      if (!s) return undefined;
      return {
        messages: s.messages,
        metadata: s.metadata,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    },

    listDetailed(tenantId?: string) {
      const entries: Array<{
        sessionKey: string;
        tenantId: string;
        userId: string;
        channelId: string;
        metadata: Record<string, unknown>;
        createdAt: number;
        updatedAt: number;
      }> = [];
      for (const [k, v] of sessions) {
        const parts = k.split(":");
        const tid = parts[0] ?? "";
        if (tenantId === undefined || tid === tenantId) {
          entries.push({
            sessionKey: k,
            tenantId: tid,
            userId: parts[1] ?? "",
            channelId: parts[2] ?? "",
            metadata: v.metadata,
            createdAt: v.createdAt,
            updatedAt: v.updatedAt,
          });
        }
      }
      return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// -- PQueue session serialization
// ---------------------------------------------------------------------------

describe("-- PQueue session serialization", () => {
  const SESSION_KEY: SessionKey = {
    tenantId: "default",
    userId: "user-1",
    channelId: "ch-1",
  };

  it("two messages for same session are serialized (second waits for first)", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const order: string[] = [];

    const handler1 = async () => {
      order.push("first-start");
      await delay(100);
      order.push("first-end");
    };

    const handler2 = async () => {
      order.push("second-start");
      order.push("second-end");
    };

    const msg1 = createMockMessage("msg-1");
    const msg2 = createMockMessage("msg-2");

    const p1 = queue.enqueue(SESSION_KEY, msg1, "echo", handler1);
    const p2 = queue.enqueue(SESSION_KEY, msg2, "echo", handler2);

    await Promise.all([p1, p2]);

    expect(order).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);

    await queue.shutdown();
  });

  it("three messages maintain FIFO order within same session", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });

    const order: string[] = [];

    const handler1 = async () => {
      order.push("1-start");
      await delay(50);
      order.push("1-end");
    };

    const handler2 = async () => {
      order.push("2-start");
      await delay(50);
      order.push("2-end");
    };

    const handler3 = async () => {
      order.push("3-start");
      await delay(50);
      order.push("3-end");
    };

    const msg1 = createMockMessage("msg-1");
    const msg2 = createMockMessage("msg-2");
    const msg3 = createMockMessage("msg-3");

    const p1 = queue.enqueue(SESSION_KEY, msg1, "echo", handler1);
    const p2 = queue.enqueue(SESSION_KEY, msg2, "echo", handler2);
    const p3 = queue.enqueue(SESSION_KEY, msg3, "echo", handler3);

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([
      "1-start",
      "1-end",
      "2-start",
      "2-end",
      "3-start",
      "3-end",
    ]);

    await queue.shutdown();
  });
});

// ---------------------------------------------------------------------------
// -- Parallel different sessions via withSessionLock
// ---------------------------------------------------------------------------

describe("-- Parallel different sessions via withSessionLock", () => {
  let lockDir: string;

  afterEach(() => {
    if (lockDir) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });

  it("different session keys execute in parallel without blocking", async () => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "agt02-"));

    let parallelCount = 0;
    let peakParallel = 0;

    const task = async (key: string) => {
      return withSessionLock(lockDir, key, async () => {
        parallelCount++;
        peakParallel = Math.max(peakParallel, parallelCount);
        await delay(150);
        parallelCount--;
      });
    };

    await Promise.all([
      task("tenant:userA:channel"),
      task("tenant:userB:channel"),
    ]);

    expect(peakParallel).toBe(2);
  });

  it("same session key serializes via withSessionLock (not parallel)", async () => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "agt02-same-"));

    let parallelCount = 0;
    let peakParallel = 0;

    const task = async (key: string) => {
      return withSessionLock(
        lockDir,
        key,
        async () => {
          parallelCount++;
          peakParallel = Math.max(peakParallel, parallelCount);
          await delay(150);
          parallelCount--;
        },
        { retries: 10, retryMinTimeout: 100 },
      );
    };

    const key = "tenant:userA:channel";

    await Promise.all([task(key), task(key)]);

    expect(peakParallel).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// -- Stale lock recovery
// ---------------------------------------------------------------------------

describe("-- Stale lock recovery", () => {
  let lockDir: string;

  afterEach(() => {
    if (lockDir) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });

  it("stale lock detected and recovered after staleMs elapses", async () => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "agt03-"));
    const key = "tenant:user:ch";

    // Create sentinel file by running withSessionLock once
    await withSessionLock(lockDir, key, () => "setup");

    // Find the sentinel file (ends with .lock and is a file, not a directory)
    const sentinelFiles = fs.readdirSync(lockDir).filter(
      (f) =>
        f.endsWith(".lock") &&
        fs.statSync(path.join(lockDir, f)).isFile(),
    );
    expect(sentinelFiles.length).toBe(1);

    const sentinelPath = path.join(lockDir, sentinelFiles[0]!);

    // Simulate a stale/crashed process lock: create the lock DIRECTORY
    // (proper-lockfile uses a directory as the lock indicator)
    const lockDirPath = `${sentinelPath}.lock`;
    fs.mkdirSync(lockDirPath, { recursive: true });

    // Set ancient mtime (60 seconds ago) to trigger stale detection
    const pastTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDirPath, pastTime, pastTime);

    // With staleMs=2000, a 60s-old lock should be considered stale
    const result = await withSessionLock(lockDir, key, () => "recovered", {
      staleMs: 2000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("recovered");
    }
  });
});

// ---------------------------------------------------------------------------
// -- Session deletion during active execution
// ---------------------------------------------------------------------------

describe("-- Session deletion during active execution", () => {
  const SESSION_KEY: SessionKey = {
    tenantId: "default",
    userId: "user-1",
    channelId: "ch-1",
  };

  it("session deletion during active execution completes gracefully", async () => {
    const eventBus = createMockEventBus();
    const config = createDefaultConfig();
    const queue = createCommandQueue({ eventBus, config });
    const store = createFakeSessionStore();
    const mgr = createSessionLifecycle(store);

    // Save initial session data
    mgr.save(SESSION_KEY, [{ role: "user", content: "hello" }]);

    // Create a "started" signal so we know the handler is running
    let resolveStarted: () => void;
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });

    let executionCompleted = false;

    const handler = async () => {
      // Signal that we have started executing
      resolveStarted!();

      // Simulate ongoing work
      await delay(100);

      // Mark completion
      executionCompleted = true;
    };

    const msg = createMockMessage("trigger");

    // Enqueue the handler (capture the promise, do NOT await yet)
    const enqueuePromise = queue.enqueue(
      SESSION_KEY,
      msg,
      "echo",
      handler,
    );

    // Wait until the handler has started executing
    await started;

    // Delete the session mid-execution
    mgr.expire(SESSION_KEY);

    // Now await the enqueue to completion
    await enqueuePromise;

    // The handler should have completed without crash
    expect(executionCompleted).toBe(true);

    // The session was deleted, so loadOrCreate returns empty (new session)
    const messages = mgr.loadOrCreate(SESSION_KEY);
    expect(messages).toEqual([]);

    await queue.shutdown();
  });
});
