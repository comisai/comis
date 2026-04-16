/**
 * Unit tests for log-validator.ts.
 *
 * Tests validateLogs() filtering, categorization, and known-acceptable pattern
 * matching, plus formatReport() output formatting.
 */

import { describe, it, expect } from "vitest";

import type { LogEntry } from "./log-verifier.js";
import { validateLogs, formatReport } from "./log-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LogEntry> & { level: string; msg: string }): LogEntry {
  return {
    levelValue: overrides.level === "error" ? 50 : overrides.level === "warn" ? 40 : 30,
    time: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateLogs
// ---------------------------------------------------------------------------

describe("Log Validator", () => {
  describe("validateLogs", () => {
    it("returns clean report for logs with only info/debug entries", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "info", msg: "Server started" }),
        makeEntry({ level: "debug", msg: "Processing request" }),
        makeEntry({ level: "info", msg: "Request complete" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(true);
      expect(report.issues).toHaveLength(0);
      expect(report.totalEntries).toBe(3);
    });

    it("detects unexpected error entry", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "info", msg: "Server started" }),
        makeEntry({ level: "error", msg: "Database connection lost", module: "db" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(false);
      expect(report.issues).toHaveLength(1);
      expect(report.issues[0]!.severity).toBe("error");
      expect(report.issues[0]!.subsystem).toBe("db");
      expect(report.issues[0]!.message).toBe("Database connection lost");
    });

    it("detects unexpected warn entry", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "info", msg: "Server started" }),
        makeEntry({ level: "warn", msg: "Memory usage high", module: "monitor" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(false);
      expect(report.issues).toHaveLength(1);
      expect(report.issues[0]!.severity).toBe("warn");
      expect(report.issues[0]!.subsystem).toBe("monitor");
      expect(report.issues[0]!.message).toBe("Memory usage high");
    });

    it("filters known acceptable warning (RPC call failed: config.read)", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "info", msg: "Server started" }),
        makeEntry({ level: "warn", msg: "RPC call failed: config.read - Unknown config section" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(true);
      expect(report.issues).toHaveLength(0);
    });

    it("filters known acceptable pattern (Tool audit: fail-tool failed)", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "warn", msg: "Tool audit: fail-tool failed with error" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(true);
    });

    it("filters known acceptable pattern (SIGTERM received)", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "error", msg: "SIGTERM received, shutting down" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(true);
    });

    it("filters known acceptable pattern (ChaosEcho)", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "error", msg: "ChaosEcho adapter injected fault" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(true);
    });

    it("categorizes by subsystem correctly", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "error", msg: "Auth failed", module: "auth" }),
        makeEntry({ level: "warn", msg: "Slow query", module: "db" }),
        makeEntry({ level: "error", msg: "Token expired", module: "auth" }),
        makeEntry({ level: "warn", msg: "Connection pool low", module: "db" }),
        makeEntry({ level: "error", msg: "Rate limit hit", module: "gateway" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(false);
      expect(report.issues).toHaveLength(5);

      // By subsystem
      expect(Object.keys(report.bySubsystem)).toHaveLength(3);
      expect(report.bySubsystem["auth"]).toHaveLength(2);
      expect(report.bySubsystem["db"]).toHaveLength(2);
      expect(report.bySubsystem["gateway"]).toHaveLength(1);
    });

    it("categorizes by severity correctly", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "error", msg: "Error one", module: "a" }),
        makeEntry({ level: "warn", msg: "Warning one", module: "b" }),
        makeEntry({ level: "error", msg: "Error two", module: "c" }),
        makeEntry({ level: "warn", msg: "Warning two", module: "a" }),
        makeEntry({ level: "warn", msg: "Warning three", module: "b" }),
      ];

      const report = validateLogs(entries);

      expect(report.clean).toBe(false);
      expect(report.issues).toHaveLength(5);

      // By severity
      expect(Object.keys(report.bySeverity)).toHaveLength(2);
      expect(report.bySeverity["error"]).toHaveLength(2);
      expect(report.bySeverity["warn"]).toHaveLength(3);
    });

    it("uses entry.name as subsystem fallback when module is absent", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "error", msg: "Something broke", name: "comis-daemon" }),
      ];

      const report = validateLogs(entries);

      expect(report.issues[0]!.subsystem).toBe("comis-daemon");
    });

    it("uses 'unknown' as subsystem when both module and name are absent", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "error", msg: "Mystery error" }),
      ];

      const report = validateLogs(entries);

      expect(report.issues[0]!.subsystem).toBe("unknown");
    });
  });

  // ---------------------------------------------------------------------------
  // formatReport
  // ---------------------------------------------------------------------------

  describe("formatReport", () => {
    it("produces CLEAN string for clean report", () => {
      const report = validateLogs([
        makeEntry({ level: "info", msg: "All good" }),
        makeEntry({ level: "debug", msg: "Details" }),
      ]);

      const output = formatReport(report);

      expect(output).toContain("CLEAN");
      expect(output).toContain("2 entries");
      expect(output).toContain("0 unexpected issues");
    });

    it("produces multi-section output for report with issues", () => {
      const entries: LogEntry[] = [
        makeEntry({ level: "info", msg: "Server started" }),
        makeEntry({ level: "error", msg: "Auth failed", module: "auth" }),
        makeEntry({ level: "warn", msg: "Slow query", module: "db" }),
      ];

      const report = validateLogs(entries);
      const output = formatReport(report);

      // Header
      expect(output).toContain("Log Validation Report");
      expect(output).toContain("====================");
      expect(output).toContain("Total entries: 3");
      expect(output).toContain("Unexpected issues: 2");

      // By Severity section
      expect(output).toContain("By Severity:");
      expect(output).toContain("error (1):");
      expect(output).toContain("[auth] Auth failed");
      expect(output).toContain("warn (1):");
      expect(output).toContain("[db] Slow query");

      // By Subsystem section
      expect(output).toContain("By Subsystem:");
      expect(output).toContain("auth (1):");
      expect(output).toContain("[error] Auth failed");
      expect(output).toContain("db (1):");
      expect(output).toContain("[warn] Slow query");
    });
  });
});
