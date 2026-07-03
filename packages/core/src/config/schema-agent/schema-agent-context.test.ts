// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the memory.distillFromLcd config block in ContextEngineConfigSchema.
 *
 * They verify:
 *   1. Empty contextEngine config produces correct memory.distillFromLcd defaults.
 *   2. Explicit overrides are not clobbered by defaults.
 *   3. The fully-populated .default() pattern works correctly (not bare .default({})).
 */

import { describe, it, expect } from "vitest";
import { ContextEngineConfigSchema } from "./schema-agent-context.js";

describe("ContextEngineConfigSchema — memory.distillFromLcd config block", () => {
  // ── Test 1: enabled default ──────────────────────────────────────────────

  it("empty contextEngine config produces memory.distillFromLcd.enabled = false", () => {
    const cfg = ContextEngineConfigSchema.parse({});
    expect(cfg.memory.distillFromLcd.enabled).toBe(false);
  });

  // ── Test 2: minDepth default ─────────────────────────────────────────────

  it("empty contextEngine config produces memory.distillFromLcd.minDepth = 1", () => {
    const cfg = ContextEngineConfigSchema.parse({});
    expect(cfg.memory.distillFromLcd.minDepth).toBe(1);
  });

  // ── Test 3: dedupCosineThreshold default ────────────────────────────────

  it("empty contextEngine config produces memory.distillFromLcd.dedupCosineThreshold = 0.92", () => {
    const cfg = ContextEngineConfigSchema.parse({});
    expect(cfg.memory.distillFromLcd.dedupCosineThreshold).toBe(0.92);
  });

  // ── Test 4: explicit enabled override ───────────────────────────────────

  it("explicit {enabled:true} is honored and not overridden by default", () => {
    const cfg = ContextEngineConfigSchema.parse({
      memory: { distillFromLcd: { enabled: true, minDepth: 2, dedupCosineThreshold: 0.85 } },
    });
    expect(cfg.memory.distillFromLcd.enabled).toBe(true);
    expect(cfg.memory.distillFromLcd.minDepth).toBe(2);
    expect(cfg.memory.distillFromLcd.dedupCosineThreshold).toBe(0.85);
  });

  // ── Test 5: partial override preserves other defaults ───────────────────

  it("partial memory block still applies distillFromLcd defaults for unspecified fields", () => {
    const cfg = ContextEngineConfigSchema.parse({
      memory: { distillFromLcd: { enabled: true } },
    });
    expect(cfg.memory.distillFromLcd.enabled).toBe(true);
    expect(cfg.memory.distillFromLcd.minDepth).toBe(1);
    expect(cfg.memory.distillFromLcd.dedupCosineThreshold).toBe(0.92);
  });

  // ── Test 6: schema boundaries (min/max validation) ──────────────────────

  it("rejects minDepth < 1", () => {
    const result = ContextEngineConfigSchema.safeParse({
      memory: { distillFromLcd: { minDepth: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects minDepth > 10", () => {
    const result = ContextEngineConfigSchema.safeParse({
      memory: { distillFromLcd: { minDepth: 11 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects dedupCosineThreshold > 1", () => {
    const result = ContextEngineConfigSchema.safeParse({
      memory: { distillFromLcd: { dedupCosineThreshold: 1.1 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects dedupCosineThreshold < 0", () => {
    const result = ContextEngineConfigSchema.safeParse({
      memory: { distillFromLcd: { dedupCosineThreshold: -0.1 } },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// contextEngine.relevance.firstByDefault config block.
//
// The CRITICAL contract (the schema re-parse trap): firstByDefault is an
// OPTIONAL boolean with NO `.default()`. An OMITTED field must parse to `undefined`
// (NOT `false`) so the scaffold-defaults resolver's `?? (capability gate)` survives.
// A `.default(false)` here would collapse undefined→false and silently kill the
// capability-gated default for small/nano. These tests pin undefined-stays-undefined.
// ---------------------------------------------------------------------------
describe("ContextEngineConfigSchema — relevance.firstByDefault config block", () => {
  it("parses { relevance: { firstByDefault: true } } to true", () => {
    const cfg = ContextEngineConfigSchema.parse({ relevance: { firstByDefault: true } });
    expect(cfg.relevance?.firstByDefault).toBe(true);
  });

  it("parses { relevance: { firstByDefault: false } } to false (explicit force-off preserved)", () => {
    const cfg = ContextEngineConfigSchema.parse({ relevance: { firstByDefault: false } });
    expect(cfg.relevance?.firstByDefault).toBe(false);
  });

  it("OMITTING relevance leaves it undefined (NO .default() — the resolver ?? gate survives)", () => {
    const cfg = ContextEngineConfigSchema.parse({});
    // The block itself is .optional() → undefined when omitted (NOT a defaulted object).
    expect(cfg.relevance).toBeUndefined();
  });

  it("OMITTING firstByDefault inside an explicit relevance block leaves the field undefined", () => {
    const cfg = ContextEngineConfigSchema.parse({ relevance: {} });
    // The field is .optional() with NO .default(false) → undefined, not false.
    expect(cfg.relevance?.firstByDefault).toBeUndefined();
  });

  it("rejects a non-boolean firstByDefault (type safety)", () => {
    const result = ContextEngineConfigSchema.safeParse({
      relevance: { firstByDefault: "yes" },
    });
    expect(result.success).toBe(false);
  });
});
