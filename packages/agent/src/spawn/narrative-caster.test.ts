// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for NarrativeCaster -- tagged subagent result formatting.
 *
 * Tests verify:
 * - [Subagent Result: {label}] prefix tag
 * - Metadata (runtime, tokens, cost, steps, condensation level)
 * - Full result disk path
 * - Label truncation and fallback for empty tasks
 * - Custom tagPrefix support
 * - Optional section rendering (skip when absent, include when present)
 * - Disabled mode fallback to [System Message] format
 * - Trailing instruction compatibility with AnnouncementBatcher
 * - Compression ratio and original token count in metadata
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createNarrativeCaster, type CastParams } from "./narrative-caster.js";
import type { CondensedResult } from "@comis/core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCondensedResult(overrides?: Partial<CondensedResult>): CondensedResult {
  return {
    level: 2,
    result: {
      taskComplete: true,
      summary: "Test completed successfully.",
      conclusions: ["All tests pass"],
      filePaths: ["/src/foo.ts"],
    },
    originalTokens: 5000,
    condensedTokens: 1000,
    compressionRatio: 0.2,
    diskPath: "/home/user/.comis/subagent-results/session/run123.json",
    ...overrides,
  };
}

function makeCastParams(overrides?: Partial<CastParams>): CastParams {
  return {
    condensedResult: makeCondensedResult(),
    task: "Run unit tests",
    runtimeMs: 5000,
    stepsExecuted: 3,
    tokensUsed: 1500,
    cost: 0.0123,
    sessionKey: "default:sub-agent-abc:sub-agent:abc",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NarrativeCaster", () => {
  it("tags result with [Subagent Result: {label}] prefix", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams());
    expect(output).toContain("[Subagent Result: Run unit tests]");
  });

  it("includes metadata (runtime, tokens, cost, steps, level)", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams());
    expect(output).toContain("Runtime: 5.0s");
    expect(output).toContain("Steps: 3");
    expect(output).toContain("Tokens: 1500");
    expect(output).toContain("Cost: $0.0123");
    expect(output).toContain("Level 2");
  });

  it("includes full result disk path", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams());
    expect(output).toContain("Full result: /home/user/.comis/subagent-results/session/run123.json");
  });

  it("truncates long labels to 100 chars with ellipsis", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const longTask = "A".repeat(200);
    const output = caster.cast(makeCastParams({ task: longTask }));
    expect(output).toContain("[Subagent Result: " + "A".repeat(97) + "...]");
  });

  it("handles missing/empty task with fallback label 'unnamed task'", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams({ task: "" }));
    expect(output).toContain("[Subagent Result: unnamed task]");
  });

  it("uses label override when provided", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams({ label: "Custom Label" }));
    expect(output).toContain("[Subagent Result: Custom Label]");
  });

  it("respects custom tagPrefix from config", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Agent Output" });
    const output = caster.cast(makeCastParams());
    expect(output).toContain("[Agent Output: Run unit tests]");
  });

  it("skips empty optional sections (no File Paths header when none)", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams({
      condensedResult: makeCondensedResult({
        result: { taskComplete: true, summary: "Done", conclusions: ["OK"] },
      }),
    }));
    expect(output).not.toContain("File Paths:");
    expect(output).not.toContain("Actionable Items:");
    expect(output).not.toContain("Errors:");
  });

  it("renders all optional sections when present (filePaths, actionableItems, errors)", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams({
      condensedResult: makeCondensedResult({
        result: {
          taskComplete: false,
          summary: "Partial completion",
          conclusions: ["Some tests fail"],
          filePaths: ["/src/a.ts"],
          actionableItems: ["Fix failing tests"],
          errors: ["TypeError in module X"],
        },
      }),
    }));
    expect(output).toContain("File Paths:");
    expect(output).toContain("- /src/a.ts");
    expect(output).toContain("Actionable Items:");
    expect(output).toContain("- Fix failing tests");
    expect(output).toContain("Errors:");
    expect(output).toContain("- TypeError in module X");
    expect(output).toContain("Status: Incomplete");
  });

  it("returns untagged [System Message] format when narrativeCasting is disabled", () => {
    const caster = createNarrativeCaster({ enabled: false, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams());
    expect(output).toContain("[System Message]");
    expect(output).not.toContain("[Subagent Result:");
  });

  it("includes trailing instruction compatible with AnnouncementBatcher (contains NO_REPLY)", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams());
    // Batcher looks for this specific marker to strip
    expect(output).toContain("Inform the user about this completed background task.");
    expect(output).toContain("NO_REPLY");
  });

  it("includes compression ratio and original token count in metadata", () => {
    const caster = createNarrativeCaster({ enabled: true, tagPrefix: "Subagent Result" });
    const output = caster.cast(makeCastParams({
      condensedResult: makeCondensedResult({
        originalTokens: 10000,
        compressionRatio: 0.15,
      }),
    }));
    expect(output).toContain("Original: 10000 tokens");
    expect(output).toContain("Ratio: 0.15");
  });
});
