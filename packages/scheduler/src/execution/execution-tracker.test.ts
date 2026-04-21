// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ExecutionLogEntry } from "./execution-tracker.js";
import { createExecutionTracker, computeMedian } from "./execution-tracker.js";

describe("execution-tracker", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-tracker-test-"));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function makeEntry(overrides: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry {
    return {
      ts: Date.now(),
      jobId: "test-job",
      status: "ok",
      durationMs: 1000,
      ...overrides,
    };
  }

  describe("record", () => {
    it("appends entry to JSONL file", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      const entry = makeEntry();
      await tracker.record(entry);

      const content = fs.readFileSync(path.join(testDir, "execution.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(entry);
    });

    it("creates log directory if not exists", async () => {
      const nestedDir = path.join(testDir, "deep", "nested");
      const tracker = createExecutionTracker({ logDir: nestedDir });

      expect(fs.existsSync(nestedDir)).toBe(false);
      await tracker.record(makeEntry());
      expect(fs.existsSync(nestedDir)).toBe(true);
    });

    it("writes log file with mode 0o600", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      await tracker.record(makeEntry());

      const logPath = path.join(testDir, "execution.jsonl");
      const fileStat = fs.statSync(logPath);
      const mode = fileStat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("getHistory", () => {
    it("returns entries filtered by jobId", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      await tracker.record(makeEntry({ jobId: "job-a", ts: 1 }));
      await tracker.record(makeEntry({ jobId: "job-b", ts: 2 }));
      await tracker.record(makeEntry({ jobId: "job-a", ts: 3 }));

      const history = await tracker.getHistory("job-a");
      expect(history).toHaveLength(2);
      expect(history.every((e) => e.jobId === "job-a")).toBe(true);
    });

    it("returns entries sorted by timestamp descending", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      await tracker.record(makeEntry({ ts: 100 }));
      await tracker.record(makeEntry({ ts: 300 }));
      await tracker.record(makeEntry({ ts: 200 }));

      const history = await tracker.getHistory("test-job");
      expect(history[0].ts).toBe(300);
      expect(history[1].ts).toBe(200);
      expect(history[2].ts).toBe(100);
    });

    it("respects limit parameter", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      for (let i = 0; i < 10; i++) {
        await tracker.record(makeEntry({ ts: i }));
      }

      const history = await tracker.getHistory("test-job", 3);
      expect(history).toHaveLength(3);
    });

    it("returns empty array for unknown jobId", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      await tracker.record(makeEntry({ jobId: "known" }));

      const history = await tracker.getHistory("unknown");
      expect(history).toEqual([]);
    });
  });

  describe("auto-prune", () => {
    it("triggers when file exceeds maxLogBytes", async () => {
      // Use a tiny maxLogBytes to trigger pruning easily
      const tracker = createExecutionTracker({
        logDir: testDir,
        maxLogBytes: 200,
        keepLines: 2,
      });

      // Write enough entries to exceed 200 bytes
      for (let i = 0; i < 10; i++) {
        await tracker.record(makeEntry({ ts: i, jobId: `job-${i}` }));
      }

      const content = fs.readFileSync(path.join(testDir, "execution.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBeLessThanOrEqual(2);
    });

    it("keeps only keepLines most recent entries", async () => {
      const tracker = createExecutionTracker({
        logDir: testDir,
        maxLogBytes: 100,
        keepLines: 3,
      });

      for (let i = 0; i < 10; i++) {
        await tracker.record(makeEntry({ ts: i, jobId: `job-${i}` }));
      }

      const content = fs.readFileSync(path.join(testDir, "execution.jsonl"), "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines.length).toBeLessThanOrEqual(3);
    });
  });

  describe("checkAnomaly", () => {
    it("returns isAnomaly=false with fewer than 5 history entries", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      // Only 3 entries
      for (let i = 0; i < 3; i++) {
        await tracker.record(makeEntry({ durationMs: 100, ts: i }));
      }

      const result = await tracker.checkAnomaly("test-job", 10000);
      expect(result.isAnomaly).toBe(false);
    });

    it("returns isAnomaly=true when durationMs > median * multiplier", async () => {
      const tracker = createExecutionTracker({
        logDir: testDir,
        anomalyMultiplier: 3,
      });

      // 10 entries with duration ~100ms
      for (let i = 0; i < 10; i++) {
        await tracker.record(makeEntry({ durationMs: 100, ts: i }));
      }

      // 400ms is > 100 * 3 = 300ms threshold
      const result = await tracker.checkAnomaly("test-job", 400);
      expect(result.isAnomaly).toBe(true);
      expect(result.medianMs).toBe(100);
      expect(result.thresholdMs).toBe(300);
    });

    it("returns isAnomaly=false for normal duration", async () => {
      const tracker = createExecutionTracker({
        logDir: testDir,
        anomalyMultiplier: 3,
      });

      for (let i = 0; i < 10; i++) {
        await tracker.record(makeEntry({ durationMs: 100, ts: i }));
      }

      // 200ms is < 100 * 3 = 300ms threshold
      const result = await tracker.checkAnomaly("test-job", 200);
      expect(result.isAnomaly).toBe(false);
      expect(result.medianMs).toBe(100);
      expect(result.thresholdMs).toBe(300);
    });
  });

  describe("token/cost fields", () => {
    it("records and retrieves entries with token/cost fields", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      const entry = makeEntry({
        totalTokens: 1500,
        costUsd: 0.0045,
        toolCalls: 3,
        llmCalls: 2,
        failedTools: ["bash"],
      });
      await tracker.record(entry);

      const history = await tracker.getHistory("test-job");
      expect(history).toHaveLength(1);
      expect(history[0].totalTokens).toBe(1500);
      expect(history[0].costUsd).toBe(0.0045);
      expect(history[0].toolCalls).toBe(3);
      expect(history[0].llmCalls).toBe(2);
      expect(history[0].failedTools).toEqual(["bash"]);
    });

    it("handles entries without token/cost fields (backward compat)", async () => {
      const tracker = createExecutionTracker({ logDir: testDir });
      await tracker.record(makeEntry());

      const history = await tracker.getHistory("test-job");
      expect(history).toHaveLength(1);
      expect(history[0].totalTokens).toBeUndefined();
      expect(history[0].costUsd).toBeUndefined();
    });
  });

  describe("computeMedian", () => {
    it("returns correct median for odd-length array", () => {
      expect(computeMedian([1, 3, 5])).toBe(3);
      expect(computeMedian([10, 20, 30, 40, 50])).toBe(30);
    });

    it("returns correct median for even-length array", () => {
      expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
      expect(computeMedian([10, 20])).toBe(15);
    });

    it("returns the value for single-element array", () => {
      expect(computeMedian([42])).toBe(42);
    });

    it("sorts unsorted input correctly", () => {
      expect(computeMedian([5, 1, 3])).toBe(3);
      expect(computeMedian([100, 1, 50, 25])).toBe(37.5);
    });
  });
});
