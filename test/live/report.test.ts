// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for report.ts — writeReport, writeLedger, writeReadiness.
 * Stage-A TDD: all tests fail until report.ts is created (RED phase).
 * No real provider calls — zero cost tier.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeReport,
  writeLedger,
  writeReadiness,
  type LiveTestReport,
} from "./report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "comis-report-test-"));
}

function makeReport(overrides?: Partial<LiveTestReport>): LiveTestReport {
  return {
    runId: "test-run-001",
    ts: new Date().toISOString(),
    git_sha: "abc1234",
    mode: "all",
    budget_usd: 2.0,
    total_cost_usd: 0,
    verdicts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tmpDirs = [];
});

describe("writeReport", () => {
  it("creates the file at the given path with valid JSON matching the LiveTestReport shape", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const outputPath = join(dir, ".test-live-report.json");
    const report = makeReport();

    writeReport(report, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const raw = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(raw) as LiveTestReport;
    expect(parsed.runId).toBe(report.runId);
    expect(parsed.mode).toBe(report.mode);
    expect(Array.isArray(parsed.verdicts)).toBe(true);
  });

  it("throws before write when the report contains a secret-shaped string in verdicts", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const outputPath = join(dir, ".test-live-report.json");

    // Inject a fake bearer token into a reason field — should trigger assertNoSecrets
    const reportWithSecret = makeReport({
      verdicts: [
        {
          scenarioId: "smoke",
          status: "failed",
          reason: "error: Bearer sk-ant-api01-AAABBBCCCDDDEEEFFFGGG",
          costUsd: 0,
        },
      ],
    });

    expect(() => writeReport(reportWithSecret, outputPath)).toThrow(/SECRET LEAK/i);
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe("writeLedger", () => {
  it("creates benchmarks/live/<date>-<sha>/report.json under the given benchmarks dir", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const report = makeReport({ git_sha: "deadbeef" });

    const ledgerDir = writeLedger(report, dir);

    expect(existsSync(join(ledgerDir, "report.json"))).toBe(true);
    // The ledger dir path must contain the sha
    expect(ledgerDir).toContain("deadbeef");
  });
});

describe("writeReadiness", () => {
  it("creates a file containing 'CERTIFIED' when the verdict is CERTIFIED", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const outputPath = join(dir, "READINESS.md");

    writeReadiness({ FND: "CERTIFIED" }, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("CERTIFIED");
  });
});
