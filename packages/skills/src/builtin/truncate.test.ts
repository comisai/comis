// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  truncateTail,
  truncateLine,
  GREP_MAX_LINE_WIDTH,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
} from "./truncate.js";

describe("truncateTail", () => {
  it("returns content unchanged when under both limits", () => {
    const result = truncateTail("line1\nline2\nline3");
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeNull();
    expect(result.content).toBe("line1\nline2\nline3");
    expect(result.totalLines).toBe(3);
  });

  it("keeps last N lines when line limit is hit", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    const result = truncateTail(lines, { maxLines: 10, maxBytes: 1024 * 1024 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.outputLines).toBe(10);
    expect(result.content).toContain("line-99");
    expect(result.content).toContain("line-90");
    expect(result.content).not.toContain("line-89");
  });

  it("keeps last N bytes when byte limit is hit", () => {
    // Each "X" line is 1 byte + 1 newline = 2 bytes per line
    // 100 lines of "ABCDEFGHIJ" (10 bytes each + newline)
    const lines = Array.from({ length: 100 }, () => "ABCDEFGHIJ").join("\n");
    const result = truncateTail(lines, { maxLines: 10000, maxBytes: 50 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.outputBytes).toBeLessThanOrEqual(50);
    // Should contain content from the end
    expect(result.content).toContain("ABCDEFGHIJ");
  });

  it("handles empty input", () => {
    const result = truncateTail("");
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("");
    expect(result.totalLines).toBe(1); // "" splits to [""]
    expect(result.totalBytes).toBe(0);
  });

  it("handles single-line input under limits", () => {
    const result = truncateTail("hello world");
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("hello world");
    expect(result.outputLines).toBe(1);
  });

  it("handles single line exceeding byte limit (lastLinePartial)", () => {
    const longLine = "A".repeat(200);
    const result = truncateTail(longLine, { maxLines: 10000, maxBytes: 50 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.lastLinePartial).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(50);
    // Should contain content from the END of the line
    expect(result.content).toBe("A".repeat(50));
  });

  it("handles multi-byte UTF-8 without mid-character splits", () => {
    // Japanese characters are 3 bytes each in UTF-8
    const chars = "あいうえおかきくけこ"; // 10 chars = 30 bytes
    const result = truncateTail(chars, { maxLines: 10000, maxBytes: 15 });
    expect(result.truncated).toBe(true);
    // Should contain complete characters only
    const buf = Buffer.from(result.content, "utf-8");
    expect(buf.length).toBeLessThanOrEqual(15);
    // Verify it's valid UTF-8 by round-tripping
    expect(Buffer.from(result.content, "utf-8").toString("utf-8")).toBe(result.content);
  });

  it("uses default limits when no options provided", () => {
    const result = truncateTail("short");
    expect(result.maxLines).toBe(DEFAULT_MAX_LINES);
    expect(result.maxBytes).toBe(DEFAULT_MAX_BYTES);
  });

  it("returns correct totalLines and totalBytes for truncated content", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
    const result = truncateTail(lines, { maxLines: 5 });
    expect(result.totalLines).toBe(50);
    expect(result.totalBytes).toBe(Buffer.byteLength(lines, "utf-8"));
    expect(result.outputLines).toBe(5);
  });
});

describe("truncateLine", () => {
  it("returns short lines unchanged", () => {
    expect(truncateLine("short")).toBe("short");
  });

  it("returns exactly 500-char lines unchanged", () => {
    const line = "x".repeat(500);
    expect(truncateLine(line)).toBe(line);
  });

  it("truncates lines longer than 500 chars with ellipsis suffix", () => {
    const line = "x".repeat(501);
    expect(truncateLine(line)).toBe("x".repeat(500) + "\u2026 [truncated]");
  });

  it("uses custom maxChars when provided", () => {
    const line = "abcdefghij";
    expect(truncateLine(line, 5)).toBe("abcde\u2026 [truncated]");
  });

  it("exports GREP_MAX_LINE_WIDTH as 500", () => {
    expect(GREP_MAX_LINE_WIDTH).toBe(500);
  });
});

describe("formatSize", () => {
  it("formats bytes (< 1024)", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(1023)).toBe("1023B");
  });

  it("formats kilobytes (1KB - 1MB)", () => {
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(50 * 1024)).toBe("50.0KB");
    expect(formatSize(1536)).toBe("1.5KB");
  });

  it("formats megabytes (>= 1MB)", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0MB");
    expect(formatSize(2.5 * 1024 * 1024)).toBe("2.5MB");
  });
});
