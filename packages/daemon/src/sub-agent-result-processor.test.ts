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
