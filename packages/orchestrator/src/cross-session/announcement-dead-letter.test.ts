// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type Result } from "@comis/shared";
import type { OutwardSendLedgerPort, OutwardSendRecord } from "@comis/core";

import {
  createAnnouncementDeadLetterQueue,
  type DeadLetterEntry,
  type AnnouncementLogger,
} from "./announcement-dead-letter.js";
import { createMockLogger as _createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

const createMockLogger = (): AnnouncementLogger => _createMockLogger() as unknown as AnnouncementLogger;


// ---------------------------------------------------------------------------
// Test helpers
function makeEntry(
  overrides: Partial<Omit<DeadLetterEntry, "id" | "lastAttemptAt">> = {},
): Omit<DeadLetterEntry, "id" | "lastAttemptAt"> {
  return {
    announcementText: "Task completed successfully",
    channelType: "telegram",
    channelId: "chat-123",
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    failedAt: Date.now(),
    attemptCount: 0,
    ...overrides,
  };
}

function makeFullEntry(
  overrides: Partial<DeadLetterEntry> = {},
): DeadLetterEntry {
  return {
    id: crypto.randomUUID(),
    announcementText: "Task completed successfully",
    channelType: "telegram",
    channelId: "chat-123",
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    failedAt: Date.now() - 120_000,
    attemptCount: 0,
    lastAttemptAt: Date.now() - 120_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnnouncementDeadLetterQueue", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dlq-test-"));
    filePath = join(tmpDir, "dlq.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("enqueue persists entry to JSONL file", async () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    const entry = makeEntry({ runId: "run-persist-001" });
    dlq.enqueue(entry);

    // Wait for fire-and-forget appendFile
    await new Promise((r) => setTimeout(r, 50));

    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content.trim()) as DeadLetterEntry;
    expect(parsed.runId).toBe("run-persist-001");
    expect(parsed.announcementText).toBe("Task completed successfully");
    expect(parsed.channelType).toBe("telegram");
    expect(parsed.channelId).toBe("chat-123");
    expect(parsed.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof parsed.lastAttemptAt).toBe("number");
  });

  it("enqueue emits announcement:dead_lettered event", () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    const entry = makeEntry({
      runId: "run-event-001",
      channelType: "discord",
      lastError: "connection_timeout",
    });
    dlq.enqueue(entry);

    expect(eventBus.emit).toHaveBeenCalledWith(
      "announcement:dead_lettered",
      expect.objectContaining({
        runId: "run-event-001",
        channelType: "discord",
        reason: "connection_timeout",
        timestamp: expect.any(Number),
      }),
    );
  });

  it("enqueue never throws on file write failure", async () => {
    const eventBus = createMockEventBus();
    const logger = createMockLogger();
    // Point to an invalid path to trigger write failure
    const badPath = join(tmpDir, "nonexistent", "subdir", "dlq.jsonl");
    const dlq = createAnnouncementDeadLetterQueue({
      filePath: badPath,
      eventBus,
      logger,
    });

    // This should NOT throw
    expect(() => dlq.enqueue(makeEntry())).not.toThrow();
    expect(dlq.size()).toBe(1);

    // Wait for fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "internal",
        hint: "DLQ append failed; entry exists in memory only",
      }),
      "Dead-letter file append failed",
    );
  });

  it("enqueue enforces maxEntries cap", () => {
    const eventBus = createMockEventBus();
    const logger = createMockLogger();
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      maxEntries: 3,
      logger,
    });

    dlq.enqueue(makeEntry({ runId: "run-1" }));
    dlq.enqueue(makeEntry({ runId: "run-2" }));
    dlq.enqueue(makeEntry({ runId: "run-3" }));
    dlq.enqueue(makeEntry({ runId: "run-4" }));

    expect(dlq.size()).toBe(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "resource",
        hint: "Dead-letter queue at capacity; oldest entry dropped",
      }),
      "Dead-letter queue at capacity",
    );
  });

  it("drain retries delivery via sendToChannel", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-drain-001",
      channelType: "telegram",
      channelId: "chat-456",
      announcementText: "Retry this message",
    });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).toHaveBeenCalledWith(
      "telegram",
      "chat-456",
      "Retry this message",
      undefined,
    );
    expect(dlq.size()).toBe(0);
  });

  it("drain passes persisted threadId to sendToChannel", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-thread-001",
      channelType: "telegram",
      channelId: "chat-789",
      announcementText: "Threaded retry",
      threadId: "topic-42",
    });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).toHaveBeenCalledWith(
      "telegram",
      "chat-789",
      "Threaded retry",
      { threadId: "topic-42" },
    );
    expect(dlq.size()).toBe(0);
  });

  it("drain emits announcement:dead_letter_delivered on success", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-delivered-001",
      channelType: "discord",
      attemptCount: 2,
    });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(eventBus.emit).toHaveBeenCalledWith(
      "announcement:dead_letter_delivered",
      expect.objectContaining({
        runId: "run-delivered-001",
        channelType: "discord",
        attemptCount: 3,
        timestamp: expect.any(Number),
      }),
    );
  });

  it("drain drops entries after maxRetries", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({ attemptCount: 5 });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(0);
  });

  it("drain drops entries after maxAgeMs", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      failedAt: Date.now() - 3_700_000,
      lastAttemptAt: Date.now() - 3_700_000,
    });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(0);
  });

  it("drain skips entries not yet eligible for retry", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({ lastAttemptAt: Date.now() });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 60_000,
    });

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(1);
  });

  it("drain handles sendToChannel failure gracefully", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-fail-001",
      attemptCount: 1,
      lastAttemptAt: Date.now() - 120_000,
    });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    const sendToChannel = vi.fn().mockRejectedValue(new Error("network down"));
    await dlq.drain(sendToChannel);

    expect(dlq.size()).toBe(1);

    // Read persisted file to verify updated entry
    const content = await readFile(filePath, "utf-8");
    const persisted = JSON.parse(content.trim()) as DeadLetterEntry;
    expect(persisted.attemptCount).toBe(2);
    expect(persisted.lastError).toBe("network down");
  });

  it("drain uses atomic write for remaining entries", async () => {
    const eventBus = createMockEventBus();
    const entry1 = makeFullEntry({
      runId: "run-success",
      lastAttemptAt: Date.now() - 120_000,
    });
    const entry2 = makeFullEntry({
      runId: "run-fail",
      lastAttemptAt: Date.now() - 120_000,
    });

    await writeFile(
      filePath,
      JSON.stringify(entry1) + "\n" + JSON.stringify(entry2) + "\n",
      "utf-8",
    );

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    let callCount = 0;
    const sendToChannel = vi.fn().mockImplementation(async () => {
      callCount++;
      // First call succeeds, second fails
      if (callCount === 1) return true;
      throw new Error("partial failure");
    });

    await dlq.drain(sendToChannel);

    expect(dlq.size()).toBe(1);

    // Read file back and verify only the failed entry remains
    const content = await readFile(filePath, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    const remaining = JSON.parse(lines[0]!) as DeadLetterEntry;
    expect(remaining.runId).toBe("run-fail");
    expect(remaining.attemptCount).toBe(entry2.attemptCount + 1);
  });

  it("corrupt JSONL lines are skipped", async () => {
    const eventBus = createMockEventBus();
    const logger = createMockLogger();
    const entry1 = makeFullEntry({
      runId: "run-valid-1",
      lastAttemptAt: Date.now() - 120_000,
    });
    const entry2 = makeFullEntry({
      runId: "run-valid-2",
      lastAttemptAt: Date.now() - 120_000,
    });

    const content =
      JSON.stringify(entry1) +
      "\n" +
      "not json{corrupt line\n" +
      JSON.stringify(entry2) +
      "\n";
    await writeFile(filePath, content, "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      logger,
    });

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).toHaveBeenCalledTimes(2);
    expect(dlq.size()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "internal",
        hint: "Corrupt DLQ entry skipped",
      }),
      "Corrupt dead-letter entry skipped",
    );
  });

  it("concurrent drain calls are serialized", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-concurrent",
      lastAttemptAt: Date.now() - 120_000,
    });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    const sendToChannel = vi.fn().mockImplementation(
      async () => {
        // Add a small delay to ensure overlap
        await new Promise((r) => setTimeout(r, 20));
        return true;
      },
    );

    // Start two drains simultaneously
    await Promise.all([dlq.drain(sendToChannel), dlq.drain(sendToChannel)]);

    // Only one drain should process the entry
    expect(sendToChannel).toHaveBeenCalledTimes(1);
    expect(dlq.size()).toBe(0);
  });

  it("drain cleans up empty file", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({ lastAttemptAt: Date.now() - 120_000 });

    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(dlq.size()).toBe(0);

    // File should be cleaned up
    let fileExists = true;
    try {
      await readFile(filePath, "utf-8");
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  it("size returns current entry count", () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    expect(dlq.size()).toBe(0);

    dlq.enqueue(makeEntry({ runId: "run-size-1" }));
    dlq.enqueue(makeEntry({ runId: "run-size-2" }));
    dlq.enqueue(makeEntry({ runId: "run-size-3" }));

    expect(dlq.size()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// WR-01: a DLQ-recovered delivery must record its idempotency key as delivered.
// The whole point of DELIVERY-03 is that a budget-failed node's failure-key ==
// its success-key, so a second sweep does not double-notify — but that depends
// on the key being in the shared deliveredKeys set. The DLQ delivers to the
// user on drain() but had no way to mark the key, re-opening the double-notify
// window. drain() now accepts an onDelivered sink the wiring binds to
// deliveryDedup.mark / batcher.markDelivered.
// ---------------------------------------------------------------------------

describe("AnnouncementDeadLetterQueue drain marks recovered keys (WR-01)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dlq-wr01-"));
    filePath = join(tmpDir, "dlq.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("invokes onDelivered with the entry's idempotencyKey on a successful re-delivery", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-recover-1",
      idempotencyKey: "default:u1:c1::run-recover-1",
    });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus, retryIntervalMs: 0 });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(onDelivered).toHaveBeenCalledOnce();
    expect(onDelivered).toHaveBeenCalledWith("default:u1:c1::run-recover-1");
    expect(dlq.size()).toBe(0);
  });

  it("does NOT invoke onDelivered when the re-delivery fails (key stays open)", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-recover-fail",
      idempotencyKey: "default:u1:c1::run-recover-fail",
    });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus, retryIntervalMs: 0 });
    const sendToChannel = vi.fn().mockResolvedValue(false); // delivery failed
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(onDelivered).not.toHaveBeenCalled();
    // Entry remains for a future retry.
    expect(dlq.size()).toBe(1);
  });

  it("does NOT invoke onDelivered for an UN-keyed entry but still delivers it (no regression)", async () => {
    const eventBus = createMockEventBus();
    // No idempotencyKey — a pre-existing/top-level-spawn DLQ row.
    const entry = makeFullEntry({ runId: "run-recover-nokey" });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus, retryIntervalMs: 0 });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    // Delivered successfully, but no key → no mark.
    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(onDelivered).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(0);
  });

  it("drain() without an onDelivered sink still delivers (backward-shape-safe optional param)", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-recover-nosink",
      idempotencyKey: "default:u1:c1::run-recover-nosink",
    });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus, retryIntervalMs: 0 });
    const sendToChannel = vi.fn().mockResolvedValue(true);

    // No second arg — must not throw.
    await dlq.drain(sendToChannel);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(dlq.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HIGH-2 (ONCE-03/04): the DLQ drain must consult the ONCE ledger before
// re-delivering. The in-memory deliveredKeys set rebuilds EMPTY on restart, so a
// JSONL entry whose announcement already COMMITTED in the durable ledger would be
// blindly re-delivered after a daemon restart — a second notify for the same run.
// The ledger is the only durable source of "already sent". The fix: an entry that
// carries a persisted (rootRunId, stepIndex) is checked against the ledger; a
// committed row → SKIP the send, treat as delivered (no double-notify). Old-format
// entries (no rootRunId/stepIndex) degrade to the existing at-least-once behavior.
// ---------------------------------------------------------------------------

/**
 * A stub OutwardSendLedgerPort whose `lookup` returns a configurable result and
 * records the (rootRunId, stepIndex) it was asked about. Only `lookup` is used by
 * the drain; the rest satisfy the port contract.
 */
function makeStubLedger(
  lookupResult: Result<OutwardSendRecord | undefined, Error> = ok(undefined),
): { ledger: OutwardSendLedgerPort; lookupCalls: Array<[string, number]> } {
  const lookupCalls: Array<[string, number]> = [];
  const ledger: OutwardSendLedgerPort = {
    lookup: vi.fn(async (rootRunId: string, stepIndex: number) => {
      lookupCalls.push([rootRunId, stepIndex]);
      return lookupResult;
    }),
    begin: vi.fn(async () => ok(undefined)),
    markUnknown: vi.fn(async () => ok(undefined)),
    commit: vi.fn(async () => ok(undefined)),
    markFailed: vi.fn(async () => ok(undefined)),
    resolveReconcile: vi.fn(async () => ok(undefined)),
    listUnreconciled: vi.fn(async () => ok([])),
  };
  return { ledger, lookupCalls };
}

/** A committed ledger row for a given key (the already-landed announcement). */
function committedRow(rootRunId: string, stepIndex: number): OutwardSendRecord {
  return {
    id: `${rootRunId}:${stepIndex}`,
    rootRunId,
    stepIndex,
    agentId: "default",
    channelType: "telegram",
    channelId: "chat-123",
    state: "committed",
    platformMessageId: "msg-prior",
    contentDigest: "deadbeefdeadbeef",
    attemptCount: 1,
  };
}

describe("AnnouncementDeadLetterQueue drain consults the ONCE ledger (HIGH-2, ONCE-03/04)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dlq-once-"));
    filePath = join(tmpDir, "dlq.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("committed → SKIP: an entry whose (rootRunId, stepIndex) is committed is NOT re-sent after restart (the HIGH-2 fix)", async () => {
    const eventBus = createMockEventBus();
    // A DLQ entry that carries its durable idempotency key.
    const entry = makeFullEntry({
      runId: "run-committed-1",
      idempotencyKey: "default:u1:c1::run-committed-1",
      rootRunId: "root-committed-1",
      stepIndex: 4,
    });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const { ledger, lookupCalls } = makeStubLedger(ok(committedRow("root-committed-1", 4)));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    // The committed announcement already landed across the restart → never re-send.
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(lookupCalls).toEqual([["root-committed-1", 4]]);
    // It is treated as delivered: onDelivered fires + the entry is dropped.
    expect(onDelivered).toHaveBeenCalledWith("default:u1:c1::run-committed-1");
    expect(dlq.size()).toBe(0);
  });

  it("uncommitted → deliver once: an entry whose ledger row is NOT committed is delivered exactly once", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-uncommitted-1",
      idempotencyKey: "default:u1:c1::run-uncommitted-1",
      rootRunId: "root-uncommitted-1",
      stepIndex: 9,
    });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    // lookup returns ok(undefined) — no committed row yet.
    const { ledger, lookupCalls } = makeStubLedger(ok(undefined));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    // Not committed → it IS delivered (exactly once), and the ledger was consulted.
    expect(lookupCalls).toEqual([["root-uncommitted-1", 9]]);
    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(onDelivered).toHaveBeenCalledWith("default:u1:c1::run-uncommitted-1");
    expect(dlq.size()).toBe(0);
  });

  it("stepIndex persisted: enqueue persists (rootRunId, stepIndex) on the JSONL row; a reload preserves the key across a restart", async () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    dlq.enqueue(
      makeEntry({
        runId: "run-persist-key",
        idempotencyKey: "default:u1:c1::run-persist-key",
        rootRunId: "root-persist-key",
        stepIndex: 3,
      }),
    );
    // Wait for the fire-and-forget append.
    await new Promise((r) => setTimeout(r, 50));

    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content.trim()) as DeadLetterEntry;
    expect(parsed.rootRunId).toBe("root-persist-key");
    expect(parsed.stepIndex).toBe(3);

    // A fresh queue (simulating a restart) reloads the row and, with a committed
    // ledger, skips the re-send using the SAME persisted key.
    const { ledger, lookupCalls } = makeStubLedger(ok(committedRow("root-persist-key", 3)));
    const dlq2 = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq2.drain(sendToChannel);

    expect(lookupCalls).toEqual([["root-persist-key", 3]]);
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("forward-additive: an old-format entry (no rootRunId/stepIndex) still drains via the legacy at-least-once path", async () => {
    const eventBus = createMockEventBus();
    // Pre-existing JSONL row from before ledgering — NO rootRunId / stepIndex.
    const entry = makeFullEntry({ runId: "run-old-format" });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const { ledger, lookupCalls } = makeStubLedger(ok(undefined));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    // No key to look up → the ledger is NOT consulted; the entry still delivers
    // (legacy at-least-once), not crashed.
    expect(lookupCalls).toEqual([]);
    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(dlq.size()).toBe(0);
  });

  it("no ledger wired → drain delivers normally (pass-through, unchanged behavior)", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-no-ledger",
      rootRunId: "root-no-ledger",
      stepIndex: 1,
    });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    // outwardLedger omitted entirely.
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus, retryIntervalMs: 0 });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(dlq.size()).toBe(0);
  });
});
