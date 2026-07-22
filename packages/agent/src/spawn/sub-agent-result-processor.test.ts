// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtemp, writeFile, mkdir, readdir, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@comis/shared";
import { createConversationLocator, formatSessionKey } from "@comis/core";
import { createDeliveryDedup } from "./announce-key.js";
import {
  sweepResultFiles,
  persistFailureRecord,
  deliverAnnouncement,
  deliverFailureNotification,
  classifyErrorContext,
} from "./sub-agent-result-processor.js";

function makeCallerConversation(agentId = "agent-main", tenantId = "default") {
  const result = createConversationLocator({ tenantId, agentId, partition: { kind: "agent" } });
  if (!result.ok) throw result.error;
  return result.value;
}

function makeCallerEndpoint(
  channelType = "telegram",
  conversationId = "chat-1",
  threadId?: string,
) {
  return {
    channelType,
    channelInstanceId: "test-instance",
    conversationId,
    conversationKind: "direct" as const,
    ...(threadId ? { threadId } : {}),
  };
}

// ---------------------------------------------------------------------------
// sweepResultFiles
// ---------------------------------------------------------------------------

describe("sweepResultFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sweep-test-"));
  });

  afterEach(async () => {
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("removes files older than retention TTL", async () => {
    // Create subagent-results/session_1/run1.json
    const sessionDir = join(tmpDir, "subagent-results", "session_1");
    await mkdir(sessionDir, { recursive: true });
    const filePath = join(sessionDir, "run1.json");
    await writeFile(filePath, '{"result": "test"}');

    // Backdate the file to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await utimes(filePath, twoDaysAgo, twoDaysAgo);

    // Sweep with 24h retention
    await sweepResultFiles(tmpDir, 86_400_000);

    // File should be deleted
    const remaining = await readdir(sessionDir).catch(() => []);
    expect(remaining).toHaveLength(0);
  });

  it("preserves files within retention TTL", async () => {
    // Create subagent-results/session_1/run1.json (fresh file)
    const sessionDir = join(tmpDir, "subagent-results", "session_1");
    await mkdir(sessionDir, { recursive: true });
    const filePath = join(sessionDir, "run1.json");
    await writeFile(filePath, '{"result": "test"}');

    // Sweep with 24h retention -- file is fresh
    await sweepResultFiles(tmpDir, 86_400_000);

    // File should still exist
    const remaining = await readdir(sessionDir);
    expect(remaining).toContain("run1.json");
  });

  it("removes empty session directories after sweeping", async () => {
    // Create subagent-results/session_1/run1.json
    const sessionDir = join(tmpDir, "subagent-results", "session_1");
    await mkdir(sessionDir, { recursive: true });
    const filePath = join(sessionDir, "run1.json");
    await writeFile(filePath, '{"result": "test"}');

    // Backdate
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await utimes(filePath, twoDaysAgo, twoDaysAgo);

    await sweepResultFiles(tmpDir, 86_400_000);

    // Both the file AND the empty directory should be removed
    const resultsDir = join(tmpDir, "subagent-results");
    const sessionDirs = await readdir(resultsDir);
    expect(sessionDirs).not.toContain("session_1");
  });

  it("returns gracefully when results directory does not exist", async () => {
    // Call on a non-existent directory -- should not throw
    const randomDir = join(tmpdir(), `nonexistent-${Date.now()}`);
    await expect(sweepResultFiles(randomDir, 86_400_000)).resolves.toBeUndefined();
  });

  it("does not crash on empty results directory", async () => {
    // Create empty subagent-results directory
    const resultsDir = join(tmpDir, "subagent-results");
    await mkdir(resultsDir, { recursive: true });

    await expect(sweepResultFiles(tmpDir, 86_400_000)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// persistFailureRecord
// ---------------------------------------------------------------------------

describe("persistFailureRecord", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "failure-record-test-"));
  });

  afterEach(async () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("writes correct JSON structure for failed endReason", async () => {
    await persistFailureRecord({
      dataDir: tmpDir,
      sessionKey: "default:sub-agent-abc:sub-agent:abc",
      runId: "run-123",
      task: "test task",
      error: "boom",
      endReason: "failed",
      runtimeMs: 5000,
    });

    const filePath = join(tmpDir, "subagent-results", "default_sub-agent-abc_sub-agent_abc", "run-123.json");
    const content = JSON.parse(await readFile(filePath, "utf-8"));

    expect(content.runId).toBe("run-123");
    expect(content.sessionKey).toBe("default:sub-agent-abc:sub-agent:abc");
    expect(content.task).toBe("test task");
    expect(content.status).toBe("failed");
    expect(content.error).toBe("boom");
    expect(content.endReason).toBe("failed");
    expect(content.runtimeMs).toBe(5000);
    expect(content.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("writes correct JSON structure for killed endReason", async () => {
    await persistFailureRecord({
      dataDir: tmpDir,
      sessionKey: "default:sub-agent-xyz:sub-agent:xyz",
      runId: "run-456",
      task: "killed task",
      error: "Killed by parent agent",
      endReason: "killed",
      runtimeMs: 12000,
    });

    const filePath = join(tmpDir, "subagent-results", "default_sub-agent-xyz_sub-agent_xyz", "run-456.json");
    const content = JSON.parse(await readFile(filePath, "utf-8"));

    expect(content.runId).toBe("run-456");
    expect(content.status).toBe("failed");
    expect(content.endReason).toBe("killed");
    expect(content.error).toBe("Killed by parent agent");
    expect(content.runtimeMs).toBe(12000);
  });

  it("swallows write errors with belt-defense (never throws)", async () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    // Use an invalid path that cannot be written
    await expect(
      persistFailureRecord({
        dataDir: "/dev/null/impossible",
        sessionKey: "default:test:test",
        runId: "run-err",
        task: "task",
        error: "some error",
        endReason: "failed",
        runtimeMs: 1000,
      }, mockLogger),
    ).resolves.toBeUndefined();

    // Logger should have been called with the warning
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-err",
        hint: "Failed to persist failure record to disk; diagnostics will be lost on restart",
        errorKind: "internal",
      }),
      "Failure record persistence failed",
    );
  });

  // -----------------------------------------------------------------------
  // Cache field propagation tests
  // -----------------------------------------------------------------------

  it("persists cache fields in failure record when provided", async () => {
    await persistFailureRecord({
      dataDir: tmpDir,
      sessionKey: "default:sub-agent-cache:sub-agent:cache",
      runId: "run-cache-1",
      task: "cache test task",
      error: "task failed",
      endReason: "failed",
      runtimeMs: 3000,
      usage: {
        totalTokens: 500,
        costUsd: 0.05,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        cacheSavedUsd: 0.01,
      },
    });

    const filePath = join(tmpDir, "subagent-results", "default_sub-agent-cache_sub-agent_cache", "run-cache-1.json");
    const content = JSON.parse(await readFile(filePath, "utf-8"));

    expect(content.usage.totalTokens).toBe(500);
    expect(content.usage.costUsd).toBe(0.05);
    expect(content.usage.cacheReadTokens).toBe(200);
    expect(content.usage.cacheWriteTokens).toBe(100);
    expect(content.usage.cacheSavedUsd).toBe(0.01);
  });

  it("usage without cache fields persists and parses without error (cache fields optional)", async () => {
    await persistFailureRecord({
      dataDir: tmpDir,
      sessionKey: "default:sub-agent-compat:sub-agent:compat",
      runId: "run-compat-1",
      task: "compat test task",
      error: "old-style failure",
      endReason: "failed",
      runtimeMs: 2000,
      usage: { totalTokens: 500, costUsd: 0.05 },
    });

    const filePath = join(tmpDir, "subagent-results", "default_sub-agent-compat_sub-agent_compat", "run-compat-1.json");
    const content = JSON.parse(await readFile(filePath, "utf-8"));

    expect(content.usage.totalTokens).toBe(500);
    expect(content.usage.costUsd).toBe(0.05);
    // Cache fields should be undefined (not present), not crash
    expect(content.usage.cacheReadTokens).toBeUndefined();
    expect(content.usage.cacheWriteTokens).toBeUndefined();
    expect(content.usage.cacheSavedUsd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deliverFailureNotification
// ---------------------------------------------------------------------------

describe("deliverFailureNotification", () => {
  it("commits a governed failure notice only from its receipt-aware outcome", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const sendGovernedAnnouncement = vi.fn().mockResolvedValue(ok({
      delivered: true as const,
      identity: { agentId: "parent-agent", rootRunId: "root-1", stepIndex: 4 },
    }));
    const deliveryDedup = createDeliveryDedup();

    await deliverFailureNotification({
      channelType: "telegram",
      channelId: "chat-1",
      threadId: "topic-1",
      task: "failed child task",
      runtimeMs: 1_000,
      runId: "run-1",
      callerAgentId: "parent-agent",
      callerSessionKey: "default:user_a:chat-1",
      callerConversation: makeCallerConversation("parent-agent"),
      destinationEndpoint: makeCallerEndpoint("telegram", "chat-1", "topic-1"),
    }, { sendToChannel, sendGovernedAnnouncement, deliveryDedup });

    expect(sendGovernedAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "parent-agent",
      callerSessionKey: "default:user_a:chat-1",
      runId: "run-1",
      channelType: "telegram",
      channelId: "chat-1",
      options: { threadId: "topic-1" },
    }));
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(deliveryDedup.has("default:user_a:chat-1::run-1")).toBe(true);
  });

  it("does not raw-fallback or mark a governed false or lost response", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const deliveryDedup = createDeliveryDedup();
    const base = {
      channelType: "telegram",
      channelId: "chat-1",
      task: "failed child task",
      runtimeMs: 1_000,
      callerAgentId: "parent-agent",
      callerSessionKey: "default:user_a:chat-1",
      callerConversation: makeCallerConversation("parent-agent"),
      destinationEndpoint: makeCallerEndpoint(),
    };
    const falseOutcome = vi.fn().mockResolvedValue(ok({
      delivered: false as const,
      failure: "operation_retained" as const,
    }));

    await expect(deliverFailureNotification(
      { ...base, runId: "run-false" },
      { sendToChannel, sendGovernedAnnouncement: falseOutcome, deliveryDedup },
    )).rejects.toThrow("Governed failure notification was not confirmed");

    const responseLoss = vi.fn().mockRejectedValue(new Error("private response loss"));
    await expect(deliverFailureNotification(
      { ...base, runId: "run-loss" },
      { sendToChannel, sendGovernedAnnouncement: responseLoss, deliveryDedup },
    )).rejects.toThrow("Governed failure notification was not confirmed");

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(deliveryDedup.size).toBe(0);
  });

  it("joins concurrent governed failure notices onto one operation", async () => {
    let settle!: (value: ReturnType<typeof ok>) => void;
    const sendGovernedAnnouncement = vi.fn().mockReturnValue(new Promise((resolve) => {
      settle = resolve;
    }));
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const params = {
      channelType: "telegram",
      channelId: "chat-1",
      task: "failed child task",
      runtimeMs: 1_000,
      runId: "run-concurrent",
      callerAgentId: "parent-agent",
      callerSessionKey: "default:user_a:chat-1",
      callerConversation: makeCallerConversation("parent-agent"),
      destinationEndpoint: makeCallerEndpoint(),
    };

    const first = deliverFailureNotification(params, { sendToChannel, sendGovernedAnnouncement });
    const second = deliverFailureNotification(params, { sendToChannel, sendGovernedAnnouncement });
    await Promise.resolve();

    expect(sendGovernedAnnouncement).toHaveBeenCalledOnce();
    settle(ok({
      delivered: true as const,
      identity: { agentId: "parent-agent", rootRunId: "root-1", stepIndex: 5 },
    }));
    await Promise.all([first, second]);
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("blocks an ownerless notice when governed delivery is configured", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const sendGovernedAnnouncement = vi.fn();

    await expect(deliverFailureNotification({
      channelType: "telegram",
      channelId: "chat-1",
      task: "failed child task",
      runtimeMs: 1_000,
      runId: "run-ownerless",
    }, { sendToChannel, sendGovernedAnnouncement })).rejects.toThrow(
      "Governed failure notification requires caller delivery authority",
    );

    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("sends static message via sendToChannel without LLM call", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await deliverFailureNotification(
      {
        channelType: "discord",
        channelId: "chan-1",
        task: "research important topic",
        runtimeMs: 5432,
        runId: "run-abc",
      },
      { sendToChannel, logger },
    );

    expect(sendToChannel).toHaveBeenCalledOnce();
    const message = sendToChannel.mock.calls[0]![2] as string;
    expect(message).toContain("task encountered an error");
    expect(message).toContain("Runtime: 5.4s");
    expect(message).toContain("research important topic");
    // Must NOT contain any raw error details
    expect(message).not.toContain("Error:");
    expect(message).not.toContain("stack");
    expect(message).not.toContain("at ");
  });

  it("uses the thread route captured with a failure notification", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);

    await deliverFailureNotification({
      channelType: "telegram",
      channelId: "chat-2",
      threadId: "topic-42",
      task: "research important topic",
      runtimeMs: 1_000,
      runId: "run-thread",
    }, { sendToChannel });

    expect(sendToChannel).toHaveBeenCalledWith(
      "telegram",
      "chat-2",
      expect.any(String),
      { threadId: "topic-42" },
    );
  });

  it("truncates long task strings to 100 chars", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const longTask = "A".repeat(150);

    await deliverFailureNotification(
      {
        channelType: "telegram",
        channelId: "chat-2",
        task: longTask,
        runtimeMs: 1000,
        runId: "run-trunc",
      },
      { sendToChannel },
    );

    const message = sendToChannel.mock.calls[0]![2] as string;
    // Truncated to 97 + "..." = 100 chars for taskPreview
    expect(message).toContain("A".repeat(97) + "...");
    expect(message).not.toContain("A".repeat(101));
  });

  it("logs WARN and rejects when sendToChannel throws", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(
      new Error("Authorization: Bearer PRIVATE_FAILURE_NOTICE_SENTINEL"),
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await expect(deliverFailureNotification(
      {
        channelType: "discord",
        channelId: "chan-fail",
        task: "some task",
        runtimeMs: 2000,
        runId: "run-warn",
      },
      { sendToChannel, logger },
    )).rejects.toThrow("PRIVATE_FAILURE_NOTICE_SENTINEL");

    expect(logger.warn).toHaveBeenCalledOnce();
    const warnObj = logger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(warnObj.runId).toBe("run-warn");
    expect(warnObj.hint).toContain("user will not be notified");
    expect(warnObj.errorKind).toBe("network");
    expect(typeof warnObj.err).toBe("string");
    expect(JSON.stringify(warnObj)).not.toContain("PRIVATE_FAILURE_NOTICE_SENTINEL");
  });

  it("rejects a resolved false channel result without marking delivery", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(false);
    const batcher = makeStubBatcher();

    await expect(deliverFailureNotification({
      channelType: "telegram",
      channelId: "chat-false",
      task: "failed task",
      runtimeMs: 1_000,
      runId: "run-false",
      callerSessionKey: "default:user_a:chat_a",
    }, { sendToChannel, batcher })).rejects.toThrow("sendToChannel returned false");

    expect(batcher.markDelivered).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deliverFailureNotification idempotency
//
// The failure path must dedup on the SAME announceKey = `${callerSessionKey}::${runId}`
// that the success path (deliverAnnouncement) builds, sharing the batcher's
// deliveredKeys via hasDelivered/markDelivered.
// A budget-failed graph node delivered twice must notify ONCE.
// ---------------------------------------------------------------------------

/** A stub batcher whose delivered-key set is a real shared Set (mirrors the orchestrator batcher). */
function makeStubBatcher() {
  const deliveredKeys = new Set<string>();
  const markDelivered = vi.fn((key: string) => { deliveredKeys.add(key); });
  const hasDelivered = vi.fn((key: string) => deliveredKeys.has(key));
  return {
    enqueue: vi.fn().mockResolvedValue(ok("queued")),
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    get pending() { return 0; },
    hasDelivered,
    markDelivered,
  };
}

function makeDecisionDeadLetterQueue() {
  return {
    enqueue: vi.fn().mockResolvedValue(ok(undefined)),
    reserveDecision: vi.fn().mockResolvedValue(ok({ created: true })),
    lookupDecision: vi.fn().mockResolvedValue(ok(undefined)),
    resolveDecision: vi.fn().mockResolvedValue(ok(true)),
    drain: vi.fn().mockResolvedValue(undefined),
    size: vi.fn().mockReturnValue(0),
  };
}

describe("deliverFailureNotification idempotency on the shared announce key", () => {
  it("is idempotent on the same (callerSessionKey, runId): second call is a no-op", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const batcher = makeStubBatcher();

    const params = {
      channelType: "discord",
      channelId: "chan-1",
      task: "budget-capped task",
      runtimeMs: 1234,
      runId: "r1",
      callerSessionKey: "default:u1:c1",
    };

    await deliverFailureNotification(params, { sendToChannel, logger, batcher });
    await deliverFailureNotification(params, { sendToChannel, logger, batcher });

    // First delivery sent once; the second short-circuits before sendToChannel.
    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(batcher.hasDelivered).toHaveBeenCalledWith("default:u1:c1::r1");
  });

  it("marks the SAME key the success path would mark (cross-path collision)", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const batcher = makeStubBatcher();

    await deliverFailureNotification(
      {
        channelType: "telegram",
        channelId: "chat-2",
        task: "t",
        runtimeMs: 500,
        runId: "r1",
        callerSessionKey: "default:u1:c1",
      },
      { sendToChannel, batcher },
    );

    // Proves a budget-failed node's failure-key == its success-key (deliverAnnouncement:514).
    expect(batcher.markDelivered).toHaveBeenCalledOnce();
    expect(batcher.markDelivered).toHaveBeenCalledWith("default:u1:c1::r1");
  });

  it("does NOT mark delivered when sendToChannel rejects (key stays retry-eligible)", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("network down"));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const batcher = makeStubBatcher();

    await expect(deliverFailureNotification(
      {
        channelType: "discord",
        channelId: "chan-fail",
        task: "t",
        runtimeMs: 2000,
        runId: "r1",
        callerSessionKey: "default:u1:c1",
      },
      { sendToChannel, logger, batcher },
    )).rejects.toThrow("network down");

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(batcher.markDelivered).not.toHaveBeenCalled();
    expect(batcher.hasDelivered("default:u1:c1::r1")).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("no-op dedup when callerSessionKey is absent (top-level spawn) — always sends", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const batcher = makeStubBatcher();

    const params = {
      channelType: "discord",
      channelId: "chan-1",
      task: "t",
      runtimeMs: 100,
      runId: "r-top",
      // no callerSessionKey
    };

    await deliverFailureNotification(params, { sendToChannel, batcher });
    await deliverFailureNotification(params, { sendToChannel, batcher });

    // No key → no dedup → both sends fire; the batcher dedup pair is never consulted.
    expect(sendToChannel).toHaveBeenCalledTimes(2);
    expect(batcher.hasDelivered).not.toHaveBeenCalled();
    expect(batcher.markDelivered).not.toHaveBeenCalled();
  });

  it("defers to a still-pending batched announcement instead of double-notifying", async () => {
    // The daemon-shutdown race: the run's completion announcement is already
    // enqueued with the batcher (not yet flushed, so hasDelivered is false)
    // when the shutdown sweep fires deliverFailureNotification for the same
    // key. The pending announcement owns delivery — the failure notice must
    // NOT also go out, or the recipient gets both messages for one runId.
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const batcher = {
      ...makeStubBatcher(),
      hasPending: vi.fn((key: string) => key === "default:u1:c1::r1"),
    };

    await deliverFailureNotification(
      {
        channelType: "discord",
        channelId: "chan-1",
        task: "shutdown-straddled task",
        runtimeMs: 1234,
        runId: "r1",
        callerSessionKey: "default:u1:c1",
      },
      { sendToChannel, logger, batcher },
    );

    expect(batcher.hasPending).toHaveBeenCalledWith("default:u1:c1::r1");
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(batcher.markDelivered).not.toHaveBeenCalled();
  });

  it("always sends when deps.batcher is absent (no dedup sink is consulted, never throws)", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);

    const params = {
      channelType: "discord",
      channelId: "chan-1",
      task: "t",
      runtimeMs: 100,
      runId: "r1",
      callerSessionKey: "default:u1:c1",
    };

    // No batcher (and no deliveryDedup) in deps → no dedup sink → both sends fire.
    await deliverFailureNotification(params, { sendToChannel });
    await deliverFailureNotification(params, { sendToChannel });

    expect(sendToChannel).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// In a NO-BATCHER construction the success path must still mark delivered
// so the failure path dedups. If deliverAnnouncement only marked a key
// indirectly THROUGH the batcher, its non-batcher success branches (direct
// announceToParent / direct sendToChannel) would deliver to the user but never
// mark, leaving deliverFailureNotification's dedup silently inert whenever the
// runner is constructed without a batcher. A shared DeliveryDedup injected into
// BOTH closes the hole: a success then a sweep-driven failure on the same key
// must NOT double-deliver, with or without a batcher.
// ---------------------------------------------------------------------------

describe("deliverAnnouncement / deliverFailureNotification shared dedup without a batcher", () => {
  it("reserves a direct parent decision before its tool-free candidate execution", async () => {
    const callerSessionKey = formatSessionKey({
      tenantId: "default", agentId: "agent-main", userId: "user_a", channelId: "chat-1",
    });
    let finishReservation!: (value: ReturnType<typeof ok>) => void;
    const deadLetterQueue = makeDecisionDeadLetterQueue();
    deadLetterQueue.reserveDecision.mockReturnValue(new Promise((resolve) => {
      finishReservation = resolve;
    }));
    const announceToParent = vi.fn().mockResolvedValue("rewritten");
    const sendGovernedAnnouncement = vi.fn().mockResolvedValue(ok({
      delivered: true as const,
      identity: { agentId: "agent-main", rootRunId: "root-1", stepIndex: 9 },
    }));

    const delivery = deliverAnnouncement({
      announcementText: "[System Message]\nResult: complete",
      announceChannelType: "telegram",
      announceChannelId: "chat-1",
      callerAgentId: "agent-main",
      callerSessionKey,
      callerConversation: makeCallerConversation(),
      destinationEndpoint: makeCallerEndpoint(),
      runId: "run-reserved",
    }, {
      sendToChannel: vi.fn().mockResolvedValue(true),
      announceToParent,
      sendGovernedAnnouncement,
      deadLetterQueue,
    });
    await Promise.resolve();
    expect(announceToParent).not.toHaveBeenCalled();

    finishReservation(ok({ created: true }));
    await delivery;

    expect(announceToParent).toHaveBeenCalledOnce();
    expect(sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(deadLetterQueue.resolveDecision).toHaveBeenCalledWith(
      `${callerSessionKey}::run-reserved`,
      "receipt_committed",
    );
  });

  it("suppresses direct parent execution when a durable decision already exists", async () => {
    const deadLetterQueue = makeDecisionDeadLetterQueue();
    deadLetterQueue.reserveDecision.mockResolvedValue(ok({ created: false }));
    const announceToParent = vi.fn();
    const sendGovernedAnnouncement = vi.fn();

    await deliverAnnouncement({
      announcementText: "[System Message]\nResult: complete",
      announceChannelType: "telegram",
      announceChannelId: "chat-1",
      callerAgentId: "agent-main",
      callerSessionKey: formatSessionKey({
        tenantId: "default", agentId: "agent-main", userId: "user_a", channelId: "chat-1",
      }),
      callerConversation: makeCallerConversation(),
      destinationEndpoint: makeCallerEndpoint(),
      runId: "run-restarted",
    }, {
      sendToChannel: vi.fn().mockResolvedValue(true),
      announceToParent,
      sendGovernedAnnouncement,
      deadLetterQueue,
    });

    expect(announceToParent).not.toHaveBeenCalled();
    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(deadLetterQueue.resolveDecision).not.toHaveBeenCalled();
  });

  it("a direct-channel success marks the shared dedup so a later failure notification is suppressed", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const { createDeliveryDedup } = await import("./announce-key.js");
    const deliveryDedup = createDeliveryDedup();

    const announceSend = vi.fn().mockResolvedValue(true);
    const failureSend = vi.fn().mockResolvedValue(true);

    // SUCCESS via deliverAnnouncement's DIRECT branch (no batcher, no announceToParent).
    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "discord",
        announceChannelId: "chan-1",
        announceThreadId: "topic-42",
        callerAgentId: "agent-main",
        callerSessionKey: "default:u1:c1",
        runId: "r1",
      },
      { sendToChannel: announceSend, deliveryDedup },
    );
    expect(announceSend).toHaveBeenCalledOnce();
    // The shared dedup now carries the key even though no batcher was wired.
    expect(deliveryDedup.has("default:u1:c1::r1")).toBe(true);

    // A sweep-driven FAILURE notification for the SAME run must dedup against
    // the shared set and NOT send a second user-facing message.
    await deliverFailureNotification(
      {
        channelType: "discord",
        channelId: "chan-1",
        task: "t",
        runtimeMs: 100,
        runId: "r1",
        callerSessionKey: "default:u1:c1",
      },
      { sendToChannel: failureSend, deliveryDedup },
    );
    expect(failureSend).not.toHaveBeenCalled();
  });

  it("a parent-injection success marks the shared dedup (announceToParent branch) without a batcher", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const { createDeliveryDedup } = await import("./announce-key.js");
    const deliveryDedup = createDeliveryDedup();

    const announceToParent = vi.fn().mockResolvedValue(undefined);
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const callerSessionKey = formatSessionKey({
      tenantId: "default", agentId: "agent-main", userId: "u2", channelId: "c2",
    });

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "telegram",
        announceChannelId: "chat-1",
        announceThreadId: "topic-42",
        callerAgentId: "agent-main",
        callerSessionKey,
        callerConversation: makeCallerConversation(),
        runId: "r2",
      },
      { sendToChannel, announceToParent, deliveryDedup },
    );

    // Parent injection succeeded → the key is marked on the shared dedup.
    expect(announceToParent).toHaveBeenCalledWith(
      "agent-main",
      expect.any(Object),
      makeCallerConversation(),
      expect.any(String),
      "telegram",
      "chat-1",
      { threadId: "topic-42" },
    );
    expect(deliveryDedup.has(`${callerSessionKey}::r2`)).toBe(true);
  });

  it("routes a parent rewrite through the governed final send before marking delivery", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const { createDeliveryDedup } = await import("./announce-key.js");
    const deliveryDedup = createDeliveryDedup();
    const deadLetterQueue = makeDecisionDeadLetterQueue();
    const callerSessionKey = formatSessionKey({
      tenantId: "default", agentId: "agent-main", userId: "user_a", channelId: "chat_a",
    });
    const sendGovernedAnnouncement = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        delivered: true,
        identity: { agentId: "agent-main", rootRunId: "root-1", stepIndex: 4 },
      },
    });

    await deliverAnnouncement({
      announcementText: "[System Message]\nResult: raw",
      announceChannelType: "telegram",
      announceChannelId: "chat-1",
      callerAgentId: "agent-main",
      callerSessionKey,
      callerConversation: makeCallerConversation(),
      destinationEndpoint: makeCallerEndpoint(),
      runId: "run-rewrite",
    }, {
      announceToParent: vi.fn().mockResolvedValue("rewritten"),
      sendToChannel: vi.fn().mockResolvedValue(true),
      sendGovernedAnnouncement,
      deadLetterQueue,
      deliveryDedup,
    });

    expect(sendGovernedAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      text: "rewritten",
      runId: "run-rewrite",
    }));
    expect(deadLetterQueue.resolveDecision).toHaveBeenCalledWith(
      `${callerSessionKey}::run-rewrite`,
      "receipt_committed",
    );
    expect(deliveryDedup.has(`${callerSessionKey}::run-rewrite`)).toBe(true);
  });

  it("blocks a governed completion before any send when caller identity is absent", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const sendGovernedAnnouncement = vi.fn();
    const enqueue = vi.fn();

    await deliverAnnouncement({
      announcementText: "[System Message]\nResult: raw",
      announceChannelType: "telegram",
      announceChannelId: "chat-1",
      runId: "run-without-owner",
    }, {
      sendToChannel,
      sendGovernedAnnouncement,
      deadLetterQueue: {
        enqueue,
        drain: vi.fn().mockResolvedValue(undefined),
        size: vi.fn().mockReturnValue(0),
      },
    } as never);

    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("redacts a failed parent-execution message without starting a fallback send", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const announceToParent = vi.fn().mockRejectedValue(
      new Error("Authorization: Bearer PRIVATE_PARENT_ANNOUNCE_SENTINEL"),
    );
    const sendToChannel = vi.fn().mockResolvedValue(true);

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "telegram",
        announceChannelId: "chat-1",
        callerAgentId: "agent-main",
        callerSessionKey: formatSessionKey({
          tenantId: "default", agentId: "agent-main", userId: "u2", channelId: "c2",
        }),
        callerConversation: makeCallerConversation(),
        runId: "r-parent-failure",
      },
      { sendToChannel, announceToParent, logger },
    );

    const warning = logger.warn.mock.calls.find(
      (call) => call[1] === "Sub-agent parent announcement ended without a safe delivery decision",
    );
    expect(typeof warning?.[0].err).toBe("string");
    expect(JSON.stringify(warning)).not.toContain("PRIVATE_PARENT_ANNOUNCE_SENTINEL");
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("the failure path dedups against the shared dedup even when no batcher is present", async () => {
    const { createDeliveryDedup } = await import("./announce-key.js");
    const deliveryDedup = createDeliveryDedup();
    const sendToChannel = vi.fn().mockResolvedValue(true);

    const params = {
      channelType: "discord",
      channelId: "chan-1",
      task: "t",
      runtimeMs: 100,
      runId: "r3",
      callerSessionKey: "default:u3:c3",
    };

    // First failure notification sends + marks the shared dedup; the second is a no-op.
    await deliverFailureNotification(params, { sendToChannel, deliveryDedup });
    await deliverFailureNotification(params, { sendToChannel, deliveryDedup });

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(deliveryDedup.has("default:u3:c3::r3")).toBe(true);
  });

  it("does NOT mark the shared dedup when the direct send fails (key stays open)", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const { createDeliveryDedup } = await import("./announce-key.js");
    const deliveryDedup = createDeliveryDedup();
    const sendToChannel = vi.fn().mockRejectedValue(new Error("network down"));

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "discord",
        announceChannelId: "chan-1",
        callerAgentId: "agent-main",
        callerSessionKey: "default:u4:c4",
        runId: "r4",
      },
      { sendToChannel, deliveryDedup },
    );

    // Failed delivery must NOT mark — a later retry / failure notification must still fire.
    expect(deliveryDedup.has("default:u4:c4::r4")).toBe(false);
  });

  it("treats a resolved false direct send as failure and persists it", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const { createDeliveryDedup } = await import("./announce-key.js");
    const deliveryDedup = createDeliveryDedup();
    const enqueue = vi.fn();

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: not delivered",
        announceChannelType: "telegram",
        announceChannelId: "chat-false",
        callerAgentId: "agent-main",
        callerSessionKey: "default:u5:c5",
        runId: "r-false",
      },
      {
        sendToChannel: vi.fn().mockResolvedValue(false),
        deliveryDedup,
        deadLetterQueue: {
          enqueue,
          drain: vi.fn().mockResolvedValue(undefined),
          size: vi.fn().mockReturnValue(0),
        },
      },
    );

    expect(enqueue).toHaveBeenCalledOnce();
    expect(deliveryDedup.has("default:u5:c5::r-false")).toBe(false);
  });

  it("threads the governed identity into a direct-send dead letter", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const enqueue = vi.fn();
    const sendGovernedAnnouncement = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        delivered: false,
        identity: {
          agentId: "agent-main",
          rootRunId: "root-r-governed",
          stepIndex: 11,
        },
        failure: "operation_retained",
      },
    });

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: governed",
        announceChannelType: "telegram",
        announceChannelId: "chat-governed",
        callerAgentId: "agent-main",
        callerSessionKey: "default:u6:c6",
        callerConversation: makeCallerConversation(),
        destinationEndpoint: makeCallerEndpoint("telegram", "chat-governed"),
        runId: "r-governed",
      },
      {
        sendToChannel: vi.fn().mockResolvedValue(true),
        sendGovernedAnnouncement,
        deadLetterQueue: {
          enqueue,
          drain: vi.fn().mockResolvedValue(undefined),
          size: vi.fn().mockReturnValue(0),
        },
      } as never,
    );

    expect(sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-main",
      rootRunId: "root-r-governed",
      stepIndex: 11,
    }));
  });
});

// ---------------------------------------------------------------------------
// classifyErrorContext - HTTP 5xx detection (word-boundary guard).
// A naive expression like
// `lowerMsg.includes("provider") || lowerMsg.includes("5") && lowerMsg.includes("00")`
// falsely classifies any message containing both "5" and "00" substrings as a
// retryable ProviderError. The word-bounded regex /\b5\d{2}\b/ matches
// only HTTP status codes 500-599.
// ---------------------------------------------------------------------------

describe("classifyErrorContext HTTP-5xx detection", () => {
  it("classifies a true HTTP 503 message as ProviderError (retryable)", () => {
    const result = classifyErrorContext("HTTP 503 from provider gateway", "failed");
    expect(result.errorType).toBe("ProviderError");
    expect(result.retryable).toBe(true);
  });

  it("classifies HTTP 500/502/504 messages as ProviderError (retryable)", () => {
    for (const code of [500, 502, 504, 599]) {
      const result = classifyErrorContext(`upstream returned ${code}`, "failed");
      expect(result.errorType).toBe("ProviderError");
      expect(result.retryable).toBe(true);
    }
  });

  it("does NOT misclassify benign messages containing '5' and '00' substrings", () => {
    // Benign messages containing both "5" and "00" substrings but no HTTP 5xx code.
    const falsePositiveCandidates = [
      "Step 5 failed at 12:00:00",
      "Took 5 attempts, total 0.0001 cost",
      "Failed at index 5 with size 100",
      "50000 tokens consumed",
    ];
    for (const msg of falsePositiveCandidates) {
      const result = classifyErrorContext(msg, "failed");
      expect(result.errorType, `msg: ${msg}`).not.toBe("ProviderError");
    }
  });

  it("still classifies explicit 'provider' messages as ProviderError", () => {
    const result = classifyErrorContext("provider authentication failure", "failed");
    expect(result.errorType).toBe("ProviderError");
    expect(result.retryable).toBe(true);
  });

  it("does NOT match 4-digit numbers containing '5xx' (e.g., 1500, 5000)", () => {
    // \b5\d{2}\b requires word boundaries — 5000 has 4 digits, not bounded.
    const result = classifyErrorContext("processed 5000 messages", "failed");
    expect(result.errorType).not.toBe("ProviderError");
  });
});

// ---------------------------------------------------------------------------
// classifyErrorContext - transport-errno widening.
// The bare Node errno spellings do NOT contain "timeout"/"timed out"
// (e.g. "ETIMEDOUT".toLowerCase() === "etimedout"), and ECONNRESET /
// ECONNREFUSED / "socket hang up" / "fetch failed" / "network request failed"
// match NONE of the other transient tokens — without an explicit branch they
// would fall through to Unknown → retryable:false → immediate dead-letter,
// defeating the most common transient delivery failure. The explicit
// transport-errno branch makes these self-heal (retry-with-backoff in the batcher).
// ---------------------------------------------------------------------------

describe("classifyErrorContext transport-errno widening", () => {
  it("classifies bare transport errno spellings as retryable (transient delivery blips)", () => {
    // Case-insensitive on the raw message.
    const transientTransport = [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "socket hang up",
      "fetch failed",
      "Network request failed", // mixed case proves case-insensitivity
    ];
    for (const msg of transientTransport) {
      const result = classifyErrorContext(msg, "failed");
      expect(result.retryable, `msg: ${msg}`).toBe(true);
    }
  });

  it("classifies errno tokens embedded in a longer message as retryable", () => {
    // Real delivery errors wrap the errno in surrounding text.
    const result = classifyErrorContext("send failed: connect ECONNREFUSED 127.0.0.1:443", "failed");
    expect(result.retryable).toBe(true);
  });

  // REGRESSION-GUARD: the widening must NOT make genuinely permanent failures
  // retryable, and must NOT collide with the existing numeric false-positive
  // pins. These must stay retryable:false / NOT ProviderError.
  it("keeps genuinely permanent failures non-retryable after the widening", () => {
    expect(classifyErrorContext("token budget exceeded", "failed").retryable).toBe(false);
    expect(classifyErrorContext("max steps reached", "failed").retryable).toBe(false);
    expect(classifyErrorContext("context window exhausted", "failed").retryable).toBe(false);
    // killed endReason is permanent regardless of message.
    expect(classifyErrorContext("ECONNRESET", "killed").retryable).toBe(false);
  });

  it("does NOT let transport tokens collide with the numeric 5xx false-positive guards", () => {
    // These must still NOT be ProviderError AND must stay retryable:false — the
    // new transport tokens share no substring with them.
    const stillPermanent = [
      "50000 tokens consumed",
      "processed 5000 messages",
      "Step 5 failed at 12:00:00",
    ];
    for (const msg of stillPermanent) {
      const result = classifyErrorContext(msg, "failed");
      expect(result.errorType, `msg: ${msg}`).not.toBe("ProviderError");
      expect(result.retryable, `msg: ${msg}`).toBe(false);
    }
  });

  // The two natural-language phrases "connection reset" /
  // "connection refused" are pure exposure — their errno twins (ECONNRESET /
  // ECONNREFUSED) already match every genuine Node transport error (which always
  // carries the errno spelling), so the phrases are redundant for real failures
  // but could over-match a PERMANENT error that quotes them as content. The
  // classifier omits the redundant phrases (errno-style only) while keeping the
  // errno-less real phrasings (fetch failed / socket hang up). Mirrors the
  // existing 5xx false-positive guard the file already carries.
  it("does NOT classify a permanent error that merely quotes 'connection refused' as retryable", () => {
    // A tool/model error that embeds the phrase as quoted content is NOT a
    // transport blip — it must stay non-retryable (no errno present).
    const result = classifyErrorContext('Tool reported: "connection refused by policy"', "failed");
    expect(result.errorType).not.toBe("TransportError");
    expect(result.retryable).toBe(false);
  });

  it("does NOT classify a permanent error that merely quotes 'connection reset' as retryable", () => {
    const result = classifyErrorContext('validation failed: expected "connection reset" flag', "failed");
    expect(result.errorType).not.toBe("TransportError");
    expect(result.retryable).toBe(false);
  });

  it("classifies errno-bearing connection failures as retryable", () => {
    // The errno-bearing forms — the real Node transport failures — keep self-healing.
    expect(classifyErrorContext("connect ECONNREFUSED 127.0.0.1:443", "failed").retryable).toBe(true);
    expect(classifyErrorContext("read ECONNRESET", "failed").retryable).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// announcement scrub
// ---------------------------------------------------------------------------

describe("announcement scrub", () => {
  it("scrubs token from announcement text before deliverAnnouncement passes it to sendToChannel", async () => {
    const rawToken = "hf_" + "c".repeat(44);
    const sendToChannel = vi.fn().mockResolvedValue(true);

    // Build the announcement with a raw token in the result text
    const { buildAnnouncementMessage, deliverAnnouncement } = await import("./sub-agent-result-processor.js");

    const announcement = buildAnnouncementMessage({
      task: "test task with token",
      status: "completed",
      response: `Task done. Access token: Bearer ${rawToken}`,
      runtimeMs: 1234,
      stepsExecuted: 5,
      tokensUsed: 100,
      cost: 0.001,
      sessionKey: "default:test:test",
    });

    // Verify the raw token is in the built announcement (pre-scrub)
    expect(announcement).toContain(rawToken);

    await deliverAnnouncement(
      {
        announcementText: announcement,
        announceChannelType: "telegram",
        announceChannelId: "chat-123",
        runId: "run-scrub-test",
      },
      { sendToChannel },
    );

    // The text delivered to the channel must NOT contain the raw token
    expect(sendToChannel).toHaveBeenCalled();
    const deliveredText = sendToChannel.mock.calls[0]![2] as string;
    expect(deliveredText).not.toContain(rawToken);
  });
});

// ---------------------------------------------------------------------------
// deliverAnnouncement idempotency-key threading.
// The key `${callerSessionKey}::${runId}` is built ONCE at the entry and
// threaded as data through the batcher enqueue and the fallback DLQ entry —
// never reconstructed downstream. `::` delimits the session key's own colons.
// ---------------------------------------------------------------------------

describe("deliverAnnouncement idempotency-key threading", () => {
  it("threads generated output references onto the durable batcher entry", async () => {
    const enqueue = vi.fn().mockResolvedValue(ok("admitted"));
    const batcher = {
      enqueue,
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      get pending() { return 0; },
    };
    const attachments = [{
      sourceAgentId: "report-agent",
      path: "/srv/comis/workspace/reports/monthly.csv",
    }];

    await deliverAnnouncement({
      announcementText: "Report ready",
      announceChannelType: "telegram",
      announceChannelId: "chat-1",
      callerAgentId: "agent-main",
      callerSessionKey: "default:agent:agent-main:user1:telegram:peer:user1",
      callerConversation: makeCallerConversation(),
      destinationEndpoint: makeCallerEndpoint(),
      runId: "run-report",
      attachments,
    }, {
      sendToChannel: vi.fn().mockResolvedValue(true),
      batcher,
    });

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
  });

  it("sets idempotencyKey = `${callerSessionKey}::${runId}` on the batcher enqueue", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const enqueue = vi.fn();
    const batcher = {
      enqueue,
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      get pending() { return 0; },
    };

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "discord",
        announceChannelId: "chan-1",
        announceThreadId: "topic-42",
        callerAgentId: "agent-main",
        callerSessionKey: formatSessionKey({
          tenantId: "default", agentId: "agent-main", userId: "user1", channelId: "chan1",
        }),
        callerConversation: makeCallerConversation(),
        destinationEndpoint: makeCallerEndpoint("discord", "chan-1", "topic-42"),
        runId: "run-xyz",
      },
      { sendToChannel: vi.fn().mockResolvedValue(true), batcher },
    );

    expect(enqueue).toHaveBeenCalledOnce();
    const arg = enqueue.mock.calls[0]![0] as {
      idempotencyKey?: string;
      announceThreadId?: string;
    };
    expect(arg.idempotencyKey).toBe("default:agent:agent-main:user1:chan1::run-xyz");
    expect(arg.announceThreadId).toBe("topic-42");
  });

  it("does NOT fabricate a key and does NOT enqueue when callerSessionKey is absent (top-level spawn)", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const enqueue = vi.fn();
    const sendToChannel = vi.fn().mockResolvedValue(true);
    const batcher = {
      enqueue,
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      get pending() { return 0; },
    };

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "discord",
        announceChannelId: "chan-1",
        // no callerAgentId / callerSessionKey → top-level spawn
        runId: "run-top",
      },
      { sendToChannel, batcher },
    );

    // The batcher enqueue path requires callerAgentId + callerSessionKey;
    // without them, delivery goes direct (no fabricated key).
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendToChannel).toHaveBeenCalledOnce();
  });

  it("threads the same idempotencyKey onto the fallback DLQ entry when the direct send fails", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const dlqEnqueue = vi.fn();
    const deadLetterQueue = {
      enqueue: dlqEnqueue,
      drain: vi.fn().mockResolvedValue(undefined),
      size: vi.fn().mockReturnValue(0),
    };

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "telegram",
        announceChannelId: "chat-1",
        callerAgentId: "agent-main",
        callerSessionKey: "default:user2:chan2",
        runId: "run-dlq",
      },
      {
        // No batcher, no announceToParent → goes straight to the direct send,
        // which rejects → fallback DLQ enqueue.
        sendToChannel: vi.fn().mockRejectedValue(
          new Error(`send failed https://private.example ${`xoxb-${"s".repeat(32)}`}`),
        ),
        deadLetterQueue,
      },
    );

    expect(dlqEnqueue).toHaveBeenCalledOnce();
    const entry = dlqEnqueue.mock.calls[0]![0] as {
      idempotencyKey?: string;
      lastError: string;
    };
    expect(entry.idempotencyKey).toBe("default:user2:chan2::run-dlq");
    expect(entry.lastError).not.toContain("xoxb-");
    expect(entry.lastError).not.toContain("private.example");
  });

  it("does not enqueue an ownerless failure into the completion dead-letter queue", async () => {
    const { deliverAnnouncement } = await import("./sub-agent-result-processor.js");
    const dlqEnqueue = vi.fn();
    const deadLetterQueue = {
      enqueue: dlqEnqueue,
      drain: vi.fn().mockResolvedValue(undefined),
      size: vi.fn().mockReturnValue(0),
    };

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "telegram",
        announceChannelId: "chat-1",
        runId: "run-nokey",
      },
      {
        sendToChannel: vi.fn().mockRejectedValue(new Error("send failed")),
        deadLetterQueue,
      },
    );

    expect(dlqEnqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// classifyErrorContext kill attribution — the errorType must track killedBy.
// A health-monitor stuck-kill's failure record read "KilledByParent" in a live
// incident replay; the structured errorType is the machine-readable twin of
// the attributed error string and must never contradict it.
// ---------------------------------------------------------------------------

describe("classifyErrorContext — killedBy attribution", () => {
  it("maps a health-monitor kill to StuckKilledByHealthMonitor", () => {
    const ctx = classifyErrorContext("Stuck sub-agent: no observed progress for 17313ms", "killed", "health_monitor");
    expect(ctx.errorType).toBe("StuckKilledByHealthMonitor");
    expect(ctx.retryable).toBe(false);
  });

  it("keeps KilledByParent for parent (and default) kills", () => {
    expect(classifyErrorContext("Killed by parent agent", "killed", "parent").errorType).toBe("KilledByParent");
    expect(classifyErrorContext("Killed by parent agent", "killed").errorType).toBe("KilledByParent");
  });

  it("maps operator/system kills to their own attribution", () => {
    expect(classifyErrorContext("stop", "killed", "operator").errorType).toBe("KilledByOperator");
    expect(classifyErrorContext("stop", "killed", "system").errorType).toBe("KilledBySystem");
  });
});

describe("persistFailureRecord — killedBy rides the structured errorContext", () => {
  it("writes StuckKilledByHealthMonitor for a health-monitor kill record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kill-attrib-record-"));
    await persistFailureRecord({
      dataDir: dir,
      sessionKey: "default:sub-agent-x:sub-agent:x",
      runId: "run-x",
      task: "t",
      error: "Stuck sub-agent: no observed progress for 20000ms",
      endReason: "killed",
      runtimeMs: 20_000,
      killedBy: "health_monitor",
    });
    const sessionDirs = await readdir(join(dir, "subagent-results"));
    const files = await readdir(join(dir, "subagent-results", sessionDirs[0]!));
    const content = JSON.parse(await readFile(join(dir, "subagent-results", sessionDirs[0]!, files[0]!), "utf-8"));
    expect(content.killedBy).toBe("health_monitor");
    expect(content.errorContext.errorType).toBe("StuckKilledByHealthMonitor");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
