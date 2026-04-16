/**
 * Tests for table rendering utilities (renderTable, renderKeyValue).
 *
 * Verifies that renderTable produces output containing all headers and row data,
 * and that renderKeyValue displays key-value pairs without table borders.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { createConsoleSpy, getSpyOutput } from "../test-helpers.js";
import { renderTable, renderKeyValue } from "./table.js";

describe("renderTable", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
  });

  it("renders table with headers and rows", () => {
    consoleSpy = createConsoleSpy();
    renderTable(["Name", "Status"], [
      ["agent-1", "running"],
      ["agent-2", "stopped"],
    ]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Name");
    expect(output).toContain("Status");
    expect(output).toContain("agent-1");
    expect(output).toContain("running");
    expect(output).toContain("agent-2");
    expect(output).toContain("stopped");
  });

  it("renders table with single row", () => {
    consoleSpy = createConsoleSpy();
    renderTable(["ID", "Type"], [["abc-123", "worker"]]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("ID");
    expect(output).toContain("Type");
    expect(output).toContain("abc-123");
    expect(output).toContain("worker");
  });

  it("renders table with empty rows", () => {
    consoleSpy = createConsoleSpy();
    renderTable(["Name"], []);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Name");
    // With no data rows, output should be short (just header)
    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("renders table with many columns", () => {
    consoleSpy = createConsoleSpy();
    const headers = ["Col1", "Col2", "Col3", "Col4", "Col5"];
    const rows = [
      ["a1", "a2", "a3", "a4", "a5"],
      ["b1", "b2", "b3", "b4", "b5"],
    ];
    renderTable(headers, rows);
    const output = getSpyOutput(consoleSpy.log);
    for (const h of headers) {
      expect(output).toContain(h);
    }
    for (const row of rows) {
      for (const cell of row) {
        expect(output).toContain(cell);
      }
    }
  });

  it("handles special characters in cell data", () => {
    consoleSpy = createConsoleSpy();
    renderTable(["Key", "Value"], [
      ["pipe|test", "dash-test"],
      ["angle<bracket>", "ampersand&more"],
    ]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("pipe|test");
    expect(output).toContain("dash-test");
    expect(output).toContain("angle<bracket>");
    expect(output).toContain("ampersand&more");
  });
});

describe("renderKeyValue", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
  });

  it("renders key-value pairs without borders", () => {
    consoleSpy = createConsoleSpy();
    renderKeyValue([
      ["Status", "Running"],
      ["Uptime", "3h 22m"],
    ]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Status");
    expect(output).toContain("Running");
    expect(output).toContain("Uptime");
    expect(output).toContain("3h 22m");
    // No box-drawing borders (top/bottom chars are empty strings in implementation)
    expect(output).not.toContain("┌");
    expect(output).not.toContain("┐");
    expect(output).not.toContain("└");
    expect(output).not.toContain("┘");
    expect(output).not.toContain("┬");
    expect(output).not.toContain("┴");
  });

  it("renders single key-value pair", () => {
    consoleSpy = createConsoleSpy();
    renderKeyValue([["Version", "2.1.0"]]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Version");
    expect(output).toContain("2.1.0");
  });

  it("renders empty pairs array", () => {
    consoleSpy = createConsoleSpy();
    expect(() => renderKeyValue([])).not.toThrow();
    const output = getSpyOutput(consoleSpy.log);
    // Should produce minimal or empty output
    const trimmed = output.trim();
    expect(trimmed.length).toBeLessThanOrEqual(10);
  });
});
