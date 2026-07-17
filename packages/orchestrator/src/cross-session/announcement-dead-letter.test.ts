// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "@comis/shared";
import type {
  OutwardSendLedgerPort,
  OutwardSendRecord,
  OutwardSendState,
} from "@comis/core";

import {
  createAnnouncementDeadLetterQueue,
  type ChannelType,
  type DeadLetterEntry,
  type AnnouncementLogger,
} from "./announcement-dead-letter.js";
import type { DeadLetterWriteOperations } from "./announcement-dead-letter-file.js";
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

function createOneTimeDirectorySyncFailure(
  directory: string,
): DeadLetterWriteOperations {
  let rejectNextDirectorySync = true;
  return {
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return {
        chmod: async (nextMode) => handle.chmod(nextMode),
        writeFile: async (data, encoding) => handle.writeFile(data, encoding),
        sync: async () => {
          if (path === directory && rejectNextDirectorySync) {
            rejectNextDirectorySync = false;
            throw new Error("directory sync unavailable");
          }
          await handle.sync();
        },
        close: async () => handle.close(),
      };
    },
    rename,
    unlink,
    chmod,
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
    await expect(dlq.enqueue(entry)).resolves.toEqual(ok(undefined));

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

  it("enqueue emits announcement:dead_lettered event after persistence", async () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    const entry = makeEntry({
      runId: "run-event-001",
      channelType: "discord",
      lastError: "connection_timeout",
    });
    await expect(dlq.enqueue(entry)).resolves.toEqual(ok(undefined));

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

    const result = await dlq.enqueue(makeEntry());
    expect(result.ok).toBe(false);
    expect(dlq.size()).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "resource",
        hint: "restore dead-letter storage before retrying the enqueue operation",
      }),
      "Dead-letter enqueue was not persisted",
    );
  });

  it("enqueue enforces maxEntries cap for retryable entries", async () => {
    const eventBus = createMockEventBus();
    const logger = createMockLogger();
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      maxEntries: 3,
      logger,
    });

    await dlq.enqueue(makeEntry({ runId: "run-1" }));
    await dlq.enqueue(makeEntry({ runId: "run-2" }));
    await dlq.enqueue(makeEntry({ runId: "run-3" }));
    await dlq.enqueue(makeEntry({ runId: "run-4" }));

    expect(dlq.size()).toBe(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "resource",
        hint: "resolve retryable dead letters before the queue reaches capacity",
      }),
      "Retryable dead-letter queue reached capacity",
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
    expect(persisted.lastError).toBe("sendToChannel rejected");
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

  it("malformed JSONL blocks delivery and preserves every persisted row", async () => {
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
    const enqueueResult = await dlq.enqueue(makeEntry({ runId: "run-must-not-rewrite" }));
    await dlq.drain(sendToChannel);

    expect(enqueueResult).toMatchObject({ ok: false });
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        errorKind: "precondition",
        hint: "repair or quarantine the malformed dead-letter file before accepting or draining announcements",
      },
      "Malformed dead-letter file blocked",
    );
    expect(await readFile(filePath, "utf8")).toBe(content);
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

  it("size returns the durably committed entry count", async () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    expect(dlq.size()).toBe(0);

    await dlq.enqueue(makeEntry({ runId: "run-size-1" }));
    await dlq.enqueue(makeEntry({ runId: "run-size-2" }));
    await dlq.enqueue(makeEntry({ runId: "run-size-3" }));

    expect(dlq.size()).toBe(3);
  });

  it("serializes concurrent lazy-load enqueues without losing either durable row", async () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    const results = await Promise.all([
      dlq.enqueue(makeEntry({ runId: "run-concurrent-a" })),
      dlq.enqueue(makeEntry({ runId: "run-concurrent-b" })),
    ]);

    expect(results).toEqual([ok(undefined), ok(undefined)]);
    expect(dlq.size()).toBe(2);
    const rows = (await readFile(filePath, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DeadLetterEntry);
    expect(rows.map((row) => row.runId).sort()).toEqual([
      "run-concurrent-a",
      "run-concurrent-b",
    ]);
  });

  it("adopts a visible snapshot after directory sync fails before the next enqueue", async () => {
    const eventBus = createMockEventBus();
    const fileOperations = createOneTimeDirectorySyncFailure(tmpDir);
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      fileOperations,
    } as Parameters<typeof createAnnouncementDeadLetterQueue>[0]);

    const first = await dlq.enqueue(makeEntry({ runId: "run-visible-a" }));
    expect(first).toMatchObject({ ok: false });
    expect(dlq.size()).toBe(1);

    await expect(
      dlq.enqueue(makeEntry({ runId: "run-following-b" })),
    ).resolves.toEqual(ok(undefined));
    const rows = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DeadLetterEntry);
    expect(rows.map((row) => row.runId)).toEqual([
      "run-visible-a",
      "run-following-b",
    ]);
    expect(dlq.size()).toBe(2);
  });

  it("serializes enqueue behind an active drain and persists the post-drain state", async () => {
    const eventBus = createMockEventBus();
    const original = makeFullEntry({
      runId: "run-draining",
      lastAttemptAt: 0,
      failedAt: 0,
    });
    await writeFile(filePath, `${JSON.stringify(original)}\n`, "utf-8");
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendToChannel = vi.fn(async () => {
      await gate;
      return true;
    });

    const drain = dlq.drain(sendToChannel);
    await vi.waitFor(() => expect(sendToChannel).toHaveBeenCalledOnce());
    const enqueue = dlq.enqueue(makeEntry({ runId: "run-after-drain" }));
    expect(dlq.size()).toBe(1);
    release?.();
    await drain;
    await expect(enqueue).resolves.toEqual(ok(undefined));

    expect(dlq.size()).toBe(1);
    const persisted = JSON.parse((await readFile(filePath, "utf-8")).trim()) as DeadLetterEntry;
    expect(persisted.runId).toBe("run-after-drain");
  });

  it("accepts msteams as a ChannelType and round-trips a dead-letter entry through enqueue and drain", async () => {
    // Type-level: msteams is a member of the closed ChannelType union. The
    // build type-check rejects both this assignment and the makeEntry call
    // below until the union admits "msteams".
    const channelType: ChannelType = "msteams";
    expect(channelType).toBe("msteams");

    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus, retryIntervalMs: 0 });

    await dlq.enqueue(
      makeEntry({
        runId: "run-msteams-1",
        channelType: "msteams",
        channelId: "19:meeting@thread.v2",
      }),
    );

    // Persisted with channelType "msteams".
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content.trim()) as DeadLetterEntry;
    expect(parsed.channelType).toBe("msteams");

    // And it round-trips through drain to sendToChannel with the msteams type.
    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);
    expect(sendToChannel).toHaveBeenCalledWith(
      "msteams",
      "19:meeting@thread.v2",
      "Task completed successfully",
      undefined,
    );
    expect(dlq.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A DLQ-recovered delivery must record its idempotency key as delivered.
// A budget-failed node's failure-key == its success-key, so a second sweep
// does not double-notify — but that depends on the key being in the shared
// deliveredKeys set. drain() accepts an onDelivered sink the wiring binds to
// deliveryDedup.mark / batcher.markDelivered, so a recovered key is marked.
// ---------------------------------------------------------------------------

describe("AnnouncementDeadLetterQueue drain marks recovered keys", () => {
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
    // No idempotencyKey: this is an unkeyed top-level-spawn DLQ row.
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

describe("AnnouncementDeadLetterQueue parent decision reservations", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dlq-parent-decision-"));
    filePath = join(tmpDir, "dlq.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function decisionInput(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: "default:user:telegram:chat-1::run-parent-1",
      agentId: "parent-agent",
      runId: "run-parent-1",
      announcementText: "scrubbed parent decision input",
      channelType: "telegram" as const,
      channelId: "chat-1",
      failedAt: 100,
      threadId: "topic-1",
      ...overrides,
    };
  }

  it("durably suppresses an existing parent decision across queue restart", async () => {
    const first = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(first.reserveDecision(decisionInput())).resolves.toEqual(
      ok({ created: true }),
    );

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.reserveDecision(decisionInput({ failedAt: 200 }))).resolves.toEqual(
      ok({ created: false }),
    );
    await expect(
      restarted.lookupDecision(decisionInput().idempotencyKey),
    ).resolves.toEqual(ok(decisionInput()));

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await restarted.drain(sendToChannel);
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(restarted.size()).toBe(1);
  });

  it("removes a parent decision only through an explicit terminal resolution", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await queue.reserveDecision(decisionInput());

    await expect(
      queue.resolveDecision(decisionInput().idempotencyKey, "no_reply"),
    ).resolves.toEqual(ok(true));
    await expect(
      queue.lookupDecision(decisionInput().idempotencyKey),
    ).resolves.toEqual(ok(undefined));
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains one pending decision when delivery failure lacks governed identity", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await queue.reserveDecision(decisionInput());

    await expect(queue.enqueue(makeEntry({
      runId: "run-parent-1",
      idempotencyKey: decisionInput().idempotencyKey,
      agentId: "parent-agent",
      channelId: "chat-1",
      threadId: "topic-1",
      lastError: "operation_validation_blocked",
    }))).resolves.toEqual(ok(undefined));

    expect(queue.size()).toBe(1);
    await expect(
      queue.lookupDecision(decisionInput().idempotencyKey),
    ).resolves.toEqual(ok(decisionInput()));
    expect((await readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("upserts a pending decision into one governed delivery row", async () => {
    const { ledger } = makeStubLedger();
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
    });
    await queue.reserveDecision(decisionInput());

    await expect(queue.enqueue(makeEntry({
      runId: "run-parent-1",
      idempotencyKey: decisionInput().idempotencyKey,
      agentId: "parent-agent",
      channelId: "chat-1",
      threadId: "topic-1",
      rootRunId: "root-parent-1",
      stepIndex: 4,
      lastError: "transport_failed",
    }))).resolves.toEqual(ok(undefined));

    expect(queue.size()).toBe(1);
    await expect(
      queue.lookupDecision(decisionInput().idempotencyKey),
    ).resolves.toEqual(ok(undefined));
    const rows = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!)).toMatchObject({
      idempotencyKey: decisionInput().idempotencyKey,
      rootRunId: "root-parent-1",
      stepIndex: 4,
    });
  });

  it("rejects a conflicting parent decision for the same idempotency key", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await queue.reserveDecision(decisionInput());

    const conflict = await queue.reserveDecision(decisionInput({
      announcementText: "different decision input",
    }));

    expect(conflict).toMatchObject({ ok: false });
    expect(queue.size()).toBe(1);
  });

  it("logs the bounded storage error when a parent decision cannot persist", async () => {
    const storageError = Object.assign(new Error("permission model denied atomic write"), {
      code: "ERR_ACCESS_DENIED",
    });
    const logger = createMockLogger();
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      logger,
      fileOperations: {
        open: vi.fn().mockRejectedValue(storageError),
        rename: vi.fn(),
        unlink: vi.fn(),
        chmod: vi.fn(),
      },
    });

    await expect(queue.reserveDecision(decisionInput())).resolves.toMatchObject({ ok: false });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "permission model denied atomic write" }),
      "Parent decision reservation was not durably persisted",
    );
  });
});

// ---------------------------------------------------------------------------
// The DLQ drain must consult the outward ledger before
// re-delivering. The in-memory deliveredKeys set rebuilds EMPTY on restart, so a
// JSONL entry whose announcement already COMMITTED in the durable ledger would be
// blindly re-delivered after a daemon restart — a second notify for the same run.
// The ledger is the only durable source of "already sent". An entry that
// carries a persisted (agentId, rootRunId, stepIndex) is checked against the
// ledger; a committed row → skip the send and treat it as delivered. Incomplete
// governed rows stay parked for operator review rather than bypassing the ledger.
// ---------------------------------------------------------------------------

/**
 * A stub OutwardSendLedgerPort whose `lookup` returns a configurable result and
 * records the (rootRunId, stepIndex) it was asked about. Transition methods are
 * spies so each fail-closed lifecycle can be asserted.
 */
interface StubLedgerOptions {
  lookupResult?: Result<OutwardSendRecord | undefined, Error>;
  beginResult?: Result<void, Error>;
  markUnknownResult?: Result<void, Error>;
  parkResult?: Result<boolean, Error>;
}

function makeStubLedger(
  options: StubLedgerOptions = {},
): { ledger: OutwardSendLedgerPort; lookupCalls: Array<[string, number]> } {
  const lookupCalls: Array<[string, number]> = [];
  const ledger: OutwardSendLedgerPort = {
    allocateStep: vi.fn(async () => ok(0)),
    lookup: vi.fn(async (rootRunId: string, stepIndex: number) => {
      lookupCalls.push([rootRunId, stepIndex]);
      return options.lookupResult ?? ok(undefined);
    }),
    begin: vi.fn(async () => options.beginResult ?? ok(undefined)),
    markUnknown: vi.fn(async () => options.markUnknownResult ?? ok(undefined)),
    commit: vi.fn(async () => ok(undefined)),
    markFailed: vi.fn(async () => ok(undefined)),
    parkUncertain: vi.fn(async () => options.parkResult ?? ok(true)),
    hasUncertainty: vi.fn(async () => ok(false)),
    listUnreconciled: vi.fn(async () => ok([])),
  };
  return { ledger, lookupCalls };
}

type GovernedDeadLetterEntry = DeadLetterEntry & { agentId: string };

function operationFingerprint(entry: DeadLetterEntry): string {
  return createHash("sha256")
    .update(JSON.stringify({
      channelId: entry.channelId,
      channelType: entry.channelType,
      kind: "cross_session_announcement",
      options: null,
      targetMessageId: null,
      text: entry.announcementText,
    }))
    .digest("hex");
}

/** A ledger row for the exact persisted announcement operation. */
function ledgerRow(
  entry: GovernedDeadLetterEntry,
  state: OutwardSendState,
  overrides: Partial<OutwardSendRecord> = {},
): OutwardSendRecord {
  const rootRunId = entry.rootRunId!;
  const stepIndex = entry.stepIndex!;
  return {
    id: `${rootRunId}:${stepIndex}`,
    rootRunId,
    stepIndex,
    agentId: entry.agentId,
    channelType: entry.channelType,
    channelId: entry.channelId,
    state,
    operationKind: "cross_session_announcement",
    operationFingerprint: operationFingerprint(entry),
    contentDigest: createHash("sha256").update(entry.announcementText).digest("hex"),
    attemptCount: 1,
    attemptedAtMs: entry.failedAt,
    ...(state === "committed" ? { platformMessageId: "msg-prior" } : {}),
    ...overrides,
  };
}

describe("AnnouncementDeadLetterQueue drain consults the outward ledger", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dlq-once-"));
    filePath = join(tmpDir, "dlq.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("committed → SKIP: an entry whose (rootRunId, stepIndex) is committed is NOT re-sent after restart", async () => {
    const eventBus = createMockEventBus();
    // A DLQ entry that carries its durable idempotency key.
    const entry = makeFullEntry({
      runId: "run-committed-1",
      idempotencyKey: "default:u1:c1::run-committed-1",
      rootRunId: "root-committed-1",
      stepIndex: 4,
      agentId: "parent-agent",
    } as Partial<DeadLetterEntry>) as GovernedDeadLetterEntry;
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const { ledger, lookupCalls } = makeStubLedger({
      lookupResult: ok(ledgerRow(entry, "committed")),
    });
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    // The retained committed receipt suppresses another channel call.
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(lookupCalls).toEqual([["root-committed-1", 4]]);
    // It is treated as delivered: onDelivered fires + the entry is dropped.
    expect(onDelivered).toHaveBeenCalledWith("default:u1:c1::run-committed-1");
    expect(dlq.size()).toBe(0);
  });

  it("commits a receipt-aware absent-row delivery before removing the dead letter", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-uncommitted-1",
      idempotencyKey: "default:u1:c1::run-uncommitted-1",
      rootRunId: "root-uncommitted-1",
      stepIndex: 9,
      agentId: "parent-agent",
      announcementText: "private completion payload",
    } as Partial<DeadLetterEntry>) as GovernedDeadLetterEntry;
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const { ledger, lookupCalls } = makeStubLedger({ lookupResult: ok(undefined) });
    const governedSendToChannel = vi.fn().mockResolvedValue(ok({
      delivered: true,
      platformMessageId: "telegram-receipt-9",
    }));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
      governedSendToChannel,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    expect(lookupCalls).toEqual([["root-uncommitted-1", 9]]);
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(governedSendToChannel).toHaveBeenCalledOnce();
    expect(ledger.begin).toHaveBeenCalledWith({
      rootRunId: "root-uncommitted-1",
      stepIndex: 9,
      agentId: "parent-agent",
      channelType: "telegram",
      channelId: "chat-123",
      operationKind: "cross_session_announcement",
      operationFingerprint: operationFingerprint(entry),
      contentDigest: createHash("sha256").update(entry.announcementText).digest("hex"),
    });
    expect(ledger.markUnknown).toHaveBeenCalledWith("root-uncommitted-1", 9);
    expect(ledger.commit).toHaveBeenCalledWith(
      "root-uncommitted-1",
      9,
      "telegram-receipt-9",
    );
    expect(ledger.parkUncertain).not.toHaveBeenCalled();
    expect(vi.mocked(ledger.begin).mock.invocationCallOrder[0])
      .toBeLessThan(governedSendToChannel.mock.invocationCallOrder[0]!);
    expect(vi.mocked(ledger.markUnknown).mock.invocationCallOrder[0])
      .toBeLessThan(governedSendToChannel.mock.invocationCallOrder[0]!);
    expect(governedSendToChannel.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(ledger.commit).mock.invocationCallOrder[0]!);
    expect(JSON.stringify(vi.mocked(ledger.begin).mock.calls[0]![0]))
      .not.toContain(entry.announcementText);
    expect(onDelivered).toHaveBeenCalledWith("default:u1:c1::run-uncommitted-1");
    expect(dlq.size()).toBe(0);
  });

  it("retains an absent governed row without beginning when receipt-aware transport is unavailable", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-no-receipt-transport",
      rootRunId: "root-no-receipt-transport",
      stepIndex: 12,
      agentId: "parent-agent",
    }) as GovernedDeadLetterEntry;
    await writeFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
    const { ledger } = makeStubLedger({ lookupResult: ok(undefined) });
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const booleanSender = vi.fn().mockResolvedValue(true);

    await dlq.drain(booleanSender);

    expect(booleanSender).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
    expect(ledger.markUnknown).not.toHaveBeenCalled();
    expect(ledger.commit).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(1);
  });

  it.each([
    ["send_attempt_started", true, true],
    ["unknown_after_send", true, false],
    ["unresolved", false, false],
    ["failed", false, false],
  ] as const)("retained %s rows block direct replay and remain queued", async (state, shouldPark, parkWins) => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: `run-${state}`,
      idempotencyKey: `default:u1:c1::run-${state}`,
      rootRunId: `root-${state}`,
      stepIndex: 2,
      agentId: "parent-agent",
    } as Partial<DeadLetterEntry>) as GovernedDeadLetterEntry;
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    const { ledger } = makeStubLedger({
      lookupResult: ok(ledgerRow(entry, state)),
      parkResult: ok(parkWins),
    });
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);

    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
    expect(ledger.parkUncertain).toHaveBeenCalledTimes(shouldPark ? 1 : 0);
    if (shouldPark) {
      expect(eventBus.emit).toHaveBeenCalledWith(
        "delivery:outward_ledger_transition",
        expect.objectContaining({
          transition: "park",
          outcome: parkWins ? "parked" : "blocked",
        }),
      );
    }
    expect(dlq.size()).toBe(1);
  });

  it("blocks and escalates a ledger lookup error without leaking the payload or error text", async () => {
    const eventBus = createMockEventBus();
    const logger = createMockLogger();
    const entry = makeFullEntry({
      runId: "run-lookup-error",
      idempotencyKey: "default:u1:c1::run-lookup-error",
      rootRunId: "root-lookup-error",
      stepIndex: 5,
      agentId: "parent-agent",
      announcementText: "private Telegram message body",
    } as Partial<DeadLetterEntry>) as GovernedDeadLetterEntry;
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    const { ledger } = makeStubLedger({
      lookupResult: err(new Error("credential-bearing database failure")),
    });
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      logger,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);

    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
    expect(ledger.parkUncertain).toHaveBeenCalledWith("root-lookup-error", 5);
    expect(dlq.size()).toBe(1);
    expect(eventBus.emit).toHaveBeenCalledWith(
      "delivery:outward_ledger_transition",
      expect.objectContaining({
        rootRunId: "root-lookup-error",
        stepIndex: 5,
        transition: "lookup",
        outcome: "blocked",
      }),
    );
    const telemetry = JSON.stringify({
      logs: vi.mocked(logger.error).mock.calls,
      events: vi.mocked(eventBus.emit).mock.calls,
    });
    expect(telemetry).not.toContain(entry.announcementText);
    expect(telemetry).not.toContain("credential-bearing database failure");
  });

  it("isolates transport, park, and observational failures without leaking their text or replaying in the same drain", async () => {
    const logger = createMockLogger();
    const eventBus = createMockEventBus({
      emitSafely: vi.fn(() => {
        throw new Error("private observer failure");
      }),
    });
    const entry = makeFullEntry({
      runId: "run-isolated-failures",
      idempotencyKey: "default:u1:c1::run-isolated-failures",
      rootRunId: "root-isolated-failures",
      stepIndex: 10,
      agentId: "parent-agent",
      announcementText: "private governed announcement",
    } as Partial<DeadLetterEntry>) as GovernedDeadLetterEntry;
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    const { ledger } = makeStubLedger({
      parkResult: err(new Error("private park failure")),
    });
    const governedSendToChannel = vi.fn().mockRejectedValue(
      new Error("private transport failure"),
    );
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      logger,
      retryIntervalMs: 0,
      outwardLedger: ledger,
      governedSendToChannel,
    });
    const sendToChannel = vi.fn().mockRejectedValue(new Error("private transport failure"));

    await expect(dlq.drain(sendToChannel)).resolves.toBeUndefined();

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(governedSendToChannel).toHaveBeenCalledOnce();
    expect(ledger.parkUncertain).toHaveBeenCalledWith("root-isolated-failures", 10);
    expect(dlq.size()).toBe(1);
    const telemetry = JSON.stringify({
      warnings: vi.mocked(logger.warn).mock.calls,
      errors: vi.mocked(logger.error).mock.calls,
    });
    expect(telemetry).not.toContain(entry.announcementText);
    expect(telemetry).not.toContain("private observer failure");
    expect(telemetry).not.toContain("private park failure");
    expect(telemetry).not.toContain("private transport failure");
  });

  it.each([
    ["begin", { beginResult: err(new Error("begin secret")) }],
    ["mark_unknown", { markUnknownResult: err(new Error("unknown secret")) }],
  ] as const)("blocks before the channel when the %s ledger transition fails", async (_transition, failures) => {
    const eventBus = createMockEventBus();
    const logger = createMockLogger();
    const entry = makeFullEntry({
      runId: "run-transition-error",
      idempotencyKey: "default:u1:c1::run-transition-error",
      rootRunId: "root-transition-error",
      stepIndex: 6,
      agentId: "parent-agent",
    } as Partial<DeadLetterEntry>) as GovernedDeadLetterEntry;
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    const { ledger } = makeStubLedger(failures);
    const governedSendToChannel = vi.fn().mockResolvedValue(ok({
      delivered: true,
      platformMessageId: "unused-receipt",
    }));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      logger,
      retryIntervalMs: 0,
      outwardLedger: ledger,
      governedSendToChannel,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);

    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(ledger.parkUncertain).toHaveBeenCalledWith("root-transition-error", 6);
    expect(dlq.size()).toBe(1);
  });

  it("blocks a committed row without an authoritative platform receipt", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-committed-no-receipt",
      idempotencyKey: "default:u1:c1::run-committed-no-receipt",
      rootRunId: "root-committed-no-receipt",
      stepIndex: 7,
      agentId: "parent-agent",
    } as Partial<DeadLetterEntry>) as GovernedDeadLetterEntry;
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    const { ledger } = makeStubLedger({
      lookupResult: ok(ledgerRow(entry, "committed", { platformMessageId: undefined })),
    });
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(1);
  });

  it("blocks a retained row whose operation identity differs from the queued announcement", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-identity-mismatch",
      idempotencyKey: "default:u1:c1::run-identity-mismatch",
      rootRunId: "root-identity-mismatch",
      stepIndex: 8,
      agentId: "parent-agent",
    } as Partial<DeadLetterEntry>) as GovernedDeadLetterEntry;
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    const { ledger } = makeStubLedger({
      lookupResult: ok(ledgerRow(entry, "committed", {
        operationFingerprint: "f".repeat(64),
      })),
    });
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);

    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(ledger.parkUncertain).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(1);
  });

  it("stepIndex persisted: enqueue persists (rootRunId, stepIndex) on the JSONL row; a reload preserves the key across a restart", async () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    await dlq.enqueue(
      makeEntry({
        runId: "run-persist-key",
        idempotencyKey: "default:u1:c1::run-persist-key",
        rootRunId: "root-persist-key",
        stepIndex: 3,
        agentId: "parent-agent",
      }),
    );

    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content.trim()) as DeadLetterEntry;
    expect(parsed.rootRunId).toBe("root-persist-key");
    expect(parsed.stepIndex).toBe(3);
    expect(parsed.agentId).toBe("parent-agent");

    // A fresh queue (simulating a restart) reloads the row and, with a committed
    // ledger, skips the re-send using the SAME persisted key.
    const persisted = parsed as GovernedDeadLetterEntry;
    const { ledger, lookupCalls } = makeStubLedger({
      lookupResult: ok(ledgerRow(persisted, "committed")),
    });
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

  it("fails closed when a ledger-wired entry lacks its complete governed operation identity", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-incomplete-identity",
      rootRunId: "root-incomplete-identity",
      stepIndex: 11,
    });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const { ledger, lookupCalls } = makeStubLedger();
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });
    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(lookupCalls).toEqual([]);
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "delivery:outward_ledger_transition",
      expect.objectContaining({
        rootRunId: "root-incomplete-identity",
        stepIndex: 11,
        transition: "lookup",
        outcome: "blocked",
      }),
    );
    expect(dlq.size()).toBe(1);
  });

  it("never age-expires, attempt-drops, or capacity-evicts governed quarantine evidence", async () => {
    const eventBus = createMockEventBus();
    const entryA = makeFullEntry({
      runId: "run-quarantine-a",
      rootRunId: "root-quarantine-a",
      stepIndex: 1,
      agentId: "parent-agent",
      failedAt: 0,
      attemptCount: 99,
      lastAttemptAt: 0,
    }) as GovernedDeadLetterEntry;
    const entryB = makeFullEntry({
      runId: "run-quarantine-b",
      rootRunId: "root-quarantine-b",
      stepIndex: 2,
      agentId: "parent-agent",
      failedAt: 0,
      attemptCount: 99,
      lastAttemptAt: 0,
    }) as GovernedDeadLetterEntry;
    const rows = new Map([
      [entryA.rootRunId, ledgerRow(entryA, "unresolved")],
      [entryB.rootRunId, ledgerRow(entryB, "unresolved")],
    ]);
    const { ledger } = makeStubLedger();
    ledger.lookup = vi.fn(async (rootRunId) => ok(rows.get(rootRunId)));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      maxAgeMs: 1,
      maxEntries: 1,
      maxRetries: 1,
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });

    for (const entry of [entryA, entryB]) {
      await dlq.enqueue({
        announcementText: entry.announcementText,
        channelType: entry.channelType,
        channelId: entry.channelId,
        agentId: entry.agentId,
        runId: entry.runId,
        failedAt: entry.failedAt,
        attemptCount: entry.attemptCount,
        rootRunId: entry.rootRunId,
        stepIndex: entry.stepIndex,
      });
    }
    expect(dlq.size()).toBe(2);

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(2);
    const persisted = (await readFile(filePath, "utf-8")).trim().split("\n");
    expect(persisted).toHaveLength(2);
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
