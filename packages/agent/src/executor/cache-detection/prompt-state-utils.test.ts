// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for cache-detection/prompt-state-utils.ts (Phase 42 split
 * per EXEC-SPLIT-09 / EXEC-SPLIT-03).
 *
 * Covers the pure exported helpers: djb2, computeHash, sanitizeMcpToolName,
 * sanitizeMcpToolNameForAnalytics. Behavior moved from the pre-split
 * cache-break-detection.test.ts file; identical describe block contents.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  djb2,
  computeHash,
  sanitizeMcpToolName,
  sanitizeMcpToolNameForAnalytics,
} from "./prompt-state-utils.js";

// ---------------------------------------------------------------------------
// djb2 / computeHash
// ---------------------------------------------------------------------------

describe("djb2 / computeHash", () => {
  it("djb2 empty string returns 5381", () => {
    expect(djb2("")).toBe(5381);
  });

  it("djb2 hello returns consistent unsigned 32-bit integer", () => {
    const h = djb2("hello");
    expect(h).toBeTypeOf("number");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xFFFFFFFF);
    // Idempotent
    expect(djb2("hello")).toBe(h);
  });

  it("computeHash produces same hash for identical JSON", () => {
    const obj = { a: 1, b: "two" };
    expect(computeHash(obj)).toBe(computeHash({ a: 1, b: "two" }));
  });

  it("computeHash produces different hash for different JSON", () => {
    expect(computeHash({ a: 1 })).not.toBe(computeHash({ a: 2 }));
  });

  it("computeHash handles undefined without crashing", () => {
    // JSON.stringify(undefined) returns undefined (not a string).
    // computeHash must handle this gracefully.
    const h = computeHash(undefined);
    expect(h).toBeTypeOf("number");
    expect(h).toBeGreaterThanOrEqual(0);
  });

  it("computeHash handles null", () => {
    const h = computeHash(null);
    expect(h).toBeTypeOf("number");
    expect(h).not.toBe(computeHash(undefined));
  });
});

// ---------------------------------------------------------------------------
// sanitizeMcpToolName
// ---------------------------------------------------------------------------

describe("sanitizeMcpToolName", () => {
  it("collapses mcp__myserver--read_file to mcp__myserver", () => {
    expect(sanitizeMcpToolName("mcp__myserver--read_file")).toBe("mcp__myserver");
  });

  it("collapses mcp__myserver--write_file to mcp__myserver", () => {
    expect(sanitizeMcpToolName("mcp__myserver--write_file")).toBe("mcp__myserver");
  });

  it("returns regular_tool unchanged", () => {
    expect(sanitizeMcpToolName("regular_tool")).toBe("regular_tool");
  });

  it("returns mcp__server unchanged when no -- suffix", () => {
    expect(sanitizeMcpToolName("mcp__server")).toBe("mcp__server");
  });
});

// ---------------------------------------------------------------------------
// sanitizeMcpToolNameForAnalytics
// ---------------------------------------------------------------------------

describe("sanitizeMcpToolNameForAnalytics", () => {
  it("collapses mcp__myserver--sometool to 'mcp'", () => {
    expect(sanitizeMcpToolNameForAnalytics("mcp__myserver--sometool")).toBe("mcp");
  });

  it("collapses mcp__myserver (no tool suffix) to 'mcp'", () => {
    expect(sanitizeMcpToolNameForAnalytics("mcp__myserver")).toBe("mcp");
  });

  it("collapses mcp__anything to 'mcp'", () => {
    expect(sanitizeMcpToolNameForAnalytics("mcp__anything")).toBe("mcp");
  });

  it("returns non-MCP tool name unchanged (read_file)", () => {
    expect(sanitizeMcpToolNameForAnalytics("read_file")).toBe("read_file");
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeMcpToolNameForAnalytics("")).toBe("");
  });
});
