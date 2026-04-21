// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the doctor check runner.
 *
 * Verifies sequential execution, error handling, summary counts,
 * and the repairable count behavior.
 */

import { describe, it, expect } from "vitest";
import { runDoctorChecks } from "./check-runner.js";
import type { DoctorCheck, DoctorContext } from "./types.js";

/** Minimal diagnostic context for testing. */
const testContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

describe("runDoctorChecks", () => {
  it("returns empty findings with 0 checks", async () => {
    const result = await runDoctorChecks([], testContext);

    expect(result.findings).toEqual([]);
    expect(result.checksRun).toBe(0);
    expect(result.passCount).toBe(0);
    expect(result.failCount).toBe(0);
    expect(result.warnCount).toBe(0);
    expect(result.skipCount).toBe(0);
    expect(result.repairableCount).toBe(0);
  });

  it("counts a passing check correctly", async () => {
    const passingCheck: DoctorCheck = {
      id: "test-pass",
      name: "Passing Check",
      run: async () => [
        {
          category: "test",
          check: "Pass check",
          status: "pass",
          message: "All good",
          repairable: false,
        },
      ],
    };

    const result = await runDoctorChecks([passingCheck], testContext);

    expect(result.findings).toHaveLength(1);
    expect(result.checksRun).toBe(1);
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(0);
  });

  it("produces skip finding when a check throws (not crash)", async () => {
    const throwingCheck: DoctorCheck = {
      id: "broken-check",
      name: "Broken Check",
      run: async () => {
        throw new Error("Something went wrong");
      },
    };

    const result = await runDoctorChecks([throwingCheck], testContext);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].status).toBe("skip");
    expect(result.findings[0].category).toBe("broken-check");
    expect(result.findings[0].message).toContain("Something went wrong");
    expect(result.findings[0].repairable).toBe(false);
    expect(result.skipCount).toBe(1);
  });

  it("computes all status counts correctly", async () => {
    const mixedCheck: DoctorCheck = {
      id: "mixed",
      name: "Mixed Findings",
      run: async () => [
        { category: "mixed", check: "C1", status: "pass", message: "OK", repairable: false },
        { category: "mixed", check: "C2", status: "fail", message: "Bad", repairable: true },
        { category: "mixed", check: "C3", status: "warn", message: "Meh", repairable: false },
        { category: "mixed", check: "C4", status: "skip", message: "Skipped", repairable: false },
        { category: "mixed", check: "C5", status: "fail", message: "Also bad", repairable: true },
      ],
    };

    const result = await runDoctorChecks([mixedCheck], testContext);

    expect(result.findings).toHaveLength(5);
    expect(result.checksRun).toBe(1);
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(2);
    expect(result.warnCount).toBe(1);
    expect(result.skipCount).toBe(1);
    expect(result.repairableCount).toBe(2);
  });

  it("aggregates findings from multiple checks in order", async () => {
    const checkA: DoctorCheck = {
      id: "check-a",
      name: "Check A",
      run: async () => [
        { category: "a", check: "A1", status: "pass", message: "A pass", repairable: false },
      ],
    };

    const checkB: DoctorCheck = {
      id: "check-b",
      name: "Check B",
      run: async () => [
        { category: "b", check: "B1", status: "fail", message: "B fail", repairable: true },
        { category: "b", check: "B2", status: "warn", message: "B warn", repairable: false },
      ],
    };

    const result = await runDoctorChecks([checkA, checkB], testContext);

    expect(result.findings).toHaveLength(3);
    expect(result.checksRun).toBe(2);
    // Order preserved (not sorted by severity)
    expect(result.findings[0].category).toBe("a");
    expect(result.findings[1].category).toBe("b");
    expect(result.findings[2].category).toBe("b");
  });
});
