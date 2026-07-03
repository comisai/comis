// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for suggestClosestTool (live incident 2026-06-12) — the small-model
 * tool-name-hallucination recovery hint.
 * @module
 */

import { describe, it, expect } from "vitest";
import { suggestClosestTool } from "./tool-name-suggest.js";

const REAL = ["memory_manage", "memory_search", "memory_ask", "skills_manage", "web_search", "file_write", "exec"];

describe("suggestClosestTool — recover a hallucinated tool name to the closest real one", () => {
  it("maps an mcp__-prefixed builtin guess to the real builtin (the live case)", () => {
    // qwen3.6 emitted this for the builtin memory_manage, mimicking mcp__yfinance--*
    expect(suggestClosestTool("mcp__memory_manage--delete", REAL)).toBe("memory_manage");
  });

  it("strips a bare --verb suffix", () => {
    expect(suggestClosestTool("memory_manage--delete", REAL)).toBe("memory_manage");
  });

  it("strips a bare mcp__ prefix", () => {
    expect(suggestClosestTool("mcp__skills_manage", REAL)).toBe("skills_manage");
  });

  it("matches when a real tool name is contained in the guess", () => {
    expect(suggestClosestTool("call_memory_search_tool", REAL)).toBe("memory_search");
  });

  it("recovers a close typo via token overlap", () => {
    expect(suggestClosestTool("memory_serch", REAL)).toBe("memory_search");
  });

  it("returns undefined when nothing is close enough (no false suggestion)", () => {
    expect(suggestClosestTool("launch_rockets", REAL)).toBeUndefined();
  });

  it("returns undefined on an empty tool list", () => {
    expect(suggestClosestTool("mcp__memory_manage--delete", [])).toBeUndefined();
  });

  it("does not suggest the missing name itself", () => {
    // even if asked, never echo the (non-existent) missing name back
    expect(suggestClosestTool("totally_unknown", REAL)).toBeUndefined();
  });
});
