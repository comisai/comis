// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for {@link DialecticConfigSchema} (Phase 109 — DIAL-02): the
 * default-OFF per-agent opt-in knob that gates the `memory_ask` tool (the
 * ONE allowed query-time LLM surface). RED-first: the schema module does not
 * exist until the GREEN patch.
 *
 * The contract these tests pin:
 *   - `enabled` defaults to `false` — the cost gate. A config that omits the
 *     `dialectic` block, or sets it `{}`, can NEVER silently enable the
 *     query-time LLM (T-109-01).
 *   - `maxOutputTokens` + `maxRecall` are positive-int DoS bounds, both
 *     defaulted (T-109-04 — the cost axis).
 *   - `z.strictObject` rejects unknown keys (matches the social-modeling
 *     discipline; T-109-01).
 *   - the knob is registered onto `PerAgentConfigSchema` as `.optional()` —
 *     present-and-enabled parses, AND omitting it entirely parses (no existing
 *     default changes).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { DialecticConfigSchema } from "./schema-dialectic.js";
import { PerAgentConfigSchema } from "./schema-agent/schema-agent-runtime.js";

describe("DialecticConfigSchema", () => {
  it("defaults every field with enabled:false (the cost gate — default-OFF)", () => {
    const parsed = DialecticConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      maxOutputTokens: 1024,
      maxRecall: 10,
    });
  });

  it("honors enabled:true while still defaulting the cost bounds", () => {
    const parsed = DialecticConfigSchema.parse({ enabled: true });
    expect(parsed.enabled).toBe(true);
    expect(parsed.maxOutputTokens).toBe(1024);
    expect(parsed.maxRecall).toBe(10);
  });

  it("rejects an unknown key (z.strictObject — the social-modeling discipline)", () => {
    expect(() => DialecticConfigSchema.parse({ foo: 1 })).toThrow();
  });

  it("rejects a non-positive cost bound (the DoS floor)", () => {
    expect(() => DialecticConfigSchema.parse({ maxOutputTokens: 0 })).toThrow();
    expect(() => DialecticConfigSchema.parse({ maxRecall: -1 })).toThrow();
  });
});

describe("PerAgentConfigSchema dialectic registration", () => {
  it("accepts a per-agent config carrying { dialectic: { enabled: true } }", () => {
    const parsed = PerAgentConfigSchema.parse({ dialectic: { enabled: true } });
    expect(parsed.dialectic).toEqual({
      enabled: true,
      maxOutputTokens: 1024,
      maxRecall: 10,
    });
  });

  it("accepts a per-agent config that omits dialectic entirely (it is .optional())", () => {
    const parsed = PerAgentConfigSchema.parse({});
    // The knob is optional — omitting it leaves it undefined (no existing
    // default changed; the only behavior change is a NEW optional block).
    expect(parsed.dialectic).toBeUndefined();
  });
});
