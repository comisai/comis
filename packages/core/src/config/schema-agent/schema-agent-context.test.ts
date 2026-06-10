// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the memory.distillFromLcd config block in ContextEngineConfigSchema.
 *
 * RED (172-01): These tests fail on pre-patch code because the
 * memory.distillFromLcd block does not exist in ContextEngineConfigSchema yet.
 *
 * They verify:
 *   1. Empty contextEngine config produces correct memory.distillFromLcd defaults.
 *   2. Explicit overrides are not clobbered by defaults.
 *   3. The fully-populated .default() pattern works correctly (not bare .default({})).
 */

import { describe, it, expect } from "vitest";
import { ContextEngineConfigSchema } from "./schema-agent-context.js";

describe("ContextEngineConfigSchema — memory.distillFromLcd config block (Phase 172-01)", () => {
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
