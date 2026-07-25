// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  economiseChildPrompt,
  economiseForReadOnlyChild,
  isReadOnlyChild,
} from "./child-prompt-economy.js";

describe("child prompt economy", () => {
  it("classifies a child from structured read-only tool metadata", () => {
    expect(isReadOnlyChild(["mcp__example__lookup"])).toBe(true);
    expect(isReadOnlyChild(["mcp__example__lookup", "write"])).toBe(false);
    expect(isReadOnlyChild(["unknown_tool"])).toBe(false);
  });

  it("accepts an explicit read-only role only without mutating tools", () => {
    expect(isReadOnlyChild([], "read-only")).toBe(true);
    expect(isReadOnlyChild(["write"], "read-only")).toBe(false);
  });

  it("does not parse rendered prompt headings to recover compiler state", () => {
    const prompt = "kernel\n\n---\n\n## Arbitrary operator heading";
    expect(economiseChildPrompt(prompt)).toBe(prompt);
  });

  it("preserves compiled string and cache blocks byte-for-byte", () => {
    const blocks = {
      staticPrefix: "kernel",
      attribution: "operator",
      semiStableBody: "runtime",
    };
    expect(economiseForReadOnlyChild("compiled", blocks, ["read"])).toEqual({
      systemPrompt: "compiled",
      systemPromptBlocks: blocks,
    });
  });
});
