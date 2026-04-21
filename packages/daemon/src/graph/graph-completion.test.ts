// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for graph-completion module: truncatePreview helper and
 * buildGraphAnnouncement announcement builder.
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { buildGraphAnnouncement, truncatePreview, extractAnnouncementPreview } from "./graph-completion.js";
import {
  type ValidatedGraph,
  type ExecutionGraph,
  validateAndSortGraph,
} from "@comis/core";
import { createGraphStateMachine } from "./graph-state-machine.js";
import type { GraphRunState } from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Module mock for node:fs (buildGraphAnnouncement indirectly lives in a
// module that imports writeFileSync, so we need to mock it)
// ---------------------------------------------------------------------------

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildValidatedGraph(
  nodes: Array<{ nodeId: string; task?: string; dependsOn?: string[] }>,
): ValidatedGraph {
  const graph: ExecutionGraph = {
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      task: n.task ?? `Task ${n.nodeId}`,
      dependsOn: n.dependsOn ?? [],
    })),
  };
  const result = validateAndSortGraph(graph);
  if (!result.ok) {
    throw new Error(`Invalid test graph: ${result.error.message}`);
  }
  return result.value;
}

function createMinimalGraphRunState(
  nodes: Array<{ nodeId: string; output?: string; status?: "completed" | "failed" | "skipped"; error?: string }>,
): GraphRunState {
  const validatedGraph = buildValidatedGraph(
    nodes.map((n) => ({ nodeId: n.nodeId })),
  );
  const sm = createGraphStateMachine(validatedGraph);

  // Transition each node through the state machine
  for (const n of nodes) {
    // Mark running first
    sm.markNodeRunning(n.nodeId, `run-${n.nodeId}`);

    if (n.status === "completed" || n.status === undefined) {
      sm.markNodeCompleted(n.nodeId, n.output);
    } else if (n.status === "failed") {
      sm.markNodeFailed(n.nodeId, n.error ?? "test error");
    }
    // "skipped" is handled by cascade; for simplicity, mark as failed
  }

  return {
    graphId: "test-graph-id",
    graphTraceId: "test-trace-id",
    graph: validatedGraph,
    stateMachine: sm,
    runIdToNode: new Map(),
    nodeOutputs: new Map(),
    nodeTimers: new Map(),
    retryTimers: new Map(),
    graphTimer: undefined,
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    runningCount: 0,
    nodeProgress: false,
    skippedNodesEmitted: new Set(),
    cumulativeTokens: 0,
    cumulativeCost: 0,
    sharedDir: "/tmp/test-graph",
    driverStates: new Map(),
    driverRunIdMap: new Map(),
    waitHandlers: new Map(),
    syntheticRunResults: new Map(),
    nodeCacheData: new Map(),
  };
}

// ---------------------------------------------------------------------------
// truncatePreview tests
// ---------------------------------------------------------------------------

describe("truncatePreview", () => {
  it("returns short text unchanged (no ellipsis)", () => {
    expect(truncatePreview("short text", 500)).toBe("short text");
  });

  it("returns '(no output)' for empty string", () => {
    expect(truncatePreview("", 500)).toBe("(no output)");
  });

  it("returns '(no output)' for undefined", () => {
    expect(truncatePreview(undefined, 500)).toBe("(no output)");
  });

  it("returns '(no output)' for whitespace-only string", () => {
    expect(truncatePreview("   \n  ", 500)).toBe("(no output)");
  });

  it("truncates long text at word boundary with ellipsis", () => {
    const longText = "The analysis reveals several key findings about the market. "
      .repeat(20);
    const result = truncatePreview(longText, 500);

    // Must end with ellipsis character
    expect(result.endsWith("\u2026")).toBe(true);
    // Must be within limit (maxLen + 1 for ellipsis char)
    expect(result.length).toBeLessThanOrEqual(501);
    // Must not cut mid-word: the char before ellipsis should end a word
    const beforeEllipsis = result.slice(0, -1).trimEnd();
    expect(beforeEllipsis).toMatch(/[a-zA-Z.)\]]$/);
  });

  it("never cuts mid-word: 'Hello wonderful world' with limit 8 returns 'Hello...'", () => {
    const result = truncatePreview("Hello wonderful world", 8);
    expect(result).toBe("Hello\u2026");
  });

  it("extracts first paragraph if it fits within limit", () => {
    // Full text must exceed limit so truncation logic triggers
    const secondParagraph = "Second paragraph with lots of detail. ".repeat(20);
    const text = "First paragraph here.\n\n" + secondParagraph;
    const result = truncatePreview(text, 500);
    // First paragraph fits within 500, so should use it with ellipsis
    expect(result).toBe("First paragraph here.\u2026");
  });

  it("does not truncate text exactly at limit", () => {
    const exactText = "a".repeat(500);
    expect(truncatePreview(exactText, 500)).toBe(exactText);
  });

  it("handles single massive word with hard-cut", () => {
    const noSpaces = "x".repeat(600);
    const result = truncatePreview(noSpaces, 500);
    expect(result.length).toBe(501); // 500 chars + ellipsis
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("uses default maxLen of 500", () => {
    const longText = "word ".repeat(200); // 1000 chars
    const result = truncatePreview(longText);
    expect(result.length).toBeLessThanOrEqual(501);
    expect(result.endsWith("\u2026")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractAnnouncementPreview tests
// ---------------------------------------------------------------------------

describe("extractAnnouncementPreview", () => {
  it("strips leading --- separators and returns substantive content", () => {
    const text = "---\n\n# INVESTMENT MEMO\n\nBuy NVDA at $183.\n\n---\n\n## Details\n\n" + "x".repeat(5000);
    const result = extractAnnouncementPreview(text, 200);
    // Must NOT start with "---"
    expect(result.startsWith("---")).toBe(false);
    // Must contain the heading
    expect(result).toContain("INVESTMENT MEMO");
  });

  it("returns full cleaned text if under limit", () => {
    const text = "---\n\nShort summary here.";
    const result = extractAnnouncementPreview(text, 500);
    expect(result).toBe("Short summary here.");
  });

  it("cuts at markdown section boundary when possible", () => {
    const text = "# Title\n\nFirst section content here.\n\n## Second Section\n\n" + "x".repeat(5000);
    const result = extractAnnouncementPreview(text, 100);
    // Should cut at the "## Second Section" boundary, not mid-content
    expect(result).toContain("First section content");
    expect(result).not.toContain("xxxx");
  });

  it("handles empty/whitespace input", () => {
    expect(extractAnnouncementPreview("", 500)).toBe("(no output)");
    expect(extractAnnouncementPreview("  \n  ", 500)).toBe("(no output)");
  });
});

// ---------------------------------------------------------------------------
// buildGraphAnnouncement tests
// ---------------------------------------------------------------------------

describe("buildGraphAnnouncement", () => {
  it("includes GraphId and node count in footer", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: "Result A" },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);

    expect(announcement).toContain("GraphId: test-graph-id");
    expect(announcement).toContain("1/1 nodes");
  });

  it("includes full output for leaf node (no downstream dependents)", () => {
    const leafOutput = "BUY NVDA at $183.74 with hard stop at $172.";
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: leafOutput },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);

    // Leaf node output appears in full as primary content
    expect(announcement).toContain(leafOutput);
  });

  it("shows intermediate nodes as summary checkmarks, leaf nodes as full output", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: "Intermediate analysis..." },
      { nodeId: "B", output: "Final trading decision: BUY." },
    ]);
    // Make B depend on A so A is intermediate, B is leaf
    gs.graph = buildValidatedGraph([
      { nodeId: "A" },
      { nodeId: "B", dependsOn: ["A"] },
    ]);
    // Re-create state machine with dependency graph
    const sm = createGraphStateMachine(gs.graph);
    sm.markNodeRunning("A", "run-A");
    sm.markNodeCompleted("A", "Intermediate analysis...");
    sm.markNodeRunning("B", "run-B");
    sm.markNodeCompleted("B", "Final trading decision: BUY.");
    gs.stateMachine = sm;

    const { text: announcement } = buildGraphAnnouncement(gs);

    // A is intermediate — shown as checkmark summary, not full output
    expect(announcement).toContain("\u2705 A");
    expect(announcement).not.toContain("Intermediate analysis...");
    // B is leaf — full output surfaced
    expect(announcement).toContain("Final trading decision: BUY.");
  });

  it("includes long leaf node output without truncation", () => {
    const longLeafOutput = "The analysis reveals several key findings. "
      .repeat(40); // ~1760 chars
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: longLeafOutput },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);

    // Leaf node — full output included even when long
    expect(announcement).toContain(longLeafOutput);
  });

  it("shows '(no output)' for leaf node with undefined output", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: undefined },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);
    expect(announcement).toContain("(no output)");
  });

  it("shows failed nodes in summary", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", status: "failed", error: "timeout" },
    ]);
    const { text: announcement } = buildGraphAnnouncement(gs);
    expect(announcement).toContain("\u274C A: timeout");
    expect(announcement).toContain("1 failed");
  });

  it("returns no buttons for short leaf output", () => {
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: "Short result" },
    ]);
    const result = buildGraphAnnouncement(gs);
    expect(result.text).toContain("Short result");
    expect(result.buttons).toBeUndefined();
  });

  it("truncates long leaf output and adds Full Report button", () => {
    // Simulate a realistic markdown report with leading --- separators
    const longOutput = "---\n\n# INVESTMENT MEMO\n\n## EXECUTIVE SUMMARY\n\n" +
      "Decision: BUY NVDA at $183.91 with 8/10 conviction.\n\n" +
      "---\n\n## POSITION PARAMETERS\n\n" +
      "| Param | Value |\n|-------|-------|\n| Size | 3% |\n\n" +
      "Detailed analysis follows. ".repeat(200); // ~6000+ chars
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: longOutput },
    ]);
    const result = buildGraphAnnouncement(gs);

    // Text should be truncated — not contain the full output
    expect(result.text.length).toBeLessThan(longOutput.length);
    // Should contain substantive content, NOT just "---…"
    expect(result.text).toContain("INVESTMENT MEMO");
    expect(result.text).toContain("EXECUTIVE SUMMARY");
    // Should contain truncation footer
    expect(result.text).toContain("Full report available");
    expect(result.text).toContain("chars");
    // Should have buttons
    expect(result.buttons).toBeDefined();
    expect(result.buttons![0][0].callback_data).toBe("graph:report:test-graph-id");
    expect(result.buttons![0][0].text).toContain("Full Report");
  });

  it("preserves full output when exactly at threshold", () => {
    // Build output that's under 3000 chars total (output + footer)
    const shortEnough = "x".repeat(2500);
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: shortEnough },
    ]);
    const result = buildGraphAnnouncement(gs);
    expect(result.text).toContain(shortEnough);
    expect(result.buttons).toBeUndefined();
  });

  it("button callback_data includes correct graphId", () => {
    const longOutput = "Analysis ".repeat(500); // ~4500 chars
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output: longOutput },
    ]);
    gs.graphId = "custom-uuid-1234";
    const result = buildGraphAnnouncement(gs);
    expect(result.buttons![0][0].callback_data).toBe("graph:report:custom-uuid-1234");
  });

  it("uses custom maxAnnouncementChars from GraphRunState", () => {
    const output = "x".repeat(200);
    const gs = createMinimalGraphRunState([
      { nodeId: "A", output },
    ]);
    gs.maxAnnouncementChars = 100;
    const result = buildGraphAnnouncement(gs);
    // With threshold of 100, this 200-char output should be truncated
    expect(result.buttons).toBeDefined();
    expect(result.text).toContain("Full report available");
  });
});
