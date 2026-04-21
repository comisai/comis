// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  MIN_CACHEABLE_TOKENS,
  DEFAULT_MIN_CACHEABLE_TOKENS,
  resolveToolMaskingTier,
  TOOL_MASKING_TIERS,
  EPHEMERAL_TOOL_KEEP_WINDOW,
} from "./constants.js";

describe("MIN_CACHEABLE_TOKENS", () => {
  it("claude-haiku-3 minimum is 2048 (Anthropic API docs)", () => {
    expect(MIN_CACHEABLE_TOKENS["claude-haiku-3"]).toBe(2048);
  });

  it("claude-haiku-3-5 minimum is 2048", () => {
    expect(MIN_CACHEABLE_TOKENS["claude-haiku-3-5"]).toBe(2048);
  });

  it("claude-haiku-4-5 minimum is 4096", () => {
    expect(MIN_CACHEABLE_TOKENS["claude-haiku-4-5"]).toBe(4096);
  });

  it("all known model families have entries", () => {
    const expectedFamilies = [
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-opus-4-",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4-",
      "claude-sonnet-3-7",
      "claude-haiku-4-5",
      "claude-haiku-3-5",
      "claude-haiku-3",
    ];

    for (const family of expectedFamilies) {
      expect(MIN_CACHEABLE_TOKENS).toHaveProperty(family);
      expect(typeof MIN_CACHEABLE_TOKENS[family]).toBe("number");
      expect(MIN_CACHEABLE_TOKENS[family]).toBeGreaterThan(0);
    }
  });

  it("DEFAULT_MIN_CACHEABLE_TOKENS is a reasonable fallback", () => {
    expect(DEFAULT_MIN_CACHEABLE_TOKENS).toBe(1024);
  });
});

// ---------------------------------------------------------------------------
// Tool Masking Tiers
// ---------------------------------------------------------------------------

describe("resolveToolMaskingTier", () => {
  // Protected tier tools
  it("returns 'protected' for memory_search", () => {
    expect(resolveToolMaskingTier("memory_search")).toBe("protected");
  });

  it("returns 'protected' for memory_get", () => {
    expect(resolveToolMaskingTier("memory_get")).toBe("protected");
  });

  it("returns 'protected' for memory_store", () => {
    expect(resolveToolMaskingTier("memory_store")).toBe("protected");
  });

  it("returns 'protected' for read (file read tool)", () => {
    expect(resolveToolMaskingTier("read")).toBe("protected");
  });

  it("returns 'protected' for file_read (legacy alias)", () => {
    expect(resolveToolMaskingTier("file_read")).toBe("protected");
  });

  it("returns 'protected' for session_search", () => {
    expect(resolveToolMaskingTier("session_search")).toBe("protected");
  });

  // Ephemeral tier tools
  it("returns 'ephemeral' for web_search", () => {
    expect(resolveToolMaskingTier("web_search")).toBe("ephemeral");
  });

  it("returns 'ephemeral' for brave_search", () => {
    expect(resolveToolMaskingTier("brave_search")).toBe("ephemeral");
  });

  it("returns 'ephemeral' for web_fetch", () => {
    expect(resolveToolMaskingTier("web_fetch")).toBe("ephemeral");
  });

  it("returns 'ephemeral' for link_reader", () => {
    expect(resolveToolMaskingTier("link_reader")).toBe("ephemeral");
  });

  it("returns 'ephemeral' for fetch_url", () => {
    expect(resolveToolMaskingTier("fetch_url")).toBe("ephemeral");
  });

  // Standard tier (default fallback)
  it("returns 'standard' for bash (unknown tool)", () => {
    expect(resolveToolMaskingTier("bash")).toBe("standard");
  });

  it("returns 'standard' for unknown_tool", () => {
    expect(resolveToolMaskingTier("unknown_tool")).toBe("standard");
  });

  it("returns 'ephemeral' for MCP tools (mcp__server__tool)", () => {
    expect(resolveToolMaskingTier("mcp__server__tool")).toBe("ephemeral");
  });

  it("returns 'ephemeral' for MCP tools (mcp:server:tool)", () => {
    expect(resolveToolMaskingTier("mcp:server:tool")).toBe("ephemeral");
  });

  it("returns 'standard' for empty string", () => {
    expect(resolveToolMaskingTier("")).toBe("standard");
  });
});

describe("TOOL_MASKING_TIERS", () => {
  it("has exactly 11 entries (6 protected + 5 ephemeral)", () => {
    expect(TOOL_MASKING_TIERS.size).toBe(11);
  });

  it("contains 6 protected-tier entries (read + file_read legacy alias)", () => {
    const protectedEntries = [...TOOL_MASKING_TIERS.entries()].filter(
      ([, tier]) => tier === "protected",
    );
    expect(protectedEntries).toHaveLength(6);
  });

  it("contains 5 ephemeral-tier entries", () => {
    const ephemeralEntries = [...TOOL_MASKING_TIERS.entries()].filter(
      ([, tier]) => tier === "ephemeral",
    );
    expect(ephemeralEntries).toHaveLength(5);
  });
});

describe("EPHEMERAL_TOOL_KEEP_WINDOW", () => {
  it("equals 10", () => {
    expect(EPHEMERAL_TOOL_KEEP_WINDOW).toBe(10);
  });
});

