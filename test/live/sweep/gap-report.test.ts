// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGapReport, writeGapReport, writeGapReadiness, type GapReport } from "./gap-report.js";
import type { SweepResult, ProbeVerdict } from "./sweep.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSweepResult(verdicts: Partial<ProbeVerdict>[]): SweepResult {
  const full: ProbeVerdict[] = verdicts.map((v, i) => ({
    id: v.id ?? `probe-${i}`,
    category: v.category ?? "search(brave)",
    status: v.status ?? "green",
    reason: v.reason,
    durationMs: v.durationMs ?? 10,
  }));
  return { verdicts: full, costUsd: 0.01, ranAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Unit tests — no COMIS_LIVE gate (mock data only, no real I/O to external services)
// ---------------------------------------------------------------------------

describe("buildGapReport", () => {
  it("Test 1: returns GapReport with required shape from a SweepResult", () => {
    const result = makeSweepResult([
      { category: "search(brave)", status: "green" },
      { category: "search(tavily)", status: "red" },
    ]);
    const report: GapReport = buildGapReport(result, "abc1234");

    expect(report.runId).toMatch(/^sweep-\d+$/);
    expect(report.ts).toBe(result.ranAt);
    expect(report.git_sha).toBe("abc1234");
    expect(Array.isArray(report.probeVerdicts)).toBe(true);
    expect(Array.isArray(report.phaseOrder)).toBe(true);
    expect(typeof report.summary.green).toBe("number");
    expect(typeof report.summary.red).toBe("number");
    expect(typeof report.summary.skip).toBe("number");
  });

  it("Test 2: phaseOrder puts most-red phases first; all 137–144 present", () => {
    // 2 reds mapped to phase 142 (via "STT(openai)" + "TTS(openai)") and 1 red to 143 (via "search(brave)")
    const result = makeSweepResult([
      { category: "STT(openai)", status: "red" },
      { category: "TTS(openai)", status: "red" },
      { category: "search(brave)", status: "red" },
      { category: "search(tavily)", status: "green" },
    ]);
    const report = buildGapReport(result, "def5678");

    // phase 142 has 2 reds, phase 143 has 1 red
    expect(report.phaseOrder[0]).toBe(142);
    expect(report.phaseOrder[1]).toBe(143);
    // All phases 137–144 must appear
    const expected = [137, 138, 139, 140, 141, 142, 143, 144];
    expect(report.phaseOrder.sort((a, b) => a - b)).toEqual(expected);
  });

  it("Test 3: phaseOrder is [137..144] natural order when zero red verdicts", () => {
    const result = makeSweepResult([
      { category: "search(brave)", status: "green" },
      { category: "search(tavily)", status: "skip" },
    ]);
    const report = buildGapReport(result, "zero001");
    expect(report.phaseOrder).toEqual([137, 138, 139, 140, 141, 142, 143, 144]);
  });

  it("Test 4: summary green/red/skip counts match input verdicts", () => {
    const result = makeSweepResult([
      { status: "green" },
      { status: "green" },
      { status: "red" },
      { status: "skip" },
      { status: "skip" },
    ]);
    const report = buildGapReport(result, "count01");
    expect(report.summary.green).toBe(2);
    expect(report.summary.red).toBe(1);
    expect(report.summary.skip).toBe(2);
  });

  it("Test 8: summary.skip includes budget-exceeded verdicts (status=skip)", () => {
    // budget-exceeded verdicts come in as status:"skip" from sweep.ts
    const result = makeSweepResult([
      { status: "skip", reason: "SKIPPED(budget-exceeded)" },
      { status: "skip", reason: "SKIPPED(no-creds)" },
      { status: "green" },
    ]);
    const report = buildGapReport(result, "budget01");
    expect(report.summary.skip).toBe(2);
    expect(report.summary.green).toBe(1);
    expect(report.summary.red).toBe(0);
  });
});

describe("writeGapReport", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("Test 5: writes gap-report.json to benchmarks/live/<date>-<sha>/ and is parseable", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gap-report-test-"));
    const result = makeSweepResult([{ status: "green" }, { status: "skip" }]);
    const ledgerDir = writeGapReport(result, tmpDir, "abc1234");

    const reportPath = join(ledgerDir, "gap-report.json");
    expect(existsSync(reportPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(reportPath, "utf-8")) as GapReport;
    expect(parsed.git_sha).toBe("abc1234");
    expect(Array.isArray(parsed.probeVerdicts)).toBe(true);
    expect(Array.isArray(parsed.phaseOrder)).toBe(true);
    expect(typeof parsed.summary).toBe("object");
    // Ledger dir path must match benchmarks/live/<date>-<sha>/ pattern
    expect(ledgerDir).toMatch(/live\/\d{4}-\d{2}-\d{2}-abc1234$/);
  });

  it("Test 6: writeGapReport throws SECRET LEAK when verdict reason contains a secret-shaped string", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gap-report-test-"));
    // Inject a fake sk-ant style key into a verdict reason
    const result = makeSweepResult([
      {
        category: "search(brave)",
        status: "red",
        reason: "sk-ant-api03-aaaaaaaaaaaaaaaa",
      },
    ]);
    expect(() => writeGapReport(result, tmpDir, "abc1234")).toThrow("SECRET LEAK");
  });
});

describe("writeGapReadiness", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("Test 7: writes markdown file containing # Gap Report and phase reorder table", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gap-report-test-"));
    const result = makeSweepResult([
      { id: "search-brave", category: "search(brave)", status: "green" },
      { id: "stt-openai", category: "STT(openai)", status: "red" },
    ]);
    const report = buildGapReport(result, "md0001");
    const outputPath = join(tmpDir, "gap-readiness.md");
    writeGapReadiness(report, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("# Gap Report");
    // Phase priority table
    expect(content).toContain("Phase Priority");
    // Probe verdicts table
    expect(content).toContain("Probe Verdicts");
    expect(content).toContain("search-brave");
    expect(content).toContain("stt-openai");
  });
});
