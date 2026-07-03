// SPDX-License-Identifier: Apache-2.0
/**
 * Pure-function tests for cache-breakpoints.ts + cache-control-block.ts.
 *
 * Hosts describes that test the public surface without invoking
 * createRequestBodyInjector:
 *
 *  - getMinCacheableTokens (cache-breakpoints.ts)
 *  - CACHEABLE_BLOCK_TYPES (cache-control-block.ts re-export)
 *  - addCacheControlToLastBlock (cache-control-block.ts re-export)
 *  - resolveCacheRetention (cache-breakpoints.ts) -- per-model retention overrides
 *  - sortToolsForCacheStability (cache-breakpoints.ts)
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  CACHEABLE_BLOCK_TYPES,
  addCacheControlToLastBlock,
  getMinCacheableTokens,
  resolveCacheRetention,
  sortToolsForCacheStability,
} from "./index.js";
import { maybePromoteBreakpoints } from "./cache-breakpoints.js";

describe("maybePromoteBreakpoints — non-Anthropic body (codex turn-abort regression)", () => {
  // The openai-codex (OpenAI responses) request body has `input`, not a
  // `messages` array, so result.messages is undefined at the call site
  // (factory.ts: the maybePromoteBreakpoints call lacked the Array.isArray
  // guard the sibling cache ops have). Promotion of cache_control breakpoints is
  // Anthropic-only, so this must no-op rather than throw `reading 'length'` in
  // the provider's onPayload hook — which aborts the whole turn ("AI didn't
  // produce a response").
  it("returns 0 without throwing when messages is undefined", () => {
    type Args = Parameters<typeof maybePromoteBreakpoints>;
    const call = () =>
      maybePromoteBreakpoints(
        undefined as unknown as Args[0],
        undefined as unknown as Args[1],
        "sk",
        3,
        "long",
      );
    expect(call).not.toThrow();
    expect(call()).toBe(0);
  });
});

describe("getMinCacheableTokens", () => {
  it("resolves known model prefixes correctly", () => {
    expect(getMinCacheableTokens("claude-opus-4-6-20260301")).toBe(4096);
    expect(getMinCacheableTokens("claude-opus-4-5-20250929")).toBe(4096);
    expect(getMinCacheableTokens("claude-opus-4-1-20260315")).toBe(1024);
    expect(getMinCacheableTokens("claude-opus-4-20260101")).toBe(1024);
    expect(getMinCacheableTokens("claude-sonnet-4-6-20260301")).toBe(2048);
    expect(getMinCacheableTokens("claude-sonnet-4-5-20250929")).toBe(1024);
    expect(getMinCacheableTokens("claude-sonnet-4-20250514")).toBe(1024);
    expect(getMinCacheableTokens("claude-haiku-4-5-20250929")).toBe(4096);
    expect(getMinCacheableTokens("claude-haiku-3-5-20240620")).toBe(2048);
  });

  it("matches longest prefix first (opus-4-6 before opus-4-)", () => {
    // opus-4-6 and opus-4-5 must match their specific entries (4096), not the catch-all opus-4- (1024)
    expect(getMinCacheableTokens("claude-opus-4-6-20260301")).toBe(4096);
    expect(getMinCacheableTokens("claude-opus-4-5-20250929")).toBe(4096);
    // sonnet-4-5 must match its specific entry (1024), not the catch-all sonnet-4- (also 1024 here, but tests prefix priority)
    expect(getMinCacheableTokens("claude-sonnet-4-5-20250929")).toBe(1024);
  });

  it("falls back to DEFAULT_MIN_CACHEABLE_TOKENS for unknown models", () => {
    expect(getMinCacheableTokens("gpt-4-turbo")).toBe(1024);
    expect(getMinCacheableTokens("unknown-model")).toBe(1024);
  });
});

describe("CACHEABLE_BLOCK_TYPES", () => {
  it("includes text, tool_use, tool_result, image", () => {
    expect(CACHEABLE_BLOCK_TYPES.has("text")).toBe(true);
    expect(CACHEABLE_BLOCK_TYPES.has("tool_use")).toBe(true);
    expect(CACHEABLE_BLOCK_TYPES.has("tool_result")).toBe(true);
    expect(CACHEABLE_BLOCK_TYPES.has("image")).toBe(true);
  });

  it("does NOT include thinking or redacted_thinking", () => {
    expect(CACHEABLE_BLOCK_TYPES.has("thinking")).toBe(false);
    expect(CACHEABLE_BLOCK_TYPES.has("redacted_thinking")).toBe(false);
  });
});

describe("addCacheControlToLastBlock thinking exclusion", () => {
  it("skips thinking block and places cache_control on preceding text block", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "internal reasoning" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(content[1].cache_control).toBeUndefined();
  });

  it("skips redacted_thinking block and places cache_control on preceding text block", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "redacted_thinking", data: "encrypted" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(content[1].cache_control).toBeUndefined();
  });

  it("places cache_control on cacheable block types as normal (text regression)", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "last" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("places cache_control on tool_use block (regression)", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "tu1", name: "bash", input: {} },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("places cache_control on tool_result block (regression)", () => {
    const message: Record<string, unknown> = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "output" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("places cache_control on image block (regression)", () => {
    const message: Record<string, unknown> = {
      role: "user",
      content: [
        { type: "text", text: "See image:" },
        { type: "image", source: { type: "base64", data: "..." } },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("falls back to last block when only block is thinking (edge case)", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal" },
      ],
    };
    addCacheControlToLastBlock(message);
    const content = message.content as Record<string, unknown>[];
    // Fallback: place on last block even though it's thinking
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("respects long retention with ttl='1h'", () => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "reasoning" },
      ],
    };
    addCacheControlToLastBlock(message, "long" as any);
    const content = message.content as Record<string, unknown>[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(content[1].cache_control).toBeUndefined();
  });

  it("no-ops on empty content array", () => {
    const message: Record<string, unknown> = { role: "assistant", content: [] };
    addCacheControlToLastBlock(message);
    expect((message.content as unknown[]).length).toBe(0);
  });

  it("no-ops on non-array content", () => {
    const message: Record<string, unknown> = { role: "assistant", content: "plain text" };
    addCacheControlToLastBlock(message);
    expect(message.content).toBe("plain text");
  });
});

describe("per-model cache retention override (resolveCacheRetention)", () => {
  it("returns override when model matches prefix", () => {
    const result = resolveCacheRetention("claude-sonnet-4-6-20260301", "long", { "claude-sonnet": "none" });
    expect(result).toBe("none");
  });

  it("uses longest-prefix-first: claude-sonnet-4-6 matches before claude-sonnet", () => {
    const overrides = {
      "claude-sonnet": "none" as const,
      "claude-sonnet-4-6": "short" as const,
    };
    const result = resolveCacheRetention("claude-sonnet-4-6-20260301", "long", overrides);
    expect(result).toBe("short");
  });

  it("returns agent-level retention when no override matches", () => {
    const result = resolveCacheRetention("gpt-4o", "long", { "claude-sonnet": "none" });
    expect(result).toBe("long");
  });

  it("returns agent-level retention when overrides is undefined", () => {
    const result = resolveCacheRetention("claude-sonnet-4-6", "long", undefined);
    expect(result).toBe("long");
  });

  it("returns agent-level retention when overrides is empty object", () => {
    const result = resolveCacheRetention("claude-sonnet-4-6", "short", {});
    expect(result).toBe("short");
  });
});

describe("sortToolsForCacheStability", () => {
  it("places built-in tools before MCP tools in mixed input", () => {
    const input = [
      { name: "read" },
      { name: "mcp__z_tool" },
      { name: "write" },
      { name: "mcp:a_tool" },
      { name: "mcp__m_tool" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    const names = result.map(t => t.name);
    // Built-in tools come first in original order
    expect(names[0]).toBe("read");
    expect(names[1]).toBe("write");
    // MCP tools come after, sorted alphabetically by localeCompare
    const mcpNames = names.slice(2);
    expect(mcpNames).toEqual([...mcpNames].sort((a, b) => (a as string).localeCompare(b as string)));
    expect(mcpNames).toContain("mcp:a_tool");
    expect(mcpNames).toContain("mcp__m_tool");
    expect(mcpNames).toContain("mcp__z_tool");
  });

  it("sorts MCP tools alphabetically among themselves", () => {
    const input = [
      { name: "mcp__zebra" },
      { name: "mcp:alpha" },
      { name: "mcp__middle" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    const names = result.map(t => t.name);
    // All MCP -- sorted alphabetically by localeCompare
    expect(names).toEqual([...names].sort((a, b) => (a as string).localeCompare(b as string)));
    expect(names.length).toBe(3);
  });

  it("preserves built-in tool relative order (not re-sorted)", () => {
    const input = [
      { name: "write" },
      { name: "bash" },
      { name: "read" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    expect(result.map(t => t.name)).toEqual(["write", "bash", "read"]);
  });

  it("returns empty array for empty input", () => {
    const result = sortToolsForCacheStability([]);
    expect(result).toEqual([]);
  });

  it("returns same order for all built-in tools", () => {
    const input = [
      { name: "read" },
      { name: "write" },
      { name: "bash" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    expect(result.map(t => t.name)).toEqual(["read", "write", "bash"]);
  });

  it("excludes server-side tools from sorting and places them at end", () => {
    const input = [
      { name: "read" },
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      { name: "mcp:foo" },
    ];
    const result = sortToolsForCacheStability(input as Array<Record<string, unknown>>);
    expect(result.map(t => t.name)).toEqual([
      "read",
      "mcp:foo",
      "tool_search_tool_regex",
    ]);
  });
});
