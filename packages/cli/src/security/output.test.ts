/**
 * Tests for security audit output rendering.
 *
 * Verifies table and JSON rendering for audit results including
 * empty findings, severity display, and passed/failed state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuditResult } from "./types.js";

vi.mock("../output/table.js", () => ({
  renderTable: vi.fn(),
}));

vi.mock("../output/format.js", () => ({
  json: vi.fn(),
}));

import { renderAuditTable, renderAuditJson } from "./output.js";
import { renderTable } from "../output/table.js";
import { json } from "../output/format.js";

describe("renderAuditTable", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("shows 'No security findings' for empty result", () => {
    const result: AuditResult = {
      findings: [],
      checksRun: 3,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      passed: true,
    };

    renderAuditTable(result);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No security findings");
  });

  it("renders findings via renderTable with severity-colored rows", () => {
    const result: AuditResult = {
      findings: [
        {
          category: "permissions",
          severity: "critical",
          message: "Config world-readable",
          remediation: "chmod 600",
          code: "PERM-01",
        },
        {
          category: "secrets",
          severity: "warning",
          message: "Key exposed",
          remediation: "Rotate key",
          code: "SEC-01",
        },
      ],
      checksRun: 2,
      criticalCount: 1,
      warningCount: 1,
      infoCount: 0,
      passed: false,
    };

    renderAuditTable(result);

    expect(renderTable).toHaveBeenCalledWith(
      ["", "Severity", "Category", "Message", "Remediation"],
      expect.any(Array),
    );
    const rows = vi.mocked(renderTable).mock.calls[0][1];
    expect(rows).toHaveLength(2);
  });

  it("shows Audit PASSED when result.passed is true", () => {
    const result: AuditResult = {
      findings: [
        { category: "info", severity: "info", message: "FYI", remediation: "N/A", code: "I-01" },
      ],
      checksRun: 1,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 1,
      passed: true,
    };

    renderAuditTable(result);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Audit PASSED");
  });

  it("shows Audit FAILED when result.passed is false", () => {
    const result: AuditResult = {
      findings: [
        { category: "crit", severity: "critical", message: "Bad", remediation: "Fix", code: "C-01" },
      ],
      checksRun: 1,
      criticalCount: 1,
      warningCount: 0,
      infoCount: 0,
      passed: false,
    };

    renderAuditTable(result);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Audit FAILED");
  });
});

describe("renderAuditJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls json() with correct structure", () => {
    const result: AuditResult = {
      findings: [
        { category: "sec", severity: "warning", message: "Warn", remediation: "Fix", code: "W-01" },
      ],
      checksRun: 5,
      criticalCount: 0,
      warningCount: 1,
      infoCount: 0,
      passed: true,
    };

    renderAuditJson(result);

    expect(json).toHaveBeenCalledWith({
      checksRun: 5,
      passed: true,
      summary: {
        critical: 0,
        warning: 1,
        info: 0,
      },
      findings: result.findings,
    });
  });
});
