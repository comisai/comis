// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for resolveMemoryOpsStrategy — R6 capability-routed memory operations.
 *
 * Pure-function routing: frontier/mid → "capable"; small/nano → "abstain"
 * unless a capableModelOverride is set.
 *
 * Mirrors the compaction-capability-router test structure.
 */
import { describe, it, expect } from "vitest";
import { resolveMemoryOpsStrategy } from "./memory-capability-router.js";

describe("resolveMemoryOpsStrategy", () => {
  it("returns capable for frontier without override", () => {
    expect(resolveMemoryOpsStrategy("frontier")).toBe("capable");
  });

  it("returns capable for mid without override", () => {
    expect(resolveMemoryOpsStrategy("mid")).toBe("capable");
  });

  it("returns abstain for small without a capable override (T-153-fabricate mitigation)", () => {
    expect(resolveMemoryOpsStrategy("small")).toBe("abstain");
  });

  it("returns abstain for nano without a capable override (T-153-fabricate mitigation)", () => {
    expect(resolveMemoryOpsStrategy("nano")).toBe("abstain");
  });

  it("returns capable for small when hasCapableModelOverride=true", () => {
    expect(resolveMemoryOpsStrategy("small", true)).toBe("capable");
  });

  it("returns capable for nano when hasCapableModelOverride=true", () => {
    expect(resolveMemoryOpsStrategy("nano", true)).toBe("capable");
  });

  it("returns abstain for small when hasCapableModelOverride=false (explicit)", () => {
    expect(resolveMemoryOpsStrategy("small", false)).toBe("abstain");
  });

  it("defaults hasCapableModelOverride to false (small without arg → abstain)", () => {
    // Verifies the default parameter behavior — equivalent to passing false.
    const withDefault = resolveMemoryOpsStrategy("small");
    const withExplicitFalse = resolveMemoryOpsStrategy("small", false);
    expect(withDefault).toBe(withExplicitFalse);
    expect(withDefault).toBe("abstain");
  });
});
