/**
 * Tests for doctor output rendering.
 *
 * Verifies table and JSON rendering for doctor results including
 * empty, mixed, and repairable finding states.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DoctorResult } from "./types.js";

vi.mock("../output/format.js", () => ({
  json: vi.fn(),
}));

import { renderDoctorTable, renderDoctorJson } from "./output.js";
import { json } from "../output/format.js";

describe("renderDoctorTable", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("shows 'No findings' for empty result", () => {
    const result: DoctorResult = {
      findings: [],
      checksRun: 0,
      passCount: 0,
      failCount: 0,
      warnCount: 0,
      skipCount: 0,
      repairableCount: 0,
    };

    renderDoctorTable(result);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No findings");
  });

  it("renders findings with status counts in summary", () => {
    const result: DoctorResult = {
      findings: [
        { category: "config", check: "C1", status: "pass", message: "OK", repairable: false },
        { category: "daemon", check: "C2", status: "fail", message: "Bad", repairable: false },
        { category: "workspace", check: "C3", status: "warn", message: "Meh", repairable: false },
        { category: "network", check: "C4", status: "skip", message: "Skip", repairable: false },
      ],
      checksRun: 4,
      passCount: 1,
      failCount: 1,
      warnCount: 1,
      skipCount: 1,
      repairableCount: 0,
    };

    renderDoctorTable(result);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("config");
    expect(output).toContain("4 checks");
    expect(output).toContain("1 pass");
    expect(output).toContain("1 fail");
  });

  it("shows repairable tag and repair count", () => {
    const result: DoctorResult = {
      findings: [
        { category: "config", check: "C1", status: "fail", message: "Broken", repairable: true },
      ],
      checksRun: 1,
      passCount: 0,
      failCount: 1,
      warnCount: 0,
      skipCount: 0,
      repairableCount: 1,
    };

    renderDoctorTable(result);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("repairable");
    expect(output).toContain("--repair");
  });
});

describe("renderDoctorJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls json() with correct structure", () => {
    const result: DoctorResult = {
      findings: [
        { category: "config", check: "C1", status: "pass", message: "OK", repairable: false },
      ],
      checksRun: 1,
      passCount: 1,
      failCount: 0,
      warnCount: 0,
      skipCount: 0,
      repairableCount: 0,
    };

    renderDoctorJson(result);

    expect(json).toHaveBeenCalledWith({
      checksRun: 1,
      summary: {
        pass: 1,
        fail: 0,
        warn: 0,
        skip: 0,
        repairable: 0,
      },
      findings: result.findings,
    });
  });
});
