// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmod,
  mkdir,
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
import { setTimeout as delay } from "node:timers/promises";
import { err, ok, type Result } from "@comis/shared";
import {
  createConversationLocator,
  createStableAnnouncementChunkOperationId,
  type ChannelEndpoint,
  type DeliveryAuthority,
  type OutwardSendLedgerPort,
  type OutwardSendRecord,
  type OutwardSendState,
} from "@comis/core";

import {
  createAnnouncementDeadLetterQueue,
  type AnnouncementDeadLetterQueue,
  type ChannelType,
  type DeadLetterEntry,
  type AnnouncementLogger,
} from "./announcement-dead-letter.js";
import type { DeadLetterWriteOperations } from "./announcement-dead-letter-file.js";
import { isSameAnnouncementRecovery } from "./announcement-dead-letter-identity.js";
import {
  createAnnouncementTerminalDecisionStore,
  createTerminalDecisionRecord,
} from "./announcement-dead-letter-terminal-decision.js";
import type { RecoveryDeliveryOptions } from "./announcement-dead-letter-types.js";
import { createMockLogger as _createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

const createMockLogger = (): AnnouncementLogger => _createMockLogger() as unknown as AnnouncementLogger;


// ---------------------------------------------------------------------------
// Test helpers
function makeDeliveryAuthority(agentId = "agent-a"): DeliveryAuthority {
  const locator = createConversationLocator({
    tenantId: "default",
    agentId,
    partition: { kind: "agent" },
  });
  if (!locator.ok) throw locator.error;
  return {
    tenantId: "default",
    agentId,
    conversationRef: locator.value.conversationRef,
  };
}

function makeDestinationEndpoint(
  channelType: string,
  channelId: string,
  threadId?: string,
): ChannelEndpoint {
  return {
    channelType,
    channelInstanceId: "test-instance",
    conversationId: channelId,
    conversationKind: "direct",
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function snapshotAttachment(sourceAgentId: string, sourcePath: string) {
  return {
    kind: "snapshot" as const,
    sourceAgentId,
    sourcePath,
    path: `/snapshots/${sourceAgentId}-${sourcePath.replaceAll("/", "-")}`,
    fileName: sourcePath.split("/").at(-1) ?? "attachment.bin",
    mimeType: "application/octet-stream",
    contentDigest: createHash("sha256").update(`${sourceAgentId}:${sourcePath}`).digest("hex"),
    sizeBytes: 12,
  };
}

function makeEntry(
  overrides: Partial<Omit<DeadLetterEntry, "id" | "lastAttemptAt">> = {},
): Omit<DeadLetterEntry, "id" | "lastAttemptAt"> {
  const entry = {
    announcementText: "Task completed successfully",
    channelType: "telegram",
    channelId: "chat-123",
    agentId: "agent-a",
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: "default:agent-a:telegram:chat-123:user_a",
    failedAt: Date.now(),
    attemptCount: 0,
    ...overrides,
  };
  return {
    ...entry,
    deliveryAuthority: overrides.deliveryAuthority
      ?? makeDeliveryAuthority(entry.agentId ?? "agent-a"),
    destinationEndpoint: overrides.destinationEndpoint
      ?? makeDestinationEndpoint(entry.channelType, entry.channelId, entry.threadId),
  };
}

function makeFullEntry(
  overrides: Partial<DeadLetterEntry> = {},
): DeadLetterEntry {
  const entry = {
    id: crypto.randomUUID(),
    announcementText: "Task completed successfully",
    channelType: "telegram",
    channelId: "chat-123",
    agentId: "agent-a",
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: "default:agent-a:telegram:chat-123:user_a",
    failedAt: Date.now() - 120_000,
    attemptCount: 0,
    lastAttemptAt: Date.now() - 120_000,
    ...overrides,
  };
  return {
    ...entry,
    deliveryAuthority: overrides.deliveryAuthority
      ?? makeDeliveryAuthority(entry.agentId ?? "agent-a"),
    destinationEndpoint: overrides.destinationEndpoint
      ?? makeDestinationEndpoint(entry.channelType, entry.channelId, entry.threadId),
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

async function listQuarantined(
  queue: ReturnType<typeof createAnnouncementDeadLetterQueue>,
) {
  const listed = await queue.listQuarantined();
  if (!listed.ok) throw listed.error;
  return listed.value;
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

  it("reconciles attachment storage against the loaded durable references", async () => {
    const attachment = snapshotAttachment("agent-a", "report.csv");
    await writeFile(filePath, `${JSON.stringify({
      ...makeEntry({ runId: "run-reconcile-snapshots", attachment }),
      id: "entry-reconcile-snapshots",
      lastAttemptAt: 0,
    })}\n`, "utf8");
    const reconcileAttachments = vi.fn(async () => ok(undefined));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      reconcileAttachments,
    });

    await expect(dlq.durableStatus()).resolves.toMatchObject({ ok: true });

    expect(reconcileAttachments).toHaveBeenCalledWith([attachment.path]);
  });

  it("compares two ungoverned recovery rows without inventing route authority", () => {
    const existing = makeFullEntry({
      runId: "run-ungoverned-identity",
      idempotencyKey: "recovery-ungoverned-identity",
    });
    const candidate = makeEntry({
      runId: "run-ungoverned-identity",
      idempotencyKey: "recovery-ungoverned-identity",
    });
    delete existing.deliveryAuthority;
    delete existing.destinationEndpoint;
    delete candidate.deliveryAuthority;
    delete candidate.destinationEndpoint;

    expect(isSameAnnouncementRecovery(existing, candidate)).toEqual(ok(true));
  });

  it("rejects a recovery comparison when persisted options are not JSON values", () => {
    const existing = makeFullEntry({
      runId: "run-invalid-persisted-options",
      idempotencyKey: "recovery-invalid-persisted-options",
      extra: { unsafe: 1n },
    });
    const candidate = makeEntry({
      runId: "run-invalid-persisted-options",
      idempotencyKey: "recovery-invalid-persisted-options",
    });

    expect(isSameAnnouncementRecovery(existing, candidate)).toMatchObject({ ok: false });
  });

  it("rejects a recovery comparison when retried options are not JSON values", () => {
    const existing = makeFullEntry({
      runId: "run-invalid-retried-options",
      idempotencyKey: "recovery-invalid-retried-options",
    });
    const candidate = makeEntry({
      runId: "run-invalid-retried-options",
      idempotencyKey: "recovery-invalid-retried-options",
      extra: { unsafe: 1n },
    });

    expect(isSameAnnouncementRecovery(existing, candidate)).toMatchObject({ ok: false });
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
        sessionKey: "default:agent-a:telegram:chat-123:user_a",
        channelType: "discord",
        reason: "delivery_failed",
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

  it("backpressures new admissions when retained storage reaches capacity", async () => {
    const eventBus = createMockEventBus();
    const logger = createMockLogger();
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      maxEntries: 3,
      retryIntervalMs: 0,
      logger,
    });

    await dlq.enqueue(makeEntry({ runId: "run-1" }));
    await dlq.enqueue(makeEntry({ runId: "run-2" }));
    await dlq.enqueue(makeEntry({ runId: "run-3" }));
    let settled = false;
    const overflow = dlq.enqueue(makeEntry({ runId: "run-4" })).finally(() => {
      settled = true;
    });
    await delay(10);

    expect(settled).toBe(false);
    expect(dlq.size()).toBe(3);
    await dlq.drain(vi.fn(async () => true));
    await expect(overflow).resolves.toEqual(ok(undefined));
    expect(dlq.size()).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entryCount: 3,
        maxEntries: 3,
        errorKind: "resource",
      }),
      "Dead-letter quarantine capacity exhausted",
    );
  });

  it("cancels a capacity-blocked admission without releasing retained evidence", async () => {
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 1,
    });
    await expect(dlq.enqueue(makeEntry({ runId: "run-capacity-owner" })))
      .resolves.toEqual(ok(undefined));
    const controller = new AbortController();

    const blocked = dlq.enqueue(makeEntry({ runId: "run-cancelled-waiter" }), controller.signal);
    controller.abort();

    await expect(blocked).resolves.toMatchObject({
      ok: false,
      error: { message: "Dead-letter admission cancelled" },
    });
    expect(dlq.size()).toBe(1);
  });

  it("parks a receipt-unknown retry before it can be replayed", async () => {
    const receiptAwareSendToChannel = vi.fn(async () => ok({
      delivered: false as const,
      status: "unknown" as const,
    }));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
      receiptAwareSendToChannel,
    });
    await dlq.enqueue(makeEntry({
      runId: "run-unknown-receipt",
      idempotencyKey: "unknown-receipt",
      lastError: "transport_rejected",
    }));

    await dlq.drain(vi.fn(async () => true));
    await dlq.drain(vi.fn(async () => true));

    expect(receiptAwareSendToChannel).toHaveBeenCalledOnce();
    expect(await listQuarantined(dlq)).toEqual([
      expect.objectContaining({
        runId: "run-unknown-receipt",
        lastError: "outward_operation_unresolved",
      }),
    ]);
  });

  it("suppresses readmission after a matching quarantine row is discarded", async () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({ filePath, eventBus });
    const entry = makeEntry({
      runId: "run-released-and-readmitted",
      attemptCount: 5,
    });

    await dlq.enqueue(entry);
    const id = (await listQuarantined(dlq))[0]!.id;
    await dlq.release(id, "discarded");
    await dlq.enqueue(entry);

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(dlq.size()).toBe(0);
    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await restarted.enqueue(entry);
    expect(restarted.size()).toBe(0);
  });

  it("suppresses readmission after a matching quarantine row is delivered", async () => {
    const eventBus = createMockEventBus();
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      retryIntervalMs: 0,
    });
    const entry = makeEntry({ runId: "run-delivered-and-readmitted" });

    await dlq.enqueue(entry);
    await dlq.drain(vi.fn().mockResolvedValue(true));
    await dlq.enqueue(entry);

    const admissions = vi.mocked(eventBus.emit).mock.calls.filter(
      ([eventName]) => eventName === "announcement:dead_lettered",
    );
    expect(admissions).toHaveLength(1);
    expect(dlq.size()).toBe(0);
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
      {
        authority: entry.deliveryAuthority,
        destinationEndpoint: entry.destinationEndpoint,
      },
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
      {
        threadId: "topic-42",
        authority: entry.deliveryAuthority,
        destinationEndpoint: entry.destinationEndpoint,
      },
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

  it("parks entries after every configured recovery attempt is exhausted", async () => {
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
    expect(dlq.size()).toBe(1);
    expect(await listQuarantined(dlq)).toMatchObject([{
      kind: "entry",
      lastError: "attempt_limit_reached",
    }]);
  });

  it("allows the configured recovery attempt after the initial platform attempt", async () => {
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxRetries: 1,
      retryIntervalMs: 0,
    });
    const entry = makeEntry({
      idempotencyKey: "initial-plus-one-recovery",
      completionKeys: ["initial-plus-one-recovery"],
    });

    await expect(dlq.beginDeliveryAttempt(entry)).resolves.toEqual(ok({ claimed: true }));
    await expect(dlq.settleDeliveryAttempt("initial-plus-one-recovery", "rejected"))
      .resolves.toEqual(ok(true));
    const sendToChannel = vi.fn().mockResolvedValue(true);

    await dlq.drain(sendToChannel);

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(dlq.size()).toBe(0);
  });

  it("refuses direct reentry after its recovery attempts are exhausted", async () => {
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxRetries: 1,
      retryIntervalMs: 0,
    });
    const entry = makeEntry({
      idempotencyKey: "bounded-direct-reentry",
      completionKeys: ["bounded-direct-reentry"],
    });

    await expect(dlq.beginDeliveryAttempt(entry)).resolves.toEqual(ok({ claimed: true }));
    await dlq.settleDeliveryAttempt("bounded-direct-reentry", "rejected");
    await expect(dlq.beginDeliveryAttempt(entry)).resolves.toEqual(ok({ claimed: true }));
    await dlq.settleDeliveryAttempt("bounded-direct-reentry", "rejected");

    await expect(dlq.beginDeliveryAttempt(entry)).resolves.toEqual(ok({ claimed: false }));
  });

  it("retires claimed chunk aliases with their logical producer ownership", async () => {
    const producerExists = vi.fn(async () => ok(false));
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
      retirementProducerExists: producerExists,
    });
    const reservation = {
      idempotencyKey: "chunk-operation",
      agentId: "agent-a",
      runId: "chunk-run",
      sessionKey: "default:agent-a:telegram:chat-123:user_a",
      announcementText: "chunk result",
      channelType: "telegram",
      channelId: "chat-123",
      failedAt: Date.now(),
      rootRunId: "root-chunk-run",
      deliveryAuthority: makeDeliveryAuthority("agent-a"),
      destinationEndpoint: makeDestinationEndpoint("telegram", "chat-123"),
      completionKeys: ["parent-operation", "logical-completion"],
      retirementKeys: ["logical-completion"],
    };
    await expect(queue.reserveDecision(reservation)).resolves.toEqual(ok({ created: true }));
    const { retirementKeys: _retirementKeys, ...attempt } = {
      ...reservation,
      attemptCount: 0,
      lastError: "outward_operation_in_flight",
    };
    await expect(queue.beginDeliveryAttempt(attempt)).resolves.toEqual(ok({ claimed: true }));
    await expect(queue.settleDeliveryAttempt("chunk-operation", "accepted"))
      .resolves.toEqual(ok(true));
    await expect(queue.prepareTerminalDecisionRetirement(["logical-completion"], {
      kind: "graph",
      tenantId: "default",
      graphId: "retired-graph",
    })).resolves.toEqual(ok(undefined));

    await queue.drain(vi.fn(async () => false));

    const terminalStore = createAnnouncementTerminalDecisionStore(filePath);
    await expect(terminalStore.lookup(reservation))
      .resolves.toEqual(ok(undefined));
    await expect(terminalStore.lookup({
      ...reservation,
      idempotencyKey: "parent-operation",
      completionKeys: ["parent-operation"],
    })).resolves.toEqual(ok(undefined));
  });

  it("refuses direct reentry after its recovery retention window", async () => {
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxRetries: 5,
      maxAgeMs: 1,
      retryIntervalMs: 0,
    });
    const entry = makeEntry({
      idempotencyKey: "aged-direct-reentry",
      completionKeys: ["aged-direct-reentry"],
      failedAt: Date.now() - 1_000,
    });

    await dlq.beginDeliveryAttempt(entry);
    await dlq.settleDeliveryAttempt("aged-direct-reentry", "rejected");

    await expect(dlq.beginDeliveryAttempt(entry)).resolves.toEqual(ok({ claimed: false }));
  });

  it("parks entries after maxAgeMs until an operator releases them", async () => {
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
    expect(dlq.size()).toBe(1);
    expect(await listQuarantined(dlq)).toMatchObject([{
      kind: "entry",
      lastError: "retention_window_elapsed",
    }]);
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
    expect(persisted.lastError).toBe("outward_operation_unresolved");
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

  it("quarantines a malformed row without blocking delivery or admission", async () => {
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
    const enqueueResult = await dlq.enqueue(makeEntry({ runId: "run-new-admission" }));
    await dlq.drain(sendToChannel);

    expect(enqueueResult).toMatchObject({ ok: true });
    expect(sendToChannel).toHaveBeenCalledTimes(3);
    expect(dlq.size()).toBe(1);
    const quarantined = await listQuarantined(dlq);
    expect(quarantined).toMatchObject([{
      kind: "invalid_record",
      reason: "invalid_json",
      sourceLine: 2,
    }]);
    expect(JSON.stringify(quarantined)).not.toContain("not json{corrupt line");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        invalidRowCount: 1,
        errorKind: "precondition",
        hint: "review and explicitly release invalid dead-letter records; valid announcements remain available",
      }),
      "Invalid dead-letter rows quarantined",
    );
    const persisted = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0]!)).toMatchObject({ recordType: "invalid_record" });

    const released = await dlq.release(quarantined[0]!.id, "discarded");
    expect(released).toMatchObject({ ok: true, value: true });
    expect(dlq.size()).toBe(0);
  });

  it("isolates invalid terminal records without disabling valid identities", async () => {
    const terminalInput = (idempotencyKey: string, runId: string) => ({
      idempotencyKey,
      agentId: "agent-a",
      runId,
      sessionKey: "default:agent-a:telegram:chat-123:user_a",
      announcementText: "terminal decision input",
      channelType: "telegram" as const,
      channelId: "chat-123",
      failedAt: 100,
      rootRunId: `root-${runId}`,
      deliveryAuthority: makeDeliveryAuthority("agent-a"),
      destinationEndpoint: makeDestinationEndpoint("telegram", "chat-123"),
      completionKeys: [idempotencyKey],
    });
    const validDecision = terminalInput("valid-terminal-operation", "valid-terminal-run");
    const malformedDecision = terminalInput(
      "malformed-terminal-operation",
      "malformed-terminal-run",
    );
    const oversizedDecision = terminalInput(
      "oversized-terminal-operation",
      "oversized-terminal-run",
    );
    const store = createAnnouncementTerminalDecisionStore(filePath);
    await expect(store.record(validDecision, "delivered")).resolves.toEqual(ok(undefined));
    const malformed = createTerminalDecisionRecord(malformedDecision, "discarded", 1);
    const oversized = createTerminalDecisionRecord(oversizedDecision, "no_reply", 1);
    if (!malformed.ok) throw malformed.error;
    if (!oversized.ok) throw oversized.error;
    const terminalRoot = `${filePath}.terminal-decisions`;
    const malformedDirectory = join(
      terminalRoot,
      "decisions",
      malformed.value.keyDigest.slice(0, 2),
    );
    const oversizedDirectory = join(
      terminalRoot,
      "decisions",
      oversized.value.keyDigest.slice(0, 2),
    );
    await mkdir(malformedDirectory, { recursive: true });
    await mkdir(oversizedDirectory, { recursive: true });
    const malformedPath = join(malformedDirectory, `${malformed.value.keyDigest}.json`);
    const oversizedPath = join(oversizedDirectory, `${oversized.value.keyDigest}.json`);
    const strayPath = join(terminalRoot, "decisions", "stray.json");
    await writeFile(malformedPath, "{malformed");
    await writeFile(oversizedPath, Buffer.alloc(1_048_577, 120));
    await writeFile(strayPath, "stray");

    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });

    await expect(queue.durableStatus()).resolves.toEqual(ok({
      activeRecoveryCount: 0,
      quarantinedCount: 3,
    }));
    expect(await listQuarantined(queue)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invalid_record", reason: "invalid_json" }),
      expect.objectContaining({ kind: "invalid_record", reason: "oversized_row" }),
      expect.objectContaining({ kind: "invalid_record", reason: "schema_mismatch" }),
    ]));
    await expect(queue.reserveDecision(validDecision)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "delivered",
    }));
    await expect(queue.reserveDecision(malformedDecision)).resolves.toMatchObject({ ok: false });
    await expect(queue.reserveDecision(terminalInput(
      "unrelated-terminal-operation",
      "unrelated-terminal-run",
    ))).resolves.toEqual(ok({ created: true }));

    await writeFile(malformedPath, JSON.stringify(malformed.value));
    await unlink(oversizedPath);
    await unlink(strayPath);

    await expect(queue.durableStatus()).resolves.toEqual(ok({
      activeRecoveryCount: 1,
      quarantinedCount: 0,
    }));
    await expect(listQuarantined(queue)).resolves.toEqual([]);
    await expect(queue.reserveDecision(malformedDecision)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "discarded",
    }));
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

  it("loads the durable count before the first health observation after restart", async () => {
    const seeded = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await seeded.enqueue(makeEntry({ runId: "run-before-restart" }));
    const fresh = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });

    const result = await fresh.durableStatus();

    expect(result).toEqual(ok({ activeRecoveryCount: 1, quarantinedCount: 0 }));
    expect(fresh.size()).toBe(1);
  });

  it("quarantine listing reports a disk read failure instead of an empty list", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath: tmpDir,
      eventBus: createMockEventBus(),
    });

    await expect(queue.listQuarantined()).resolves.toMatchObject({ ok: false });
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

    const visibleEntry = makeEntry({
      runId: "run-visible-a",
      idempotencyKey: "session-a::run-visible-a",
    });
    const first = await dlq.enqueue(visibleEntry);
    expect(first).toMatchObject({ ok: false });
    expect(dlq.size()).toBe(1);

    await expect(dlq.enqueue(visibleEntry)).resolves.toEqual(ok(undefined));
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

  it("rejects one recovery key reused for different announcement content", async () => {
    const logger = createMockLogger();
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      logger,
    });
    const original = makeEntry({
      runId: "run-key-owner",
      idempotencyKey: "session-a::run-key-owner",
      announcementText: "first completion",
    });
    await dlq.enqueue(original);

    const conflict = await dlq.enqueue({
      ...original,
      announcementText: "different completion",
    });

    expect(conflict).toMatchObject({ ok: false });
    expect(dlq.size()).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "validation",
        hint: "reuse a dead-letter recovery key only for its exact original owner, destination, and content",
      }),
      "Dead-letter recovery key identity mismatch",
    );
  });

  it("rejects one recovery key reused for a different authenticated endpoint", async () => {
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    const original = makeEntry({
      runId: "run-route-owner",
      idempotencyKey: "session-a::run-route-owner",
    });
    await dlq.enqueue(original);

    const conflict = await dlq.enqueue({
      ...original,
      destinationEndpoint: {
        ...makeDestinationEndpoint("telegram", "chat-123"),
        channelInstanceId: "other-instance",
      },
    });
    if (conflict.ok) {
      throw new Error("route identity conflict was admitted");
    }

    expect(conflict.error.message).toContain("identity mismatch");
    expect(dlq.size()).toBe(1);
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
      {
        authority: parsed.deliveryAuthority,
        destinationEndpoint: parsed.destinationEndpoint,
      },
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

  // The quarantine WARN is emitted at the non-zero transition and the dead-letter
  // file is unlinked once the queue drains, so an operator who reads the WARN
  // later finds no file and no resolution line at the default log level — the
  // resolution was DEBUG-only. Live, that combination read as "the announcement
  // was lost" when the entry had in fact been dropped correctly because the
  // outward ledger proved the user was already told.
  it("records the resolution at INFO so a drained quarantine is visible without debug logging", async () => {
    const logger = createMockLogger();
    const entry = makeFullEntry({
      runId: "run-resolution-visible",
      idempotencyKey: "default:u1:c1::run-resolution-visible",
    });
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    const dlq = createAnnouncementDeadLetterQueue({
      filePath, eventBus: createMockEventBus(), logger, retryIntervalMs: 0,
    });

    await dlq.drain(vi.fn().mockResolvedValue(true));

    const resolutions = (logger.info as unknown as { mock: { calls: [Record<string, unknown>, string][] } })
      .mock.calls.filter(([, msg]) => /dead-letter/i.test(msg));
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.[0]).toMatchObject({ runId: "run-resolution-visible" });
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
      sessionKey: "default:user:telegram:chat-1",
      announcementText: "scrubbed parent decision input",
      channelType: "telegram" as const,
      channelId: "chat-1",
      failedAt: 100,
      threadId: "topic-1",
      rootRunId: "root-parent-1",
      deliveryAuthority: makeDeliveryAuthority("parent-agent"),
      destinationEndpoint: makeDestinationEndpoint("telegram", "chat-1", "topic-1"),
      completionKeys: ["default:user:telegram:chat-1::run-parent-1"],
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

  it("blocks reservation growth without evicting an existing completion owner", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 1,
    });
    const completionKey = decisionInput().idempotencyKey;
    await expect(queue.reserveDecision(decisionInput())).resolves.toEqual(
      ok({ created: true }),
    );

    let secondSettled = false;
    const secondReservation = queue.reserveDecision(decisionInput({
      idempotencyKey: "second-completion",
      runId: "run-parent-2",
      completionKeys: ["second-completion"],
    })).finally(() => {
      secondSettled = true;
    });
    await delay(10);
    expect(secondSettled).toBe(false);
    await expect(queue.lookupDecision(completionKey)).resolves.toEqual(ok(decisionInput()));

    await expect(queue.resolveDecision(completionKey, "no_reply"))
      .resolves.toEqual(ok(true));
    await expect(secondReservation).resolves.toEqual(ok({ created: true }));
    await expect(queue.replaceDecisions(["second-completion"], [
      decisionInput({
        idempotencyKey: "operation-summary",
        runId: "run-parent-2",
        completionKeys: ["second-completion"],
      }),
      decisionInput({
        idempotencyKey: "operation-attachment",
        runId: "run-parent-2",
        partId: "attachment:0",
        completionKeys: ["second-completion"],
      }),
    ])).resolves.toMatchObject({ ok: false });

    await expect(queue.lookupDecision("second-completion")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ idempotencyKey: "second-completion" }),
    });
    expect(queue.size()).toBe(1);
  });

  it("rewrites concrete attachment reservations without increasing capacity", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 2,
    });
    const firstOperation = decisionInput({
      idempotencyKey: "attachment-operation-a",
      runId: "run-parent-a",
      partId: "attachment:0",
      attachment: snapshotAttachment("worker-a", "a.csv"),
      completionKeys: ["attachment-operation-a", "completion-a"],
    });
    const secondOperation = decisionInput({
      idempotencyKey: "attachment-operation-b",
      runId: "run-parent-b",
      partId: "attachment:0",
      attachment: snapshotAttachment("worker-b", "b.csv"),
      completionKeys: ["attachment-operation-b", "completion-b"],
    });

    await expect(queue.replaceDecisions([], [firstOperation, secondOperation]))
      .resolves.toEqual(ok({ created: true }));
    await expect(queue.replaceDecisions(
      [firstOperation.idempotencyKey, secondOperation.idempotencyKey],
      [
        {
          ...firstOperation,
          announcementText: "combined",
          completionKeys: ["attachment-operation-a", "completion-a", "completion-b"],
        },
        {
          ...secondOperation,
          completionKeys: ["attachment-operation-b", "completion-a", "completion-b"],
        },
      ],
    )).resolves.toEqual(ok({ created: true }));
    expect(queue.size()).toBe(2);
  });

  it("retains a cancelled capacity waiter as a durable producer reservation", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 1,
    });
    const first = decisionInput({ failedAt: Date.now() });
    await expect(queue.reserveDecision(first)).resolves.toEqual(
      ok({ created: true }),
    );
    const controller = new AbortController();
    const retained = queue.reserveDecision(decisionInput({
      idempotencyKey: "shutdown-handoff",
      runId: "run-shutdown-handoff",
      completionKeys: ["shutdown-handoff"],
      failedAt: Date.now(),
    }), controller.signal);

    await delay(10);
    controller.abort();

    await expect(retained).resolves.toEqual(ok({ created: false, deferred: true }));
    await expect(queue.lookupDecision("shutdown-handoff")).resolves.toEqual(ok(undefined));
    expect(queue.size()).toBe(2);

    await expect(queue.resolveDecision(first.idempotencyKey, "no_reply"))
      .resolves.toEqual(ok(true));
    await queue.drain(vi.fn(async () => false));
    await expect(queue.lookupDecision("shutdown-handoff")).resolves.toMatchObject({
      ok: true,
      value: { idempotencyKey: "shutdown-handoff" },
    });
    expect(queue.size()).toBe(1);
  });

  it("backpressures producer work before handoff ownership can overflow", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 2,
    });
    const producer = (runId: string) => decisionInput({
      idempotencyKey: `operation-${runId}`,
      runId,
      completionKeys: [`operation-${runId}`],
      retirementKeys: [`operation-${runId}`],
    });
    await expect(queue.reserveProducer(producer("producer-a"))).resolves.toEqual(ok(undefined));
    await expect(queue.reserveProducer(producer("producer-b"))).resolves.toEqual(ok(undefined));

    let thirdAdmitted = false;
    const third = queue.reserveProducer(producer("producer-c")).then((result) => {
      thirdAdmitted = true;
      return result;
    });
    await delay(10);
    expect(thirdAdmitted).toBe(false);
    expect(queue.size()).toBe(2);

    await expect(queue.cancelProducer("producer-a")).resolves.toEqual(ok(undefined));
    await expect(third).resolves.toEqual(ok(undefined));
    expect(queue.size()).toBe(2);
  });

  it("promotes a persisted producer reservation after restart", async () => {
    const producer = decisionInput({
      idempotencyKey: "producer-fallback-operation",
      runId: "producer-fallback-run",
      failedAt: Date.now() - 500_000,
      completionKeys: ["producer-fallback-operation"],
      retirementKeys: ["producer-fallback-operation"],
    });
    const first = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
    });
    await expect(first.reserveProducer(producer)).resolves.toEqual(ok(undefined));
    await expect(first.releaseProducer(producer.runId)).resolves.toEqual(ok(undefined));

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
    });
    const send = vi.fn(async () => true);
    await restarted.drain(send);

    expect(send).toHaveBeenCalledWith(
      producer.channelType,
      producer.channelId,
      producer.announcementText,
      expect.objectContaining({ threadId: producer.threadId }),
    );
    expect(restarted.size()).toBe(0);
  });

  it("durably suppresses a producer before removing its reservation", async () => {
    const producer = decisionInput({
      idempotencyKey: "suppressed-producer-operation",
      runId: "suppressed-producer-run",
      completionKeys: ["suppressed-producer-operation"],
      retirementKeys: ["suppressed-producer-operation"],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(queue.reserveProducer(producer)).resolves.toEqual(ok(undefined));

    await expect(queue.suppressProducer(producer.runId)).resolves.toEqual(ok(true));
    expect(queue.size()).toBe(0);

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.reserveDecision(producer)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "no_reply",
    }));
  });

  it("applies producer suppression to later operation aliases", async () => {
    const completionKey = "suppressed-logical-completion";
    const producer = decisionInput({
      idempotencyKey: completionKey,
      runId: "suppressed-alias-run",
      completionKeys: [completionKey],
      retirementKeys: [completionKey],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(queue.reserveProducer(producer)).resolves.toEqual(ok(undefined));
    await expect(queue.suppressProducer(producer.runId)).resolves.toEqual(ok(true));

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.reserveDecision(decisionInput({
      idempotencyKey: "hashed-operation-alias",
      runId: producer.runId,
      completionKeys: [completionKey],
      retirementKeys: [completionKey],
    }))).resolves.toEqual(ok({
      created: false,
      terminalDecision: "no_reply",
    }));
  });

  it("finishes a pending producer suppression when admission resumes", async () => {
    const producer = decisionInput({
      idempotencyKey: "pending-suppression-operation",
      runId: "pending-suppression-run",
      completionKeys: ["pending-suppression-operation"],
      retirementKeys: ["pending-suppression-operation"],
    });
    const terminalRecord = createTerminalDecisionRecord(producer, "no_reply", 100);
    if (!terminalRecord.ok) throw terminalRecord.error;
    const decisionsPath = join(tmpDir, "dlq.jsonl.terminal-decisions", "decisions");
    const blockedShard = join(decisionsPath, terminalRecord.value.keyDigest.slice(0, 2));
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(queue.reserveProducer(producer)).resolves.toEqual(ok(undefined));
    await mkdir(decisionsPath, { recursive: true });
    await writeFile(blockedShard, "blocked", "utf8");

    await expect(queue.suppressProducer(producer.runId)).resolves.toEqual(ok(true));
    await unlink(blockedShard);

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.reserveProducer(producer)).resolves.toEqual(ok(undefined));
    await expect(restarted.reserveDecision(producer)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "no_reply",
    }));
  });

  it("commits chunk-group suppression before individual terminal aliases", async () => {
    const groupKey = "chunk-group-terminal";
    const groupOwner = decisionInput({
      idempotencyKey: groupKey,
      runId: "chunk-group-run",
      completionKeys: [groupKey],
    });
    const groupRecord = createTerminalDecisionRecord(groupOwner, "discarded", 100);
    if (!groupRecord.ok) throw groupRecord.error;
    let childKey = "chunk-child-terminal";
    let child = decisionInput({
      idempotencyKey: childKey,
      runId: "chunk-group-run",
      partId: "summary:chunk:1",
      completionKeys: [groupKey],
      terminalGroupKey: groupKey,
    });
    let childRecord = createTerminalDecisionRecord(child, "discarded", 100);
    if (!childRecord.ok) throw childRecord.error;
    while (childRecord.value.keyDigest.slice(0, 2) === groupRecord.value.keyDigest.slice(0, 2)) {
      childKey += "x";
      child = { ...child, idempotencyKey: childKey };
      childRecord = createTerminalDecisionRecord(child, "discarded", 100);
      if (!childRecord.ok) throw childRecord.error;
    }
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await queue.enqueue({
      ...child,
      attemptCount: 5,
      lastError: "outward_operation_unresolved",
    });
    const childShard = join(
      tmpDir,
      "dlq.jsonl.terminal-decisions",
      "decisions",
      childRecord.value.keyDigest.slice(0, 2),
    );
    await mkdir(join(tmpDir, "dlq.jsonl.terminal-decisions", "decisions"), { recursive: true });
    await writeFile(childShard, "blocked", "utf8");
    const retained = (await listQuarantined(queue))[0];
    if (!retained) throw new Error("Expected retained chunk quarantine row");

    await expect(queue.release(retained.id, "discarded")).resolves.toMatchObject({ ok: false });
    await expect(createAnnouncementTerminalDecisionStore(filePath).lookup(groupOwner))
      .resolves.toEqual(ok("discarded"));
  });

  it("consumes persisted producer ownership on terminal admission replay", async () => {
    const operation = decisionInput({
      idempotencyKey: "terminal-producer-operation",
      runId: "terminal-producer-run",
      completionKeys: ["terminal-producer-operation"],
      retirementKeys: ["terminal-producer-operation"],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 1,
    });
    await expect(queue.reserveProducer(operation)).resolves.toEqual(ok(undefined));
    await expect(createAnnouncementTerminalDecisionStore(filePath).record(operation, "delivered"))
      .resolves.toEqual(ok(undefined));

    await expect(queue.reserveDecision(operation)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "delivered",
    }));

    expect(queue.size()).toBe(0);
    await expect(queue.reserveProducer(decisionInput({
      idempotencyKey: "next-producer-operation",
      runId: "next-producer-run",
      completionKeys: ["next-producer-operation"],
      retirementKeys: ["next-producer-operation"],
    }))).resolves.toEqual(ok(undefined));
  });

  it("consumes producer ownership when every replacement is terminal", async () => {
    const completionKey = "terminal-replacement-completion";
    const first = decisionInput({
      idempotencyKey: "terminal-replacement-first",
      runId: "terminal-replacement-run",
      completionKeys: [completionKey],
      retirementKeys: [completionKey],
    });
    const second = decisionInput({
      idempotencyKey: "terminal-replacement-second",
      runId: "terminal-replacement-run",
      completionKeys: [completionKey],
      retirementKeys: [completionKey],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 1,
    });
    const terminalStore = createAnnouncementTerminalDecisionStore(filePath);
    await expect(queue.reserveProducer(first)).resolves.toEqual(ok(undefined));
    await expect(terminalStore.record(first, "delivered")).resolves.toEqual(ok(undefined));
    await expect(terminalStore.record(second, "delivered")).resolves.toEqual(ok(undefined));

    await expect(queue.replaceDecisions([], [first, second]))
      .resolves.toEqual(ok({ created: false }));

    expect(queue.size()).toBe(0);
  });

  it("hands off a cancelled attachment replacement atomically within its bound", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 2,
    });
    const first = decisionInput({ failedAt: Date.now() });
    const second = decisionInput({
      idempotencyKey: "capacity-owner-2",
      runId: "capacity-run-2",
      completionKeys: ["capacity-owner-2"],
      failedAt: Date.now(),
    });
    await queue.replaceDecisions([], [first, second]);
    const controller = new AbortController();
    const attachment = decisionInput({
      idempotencyKey: "attachment-handoff",
      runId: "attachment-handoff-run",
      completionKeys: ["attachment-handoff"],
      failedAt: Date.now(),
      partId: "attachment:0",
      attachment: snapshotAttachment("worker-a", "handoff.txt"),
    });
    const summary = decisionInput({
      idempotencyKey: "summary-handoff",
      runId: "attachment-handoff-run",
      completionKeys: ["summary-handoff"],
      failedAt: Date.now(),
    });
    const retained = queue.replaceDecisions([], [attachment, summary], controller.signal);

    await delay(10);
    controller.abort();

    await expect(retained).resolves.toEqual(ok({ created: false, deferred: true }));
    expect(queue.size()).toBe(3);
    const retainedRows = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(retainedRows).toContainEqual(expect.objectContaining({
      recordType: "producer_handoff",
      operationCount: 2,
      groupDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      operations: expect.arrayContaining([
        expect.objectContaining({ idempotencyKey: "attachment-handoff" }),
        expect.objectContaining({ idempotencyKey: "summary-handoff" }),
      ]),
    }));
    const overflowController = new AbortController();
    const overflow = queue.reserveDecision(decisionInput({
      idempotencyKey: "overflow-handoff",
      runId: "overflow-handoff-run",
      completionKeys: ["overflow-handoff"],
    }), overflowController.signal);
    await delay(10);
    overflowController.abort();
    await expect(overflow).resolves.toEqual(ok({ created: false, deferred: true }));
    expect(queue.size()).toBe(4);
    await queue.resolveDecision(first.idempotencyKey, "no_reply");
    await queue.resolveDecision(second.idempotencyKey, "no_reply");
    await queue.drain(vi.fn(async () => false));
    await expect(queue.lookupDecision("attachment-handoff")).resolves.toMatchObject({
      ok: true,
      value: { idempotencyKey: "attachment-handoff" },
    });
    await expect(queue.lookupDecision("summary-handoff")).resolves.toMatchObject({
      ok: true,
      value: { idempotencyKey: "summary-handoff" },
    });
    await expect(queue.lookupDecision("overflow-handoff")).resolves.toEqual(ok(undefined));
    expect((await readFile(filePath, "utf8"))).toContain("overflow-handoff");
    expect(queue.size()).toBe(3);
  });

  it("quarantines an incomplete producer handoff as one invalid transition", async () => {
    const operation = decisionInput({
      idempotencyKey: "incomplete-operation",
      completionKeys: ["incomplete-completion"],
    });
    await writeFile(filePath, `${JSON.stringify({
      recordType: "producer_handoff",
      id: "handoff:incomplete-transition",
      transitionId: "incomplete-transition",
      expectedKeys: [],
      operationCount: 2,
      groupDigest: "a".repeat(64),
      operations: [operation],
    })}\n`, "utf8");
    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });

    await expect(restarted.listQuarantined()).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({
        kind: "invalid_record",
        reason: "schema_mismatch",
      })],
    });
    expect(restarted.size()).toBe(1);
  });

  it("settles shared handoff ownership only after every sibling is terminal", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 2,
    });
    const first = decisionInput({
      idempotencyKey: "capacity-a",
      completionKeys: ["capacity-a"],
    });
    const second = decisionInput({
      idempotencyKey: "capacity-b",
      completionKeys: ["capacity-b"],
    });
    await queue.replaceDecisions([], [first, second]);
    const sharedCompletionKey = "shared-handoff-completion";
    const summary = decisionInput({
      idempotencyKey: "shared-summary",
      completionKeys: [sharedCompletionKey],
    });
    const attachment = decisionInput({
      idempotencyKey: "shared-attachment",
      partId: "attachment:0",
      completionKeys: [sharedCompletionKey],
    });
    const controller = new AbortController();
    const retained = queue.replaceDecisions([], [summary, attachment], controller.signal);
    await delay(10);
    controller.abort();
    await expect(retained).resolves.toEqual(ok({ created: false, deferred: true }));
    await queue.resolveDecision(first.idempotencyKey, "no_reply");
    await queue.resolveDecision(second.idempotencyKey, "no_reply");
    const decisions = createAnnouncementTerminalDecisionStore(filePath);
    await decisions.record(summary, "delivered");
    await decisions.record(attachment, "discarded");
    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 2,
    });

    await restarted.drain(vi.fn(async () => false));

    await expect(restarted.reserveDecision(decisionInput({
      idempotencyKey: sharedCompletionKey,
      completionKeys: [sharedCompletionKey],
    }))).resolves.toEqual(ok({
      created: false,
      terminalDecision: "discarded",
    }));
    expect(restarted.size()).toBe(0);
  });

  it("persists an immutable attachment snapshot during reservation admission", async () => {
    const cleanup = vi.fn(async () => ok(undefined));
    const prepareAttachment = vi.fn(async (attachment) => ok({
      kind: "snapshot" as const,
      sourceAgentId: attachment.sourceAgentId,
      sourcePath: attachment.path,
      path: "/durable/completion-attachments/report.csv",
      fileName: "report.csv",
      mimeType: "text/csv",
      contentDigest: "a".repeat(64),
      sizeBytes: 12,
      cleanup,
    }));
    const decision = decisionInput({
      idempotencyKey: "attachment-admission",
      partId: "attachment:0",
      attachment: {
        kind: "source",
        sourceAgentId: "worker-a",
        path: "/workspace/report.csv",
      },
      completionKeys: ["completion-a"],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      prepareAttachment,
    });

    await expect(queue.reserveDecision(decision)).resolves.toEqual(ok({ created: true }));

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.lookupDecision(decision.idempotencyKey)).resolves.toMatchObject({
      ok: true,
      value: {
        attachment: {
          kind: "snapshot",
          sourcePath: "/workspace/report.csv",
          path: "/durable/completion-attachments/report.csv",
          contentDigest: "a".repeat(64),
        },
      },
    });
    expect(prepareAttachment).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("preserves distinct immutable snapshots for repeated source paths", async () => {
    let snapshotIndex = 0;
    const prepareAttachment = vi.fn(async (attachment) => {
      snapshotIndex++;
      return ok({
        kind: "snapshot" as const,
        sourceAgentId: attachment.sourceAgentId,
        sourcePath: attachment.path,
        path: `/durable/completion-attachments/report-${snapshotIndex}.csv`,
        fileName: "report.csv",
        mimeType: "text/csv",
        contentDigest: String(snapshotIndex).repeat(64),
        sizeBytes: 12,
        cleanup: vi.fn(async () => ok(undefined)),
      });
    });
    const first = decisionInput({
      idempotencyKey: "same-path-first",
      runId: "same-path-run-first",
      partId: "attachment:0",
      attachment: {
        kind: "source",
        sourceAgentId: "worker-a",
        path: "/workspace/report.csv",
      },
      completionKeys: ["same-path-first", "completion-first"],
    });
    const second = decisionInput({
      idempotencyKey: "same-path-second",
      runId: "same-path-run-second",
      partId: "attachment:0",
      attachment: {
        kind: "source",
        sourceAgentId: "worker-a",
        path: "/workspace/report.csv",
      },
      completionKeys: ["same-path-second", "completion-second"],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      prepareAttachment,
    });
    await expect(queue.replaceDecisions([], [first, second]))
      .resolves.toEqual(ok({ created: true }));

    await expect(queue.replaceDecisions(
      [first.idempotencyKey, second.idempotencyKey],
      [
        { ...first, completionKeys: [first.idempotencyKey, "completion-first", "completion-second"] },
        { ...second, completionKeys: [second.idempotencyKey, "completion-first", "completion-second"] },
      ],
    )).resolves.toEqual(ok({ created: true }));

    await expect(queue.lookupDecision(first.idempotencyKey)).resolves.toMatchObject({
      ok: true,
      value: {
        attachment: {
          path: "/durable/completion-attachments/report-1.csv",
          contentDigest: "1".repeat(64),
        },
      },
    });
    await expect(queue.lookupDecision(second.idempotencyKey)).resolves.toMatchObject({
      ok: true,
      value: {
        attachment: {
          path: "/durable/completion-attachments/report-2.csv",
          contentDigest: "2".repeat(64),
        },
      },
    });
    expect(prepareAttachment).toHaveBeenCalledTimes(2);
  });

  it("finds a persisted text chunk manifest through every represented completion", async () => {
    const decision = decisionInput({
      idempotencyKey: "chunked-summary",
      completionKeys: ["completion-chunked-summary"],
    });
    const chunks = ["first formatted chunk", "second formatted chunk"];
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await queue.reserveDecision(decision);

    await expect(queue.recordDecisionTextChunks(
      decision.idempotencyKey,
      chunks,
    )).resolves.toEqual(ok(undefined));
    await expect(queue.replaceDecisions([decision.idempotencyKey], chunks.map((chunk, index) => ({
      ...decision,
      idempotencyKey: `chunk-operation-${index}`,
      announcementText: chunk,
      partId: `text:chunk:${index}`,
      textChunks: chunks,
    })))).resolves.toEqual(ok({ created: true }));

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.lookupDecisionTextChunks("completion-chunked-summary"))
      .resolves.toEqual(ok(chunks));
    await expect(restarted.recordDecisionTextChunks(
      "chunk-operation-0",
      ["changed chunk"],
    )).resolves.toMatchObject({ ok: false });
  });

  it("recovers a ledgerless parent reservation after its rewrite grace", async () => {
    const decision = decisionInput({
      failedAt: Date.now() - 301_000,
      idempotencyKey: "ledgerless-parent-recovery",
      completionKeys: ["ledgerless-parent-recovery"],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
    });
    await queue.reserveDecision(decision);
    const send = vi.fn(async () => true);

    await queue.drain(send);

    expect(send).toHaveBeenCalledWith(
      "telegram",
      "chat-1",
      "scrubbed parent decision input",
      expect.objectContaining({ threadId: "topic-1" }),
    );
    expect(queue.size()).toBe(0);
    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.reserveDecision(decision)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "delivered",
    }));
  });

  it("preserves chunk suppression groups through reservation adjudication", async () => {
    const terminalGroupKey = "adjudicated-chunk-group";
    const firstChunk = decisionInput({
      failedAt: Date.now() - 301_000,
      idempotencyKey: "adjudicated-chunk-first",
      partId: "text:chunk:0",
      completionKeys: ["adjudicated-chunk-first"],
      terminalGroupKey,
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
      maxRetries: 1,
    });
    await expect(queue.reserveDecision(firstChunk)).resolves.toEqual(ok({ created: true }));
    await queue.drain(vi.fn(async () => false));

    const retained = (await listQuarantined(queue))[0];
    if (!retained) throw new Error("Expected adjudicated chunk quarantine row");
    await expect(queue.release(retained.id, "discarded")).resolves.toEqual(ok(true));

    await expect(queue.reserveDecision(decisionInput({
      idempotencyKey: "adjudicated-chunk-second",
      partId: "text:chunk:1",
      completionKeys: ["adjudicated-chunk-second"],
      terminalGroupKey,
    }))).resolves.toEqual(ok({
      created: false,
      terminalDecision: "discarded",
    }));
  });

  it("replays a persisted ledgerless manifest one chunk at a time", async () => {
    const chunks = ["first durable chunk", "second durable chunk"];
    const decision = decisionInput({
      failedAt: Date.now() - 301_000,
      idempotencyKey: "ledgerless-manifest-parent",
      completionKeys: ["ledgerless-manifest-parent"],
      announcementText: chunks.join(" "),
      textChunks: chunks,
    });
    const receiptAwareSendToChannel = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
      platformMessageId: "message-chunk",
    }));
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
      receiptAwareSendToChannel,
    });
    await queue.reserveDecision(decision);

    await queue.drain(vi.fn(async () => false));

    expect(receiptAwareSendToChannel.mock.calls.map(([, , text]) => text))
      .toEqual(chunks);
    expect(queue.size()).toBe(0);
    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      receiptAwareSendToChannel,
    });
    await expect(restarted.reserveDecision(decision)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "delivered",
    }));
  });

  it("quarantines a ledgerless attachment after its rewrite grace", async () => {
    const decision = decisionInput({
      failedAt: Date.now() - 301_000,
      idempotencyKey: "ledgerless-attachment-recovery",
      completionKeys: ["ledgerless-attachment-recovery"],
      partId: "attachment:0",
      attachment: snapshotAttachment("worker-a", "report.csv"),
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
    });
    await expect(queue.reserveDecision(decision)).resolves.toEqual(ok({ created: true }));
    const sendToChannel = vi.fn().mockResolvedValue(true);

    await queue.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    await expect(queue.listQuarantined()).resolves.toMatchObject({
      ok: true,
      value: [{
        idempotencyKey: "ledgerless-attachment-recovery",
        lastError: "attachment_delivery_unavailable",
      }],
    });
    await expect(queue.durableStatus()).resolves.toEqual(ok({
      activeRecoveryCount: 0,
      quarantinedCount: 1,
    }));
  });

  it("keeps live ledgerless attempts non-actionable until restart makes them ambiguous", async () => {
    const attempt = makeEntry({
      runId: "run-ledgerless-in-flight",
      idempotencyKey: "ledgerless-in-flight",
      completionKeys: ["ledgerless-in-flight"],
      failedAt: Date.now(),
      lastError: "outward_operation_in_flight",
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
    });

    await expect(queue.beginDeliveryAttempt(attempt)).resolves.toEqual(ok({ claimed: true }));
    await expect(queue.listQuarantined()).resolves.toEqual(ok([]));
    await expect(queue.durableStatus()).resolves.toEqual(ok({
      activeRecoveryCount: 1,
      quarantinedCount: 0,
    }));

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
    });
    await expect(restarted.listQuarantined()).resolves.toMatchObject({
      ok: true,
      value: [{
        idempotencyKey: "ledgerless-in-flight",
        lastError: "outward_operation_unresolved",
      }],
    });
  });

  it("terminalizes every completion represented by an accepted ledgerless operation", async () => {
    const decision = decisionInput({
      idempotencyKey: "coalesced-summary-operation",
      completionKeys: ["completion-a", "completion-b"],
      failedAt: Date.now(),
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
    });
    await queue.reserveDecision(decision);
    await expect(queue.beginDeliveryAttempt({
      announcementText: decision.announcementText,
      channelType: decision.channelType,
      channelId: decision.channelId,
      agentId: decision.agentId,
      runId: decision.runId,
      sessionKey: decision.sessionKey,
      failedAt: decision.failedAt,
      attemptCount: 0,
      lastError: "outward_operation_in_flight",
      threadId: decision.threadId,
      idempotencyKey: decision.idempotencyKey,
      rootRunId: decision.rootRunId,
      deliveryAuthority: decision.deliveryAuthority,
      destinationEndpoint: decision.destinationEndpoint,
      completionKeys: decision.completionKeys,
    })).resolves.toEqual(ok({ claimed: true }));
    await expect(queue.settleDeliveryAttempt(decision.idempotencyKey, "accepted"))
      .resolves.toEqual(ok(true));

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    for (const completionKey of decision.completionKeys) {
      await expect(restarted.reserveDecision(decisionInput({
        idempotencyKey: completionKey,
        completionKeys: [completionKey],
      }))).resolves.toEqual(ok({
        created: false,
        terminalDecision: "delivered",
      }));
    }
  });

  it("keeps a visible reservation snapshot when final directory sync fails", async () => {
    const cleanup = vi.fn(async () => ok(undefined));
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      fileOperations: createOneTimeDirectorySyncFailure(tmpDir),
      prepareAttachment: vi.fn(async (attachment) => ok({
        kind: "snapshot" as const,
        sourceAgentId: attachment.sourceAgentId,
        sourcePath: attachment.path,
        path: "/durable/completion-attachments/visible.csv",
        fileName: "visible.csv",
        mimeType: "text/csv",
        contentDigest: "b".repeat(64),
        sizeBytes: 12,
        cleanup,
      })),
    });
    const decision = decisionInput({
      idempotencyKey: "visible-attachment",
      attachment: {
        kind: "source",
        sourceAgentId: "worker-a",
        path: "/workspace/visible.csv",
      },
    });

    await expect(queue.reserveDecision(decision)).resolves.toMatchObject({ ok: false });
    await expect(queue.lookupDecision(decision.idempotencyKey)).resolves.toMatchObject({
      ok: true,
      value: {
        attachment: { path: "/durable/completion-attachments/visible.csv" },
      },
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cleans a shared attachment snapshot only after its final owner settles", async () => {
    const cleanupAttachment = vi.fn(async () => ok(undefined));
    const sharedAttachment = snapshotAttachment("worker-a", "shared.csv");
    const first = decisionInput({
      idempotencyKey: "shared-attachment-first",
      runId: "shared-run-first",
      attachment: sharedAttachment,
      completionKeys: ["shared-completion-first"],
    });
    const second = decisionInput({
      idempotencyKey: "shared-attachment-second",
      runId: "shared-run-second",
      attachment: sharedAttachment,
      completionKeys: ["shared-completion-second"],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      cleanupAttachment,
    });
    await queue.replaceDecisions([], [first, second]);

    await expect(queue.resolveDecision(first.idempotencyKey, "receipt_committed"))
      .resolves.toEqual(ok(true));
    expect(cleanupAttachment).not.toHaveBeenCalled();
    await expect(queue.resolveDecision(second.idempotencyKey, "receipt_committed"))
      .resolves.toEqual(ok(true));
    expect(cleanupAttachment).toHaveBeenCalledOnce();
    expect(cleanupAttachment).toHaveBeenCalledWith(sharedAttachment);
  });

  it("cleans an attachment snapshot after no-reply settlement", async () => {
    const cleanupAttachment = vi.fn(async () => ok(undefined));
    const attachment = snapshotAttachment("worker-a", "no-reply.csv");
    const decision = decisionInput({
      idempotencyKey: "no-reply-attachment",
      runId: "no-reply-attachment-run",
      attachment,
      completionKeys: ["no-reply-attachment"],
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      cleanupAttachment,
    });
    await queue.replaceDecisions([], [decision]);

    await expect(queue.resolveDecision(decision.idempotencyKey, "no_reply"))
      .resolves.toEqual(ok(true));
    expect(cleanupAttachment).toHaveBeenCalledOnce();
    expect(cleanupAttachment).toHaveBeenCalledWith(attachment);
  });

  it("atomically replaces parent decisions with exact outward operations", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    const firstKey = "default:user:telegram:chat-1::run-parent-1";
    const secondKey = "default:user:telegram:chat-1::run-parent-2";
    await queue.reserveDecision(decisionInput());
    await queue.reserveDecision(decisionInput({
      idempotencyKey: secondKey,
      runId: "run-parent-2",
      completionKeys: [secondKey],
    }));
    const operations = [
      decisionInput({
        idempotencyKey: "operation-summary",
        partId: "summary",
        announcementText: "combined summary",
        completionKeys: [firstKey, secondKey],
      }),
      decisionInput({
        idempotencyKey: "operation-attachment",
        partId: "attachment:0",
        announcementText: "",
        attachment: snapshotAttachment("worker-a", "report.txt"),
        completionKeys: [secondKey],
      }),
    ];

    await expect(queue.replaceDecisions(
      [firstKey, secondKey],
      [decisionInput({
        idempotencyKey: "operation-incomplete",
        completionKeys: [firstKey],
      })],
    )).resolves.toMatchObject({ ok: false });
    expect(queue.size()).toBe(2);
    await expect(queue.replaceDecisions(
      [firstKey, secondKey],
      operations,
    )).resolves.toEqual(ok({ created: true }));
    await expect(queue.lookupDecision(firstKey)).resolves.toEqual(ok(undefined));
    await expect(queue.lookupDecision("operation-summary")).resolves.toEqual(ok(operations[0]));
    await expect(queue.lookupDecision("operation-attachment")).resolves.toEqual(ok(operations[1]));

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.replaceDecisions(
      [firstKey, secondKey],
      operations,
    )).resolves.toEqual(ok({ created: false }));
    expect(restarted.size()).toBe(2);
  });

  it("settles terminal operations while reserving remaining outward work", async () => {
    const { ledger } = makeStubLedger();
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
    });
    const completionKey = decisionInput().idempotencyKey;
    const terminalOperation = decisionInput({
      idempotencyKey: "terminal-summary",
      partId: "summary",
      completionKeys: [completionKey],
    });
    const pendingOperation = decisionInput({
      idempotencyKey: "pending-attachment",
      partId: "attachment:0",
      completionKeys: [completionKey],
    });
    await queue.reserveDecision(decisionInput());
    await ledger.recordTerminalDecision(
      terminalOperation.rootRunId,
      terminalOperation.idempotencyKey,
      "delivered",
    );

    await expect(queue.replaceDecisions(
      [completionKey],
      [terminalOperation, pendingOperation],
    )).resolves.toEqual(ok({ created: true }));

    await expect(queue.lookupDecision(completionKey)).resolves.toEqual(ok(undefined));
    await expect(queue.lookupDecision("terminal-summary")).resolves.toEqual(ok(undefined));
    await expect(queue.lookupDecision("pending-attachment"))
      .resolves.toEqual(ok(pendingOperation));
  });

  it("emits a session-attributed diagnostic after reserving a parent decision", async () => {
    const eventBus = createMockEventBus();
    const queue = createAnnouncementDeadLetterQueue({ filePath, eventBus });

    await expect(queue.reserveDecision(decisionInput())).resolves.toEqual(
      ok({ created: true }),
    );

    expect(eventBus.emit).toHaveBeenCalledWith(
      "announcement:dead_lettered",
      expect.objectContaining({
        runId: "run-parent-1",
        sessionKey: "default:user:telegram:chat-1",
        channelType: "telegram",
        reason: "parent_decision_reserved",
        timestamp: expect.any(Number),
      }),
    );
  });

  it("rejects a parent decision that has no adjudicable ledger root", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });

    const result = await queue.reserveDecision(decisionInput({ rootRunId: undefined }));

    expect(result).toMatchObject({ ok: false });
    expect(queue.size()).toBe(0);
  });

  it("rejects a parent decision that has no durable recovery route", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });

    const result = await queue.reserveDecision(decisionInput({
      deliveryAuthority: undefined,
      destinationEndpoint: undefined,
    }));

    expect(result).toMatchObject({ ok: false });
    expect(queue.size()).toBe(0);
  });

  // A governed entry the ledger cannot complete is RETAINED on purpose and never
  // replayed automatically, so every 5-minute drain re-reaches it. Re-logging its
  // standing condition at ERROR each pass turns one stuck entry into unbounded
  // ERROR volume that buries genuinely new failures: measured live on
  // comis-moshe, a single entry emitted an ERROR on every sweep indefinitely
  // (10:16:38, 10:17:57, 10:23:16, 10:28:16, …). Log the TRANSITION into the
  // condition, not the condition — the same treatment the quarantine WARN already
  // gets in health-metrics.
  it("logs a stuck governed entry once, not on every sweep", async () => {
    const logger = createMockLogger();
    const ledger = {
      lookupTerminalDecision: vi.fn(async () => ok(undefined)),
      recordTerminalDecision: vi.fn(async () => ok(undefined)),
      // Definitive absent lookup, so the drain proceeds to the transport check.
      lookup: vi.fn(async () => ok(undefined)),
      allocateStep: vi.fn(async () => ok({ ok: true, value: { stepIndex: 1 } })),
      recordState: vi.fn(async () => ok(undefined)),
      begin: vi.fn(async () => ok(undefined)),
    } as unknown as OutwardSendLedgerPort;
    // No governedSendToChannel: the receipt-aware transport is unavailable, which
    // is a precondition failure the entry cannot resolve on its own.
    const queue = createAnnouncementDeadLetterQueue({
      // retryIntervalMs 0: `lastAttemptAt` is stamped at enqueue, so the default
      // 60s interval would skip every drain in this test and the entry would
      // never reach the governed path at all.
      filePath, eventBus: createMockEventBus(), logger, outwardLedger: ledger, retryIntervalMs: 0,
    });
    await queue.enqueue(makeEntry({ agentId: "agent-1", rootRunId: "root-1", stepIndex: 1 }));

    const send = vi.fn().mockResolvedValue(true);
    await queue.drain(send);
    await queue.drain(send);
    await queue.drain(send);

    const stuck = (logger.error as unknown as { mock: { calls: [unknown, string][] } })
      .mock.calls.filter(([, msg]) => /cannot provide a platform receipt/.test(String(msg)));
    expect(stuck).toHaveLength(1);
    // Fail-safe unchanged: still retained, never dropped for being noisy.
    expect(queue.size()).toBe(1);
  });

  it("persists a successful no-reply resolution across restart", async () => {
    const decision = decisionInput();
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await queue.reserveDecision(decision);

    await expect(
      queue.resolveDecision(decision.idempotencyKey, "no_reply"),
    ).resolves.toEqual(ok(true));
    await expect(
      queue.lookupDecision(decision.idempotencyKey),
    ).resolves.toEqual(ok(undefined));
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await expect(restarted.reserveDecision(decision)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "no_reply",
    }));
    await expect(restarted.lookupDecision(decision.idempotencyKey))
      .resolves.toEqual(ok(undefined));
  });

  it("records a governed no-reply decision before removing its reservation", async () => {
    const decision = decisionInput();
    const { ledger } = makeStubLedger({ lookupResult: ok(undefined) });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
    });
    await queue.reserveDecision(decision);

    await expect(queue.resolveDecision(decision.idempotencyKey, "no_reply"))
      .resolves.toEqual(ok(true));
    expect(ledger.recordTerminalDecision).toHaveBeenCalledWith(
      decision.rootRunId,
      decision.idempotencyKey,
      "no_reply",
    );

    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
    });
    await expect(restarted.reserveDecision(decision)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "no_reply",
    }));
  });

  it("does not acknowledge no-reply until reservation removal is durable", async () => {
    const seeded = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    const decision = decisionInput({ failedAt: 100 });
    await seeded.reserveDecision(decision);

    let terminalDecision: "delivered" | "discarded" | "no_reply" | undefined;
    const ledger: OutwardSendLedgerPort = {
      lookupTerminalDecision: vi.fn(async () => ok(terminalDecision)),
      recordTerminalDecision: vi.fn(async (_rootRunId, _operationId, outcome) => {
        terminalDecision = outcome;
        return ok(undefined);
      }),
      allocateStep: vi.fn(async () => ok(7)),
      lookup: vi.fn(async () => ok(undefined)),
      begin: vi.fn(async () => ok(undefined)),
      markUnknown: vi.fn(async () => ok(undefined)),
      reclaimPreSend: vi.fn(async () => ok(false)),
      commit: vi.fn(async () => ok(undefined)),
      markFailed: vi.fn(async () => ok(undefined)),
      parkUncertain: vi.fn(async () => ok(false)),
      hasUncertainty: vi.fn(async () => ok(false)),
      listUnreconciled: vi.fn(async () => ok([])),
    };
    const unavailable = new Error("snapshot removal unavailable");
    const blocked = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
      fileOperations: {
        open: vi.fn().mockRejectedValue(unavailable),
        rename: vi.fn(),
        unlink: vi.fn().mockRejectedValue(unavailable),
        chmod: vi.fn(),
      } as unknown as DeadLetterWriteOperations,
    });

    await expect(blocked.resolveDecision(decision.idempotencyKey, "no_reply"))
      .resolves.toMatchObject({ ok: false });
    expect(terminalDecision).toBe("no_reply");

    const governedSendToChannel = vi.fn();
    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
      governedSendToChannel,
      retryIntervalMs: 0,
    });
    await restarted.drain(vi.fn(async () => true));

    expect(governedSendToChannel).not.toHaveBeenCalled();
    expect(restarted.size()).toBe(0);
    await expect(restarted.reserveDecision(decision)).resolves.toEqual(ok({
      created: false,
      terminalDecision: "no_reply",
    }));
  });

  it("rejects a mismatched ledgerless operation without replacing its owner", async () => {
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
    }))).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: "Announcement operation reservation identity mismatch",
      }),
    });

    expect(queue.size()).toBe(1);
    await expect(
      queue.lookupDecision(decisionInput().idempotencyKey),
    ).resolves.toEqual(ok(decisionInput()));
    expect((await readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("delivers a parked reservation the ledger shows was never sent", async () => {
    // A sub-agent completed and produced real work; the parent turn that should
    // have adjudicated delivery died first, so the completion parked as a
    // reservation. drain() only ever walked normal entries, so nothing drained
    // it and the user was never told — they had to ask. The ledger can settle
    // this: allocateStep is idempotent by (rootRunId, operationId), and a lookup
    // that returns undefined means no send was ever attempted at that step.
    const { ledger } = makeStubLedger(); // lookup -> ok(undefined) = never sent
    const sendToChannel = vi.fn(async () => true);
    const governedSendToChannel = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
      platformMessageId: "m-1",
    }));
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
      governedSendToChannel,
    });
    await queue.reserveDecision(decisionInput({ rootRunId: "root-parent-1" }));
    expect(queue.size()).toBe(1);

    await queue.drain(sendToChannel);

    // The reservation is adjudicated and no longer parked.
    expect(queue.size()).toBe(0);
    expect(governedSendToChannel).toHaveBeenCalledOnce();
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(ledger.allocateStep).not.toHaveBeenCalled();
  });

  it("persists a recovered chunk manifest without reentering the drain serializer", async () => {
    const { ledger } = makeStubLedger();
    let queue: AnnouncementDeadLetterQueue;
    const governedSendToChannel = vi.fn(async (
      _type: ChannelType,
      _id: string,
      _text: string,
      options?: RecoveryDeliveryOptions,
    ) => {
      const operationId = options?.governedText?.operationId;
      if (!operationId) return err(new Error("governed operation missing"));
      const persistTextChunks = options.governedText.persistTextChunks
        ?? ((chunks: readonly string[]) => queue.recordDecisionTextChunks(operationId, chunks));
      const persisted = await persistTextChunks(["persisted recovery chunk"]);
      if (!persisted.ok) return persisted;
      return ok({
        delivered: true as const,
        status: "accepted" as const,
        platformMessageId: "message-recovered-chunk",
      });
    });
    queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
      governedSendToChannel,
      retryIntervalMs: 0,
    });
    await queue.reserveDecision(decisionInput({ rootRunId: "root-recovered-chunk" }));

    const outcome = await Promise.race([
      queue.drain(vi.fn(async () => true)).then(() => "drained" as const),
      delay(250, "timed_out" as const),
    ]);

    expect(outcome).toBe("drained");
    expect(governedSendToChannel).toHaveBeenCalledOnce();
    expect(queue.size()).toBe(0);
  });

  it("replays persisted delivery extras with the original operation", async () => {
    const extra = {
      reply_markup: { inline_keyboard: [[{ text: "Open", callback_data: "open:1" }]] },
    };
    const seeded = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
    });
    await seeded.reserveDecision(decisionInput({ extra }));
    const { ledger } = makeStubLedger();
    const governedSendToChannel = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
      platformMessageId: "message-extra-1",
    }));
    const restarted = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
      governedSendToChannel,
      retryIntervalMs: 0,
    });

    await restarted.drain(vi.fn(async () => true));

    expect(governedSendToChannel).toHaveBeenCalledWith(
      "telegram",
      "chat-1",
      "scrubbed parent decision input",
      expect.objectContaining({ extra }),
    );
    expect(restarted.size()).toBe(0);
  });

  it("does not adjudicate a parent decision while its rewrite can still be running", async () => {
    const { ledger } = makeStubLedger();
    const governedSendToChannel = vi.fn(async () =>
      ok({ delivered: true, status: "accepted", platformMessageId: "m-1" }),
    );
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
      governedSendToChannel,
    });
    await queue.reserveDecision(decisionInput({
      rootRunId: "root-parent-1",
      failedAt: Date.now(),
    }));

    await queue.drain(vi.fn(async () => true));

    expect(ledger.allocateStep).not.toHaveBeenCalled();
    expect(governedSendToChannel).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(await queue.durableStatus()).toEqual(ok({
      activeRecoveryCount: 1,
      quarantinedCount: 0,
    }));
    expect(await listQuarantined(queue)).toHaveLength(0);
  });

  it("leaves a reservation parked when the ledger cannot answer", async () => {
    // Fail-SAFE: a ledger read that errors must never be read as "not sent".
    const { ledger } = makeStubLedger();
    (ledger.allocateStep as unknown as { mockResolvedValue(v: unknown): void })
      .mockResolvedValue(err(new Error("ledger unavailable")));
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
    });
    await queue.reserveDecision(decisionInput({ rootRunId: "root-parent-1" }));

    await queue.drain(vi.fn(async () => true));

    expect(queue.size()).toBe(1);
  });

  it("isolates a persisted reservation without a rootRunId as invalid evidence", async () => {
    const { ledger } = makeStubLedger();
    const incomplete = {
      ...decisionInput({ rootRunId: undefined }),
      recordType: "parent_decision_reservation",
      id: "incomplete-reservation",
    };
    await writeFile(filePath, `${JSON.stringify(incomplete)}\n`, "utf8");
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
    });

    await queue.drain(vi.fn(async () => true));

    expect(queue.size()).toBe(1);
    expect(ledger.allocateStep).not.toHaveBeenCalled();
    expect(await listQuarantined(queue)).toMatchObject([{
      kind: "invalid_record",
      reason: "schema_mismatch",
    }]);
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
      sessionKey: "default:user:telegram:chat-1",
      announcementText: "scrubbed parent decision input",
      channelId: "chat-1",
      threadId: "topic-1",
      rootRunId: "root-parent-1",
      stepIndex: 4,
      completionKeys: [decisionInput().idempotencyKey],
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
  const terminalDecisions = new Map<string, "delivered" | "discarded" | "no_reply">();
  const ledger: OutwardSendLedgerPort = {
    lookupTerminalDecision: vi.fn(async (rootRunId, operationId) =>
      ok(terminalDecisions.get(`${rootRunId}\u0000${operationId}`))),
    recordTerminalDecision: vi.fn(async (rootRunId, operationId, outcome) => {
      const key = `${rootRunId}\u0000${operationId}`;
      const existing = terminalDecisions.get(key);
      if (existing !== undefined && existing !== outcome) {
        return err(new Error("terminal decision conflict"));
      }
      terminalDecisions.set(key, outcome);
      return ok(undefined);
    }),
    allocateStep: vi.fn(async () => ok(0)),
    lookup: vi.fn(async (rootRunId: string, stepIndex: number) => {
      lookupCalls.push([rootRunId, stepIndex]);
      return options.lookupResult ?? ok(undefined);
    }),
    begin: vi.fn(async () => options.beginResult ?? ok(undefined)),
    markUnknown: vi.fn(async () => options.markUnknownResult ?? ok(undefined)),
    reclaimPreSend: vi.fn(async () => ok(true)),
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
    const logger = createMockLogger();
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
      logger,
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
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-committed-1",
        rootRunId: "root-committed-1",
        stepIndex: 4,
        step: "dlq-ledger-committed-skip",
        durationMs: expect.any(Number),
      }),
      "Committed dead-letter operation removed without replay",
    );
    expect(dlq.size()).toBe(0);
  });

  it("settles one completion key after all committed operations clear", async () => {
    const completionKey = "default:u1:c1::run-multipart-committed";
    const summary = makeFullEntry({
      id: "summary-entry",
      runId: "run-multipart-committed",
      idempotencyKey: "operation-summary",
      rootRunId: "root-multipart-committed",
      stepIndex: 1,
      agentId: "parent-agent",
      announcementText: "summary",
      partId: "summary",
      completionKeys: [completionKey],
    }) as GovernedDeadLetterEntry;
    const finalPart = makeFullEntry({
      id: "final-entry",
      runId: "run-multipart-committed",
      idempotencyKey: "operation-final",
      rootRunId: "root-multipart-committed",
      stepIndex: 2,
      agentId: "parent-agent",
      announcementText: "final part",
      partId: "part:1",
      completionKeys: [completionKey],
    }) as GovernedDeadLetterEntry;
    await writeFile(
      filePath,
      `${JSON.stringify(summary)}\n${JSON.stringify(finalPart)}\n`,
      "utf8",
    );
    const { ledger } = makeStubLedger();
    vi.mocked(ledger.lookup).mockImplementation(async (_rootRunId, stepIndex) =>
      ok(ledgerRow(stepIndex === 1 ? summary : finalPart, "committed")));
    const onDelivered = vi.fn();
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
      outwardLedger: ledger,
    });

    await dlq.drain(vi.fn(async () => true), onDelivered);

    expect(onDelivered).toHaveBeenCalledOnce();
    expect(onDelivered).toHaveBeenCalledWith(completionKey);
    expect(dlq.size()).toBe(0);
  });

  it("commits a receipt-aware absent-row delivery before removing the dead letter", async () => {
    const eventBus = createMockEventBus();
    const logger = createMockLogger();
    const deliveryAuthority = makeDeliveryAuthority("parent-agent");
    const destinationEndpoint = {
      channelType: "telegram",
      channelInstanceId: "telegram-bot-a",
      conversationId: "chat-123",
      conversationKind: "direct",
    } satisfies ChannelEndpoint;
    const entry = {
      ...makeFullEntry({
        runId: "run-uncommitted-1",
        idempotencyKey: "default:u1:c1::run-uncommitted-1",
        rootRunId: "root-uncommitted-1",
        stepIndex: 9,
        agentId: "parent-agent",
        announcementText: "private completion payload",
      } as Partial<DeadLetterEntry>),
      deliveryAuthority,
      destinationEndpoint,
    } as GovernedDeadLetterEntry & {
      deliveryAuthority: DeliveryAuthority;
      destinationEndpoint: ChannelEndpoint;
    };
    await writeFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

    const { ledger, lookupCalls } = makeStubLedger({ lookupResult: ok(undefined) });
    const governedSendToChannel = vi.fn().mockResolvedValue(ok({
      delivered: true,
      status: "accepted",
      platformMessageId: "telegram-receipt-9",
    }));
    const ensureSessionObservation = vi.fn(() => ok(undefined));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus,
      logger,
      retryIntervalMs: 0,
      outwardLedger: ledger,
      governedSendToChannel,
      ensureSessionObservation,
    } as never);
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const onDelivered = vi.fn();

    await dlq.drain(sendToChannel, onDelivered);

    expect(lookupCalls).toEqual([["root-uncommitted-1", 9]]);
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(governedSendToChannel).toHaveBeenCalledOnce();
    expect(governedSendToChannel).toHaveBeenCalledWith(
      "telegram",
      "chat-123",
      "private completion payload",
      { authority: deliveryAuthority, destinationEndpoint },
    );
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
    expect(ensureSessionObservation).toHaveBeenCalledWith({
      agentId: "parent-agent",
      sessionKey: entry.sessionKey,
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      "delivery:outward_ledger_transition",
      expect.objectContaining({
        rootRunId: "root-uncommitted-1",
        stepIndex: 9,
        transition: "commit",
        outcome: "committed",
        sessionKey: entry.sessionKey,
        platformMessageId: "telegram-receipt-9",
      }),
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
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-uncommitted-1",
        rootRunId: "root-uncommitted-1",
        stepIndex: 9,
        step: "dlq-ledger-receipt-committed",
        attemptCount: 1,
        durationMs: expect.any(Number),
      }),
      "Dead-letter entry delivered and platform receipt committed",
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Committed dead-letter operation removed without replay",
    );
    expect(dlq.size()).toBe(0);
  });

  it("rebuilds and settles one retained attachment operation", async () => {
    const completionKey = "default:u1:c1::run-attachment-recovery";
    const entry = makeFullEntry({
      runId: "run-attachment-recovery",
      idempotencyKey: "operation-attachment-recovery",
      rootRunId: "root-attachment-recovery",
      stepIndex: 10,
      agentId: "parent-agent",
      announcementText: "attachment caption",
      partId: "attachment:0",
      attachment: snapshotAttachment("worker-a", "report.txt"),
      completionKeys: [completionKey],
    }) as GovernedDeadLetterEntry;
    await writeFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    const cleanupAttachment = vi.fn(async () => ok(undefined));
    const governedSendToChannel = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
      platformMessageId: "attachment-receipt",
    }));
    const { ledger } = makeStubLedger({ lookupResult: ok(undefined) });
    const onDelivered = vi.fn();
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
      outwardLedger: ledger,
      governedSendToChannel,
      cleanupAttachment,
    });

    await dlq.drain(vi.fn(async () => true), onDelivered);

    expect(governedSendToChannel).toHaveBeenCalledWith(
      "telegram",
      "chat-123",
      "attachment caption",
      expect.objectContaining({
        authority: entry.deliveryAuthority,
        destinationEndpoint: entry.destinationEndpoint,
      }),
      entry.attachment,
    );
    expect(ledger.commit).toHaveBeenCalledWith(
      "root-attachment-recovery",
      10,
      "attachment-receipt",
    );
    expect(cleanupAttachment).toHaveBeenCalledWith(entry.attachment);
    expect(onDelivered).toHaveBeenCalledWith(completionKey);
    expect(dlq.size()).toBe(0);
  });

  it("settles a committed attachment without reopening its source file", async () => {
    const entry = makeFullEntry({
      runId: "run-attachment-committed",
      idempotencyKey: "operation-attachment-committed",
      rootRunId: "root-attachment-committed",
      stepIndex: 14,
      agentId: "parent-agent",
      partId: "attachment:0",
      attachment: snapshotAttachment("worker-a", "missing-report.txt"),
      completionKeys: ["completion-attachment-committed"],
    }) as GovernedDeadLetterEntry;
    await writeFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    const { ledger } = makeStubLedger({
      lookupResult: ok(ledgerRow(entry, "committed")),
    });
    vi.mocked(ledger.allocateStep).mockResolvedValue(ok(14));
    const governedSendToChannel = vi.fn();
    const ensureSessionObservation = vi.fn(() => ok(undefined));
    const dlq = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      retryIntervalMs: 0,
      outwardLedger: ledger,
      governedSendToChannel,
      ensureSessionObservation,
    });

    await dlq.drain(vi.fn(async () => true));

    expect(governedSendToChannel).not.toHaveBeenCalled();
    expect(ensureSessionObservation).toHaveBeenCalledWith({
      agentId: "parent-agent",
      sessionKey: entry.sessionKey,
    });
    expect(dlq.size()).toBe(0);
  });

  it.each([
    ["send_attempt_started", "outward_operation_unresolved"],
    ["unknown_after_send", "outward_operation_unresolved"],
    ["unresolved", "outward_operation_unresolved"],
    ["failed", "outward_operation_failed"],
  ] as const)(
    "surfaces retained attachment state %s without reopening its source file",
    async (state, expectedReason) => {
      const entry = makeFullEntry({
        runId: `run-attachment-${state}`,
        idempotencyKey: `operation-attachment-${state}`,
        rootRunId: `root-attachment-${state}`,
        stepIndex: 15,
        agentId: "parent-agent",
        partId: "attachment:0",
        attachment: snapshotAttachment("worker-a", "missing-report.txt"),
        completionKeys: [`completion-attachment-${state}`],
      }) as GovernedDeadLetterEntry;
      await writeFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
      const { ledger } = makeStubLedger({
        lookupResult: ok(ledgerRow(entry, state)),
      });
      vi.mocked(ledger.allocateStep).mockResolvedValue(ok(15));
      const governedSendToChannel = vi.fn();
      const dlq = createAnnouncementDeadLetterQueue({
        filePath,
        eventBus: createMockEventBus(),
        retryIntervalMs: 0,
        outwardLedger: ledger,
        governedSendToChannel,
      });

      await dlq.drain(vi.fn(async () => true));

      expect(governedSendToChannel).not.toHaveBeenCalled();
      expect((await listQuarantined(dlq))[0]).toMatchObject({
        lastError: expectedReason,
      });
    },
  );

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
      status: "accepted",
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

  it("isolates a governed row that lacks its complete recovery route", async () => {
    const eventBus = createMockEventBus();
    const entry = makeFullEntry({
      runId: "run-incomplete-identity",
      rootRunId: "root-incomplete-identity",
      stepIndex: 11,
    });
    delete entry.deliveryAuthority;
    delete entry.destinationEndpoint;
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
    expect(await listQuarantined(dlq)).toMatchObject([{
      kind: "invalid_record",
      reason: "schema_mismatch",
    }]);
    expect(dlq.size()).toBe(1);
  });

  it("never age-expires or attempt-drops governed evidence and backpressures overflow", async () => {
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

    const admissionInput = (entry: GovernedDeadLetterEntry) => ({
        announcementText: entry.announcementText,
        channelType: entry.channelType,
        channelId: entry.channelId,
        agentId: entry.agentId,
        runId: entry.runId,
        sessionKey: entry.sessionKey,
        failedAt: entry.failedAt,
        attemptCount: entry.attemptCount,
        rootRunId: entry.rootRunId,
        stepIndex: entry.stepIndex,
        deliveryAuthority: entry.deliveryAuthority,
        destinationEndpoint: entry.destinationEndpoint,
      });
    expect(await dlq.enqueue(admissionInput(entryA))).toEqual(ok(undefined));
    let overflowSettled = false;
    const overflow = dlq.enqueue(admissionInput(entryB)).finally(() => {
      overflowSettled = true;
    });
    await delay(10);
    expect(overflowSettled).toBe(false);
    expect(dlq.size()).toBe(1);

    const sendToChannel = vi.fn().mockResolvedValue(true);
    await dlq.drain(sendToChannel);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(dlq.size()).toBe(1);
    const firstId = (await listQuarantined(dlq))[0]!.id;
    expect(await dlq.release(firstId, "discarded")).toEqual(ok(true));
    await expect(overflow).resolves.toEqual(ok(undefined));
    expect((await readFile(filePath, "utf-8")).trim().split("\n")).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// The operator lever. A quarantined announcement is held BY DESIGN — nothing
// drains it, because retrying risks a duplicate delivery. Live on comis-moshe a
// governed entry sat unresolved for 45 minutes, re-warning every 5, and the
// only way to clear it was to stop the daemon and delete the JSONL by hand: the
// in-memory queue is authoritative and rewrites the file on the next persist,
// so editing it under a running daemon is silently undone. A condition the
// runtime knows about and offers no lever for is not finished.
// ---------------------------------------------------------------------------
describe("AnnouncementDeadLetterQueue operator lever", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dlq-operator-"));
    filePath = join(tmpDir, "dead-letters.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("separates active recovery from operator quarantine", async () => {
    const { ledger } = makeStubLedger();
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
    });
    await queue.enqueue(makeEntry({
      runId: "run-retryable",
      idempotencyKey: "operation-retryable",
      rootRunId: "root-retryable",
      stepIndex: 1,
      lastError: "outward_ledger_lookup_blocked",
    }));
    expect(await queue.durableStatus()).toEqual({
      ok: true,
      value: { activeRecoveryCount: 1, quarantinedCount: 0 },
    });
    expect(await listQuarantined(queue)).toHaveLength(0);
  });

  it("lists a quarantined announcement by id without exposing its text", async () => {
    const queue = createAnnouncementDeadLetterQueue({ filePath, eventBus: createMockEventBus() });
    await queue.enqueue(makeEntry({
      runId: "run-stuck",
      channelType: "telegram",
      channelId: "678314278",
      announcementText: "the answer the user never saw",
      lastError: "outward_operation_unresolved",
      attemptCount: 5,
    }));

    const rows = await listQuarantined(queue);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.runId).toBe("run-stuck");
    expect(row.channelType).toBe("telegram");
    expect(row.channelId).toBe("678314278");
    expect(row.lastError).toBe("outward_operation_unresolved");
    expect(row.kind).toBe("entry");
    expect(typeof row.id).toBe("string");
    // The operator needs to know there IS content and how much, never the
    // content itself: this row rides an admin RPC and a terminal.
    expect(row.announcementChars).toBe("the answer the user never saw".length);
    expect(JSON.stringify(row)).not.toContain("the answer the user never saw");
  });

  it("lists entries written by a PREVIOUS process, before any drain has run", async () => {
    // The queue loads from disk lazily, inside the serialized operations. A
    // fresh daemon has not drained yet, so an operator running `list` right
    // after a restart saw an empty queue while the JSONL held a stuck item —
    // the exact state the command exists to surface. Reproduced live on
    // comis-moshe against a real parked announcement.
    const seeded = createAnnouncementDeadLetterQueue({ filePath, eventBus: createMockEventBus() });
    await seeded.enqueue(makeEntry({
      runId: "run-from-a-previous-boot",
      attemptCount: 5,
    }));

    // A brand-new queue over the same file: nothing has loaded it yet.
    const fresh = createAnnouncementDeadLetterQueue({ filePath, eventBus: createMockEventBus() });
    const rows = await listQuarantined(fresh);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe("run-from-a-previous-boot");
  });

  it("releases a quarantined announcement by id and persists the removal", async () => {
    const queue = createAnnouncementDeadLetterQueue({ filePath, eventBus: createMockEventBus() });
    const entry = makeEntry({ runId: "run-stuck", attemptCount: 5 });
    await queue.enqueue(entry);
    const id = (await listQuarantined(queue))[0]!.id;

    const released = await queue.release(id, "discarded");

    expect(released).toMatchObject({ ok: true, value: true });
    expect(await listQuarantined(queue)).toHaveLength(0);
    expect(queue.size()).toBe(0);
    // Durable: a fresh queue over the same file must not resurrect it.
    const reloaded = createAnnouncementDeadLetterQueue({ filePath, eventBus: createMockEventBus() });
    await reloaded.enqueue(entry);
    await reloaded.drain(vi.fn().mockResolvedValue(true));
    expect(reloaded.size()).toBe(0);
  });

  it("records governed terminal decisions before removing quarantine evidence", async () => {
    const { ledger } = makeStubLedger();
    let decision: "delivered" | "discarded" | "no_reply" | undefined;
    vi.mocked(ledger.lookupTerminalDecision).mockImplementation(async () => ok(decision));
    vi.mocked(ledger.recordTerminalDecision).mockImplementation(async (_root, _operation, outcome) => {
      decision = outcome;
      return ok(undefined);
    });
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
    });
    const entry = makeEntry({
      runId: "run-governed-release",
      idempotencyKey: "operation-governed-release",
      rootRunId: "root-governed-release",
      stepIndex: 4,
      lastError: "outward_operation_unresolved",
    });
    await queue.enqueue(entry);
    const id = (await listQuarantined(queue))[0]!.id;

    expect(await queue.release(id, "discarded")).toEqual(ok(true));
    expect(ledger.recordTerminalDecision).toHaveBeenCalledWith(
      "root-governed-release",
      "operation-governed-release",
      "discarded",
    );
    await queue.enqueue(entry);
    expect(queue.size()).toBe(0);
  });

  it("settles the uncertain governed chunk before recovering its tail", async () => {
    const chunks = ["first governed chunk", "second governed chunk"];
    const runId = "run-governed-chunk-release";
    const sessionKey = "default:agent-a:telegram:chat-123:user_a";
    const partId = "summary";
    const chunkOperationIds = chunks.map((_, chunkIndex) =>
      createStableAnnouncementChunkOperationId(
        "agent-a",
        sessionKey,
        runId,
        partId,
        chunkIndex,
      ));
    const { ledger } = makeStubLedger();
    vi.mocked(ledger.allocateStep).mockImplementation(async (_rootRunId, operationId) =>
      ok(chunkOperationIds.indexOf(operationId)));
    vi.mocked(ledger.lookup).mockImplementation(async (rootRunId, stepIndex) =>
      stepIndex === 0
        ? ok({
            id: `${rootRunId}:${stepIndex}`,
            rootRunId,
            stepIndex,
            agentId: "agent-a",
            channelType: "telegram",
            channelId: "chat-123",
            state: "unresolved" as const,
            operationKind: "cross_session_announcement" as const,
            operationFingerprint: "a".repeat(64),
            contentDigest: "b".repeat(64),
            attemptCount: 1,
            attemptedAtMs: 100,
          })
        : ok(undefined));
    const governedSendToChannel = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
      platformMessageId: "message-tail",
    }));
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      outwardLedger: ledger,
      governedSendToChannel,
      retryIntervalMs: 0,
    });
    await queue.enqueue(makeEntry({
      runId,
      sessionKey,
      rootRunId: "root-governed-chunk-release",
      idempotencyKey: "governed-chunk-parent",
      partId,
      textChunks: chunks,
      lastError: "outward_operation_unresolved",
    }));
    const id = (await listQuarantined(queue))[0]!.id;

    await expect(queue.release(id, "delivered")).resolves.toEqual(ok(true));

    expect(ledger.recordTerminalDecision).toHaveBeenCalledWith(
      "root-governed-chunk-release",
      chunkOperationIds[0],
      "delivered",
    );
    expect(queue.size()).toBe(1);
    await queue.drain(vi.fn(async () => false));
    expect(governedSendToChannel).toHaveBeenCalledWith(
      "telegram",
      "chat-123",
      "Task completed successfully",
      expect.objectContaining({
        governedText: expect.objectContaining({ preparedTextChunks: chunks }),
      }),
    );
    expect(queue.size()).toBe(0);
  });

  it("does not spend pending capacity on prior terminal decisions", async () => {
    const queue = createAnnouncementDeadLetterQueue({
      filePath,
      eventBus: createMockEventBus(),
      maxEntries: 1,
    });
    const first = makeEntry({ runId: "run-release-first", attemptCount: 5 });
    const second = makeEntry({ runId: "run-release-second", attemptCount: 5 });

    await queue.enqueue(first);
    const firstId = (await listQuarantined(queue))[0]!.id;
    expect(await queue.release(firstId, "discarded")).toEqual(ok(true));
    await expect(queue.enqueue(second)).resolves.toEqual(ok(undefined));
    const secondId = (await listQuarantined(queue))[0]!.id;
    expect(await queue.release(secondId, "discarded")).toEqual(ok(true));
  });

  it("reports an unknown id as not released rather than failing the call", async () => {
    const queue = createAnnouncementDeadLetterQueue({ filePath, eventBus: createMockEventBus() });
    await queue.enqueue(makeEntry({ runId: "run-stuck" }));

    const released = await queue.release("no-such-id", "discarded");

    expect(released).toMatchObject({ ok: true, value: false });
    expect(queue.size()).toBe(1);
  });
});
