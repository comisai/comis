// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAnnouncementDeadLetterQueue,
  type DeadLetterEntry,
} from "./announcement-dead-letter.js";
import type { SubAgentRunnerLogger } from "./sub-agent-runner.js";
import { createMockLogger as _createMockLogger } from "../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../test/support/mock-event-bus.js";

const createMockLogger = (): SubAgentRunnerLogger => _createMockLogger() as unknown as SubAgentRunnerLogger;


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
        errorKind: "io",
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
        errorKind: "data",
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
