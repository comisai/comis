// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for VerificationConfigSchema and HonestyConfigSchema.
 *
 * Phase 154 (R4/S2): pre-delivery critic config keys.
 *
 * RED tests: these will fail until VerificationConfigSchema and HonestyConfigSchema
 * are exported from schema-agent-prompt.ts and wired into schema-agent-runtime.ts.
 */
import { describe, it, expect } from "vitest";
import { VerificationConfigSchema, HonestyConfigSchema } from "./schema-agent/index.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

// ---------------------------------------------------------------------------
// VerificationConfigSchema
// ---------------------------------------------------------------------------

describe("VerificationConfigSchema", () => {
  it("returns enabled=false by default (opt-in)", () => {
    const result = VerificationConfigSchema.parse({});
    expect(result.enabled).toBe(false);
  });

  it("returns minResponseChars=200 by default", () => {
    const result = VerificationConfigSchema.parse({});
    expect(result.minResponseChars).toBe(200);
  });

  it("accepts enabled=true", () => {
    const result = VerificationConfigSchema.parse({ enabled: true });
    expect(result.enabled).toBe(true);
  });

  it("accepts valid minResponseChars (50–2000 range)", () => {
    for (const v of [50, 100, 500, 1000, 2000]) {
      const result = VerificationConfigSchema.parse({ minResponseChars: v });
      expect(result.minResponseChars).toBe(v);
    }
  });

  it("rejects minResponseChars < 50", () => {
    const result = VerificationConfigSchema.safeParse({ minResponseChars: 49 });
    expect(result.success).toBe(false);
  });

  it("rejects minResponseChars > 2000", () => {
    const result = VerificationConfigSchema.safeParse({ minResponseChars: 2001 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer minResponseChars", () => {
    const result = VerificationConfigSchema.safeParse({ minResponseChars: 100.5 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (z.strictObject)", () => {
    const result = VerificationConfigSchema.safeParse({ enabled: false, unknownKey: "bad" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HonestyConfigSchema
// ---------------------------------------------------------------------------

describe("HonestyConfigSchema", () => {
  it("returns maxCriticRetries=2 by default", () => {
    const result = HonestyConfigSchema.parse({});
    expect(result.maxCriticRetries).toBe(2);
  });

  it("accepts valid maxCriticRetries (0–5 range)", () => {
    for (const v of [0, 1, 2, 3, 4, 5]) {
      const result = HonestyConfigSchema.parse({ maxCriticRetries: v });
      expect(result.maxCriticRetries).toBe(v);
    }
  });

  it("rejects maxCriticRetries > 5", () => {
    const result = HonestyConfigSchema.safeParse({ maxCriticRetries: 6 });
    expect(result.success).toBe(false);
  });

  it("rejects maxCriticRetries < 0", () => {
    const result = HonestyConfigSchema.safeParse({ maxCriticRetries: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer maxCriticRetries", () => {
    const result = HonestyConfigSchema.safeParse({ maxCriticRetries: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (z.strictObject)", () => {
    const result = HonestyConfigSchema.safeParse({ maxCriticRetries: 2, unknownKey: "bad" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PerAgentConfigSchema — wiring: verification + honesty keys
// ---------------------------------------------------------------------------

describe("PerAgentConfigSchema — verification + honesty wiring (Phase 154)", () => {
  it("accepts verification block with defaults applied", () => {
    const cfg = PerAgentConfigSchema.parse({ verification: { enabled: true } });
    expect(cfg.verification?.enabled).toBe(true);
    expect(cfg.verification?.minResponseChars).toBe(200);
  });

  it("accepts honesty block with defaults applied", () => {
    const cfg = PerAgentConfigSchema.parse({ honesty: { maxCriticRetries: 3 } });
    expect(cfg.honesty?.maxCriticRetries).toBe(3);
  });

  it("accepts both verification + honesty without ZodError", () => {
    const cfg = PerAgentConfigSchema.parse({
      verification: { enabled: true },
      honesty: { maxCriticRetries: 3 },
    });
    expect(cfg.verification?.enabled).toBe(true);
    expect(cfg.honesty?.maxCriticRetries).toBe(3);
  });

  it("verification and honesty are optional — omitting them parses fine", () => {
    const cfg = PerAgentConfigSchema.parse({});
    expect(cfg.verification).toBeUndefined();
    expect(cfg.honesty).toBeUndefined();
  });
});
