// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { buildAbortSummary } from "./abort-summary.js";

describe("buildAbortSummary", () => {
  it("returns formatted summary with completed operations from toolExecResults", () => {
    const result = buildAbortSummary({
      toolExecResults: [
        { toolName: "file_read", success: true, durationMs: 100 },
        { toolName: "file_write", success: true, durationMs: 200 },
        { toolName: "web_search", success: false, durationMs: 50, errorText: "timeout" },
      ],
    });

    expect(result).toBeDefined();
    expect(result).toContain("3 tool operations");
    expect(result).toContain("2 succeeded");
    expect(result).toContain("1 failed");
    expect(result).toContain("file_read");
    expect(result).toContain("file_write");
  });

  it("returns undefined when no successful operations found", () => {
    const result = buildAbortSummary({
      toolExecResults: [
        { toolName: "web_fetch", success: false, durationMs: 50, errorText: "404" },
      ],
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when toolExecResults is empty", () => {
    expect(buildAbortSummary({ toolExecResults: [] })).toBeUndefined();
    expect(buildAbortSummary({})).toBeUndefined();
  });

  it("counts successful vs failed tool calls", () => {
    const result = buildAbortSummary({
      toolExecResults: [
        { toolName: "a", success: true, durationMs: 10 },
        { toolName: "b", success: true, durationMs: 10 },
        { toolName: "c", success: true, durationMs: 10 },
        { toolName: "d", success: false, durationMs: 10, errorText: "err" },
        { toolName: "e", success: false, durationMs: 10, errorText: "err" },
      ],
    });

    expect(result).toContain("3 succeeded");
    expect(result).toContain("2 failed");
  });

  it("identifies last error pattern from toolExecResults", () => {
    const result = buildAbortSummary({
      toolExecResults: [
        { toolName: "a", success: true, durationMs: 10 },
        { toolName: "b", success: false, durationMs: 10, errorText: "Connection timeout" },
        { toolName: "c", success: false, durationMs: 10, errorText: "Rate limit exceeded" },
      ],
    });

    expect(result).toBeDefined();
    expect(result).toContain("Last error:");
    expect(result).toContain("Rate limit exceeded");
  });

  it("limits unique tool names to 5 in display", () => {
    const result = buildAbortSummary({
      toolExecResults: [
        { toolName: "tool_1", success: true, durationMs: 10 },
        { toolName: "tool_2", success: true, durationMs: 10 },
        { toolName: "tool_3", success: true, durationMs: 10 },
        { toolName: "tool_4", success: true, durationMs: 10 },
        { toolName: "tool_5", success: true, durationMs: 10 },
        { toolName: "tool_6", success: true, durationMs: 10 },
        { toolName: "tool_7", success: true, durationMs: 10 },
      ],
    });

    expect(result).toBeDefined();
    // Should show max 5 tool names
    const toolsLine = result!.split("\n").find(l => l.includes("Tools used:"));
    expect(toolsLine).toBeDefined();
    // Count commas -- 5 items = 4 commas + "..."
    const toolNames = toolsLine!.replace("- Tools used: ", "").split(", ");
    expect(toolNames.length).toBeLessThanOrEqual(6); // 5 names + "..."
  });
});
