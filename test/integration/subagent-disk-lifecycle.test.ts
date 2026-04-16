/**
 * Integration tests for subagent disk offload write and sweep cleanup lifecycle.
 *
 * Exercises ResultCondenser disk persistence (COND-05) and sweepResultFiles
 * cleanup (DISK-02/DISK-03) with real filesystem operations in temp directories.
 * No daemon, no LLM, no network.
 *
 * Covers:
 * - TEST-08: Disk offload write (ResultCondenser persists full result JSON)
 * - TEST-08: Sweep removes expired files (utimesSync + sweepResultFiles)
 * - TEST-08: Sweep preserves fresh files
 * - TEST-08: Sweep cleans up empty session directories
 * - TEST-08: Sweep handles missing results directory gracefully
 * - TEST-08: End-to-end condenser write then sweep cleanup lifecycle
 *
 * @module
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sweepResultFiles } from "@comis/daemon";
import { createResultCondenser } from "@comis/agent";

// ---------------------------------------------------------------------------
// Shared temp directory for tests (a), (b)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subagent-disk-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock logger (pino-compatible)
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("subagent disk lifecycle integration", () => {

  // -------------------------------------------------------------------------
  // (a) ResultCondenser writes full result to disk (COND-05)
  // -------------------------------------------------------------------------

  it("ResultCondenser writes full result to disk (COND-05)", async () => {
    const mockLogger = createMockLogger();

    const condenser = createResultCondenser({
      maxResultTokens: 4000,
      condensationStrategy: "auto",
      dataDir: tmpDir,
      logger: mockLogger,
    });

    const condensedResult = await condenser.condense({
      fullResult:
        "The research task found 5 key results. Finding 1: AI safety requires interpretability. Finding 2: RLHF has limitations. Finding 3: Constitutional AI shows promise. Finding 4: Scalable oversight is critical. Finding 5: Adversarial testing improves robustness.",
      task: "Research AI safety",
      runId: "test-run-001",
      sessionKey: "test-integration:user1:ch1",
      agentId: "researcher",
    });

    // Level 1 passthrough (short result, no model/apiKey)
    expect(condensedResult.level).toBe(1);

    // diskPath is a non-empty string
    expect(condensedResult.diskPath).toBeDefined();
    expect(typeof condensedResult.diskPath).toBe("string");
    expect(condensedResult.diskPath.length).toBeGreaterThan(0);

    // File exists at the returned diskPath
    expect(existsSync(condensedResult.diskPath)).toBe(true);

    // File contents are valid JSON with expected fields
    const fileContents = readFileSync(condensedResult.diskPath, "utf-8");
    const parsed = JSON.parse(fileContents);
    expect(parsed.runId).toBe("test-run-001");
    expect(parsed.fullResult).toContain("The research task found 5 key results");

    // File is located under tmpDir/subagent-results/
    expect(condensedResult.diskPath.startsWith(join(tmpDir, "subagent-results"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (b) sweepResultFiles removes expired files
  // -------------------------------------------------------------------------

  it("sweepResultFiles removes expired files", async () => {
    // Create test directory structure
    const sessionDir = join(tmpDir, "subagent-results", "session_one");
    mkdirSync(sessionDir, { recursive: true });

    const expiredPath = join(sessionDir, "expired-run.json");
    const freshPath = join(sessionDir, "fresh-run.json");

    writeFileSync(
      expiredPath,
      JSON.stringify({ runId: "expired", fullResult: "old data" }),
    );
    writeFileSync(
      freshPath,
      JSON.stringify({ runId: "fresh", fullResult: "new data" }),
    );

    // Set expired file's mtime to 100 seconds ago
    const pastDate = new Date(Date.now() - 100_000);
    utimesSync(expiredPath, pastDate, pastDate);

    // Leave fresh file with current mtime

    // Sweep with 60s retention
    await sweepResultFiles(tmpDir, 60_000);

    // Expired file should be removed
    expect(existsSync(expiredPath)).toBe(false);

    // Fresh file should still exist with unchanged contents
    expect(existsSync(freshPath)).toBe(true);
    const freshContents = JSON.parse(readFileSync(freshPath, "utf-8"));
    expect(freshContents.runId).toBe("fresh");
    expect(freshContents.fullResult).toBe("new data");
  });

  // -------------------------------------------------------------------------
  // (c) sweepResultFiles cleans up empty session directories
  // -------------------------------------------------------------------------

  it("sweepResultFiles cleans up empty session directories", async () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), "subagent-disk-empty-"));
    try {
      const sessionDir = join(tmpDir2, "subagent-results", "empty_session");
      mkdirSync(sessionDir, { recursive: true });

      const filePath = join(sessionDir, "only-file.json");
      writeFileSync(
        filePath,
        JSON.stringify({ runId: "sole", fullResult: "data" }),
      );

      // Set mtime well past the retention
      const pastDate = new Date(Date.now() - 200_000);
      utimesSync(filePath, pastDate, pastDate);

      await sweepResultFiles(tmpDir2, 60_000);

      // File should be removed
      expect(existsSync(filePath)).toBe(false);

      // Empty session directory should also be removed
      expect(existsSync(sessionDir)).toBe(false);
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // (d) sweepResultFiles preserves non-empty session directories
  // -------------------------------------------------------------------------

  it("sweepResultFiles preserves non-empty session directories", async () => {
    const tmpDir3 = mkdtempSync(join(tmpdir(), "subagent-disk-mixed-"));
    try {
      const sessionDir = join(tmpDir3, "subagent-results", "mixed_session");
      mkdirSync(sessionDir, { recursive: true });

      const expiredPath = join(sessionDir, "old-file.json");
      const freshPath = join(sessionDir, "new-file.json");

      writeFileSync(
        expiredPath,
        JSON.stringify({ runId: "old", fullResult: "expired data" }),
      );
      writeFileSync(
        freshPath,
        JSON.stringify({ runId: "new", fullResult: "fresh data" }),
      );

      // Set expired file's mtime to past
      const pastDate = new Date(Date.now() - 200_000);
      utimesSync(expiredPath, pastDate, pastDate);

      await sweepResultFiles(tmpDir3, 60_000);

      // Expired file removed, fresh file preserved
      expect(existsSync(expiredPath)).toBe(false);
      expect(existsSync(freshPath)).toBe(true);

      // Session directory still exists (has remaining file)
      expect(existsSync(sessionDir)).toBe(true);
    } finally {
      rmSync(tmpDir3, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // (e) sweepResultFiles handles missing results directory gracefully
  // -------------------------------------------------------------------------

  it("sweepResultFiles handles missing results directory gracefully", async () => {
    const tmpDir4 = mkdtempSync(join(tmpdir(), "subagent-disk-missing-"));
    try {
      // tmpDir4 has NO subagent-results/ subdirectory
      // Should NOT throw
      await sweepResultFiles(tmpDir4, 60_000);

      // If we reach here, no error was thrown (test passes implicitly)
      expect(true).toBe(true);
    } finally {
      rmSync(tmpDir4, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // (f) End-to-end: condenser writes file, sweep cleans up expired file
  // -------------------------------------------------------------------------

  it("end-to-end: condenser writes file, sweep cleans up expired file", async () => {
    const tmpDir5 = mkdtempSync(join(tmpdir(), "subagent-disk-e2e-"));
    try {
      const mockLogger = createMockLogger();

      const condenser = createResultCondenser({
        maxResultTokens: 4000,
        condensationStrategy: "auto",
        dataDir: tmpDir5,
        logger: mockLogger,
      });

      // Write a file via the condenser
      const result = await condenser.condense({
        fullResult: "End-to-end test: the subagent completed analysis of market data.",
        task: "Analyze market data",
        runId: "e2e-run-001",
        sessionKey: "test-e2e:user1:ch1",
        agentId: "analyst",
      });

      // Verify file exists
      expect(existsSync(result.diskPath)).toBe(true);

      // Age the file beyond retention using utimesSync
      const pastDate = new Date(Date.now() - 200_000);
      utimesSync(result.diskPath, pastDate, pastDate);

      // Sweep with 60s retention
      await sweepResultFiles(tmpDir5, 60_000);

      // Condenser-written file should be removed
      expect(existsSync(result.diskPath)).toBe(false);

      // Session directory should be removed (was the only file)
      // The session dir is the parent of the file
      const sessionDir = join(
        tmpDir5,
        "subagent-results",
        "test-e2e_user1_ch1",
      );
      expect(existsSync(sessionDir)).toBe(false);
    } finally {
      rmSync(tmpDir5, { recursive: true, force: true });
    }
  });
});
