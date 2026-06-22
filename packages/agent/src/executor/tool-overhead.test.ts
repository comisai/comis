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
import { toolDefOverheadChars, DEFERRAL_STUB_MARKER_KEY } from "./tool-overhead.js";

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

  // ROOT-CAUSE context-exhaustion fix (2026-06-22 VPS gpt-5.3-codex): auto-discovery
  // STUBS are stripped from the wire by createStubFilterInjector, so they cost ~0 on
  // the request and MUST NOT inflate the system-token estimate. Counting them made the
  // pre-flight see ~13.7K (all-65-tools size) and FALSE-exhaust an 8192 window after the
  // fit pass had correctly deferred to ~12 active tools.
  it("EXCLUDES auto-discovery stubs (DEFERRAL_STUB_MARKER_KEY) — they are wire-stripped, ~0 cost", () => {
    const real = { name: "real_tool", description: "x".repeat(100), parameters: { type: "object" } };
    const stub = {
      name: "mcp__srv--deferred",
      description: "y".repeat(500),
      parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
      [DEFERRAL_STUB_MARKER_KEY]: true,
    };
    // The stub contributes 0; only the real tool counts: "real_tool"(9) + 100 + '{"type":"object"}'(17) = 126.
    expect(toolDefOverheadChars([real, stub])).toBe(126);
    // A set of ONLY stubs costs nothing — the exact case that broke the pre-flight (44 stubs).
    expect(toolDefOverheadChars([stub, { ...stub, name: "mcp__srv--other" }])).toBe(0);
  });
});
