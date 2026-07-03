// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for {@link DialecticConfigSchema}: the
 * per-agent knob that gates the `memory_ask` tool (the
 * ONE allowed query-time LLM surface).
 *
 * The contract these tests pin:
 *   - `enabled` defaults to `true` (opt-out posture) — it is a COST feature,
 *     force-disabled at the wiring layer when the master cost-feature switch
 *     is off.
 *   - `maxOutputTokens` + `maxRecall` are positive-int DoS bounds, both
 *     defaulted (the cost axis).
 *   - `z.strictObject` rejects unknown keys (typo guard).
 *   - the knob is registered onto `PerAgentConfigSchema` with a populated
 *     default — a config that omits the `dialectic` block still parses.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { DialecticConfigSchema } from "./schema-dialectic.js";
import { PerAgentConfigSchema } from "./schema-agent/schema-agent-runtime.js";

describe("DialecticConfigSchema", () => {
  it("defaults every field with enabled:true (opt-out posture; kill-switch-gated cost feature)", () => {
    // Opt-out posture: memory_ask defaults ON. It is a COST feature (the one
    // query-time LLM surface), so the master cost-feature kill switch still force-disables it at
    // the dialectic-wiring layer. The DoS cost bounds stay frozen.
    const parsed = DialecticConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: true,
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

  it("rejects an unknown key (z.strictObject typo guard)", () => {
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

  it("defaults dialectic ON for a config that omits it (opt-out posture; kill-switch-gated)", () => {
    // The knob is not `.optional()`; a bare config gets it populated +
    // enabled. The master cost-feature kill switch still force-disables memory_ask at the wiring
    // layer (buildDialecticWiring returns the dead `{}` when costFeatures is off).
    const parsed = PerAgentConfigSchema.parse({});
    expect(parsed.dialectic).toBeDefined();
    expect(parsed.dialectic!.enabled).toBe(true);
  });
});
