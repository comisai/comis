// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtemp, writeFile, mkdir, readdir, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sweepResultFiles,
  persistFailureRecord,
  deliverFailureNotification,
  classifyErrorContext,
} from "./sub-agent-result-processor.js";

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

  it("backward compat: old usage without cache fields parses without error", async () => {
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

  it("logs WARN when sendToChannel throws (does not propagate)", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("network down"));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    // Must not throw
    await deliverFailureNotification(
      {
        channelType: "discord",
        channelId: "chan-fail",
        task: "some task",
        runtimeMs: 2000,
        runId: "run-warn",
      },
      { sendToChannel, logger },
    );

    expect(logger.warn).toHaveBeenCalledOnce();
    const warnObj = logger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(warnObj.runId).toBe("run-warn");
    expect(warnObj.hint).toContain("user will not be notified");
    expect(warnObj.errorKind).toBe("network");
  });
});

// ---------------------------------------------------------------------------
// deliverFailureNotification idempotency (DELIVERY-03)
//
// The failure path must dedup on the SAME announceKey = `${callerSessionKey}::${runId}`
// that the success path (deliverAnnouncement) builds, sharing the batcher's
// deliveredKeys via hasDelivered/markDelivered (D-SHAREDDEDUP from Plan 01).
// A Phase-170 budget-failed node delivered twice must notify ONCE.
//
// NOTE: these tests pass `callerSessionKey` + a `batcher` with hasDelivered/
// markDelivered into deliverFailureNotification — neither exists on the
// pre-patch signature, so the suite fails to compile against pre-patch code.
// That compile-failure IS the RED for the signature change (§2.10).
// ---------------------------------------------------------------------------

/** A stub batcher whose delivered-key set is a real shared Set (mirrors the orchestrator batcher). */
function makeStubBatcher() {
  const deliveredKeys = new Set<string>();
  const markDelivered = vi.fn((key: string) => { deliveredKeys.add(key); });
  const hasDelivered = vi.fn((key: string) => deliveredKeys.has(key));
  return {
    enqueue: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    get pending() { return 0; },
    hasDelivered,
    markDelivered,
  };
}

describe("deliverFailureNotification idempotency (DELIVERY-03)", () => {
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

  it("does NOT mark delivered when sendToChannel rejects (key stays retry-eligible, Pitfall 3)", async () => {
    const sendToChannel = vi.fn().mockRejectedValue(new Error("network down"));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const batcher = makeStubBatcher();

    await deliverFailureNotification(
      {
        channelType: "discord",
        channelId: "chan-fail",
        task: "t",
        runtimeMs: 2000,
        runId: "r1",
        callerSessionKey: "default:u1:c1",
      },
      { sendToChannel, logger, batcher },
    );

    expect(sendToChannel).toHaveBeenCalledOnce();
    expect(batcher.markDelivered).not.toHaveBeenCalled();
    expect(batcher.hasDelivered("default:u1:c1::r1")).toBe(false);
    // Still never throws.
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

  it("behaves as today when deps.batcher is absent (no dedup, always sends, never throws)", async () => {
    const sendToChannel = vi.fn().mockResolvedValue(true);

    const params = {
      channelType: "discord",
      channelId: "chan-1",
      task: "t",
      runtimeMs: 100,
      runId: "r1",
      callerSessionKey: "default:u1:c1",
    };

    // No batcher in deps → behaves exactly as the pre-patch path.
    await deliverFailureNotification(params, { sendToChannel });
    await deliverFailureNotification(params, { sendToChannel });

    expect(sendToChannel).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// WR-02: in a NO-BATCHER construction the success path must still mark delivered
// so the failure path dedups. Pre-fix, deliverAnnouncement only marked a key
// indirectly THROUGH the batcher; its non-batcher success branches (direct
// announceToParent / direct sendToChannel) delivered to the user but never
// marked, so deliverFailureNotification's dedup was silently inert whenever the
// runner was constructed without a batcher. A shared DeliveryDedup injected into
// BOTH closes the hole: a success then a sweep-driven failure on the same key
// must NOT double-deliver, with or without a batcher.
// ---------------------------------------------------------------------------

describe("deliverAnnouncement / deliverFailureNotification shared dedup without a batcher (WR-02)", () => {
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

    await deliverAnnouncement(
      {
        announcementText: "[System Message]\nResult: ok",
        announceChannelType: "telegram",
        announceChannelId: "chat-1",
        callerAgentId: "agent-main",
        callerSessionKey: "default:u2:c2",
        runId: "r2",
      },
      { sendToChannel, announceToParent, deliveryDedup },
    );

    // Parent injection succeeded → the key is marked on the shared dedup.
    expect(announceToParent).toHaveBeenCalledOnce();
    expect(deliveryDedup.has("default:u2:c2::r2")).toBe(true);
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

  it("does NOT mark the shared dedup when the direct send fails (key stays open, Pitfall 3)", async () => {
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
});

// ---------------------------------------------------------------------------
// classifyErrorContext - HTTP 5xx detection (operator-precedence regression).
// The old expression
// `lowerMsg.includes("provider") || lowerMsg.includes("5") && lowerMsg.includes("00")`
// falsely classified any message containing both "5" and "00" substrings as a
// retryable ProviderError. The fix uses a word-bounded regex /\b5\d{2}\b/ to
// match only HTTP status codes 500-599.
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
    // These were false-positives under the prior operator-precedence bug.
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
// classifyErrorContext - transport-errno widening (DELIVERY-02).
// The bare Node errno spellings do NOT contain "timeout"/"timed out"
// (e.g. "ETIMEDOUT".toLowerCase() === "etimedout"), and ECONNRESET /
// ECONNREFUSED / "socket hang up" / "fetch failed" / "network request failed"
// match NONE of the existing transient tokens — so on pre-patch code they fall
// through to Unknown → retryable:false → immediate dead-letter, defeating the
// most common transient delivery failure. The widening adds an explicit
// transport-errno branch so these self-heal (retry-with-backoff in the batcher).
// ---------------------------------------------------------------------------

describe("classifyErrorContext transport-errno widening (DELIVERY-02)", () => {
  it("classifies bare transport errno spellings as retryable (transient delivery blips)", () => {
    // All FAIL on pre-patch code (Unknown / retryable:false); the widening flips
    // each to retryable:true. Case-insensitive on the raw message.
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
  // pins. These stay exactly as pre-patch (retryable:false / NOT ProviderError).
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

  it("is re-exported from the spawn barrel so the daemon wiring can inject it (DELIVERY-02)", async () => {
    // Characterization pin (Task 2): classifyErrorContext must reach the
    // @comis/agent public surface via the spawn/index.js barrel — the path
    // packages/agent/src/index.ts re-exports from — so setup-cross-session
    // can inject it into the orchestrator batcher (it cannot import the agent
    // internal directly). The dist-import smoke check covers the full barrel.
    const spawnBarrel = await import("./index.js");
    expect(typeof spawnBarrel.classifyErrorContext).toBe("function");
    // The barrel symbol is the same function as the module export.
    expect(spawnBarrel.classifyErrorContext("ECONNRESET", "failed").retryable).toBe(true);
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
// deliverAnnouncement idempotency-key threading (DELIVERY-01).
// The key `${callerSessionKey}::${runId}` is built ONCE at the entry and
// threaded as data through the batcher enqueue and the fallback DLQ entry —
// never reconstructed downstream. `::` delimits the session key's own colons.
// ---------------------------------------------------------------------------

describe("deliverAnnouncement idempotency key (DELIVERY-01)", () => {
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
        callerAgentId: "agent-main",
        callerSessionKey: "default:user1:chan1",
        runId: "run-xyz",
      },
      { sendToChannel: vi.fn().mockResolvedValue(true), batcher },
    );

    expect(enqueue).toHaveBeenCalledOnce();
    const arg = enqueue.mock.calls[0]![0] as { idempotencyKey?: string };
    expect(arg.idempotencyKey).toBe("default:user1:chan1::run-xyz");
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
        sendToChannel: vi.fn().mockRejectedValue(new Error("send failed")),
        deadLetterQueue,
      },
    );

    expect(dlqEnqueue).toHaveBeenCalledOnce();
    const entry = dlqEnqueue.mock.calls[0]![0] as { idempotencyKey?: string };
    expect(entry.idempotencyKey).toBe("default:user2:chan2::run-dlq");
  });

  it("leaves idempotencyKey undefined on the fallback DLQ entry when callerSessionKey is absent", async () => {
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

    expect(dlqEnqueue).toHaveBeenCalledOnce();
    const entry = dlqEnqueue.mock.calls[0]![0] as { idempotencyKey?: string };
    expect(entry.idempotencyKey).toBeUndefined();
  });
});
