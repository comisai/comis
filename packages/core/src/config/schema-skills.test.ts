// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SkillsConfigSchema } from "./schema-skills.js";

/**
 * Regression tests for 260423-irr: tighten `minBm25Score` to z.number().min(0).max(1).
 *
 * As of 2026-04-23, discover_tools normalizes BM25 scores to [0, 1] before the
 * floor applies (see .planning/design/discover-tools-bm25-fallback-fix.md §5.3).
 * A stale raw-score override like `2.5` would produce zero matches under the
 * new normalized semantics — hard-fail at config load is safer than silently
 * broken discovery (AGENTS.md §3.4 fail-fast, design §5.6).
 */
describe("SkillsConfigSchema -- toolDiscovery.minBm25Score [.max(1) tightening]", () => {
  it("minBm25Score > 1.0 fails validation", () => {
    const result = SkillsConfigSchema.safeParse({ toolDiscovery: { minBm25Score: 2.5 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["toolDiscovery", "minBm25Score"]);
    }
  });

  it("minBm25Score == 1.0 is accepted (top-only mode)", () => {
    const result = SkillsConfigSchema.parse({ toolDiscovery: { minBm25Score: 1.0 } });
    expect(result.toolDiscovery.minBm25Score).toBe(1.0);
  });

  it("minBm25Score == 0 is accepted (floor disabled)", () => {
    const result = SkillsConfigSchema.parse({ toolDiscovery: { minBm25Score: 0 } });
    expect(result.toolDiscovery.minBm25Score).toBe(0);
  });

  it("minBm25Score default is 0.8", () => {
    const result = SkillsConfigSchema.parse({});
    expect(result.toolDiscovery.minBm25Score).toBe(0.8);
  });
});
