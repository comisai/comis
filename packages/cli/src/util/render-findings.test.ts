// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the unified renderFindings helper.
 *
 * RED-then-GREEN coverage for the discriminated-union CLI render utility
 * that consolidates the 5 per-domain render sites (doctor / security / health /
 * status / channel). Per-variant assertions cover all four render configurations:
 *
 *   - Config A — compact findings (doctor / health-flat shape)
 *   - Config B — table findings (security shape)
 *   - Config C — grouped-by-category compact findings (health shape)
 *   - Config D — sections (status / channel shape)
 *
 * Module ./render-findings.js does not yet exist when this file is committed
 * (RED state); Task 2 implements it (GREEN state).
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the table primitives so we can assert call shape without touching
// the cli-table3 rendering pipeline directly.
vi.mock("../output/table.js", () => ({
  renderTable: vi.fn(),
  renderKeyValue: vi.fn(),
}));

import { renderTable, renderKeyValue } from "../output/table.js";
import { createConsoleSpy, getSpyOutput } from "../test-helpers.js";
import {
  renderFindings,
  type NormalizedFinding,
} from "./render-findings.js";

describe("renderFindings — config A compact findings (doctor/health-flat shape)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
    vi.mocked(renderTable).mockClear();
    vi.mocked(renderKeyValue).mockClear();
  });

  it("renders 'No findings.' on empty input in compact mode", () => {
    consoleSpy = createConsoleSpy();
    renderFindings(
      { kind: "findings", findings: [], summary: { total: 0, counts: {} } },
      { renderMode: "compact" },
    );
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No findings.");
  });

  it("renders one finding with icon, category, title, message, and hint line", () => {
    consoleSpy = createConsoleSpy();
    const finding: NormalizedFinding = {
      status: "fail",
      category: "config",
      title: "load",
      message: "Config not found",
      hint: "Run comis config init",
    };
    renderFindings(
      {
        kind: "findings",
        findings: [finding],
        summary: { total: 1, counts: { fail: 1 } },
      },
      { renderMode: "compact" },
    );
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("config");
    expect(output).toContain("load");
    expect(output).toContain("Config not found");
    expect(output).toContain("Run comis config init");
  });

  it("renders the [repairable] badge in cyan when present", () => {
    consoleSpy = createConsoleSpy();
    renderFindings(
      {
        kind: "findings",
        findings: [
          {
            status: "fail",
            category: "config",
            title: "x",
            message: "y",
            badge: "[repairable]",
          },
        ],
        summary: { total: 1, counts: { fail: 1 } },
      },
      { renderMode: "compact" },
    );
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("[repairable]");
  });
});

describe("renderFindings — config B table findings (security shape)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
    vi.mocked(renderTable).mockClear();
    vi.mocked(renderKeyValue).mockClear();
  });

  it("renders 'No security findings' on empty input in table mode", () => {
    consoleSpy = createConsoleSpy();
    renderFindings(
      { kind: "findings", findings: [], summary: { total: 0, counts: {} } },
      { renderMode: "table" },
    );
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No security findings");
  });

  it("calls renderTable with the 5-col security header", () => {
    consoleSpy = createConsoleSpy();
    renderFindings(
      {
        kind: "findings",
        findings: [
          {
            status: "critical",
            category: "secrets",
            title: "SEC-001",
            message: "Plaintext key",
            hint: "Encrypt at rest",
          },
        ],
        summary: { total: 1, counts: { critical: 1 } },
      },
      { renderMode: "table" },
    );
    expect(renderTable).toHaveBeenCalledWith(
      ["", "Severity", "Category", "Message", "Remediation"],
      expect.any(Array),
    );
    // Verify the row data also flows through with category/message/remediation.
    const rows = vi.mocked(renderTable).mock.calls[0]![1] as readonly (readonly string[])[];
    expect(rows).toHaveLength(1);
    const firstRow = rows[0]!;
    expect(firstRow.some((cell) => cell.includes("secrets"))).toBe(true);
    expect(firstRow.some((cell) => cell.includes("Plaintext key"))).toBe(true);
    expect(firstRow.some((cell) => cell.includes("Encrypt at rest"))).toBe(true);
  });
});

describe("renderFindings — config C grouped-by-category (health shape)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
    vi.mocked(renderTable).mockClear();
    vi.mocked(renderKeyValue).mockClear();
  });

  it("emits ONE bolded category header for two findings sharing the same category", () => {
    consoleSpy = createConsoleSpy();
    renderFindings(
      {
        kind: "findings",
        findings: [
          { status: "fail", category: "boot", title: "x", message: "A" },
          { status: "warn", category: "boot", title: "y", message: "B" },
        ],
        summary: { total: 2, counts: { fail: 1, warn: 1 } },
      },
      { renderMode: "compact", groupBy: "category" },
    );
    const output = getSpyOutput(consoleSpy.log);
    // Both messages present:
    expect(output).toContain("A");
    expect(output).toContain("B");
    // The groupBy-category render emits the header once per category and the
    // per-finding lines do NOT re-print the category (only the message).
    // So we expect exactly 1 occurrence of "boot".
    const headerOccurrences = (output.match(/boot/g) ?? []).length;
    expect(headerOccurrences).toBe(1);
  });
});

describe("renderFindings — config D sections variant (status/channel shape)", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
    vi.mocked(renderTable).mockClear();
    vi.mocked(renderKeyValue).mockClear();
  });

  it("delegates kv-section to renderKeyValue with the supplied pairs", () => {
    consoleSpy = createConsoleSpy();
    renderFindings({
      kind: "sections",
      sections: [
        {
          kind: "kv",
          title: "Daemon",
          pairs: [
            ["Status", "up"],
            ["PID", "123"],
          ],
        },
      ],
    });
    expect(renderKeyValue).toHaveBeenCalledWith([
      ["Status", "up"],
      ["PID", "123"],
    ]);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Daemon");
  });

  it("delegates table-section to renderTable with the supplied headers and rows", () => {
    consoleSpy = createConsoleSpy();
    renderFindings({
      kind: "sections",
      sections: [
        {
          kind: "table",
          title: "Channels",
          headers: ["Type", "Status"],
          rows: [["discord", "up"]],
        },
      ],
    });
    expect(renderTable).toHaveBeenCalledWith(
      ["Type", "Status"],
      [["discord", "up"]],
    );
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Channels");
  });

  it("prints emptyMessage in dim when table-section rows are empty", () => {
    consoleSpy = createConsoleSpy();
    renderFindings({
      kind: "sections",
      sections: [
        {
          kind: "table",
          title: "Channels",
          headers: ["Type", "Status"],
          rows: [],
          emptyMessage: "No channels configured",
        },
      ],
    });
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No channels configured");
    // renderTable MUST NOT be called when rows is empty + emptyMessage given:
    expect(renderTable).not.toHaveBeenCalled();
  });

  it("omits the bolded title for an untitled table-section (channel flat-listing case)", () => {
    consoleSpy = createConsoleSpy();
    renderFindings({
      kind: "sections",
      sections: [
        {
          kind: "table",
          headers: ["Channel", "Type", "Status", "Details"],
          rows: [["main", "discord", "connected", "-"]],
        },
      ],
    });
    expect(renderTable).toHaveBeenCalledWith(
      ["Channel", "Type", "Status", "Details"],
      [["main", "discord", "connected", "-"]],
    );
    // No title provided → no bolded heading. Capture log output and assert
    // that no log line contains the literal headers as a section title.
    const output = getSpyOutput(consoleSpy.log);
    // The "Channel" column header appears INSIDE the (mocked) renderTable call,
    // not as a section title. Since renderTable is mocked here, nothing from
    // the table prints; only a section title would. Assert no log lines were
    // produced beyond the (none) section title.
    // We assert by absence of "Channel" outside the renderTable mock call args.
    expect(output).not.toContain("Channel");
  });
});
