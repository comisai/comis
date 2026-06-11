// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for toolDefOverheadChars — the shared tool-schema char-overhead reduce
 * (FLOOR-01 / I8 extraction from executor-tool-assembly.ts).
 *
 * The function is ALSO identity-pinned from viable-floor.test.ts (FLOOR-01-13);
 * this co-located neighbor pins the arithmetic directly (coverage-gate
 * file-neighbor invariant for packages/agent/src/executor/).
 */
import { describe, it, expect } from "vitest";
import { toolDefOverheadChars } from "./tool-overhead.js";

describe("toolDefOverheadChars", () => {
  it("sums name + description + JSON.stringify(parameters) lengths across the toolset", () => {
    // "alpha"(5) + 100 + '{"type":"object"}'(17) = 122; "beta"(4) + 50 + 0 = 54 → 176
    const total = toolDefOverheadChars([
      { name: "alpha", description: "x".repeat(100), parameters: { type: "object" } },
      { name: "beta", description: "y".repeat(50) },
    ]);
    expect(total).toBe(176);
  });

  it("treats missing name/description/parameters as zero-length contributions", () => {
    expect(toolDefOverheadChars([{ name: "solo" }])).toBe(4);
    expect(toolDefOverheadChars([{}])).toBe(0);
  });

  it("returns zero for an empty toolset (no tools, no overhead)", () => {
    expect(toolDefOverheadChars([])).toBe(0);
  });
});
