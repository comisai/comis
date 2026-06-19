// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { GeminiCacheConfigSchema } from "./schema-gemini-cache.js";
import { AgentConfigSchema } from "./schema-agent/index.js";

// ---------------------------------------------------------------------------
// GeminiCacheConfigSchema
// ---------------------------------------------------------------------------

describe("GeminiCacheConfigSchema", () => {
  it("produces correct defaults from empty object (explicit caching ON by default)", () => {
    const result = GeminiCacheConfigSchema.parse({});
    expect(result).toEqual({ enabled: true, maxActiveCaches: 20 });
  });

  it("accepts an explicit opt-OUT", () => {
    const result = GeminiCacheConfigSchema.parse({ enabled: false });
    expect(result).toEqual({ enabled: false, maxActiveCaches: 20 });
  });

  it("accepts explicit values", () => {
    const result = GeminiCacheConfigSchema.parse({ enabled: true, maxActiveCaches: 10 });
    expect(result).toEqual({ enabled: true, maxActiveCaches: 10 });
  });

  it("rejects maxActiveCaches: 0 (must be positive)", () => {
    const result = GeminiCacheConfigSchema.safeParse({ maxActiveCaches: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects maxActiveCaches: 1.5 (must be integer)", () => {
    const result = GeminiCacheConfigSchema.safeParse({ maxActiveCaches: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strictObject)", () => {
    const result = GeminiCacheConfigSchema.safeParse({ enabled: true, unknownField: "bad" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentConfigSchema geminiCache integration
// ---------------------------------------------------------------------------

describe("AgentConfigSchema geminiCache integration", () => {
  it("includes geminiCache with correct defaults when omitted (ON by default)", () => {
    const config = AgentConfigSchema.parse({});
    expect(config.geminiCache).toEqual({ enabled: true, maxActiveCaches: 20 });
  });

  it("applies maxActiveCaches default when only enabled is set", () => {
    const config = AgentConfigSchema.parse({ geminiCache: { enabled: true } });
    expect(config.geminiCache.maxActiveCaches).toBe(20);
  });
});
