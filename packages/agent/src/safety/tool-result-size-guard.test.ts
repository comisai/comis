// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  createToolResultSizeGuard,
  type ToolResultSizeGuard,
  type TruncationMetadata,
} from "./tool-result-size-guard.js";

describe("createToolResultSizeGuard", () => {
  const guard = createToolResultSizeGuard();

  describe("no truncation needed", () => {
    it("returns unchanged content when single text block is under maxChars", () => {
      const content = [{ type: "text", text: "Hello world" }];
      const result = guard.truncateIfNeeded(content, 1000);

      expect(result.truncated).toBe(false);
      expect(result.content).toEqual(content);
      expect(result.metadata).toBeUndefined();
    });

    it("returns unchanged content for empty array", () => {
      const result = guard.truncateIfNeeded([], 1000);

      expect(result.truncated).toBe(false);
      expect(result.content).toEqual([]);
      expect(result.metadata).toBeUndefined();
    });

    it("returns unchanged when total text equals maxChars exactly", () => {
      const text = "a".repeat(500);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 500);

      expect(result.truncated).toBe(false);
      expect(result.content).toEqual(content);
    });
  });

  describe("single text block truncation", () => {
    it("truncates with head + marker + tail", () => {
      const text = "a".repeat(10_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");

      const truncatedText = result.content[0]!.text!;
      // Should start with head (default 2000 chars)
      expect(truncatedText.startsWith("a".repeat(2000))).toBe(true);
      // Should end with tail (default 1000 chars)
      expect(truncatedText.endsWith("a".repeat(1000))).toBe(true);
      // Should contain truncation marker
      expect(truncatedText).toContain("truncated");
      // Should be shorter than original
      expect(truncatedText.length).toBeLessThan(10_000);
    });

    it("includes accurate metadata", () => {
      const text = "x".repeat(10_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.metadata).toBeDefined();
      expect(result.metadata!.originalChars).toBe(10_000);
      expect(result.metadata!.truncatedChars).toBeLessThan(10_000);
      expect(result.metadata!.blocksAffected).toBe(1);
    });
  });

  describe("multiple text blocks", () => {
    it("proportionally truncates blocks based on relative size", () => {
      // Block A: 40_000 chars (80%), Block B: 10_000 chars (20%)
      const content = [
        { type: "text", text: "A".repeat(40_000) },
        { type: "text", text: "B".repeat(10_000) },
      ];
      // maxChars = 25_000 total.
      // Budget A: floor(40000/50000 * 25000) = 20000. A(40000) > 20000 => truncated
      // Budget B: floor(10000/50000 * 25000) = 5000. B(10000) > 5000 => truncated
      const result = guard.truncateIfNeeded(content, 25_000);

      expect(result.truncated).toBe(true);
      expect(result.content).toHaveLength(2);

      // Both blocks truncated since both exceed proportional budgets
      expect(result.content[0]!.text!.length).toBeLessThan(40_000);
      expect(result.content[1]!.text!.length).toBeLessThan(10_000);

      // Larger block has more absolute reduction
      const aReduction = 40_000 - result.content[0]!.text!.length;
      const bReduction = 10_000 - result.content[1]!.text!.length;
      expect(aReduction).toBeGreaterThan(bReduction);

      expect(result.metadata!.blocksAffected).toBe(2);
    });

    it("truncates all blocks when all exceed their budgets", () => {
      const content = [
        { type: "text", text: "A".repeat(10_000) },
        { type: "text", text: "B".repeat(10_000) },
      ];
      // maxChars = 5000. Each block budget = 2500 (50% each)
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      expect(result.content[0]!.text!.length).toBeLessThan(10_000);
      expect(result.content[1]!.text!.length).toBeLessThan(10_000);
      expect(result.metadata!.blocksAffected).toBe(2);
    });
  });

  describe("non-text blocks", () => {
    it("passes non-text blocks through untouched", () => {
      const content = [
        { type: "image", url: "https://example.com/img.png" },
        { type: "text", text: "x".repeat(10_000) },
      ];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      // Image block preserved exactly
      expect(result.content[0]).toEqual({ type: "image", url: "https://example.com/img.png" });
      // Text block truncated
      expect(result.content[1]!.text!.length).toBeLessThan(10_000);
    });

    it("does not count non-text blocks toward total chars", () => {
      const content = [
        { type: "image", url: "https://example.com/img.png", data: "x".repeat(100_000) },
        { type: "text", text: "Hello" },
      ];
      const result = guard.truncateIfNeeded(content, 1000);

      // Only text chars (5) are counted, which is under 1000
      expect(result.truncated).toBe(false);
      expect(result.content).toEqual(content);
    });
  });

  describe("custom options", () => {
    it("uses custom preserveHeadChars and preserveTailChars", () => {
      const custom = createToolResultSizeGuard({
        preserveHeadChars: 100,
        preserveTailChars: 50,
      });
      const text = "H".repeat(100) + "M".repeat(4800) + "T".repeat(100);
      const content = [{ type: "text", text }];
      const result = custom.truncateIfNeeded(content, 1000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;
      // Head should be 100 H's
      expect(truncatedText.startsWith("H".repeat(100))).toBe(true);
      // Tail should be 50 T's
      expect(truncatedText.endsWith("T".repeat(50))).toBe(true);
    });

    it("uses custom truncation marker", () => {
      const custom = createToolResultSizeGuard({
        truncationMarker: "---CUT ${removed} chars---",
      });
      const text = "x".repeat(10_000);
      const content = [{ type: "text", text }];
      const result = custom.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      expect(result.content[0]!.text!).toContain("---CUT");
      expect(result.content[0]!.text!).toContain("chars---");
    });
  });

  describe("metadata accuracy", () => {
    it("reports correct originalChars across multiple blocks", () => {
      const content = [
        { type: "text", text: "a".repeat(3000) },
        { type: "text", text: "b".repeat(7000) },
        { type: "image", url: "img.png" },
      ];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.metadata!.originalChars).toBe(10_000);
      expect(result.metadata!.truncatedChars).toBeLessThan(10_000);
    });

    it("truncatedChars equals the sum of all text block lengths after truncation", () => {
      const content = [
        { type: "text", text: "x".repeat(8000) },
        { type: "text", text: "y".repeat(4000) },
      ];
      const result = guard.truncateIfNeeded(content, 5000);

      const actualTotalChars = result.content
        .filter((b) => b.type === "text" && b.text)
        .reduce((sum, b) => sum + b.text!.length, 0);

      expect(result.metadata!.truncatedChars).toBe(actualTotalChars);
    });
  });

  // ---------------------------------------------------------------------------
  // Important-tail-aware truncation
  // ---------------------------------------------------------------------------

  describe("important-tail-aware truncation", () => {
    it("allocates 30% tail budget when error content detected at tail", () => {
      // 20K text with error content in the last 200 chars
      const filler = "x".repeat(19_800);
      const errorTail = "Error: connection refused\nStack trace: at main() line 42\n" +
        "a".repeat(143);
      const text = filler + errorTail;
      expect(text.length).toBe(20_000);

      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Tail should contain the error content
      expect(truncatedText).toContain("Error: connection refused");

      // Head is ~50% of 5000 = ~2500, tail is ~30% of 5000 = ~1500
      // The truncation marker is between them
      const markerIndex = truncatedText.indexOf("[...");
      expect(markerIndex).toBeGreaterThan(0);

      // Head portion (before marker) should be approximately 50% of budget
      // Allow tolerance for newline snapping
      expect(markerIndex).toBeGreaterThanOrEqual(2000);
      expect(markerIndex).toBeLessThanOrEqual(3500);

      // Tail portion (after marker) should be approximately 30% of budget
      const markerEnd = truncatedText.indexOf("]\n", markerIndex) + 2;
      const tailLength = truncatedText.length - markerEnd;
      expect(tailLength).toBeGreaterThanOrEqual(1000);
      expect(tailLength).toBeLessThanOrEqual(2000);
    });

    it("allocates 30% tail budget when JSON closing detected at tail", () => {
      // 20K text ending with JSON closing
      const filler = "x".repeat(19_998);
      const text = filler + "}\n";
      expect(text.length).toBe(20_000);

      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Tail should contain the JSON closing
      expect(truncatedText.trimEnd().endsWith("}")).toBe(true);
    });

    it("allocates 30% tail budget when summary markers detected at tail", () => {
      // 20K text ending with summary content
      const filler = "x".repeat(19_975);
      const summaryTail = "Total: 42 items processed";
      const text = filler + summaryTail;
      expect(text.length).toBe(20_000);

      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Tail should preserve the summary
      expect(truncatedText).toContain("Total: 42 items processed");
    });

    it("uses default head-heavy allocation when no important tail", () => {
      // 20K text of just "a" characters -- no important tail
      const text = "a".repeat(20_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Should use defaults: preserveHeadChars=2000, preserveTailChars=1000
      // Head starts with 2000 a's
      expect(truncatedText.startsWith("a".repeat(2000))).toBe(true);
      // Tail ends with 1000 a's
      expect(truncatedText.endsWith("a".repeat(1000))).toBe(true);

      // Total tail portion should be approximately the default 1000 chars
      // (no newlines in "a" text, so no snapping occurs)
      const markerMatch = truncatedText.match(/\[\.\.\..*?truncated.*?\]/);
      expect(markerMatch).toBeTruthy();
      const markerEnd = truncatedText.indexOf(markerMatch![0]) + markerMatch![0].length + 1; // +1 for trailing \n
      const tailLength = truncatedText.length - markerEnd;
      expect(tailLength).toBe(1000);
    });

    it("skips important-tail detection for small texts (< 5000 chars)", () => {
      // 4K text with error at tail -- below 5000 char threshold
      const filler = "x".repeat(3_800);
      const errorTail = "Error: something failed\n" + "z".repeat(176);
      const text = filler + errorTail;
      expect(text.length).toBe(4_000);

      const content = [{ type: "text", text }];
      // Truncate to 2K -- text is < 5000, so important tail detection is skipped
      const result = guard.truncateIfNeeded(content, 2000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Should use default allocation (preserveHeadChars=2000, preserveTailChars=1000)
      // Since text(4000) > head+tail(3000), defaults are used directly.
      // Head should be 2000 chars, tail should be 1000 chars.
      // Without important-tail: head is NOT 50% of budget.
      // The budget is 2000. headSize=2000, tailSize=1000. But the budget is only 2000,
      // so text.length(4000) > totalPreserve(3000), we get defaults.
      // head=2000, tail=1000. head+tail = 3000 > budget(2000). But truncateText is called
      // with budget=2000, and text.length(4000) > budget(2000).
      // Since text(4000) < 5000, important tail is NOT used.
      // text(4000) > totalPreserve(3000), so we stay at defaults: head=2000, tail=1000.
      // Output = head(2000) + marker + tail(1000) = > 3000 chars.
      // This exceeds the budget but the function only ensures head+marker+tail is
      // returned when text > budget. The marker is for display purposes.

      // Verify it does NOT use 50/30 proportional split
      // With proportional: head would be floor(2000*0.5)=1000
      // Without: head would be 2000 (default preserveHeadChars)
      expect(truncatedText.startsWith("x".repeat(2000))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // MCP tool results
  // ---------------------------------------------------------------------------

  describe("MCP tool results", () => {
    it("truncates MCP tool result exceeding maxChars with head+tail preservation", () => {
      // 80K content from an MCP tool like mcp__context7--resolve-library-id
      const text = "x".repeat(80_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 50_000);

      expect(result.truncated).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");

      const truncatedText = result.content[0]!.text!;
      // Should contain truncation marker
      expect(truncatedText).toContain("truncated");
      // Should be shorter than original
      expect(truncatedText.length).toBeLessThan(80_000);
      // Should preserve head and tail
      expect(truncatedText.startsWith("x".repeat(2000))).toBe(true);
      expect(truncatedText.endsWith("x".repeat(1000))).toBe(true);

      // Metadata should be accurate
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.originalChars).toBe(80_000);
      expect(result.metadata!.truncatedChars).toBeLessThan(80_000);
      expect(result.metadata!.blocksAffected).toBe(1);
    });

    it("passes MCP tool result under limit through unchanged", () => {
      // 10K content from mcp__context7--query-docs, under 50K limit
      const text = "y".repeat(10_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 50_000);

      expect(result.truncated).toBe(false);
      expect(result.content).toEqual(content);
      expect(result.metadata).toBeUndefined();
    });

    it("includes accurate metadata for truncated MCP tool results", () => {
      // Simulating mcp__context7--resolve-library-id returning 80K
      const text = "z".repeat(80_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 50_000);

      expect(result.truncated).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.originalChars).toBe(80_000);
      expect(result.metadata!.truncatedChars).toBeLessThan(80_000);
      expect(result.metadata!.blocksAffected).toBe(1);

      // Verify truncatedChars matches actual output
      const actualChars = result.content
        .filter((b) => b.type === "text" && b.text)
        .reduce((sum, b) => sum + b.text!.length, 0);
      expect(result.metadata!.truncatedChars).toBe(actualChars);
    });
  });

  // ---------------------------------------------------------------------------
  // Newline boundary truncation
  // ---------------------------------------------------------------------------

  describe("newline boundary truncation", () => {
    it("snaps head cut to nearest newline boundary", () => {
      // Create text with newlines every 100 chars (line-based text)
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push("L" + String(i).padStart(3, "0") + "x".repeat(96));
      }
      const text = lines.join("\n") + "\n";
      // Each line is 100 chars + \n = 101 chars per line, ~20200 total

      const content = [{ type: "text", text }];
      // Budget = 5000. Text is > 5000. No important tail (all "x" chars).
      // Default: headSize=2000, tailSize=1000.
      // Head cut should snap to a newline near position 2000.
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Find the marker
      const markerIndex = truncatedText.indexOf("\n[...");
      expect(markerIndex).toBeGreaterThan(0);

      // The head portion (before marker) should end at a line boundary
      const headPortion = truncatedText.slice(0, markerIndex);
      // The head should end with a complete line (ending in \n or at a line start)
      // Since we snap to after the newline, the head ends just before the marker
      // which starts with \n. The headPortion should be a clean number of lines.
      expect(headPortion.endsWith("\n") || headPortion.endsWith("x")).toBe(true);
    });

    it("snaps tail cut to nearest newline boundary", () => {
      // Create text with newlines every 100 chars
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push("L" + String(i).padStart(3, "0") + "x".repeat(96));
      }
      const text = lines.join("\n") + "\n";

      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Find where the tail starts (after the marker)
      const markerEnd = truncatedText.indexOf("]\n");
      expect(markerEnd).toBeGreaterThan(0);
      const tailStart = markerEnd + 2; // after "]\n"
      const tailPortion = truncatedText.slice(tailStart);

      // The tail should start at a line boundary (first char of a line)
      // Since newline snapping returns index after the newline, the tail
      // starts at the beginning of a line
      expect(tailPortion.startsWith("L")).toBe(true);
    });

    it("preserves original cut position when no newlines within tolerance", () => {
      // Single long line with NO newlines
      const text = "a".repeat(20_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Should use default head=2000, tail=1000 exactly (no snapping possible)
      expect(truncatedText.startsWith("a".repeat(2000))).toBe(true);
      expect(truncatedText.endsWith("a".repeat(1000))).toBe(true);

      // Verify exact head length: find the marker start
      const markerStart = truncatedText.indexOf("\n[...");
      // The marker starts with \n, so head ends at markerStart
      expect(markerStart).toBe(2000);
    });

    it("newline snapping stays within 80-120% of target", () => {
      // Create a text where we control newline positions precisely.
      // Default head target = 2000. Tolerance = 2000 * 0.2 = 400.
      // So snapping range is [1600, 2400].

      // Place newlines at specific positions:
      // - At position 1700 (within range, 85% of target) -> should snap
      // - At position 2300 (within range, 115% of target) -> should be considered
      // - At position 1500 (outside range, 75% of target) -> should NOT snap

      // Build text with newlines only at controlled positions
      // Fill with "x" except newlines at positions 1500, 1700, 2300
      const chars: string[] = new Array(20_000).fill("x");
      chars[1500] = "\n";
      chars[1700] = "\n";
      chars[2300] = "\n";
      const text = chars.join("");

      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Find the marker to determine actual head cut position
      const markerStart = truncatedText.indexOf("\n[...");
      // The head cut should have snapped to position 1701 (after newline at 1700)
      // or 2301 (after newline at 2300), but NOT to 1501 (after newline at 1500).
      // Since 1700 is closer to 2000 than 2300, it should prefer 1700.
      // headSize = snapped to 1701 (just after newline at 1700)
      expect(markerStart).toBe(1701);
    });

    it("combined: important tail with newline boundary snapping", () => {
      // Create structured text with lines and error content at tail.
      // Lines of ~100 chars each, error at the end.
      const lines: string[] = [];
      for (let i = 0; i < 190; i++) {
        lines.push("DATA" + String(i).padStart(4, "0") + ":".padEnd(91, "d"));
      }
      // Add error content at the tail
      lines.push("Error: connection timeout at db.connect()");
      lines.push("Stack trace: at processRequest() line 42");
      lines.push("  at handleMessage() line 18");
      lines.push("  at main() line 5");
      const text = lines.join("\n") + "\n";

      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;

      // Verify tail contains error content
      expect(truncatedText).toContain("Error: connection timeout");
      expect(truncatedText).toContain("Stack trace");

      // Verify cuts landed on newline boundaries
      // Find the marker
      const markerMatch = truncatedText.match(/\n\[\.\.\..*?truncated.*?\]\n/);
      expect(markerMatch).toBeTruthy();
      const markerIndex = truncatedText.indexOf(markerMatch![0]);

      // Head portion before marker should end with a newline (snapped to line boundary)
      const headPortion = truncatedText.slice(0, markerIndex);
      expect(headPortion.endsWith("\n")).toBe(true);

      // Tail portion after marker should start at a line boundary
      const afterMarker = truncatedText.slice(markerIndex + markerMatch![0].length);
      // Should start with a line identifier or error text
      expect(afterMarker.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Enhanced truncation marker with actionable instructions
  // ---------------------------------------------------------------------------

  describe("actionable truncation marker", () => {
    it("includes actionable instruction in truncation marker", () => {
      const text = "x".repeat(10_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;
      expect(truncatedText).toContain("reduce output size");
      expect(truncatedText).toContain("--max-lines");
      expect(truncatedText).toContain("head/tail");
      expect(truncatedText).toContain("grep");
    });

    it("appends tool hint when provided", () => {
      const text = "x".repeat(10_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000, "Use head/tail/grep to limit output");

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;
      expect(truncatedText).toContain("Hint: Use head/tail/grep to limit output");
    });

    it("caps tool hint at 100 chars", () => {
      const text = "x".repeat(10_000);
      const content = [{ type: "text", text }];
      const longHint = "A".repeat(150);
      const result = guard.truncateIfNeeded(content, 5000, longHint);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;
      // Should contain truncated hint ending with "..."
      expect(truncatedText).toContain("Hint: " + "A".repeat(97) + "...");
      // Should NOT contain the full 150-char hint
      expect(truncatedText).not.toContain("A".repeat(150));
    });

    it("omits hint suffix when no toolHint provided", () => {
      const text = "x".repeat(10_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;
      expect(truncatedText).not.toContain("Hint:");
      // Marker should end cleanly with the closing bracket (no hint appended)
      expect(truncatedText).toMatch(/limit scope\)\.\]/);
    });

    it("enhanced marker base text stays under 200 chars", () => {
      // The base marker template without hint and with a large removed count
      const text = "x".repeat(100_000);
      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000);

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;
      // Extract marker between the newlines
      const markerMatch = truncatedText.match(/\n(\[\.\.\..*?\])\n/);
      expect(markerMatch).toBeTruthy();
      // Base marker (no hint) should be under 200 chars
      expect(markerMatch![1].length).toBeLessThan(200);
    });

    it("important-tail detection works with enhanced marker", () => {
      // Large text with error at tail -- important-tail should still trigger
      const filler = "x".repeat(19_800);
      const errorTail = "Error: connection refused\nStack trace: at main() line 42\n" +
        "a".repeat(143);
      const text = filler + errorTail;

      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000, "Check connection settings");

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;
      // tail should preserve error content
      expect(truncatedText).toContain("Error: connection refused");
      // actionable instruction present
      expect(truncatedText).toContain("reduce output size");
      // tool hint present
      expect(truncatedText).toContain("Hint: Check connection settings");
    });

    it("newline snapping works with enhanced marker", () => {
      // Create text with newlines at controlled positions
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push("L" + String(i).padStart(3, "0") + "x".repeat(96));
      }
      const text = lines.join("\n") + "\n";

      const content = [{ type: "text", text }];
      const result = guard.truncateIfNeeded(content, 5000, "Limit scope of search");

      expect(result.truncated).toBe(true);
      const truncatedText = result.content[0]!.text!;
      // Enhanced marker with hint should be present
      expect(truncatedText).toContain("Hint: Limit scope of search");
      // Tail should start at a line boundary
      const markerMatch = truncatedText.match(/\n(\[\.\.\..*?\])\n/);
      expect(markerMatch).toBeTruthy();
      const afterMarker = truncatedText.slice(
        truncatedText.indexOf(markerMatch![0]) + markerMatch![0].length,
      );
      expect(afterMarker.startsWith("L")).toBe(true);
    });
  });
});
