// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DurabilityConfigSchema } from "./schema-agent-autonomy-durability.js";
import { AutonomyConfigSchema } from "./schema-agent-autonomy.js";

/**
 * The durability posture's `orchestrateResume` toggle — the single gate every
 * resumable-orchestrate behavior nests under. It is default-OFF, nested INSIDE
 * `DurabilityConfigSchema` (not a flat toggle), so an omitted block fails closed
 * (deny-by-absence) and a typo'd key is rejected by the `strictObject` rather
 * than silently ignored.
 */
describe("DurabilityConfigSchema.orchestrateResume (default-off resume gate)", () => {
  it("resolves to false when the durability block is parsed with no override (field default)", () => {
    const cfg = DurabilityConfigSchema.parse({});
    expect(cfg.orchestrateResume).toBe(false);
    // The pre-existing default-off posture is unchanged.
    expect(cfg.enabled).toBe(false);
  });

  it("resolves to false when the WHOLE durability block is omitted (parent .default() factory carries it)", () => {
    // AutonomyConfigSchema wires `durability: DurabilityConfigSchema.default(() =>
    // DurabilityConfigSchema.parse({}))` — a re-parsing factory, so an omitted
    // block materializes every field default INCLUDING orchestrateResume:false.
    // This is the deny-by-absence proof: no autonomy config ⇒ resume disabled.
    const autonomy = AutonomyConfigSchema.parse({});
    expect(autonomy.durability.orchestrateResume).toBe(false);
  });

  it("parses an explicit { orchestrateResume: true } to true", () => {
    const cfg = DurabilityConfigSchema.parse({ orchestrateResume: true });
    expect(cfg.orchestrateResume).toBe(true);
  });

  it("rejects a typo'd key (proves the toggle is INSIDE the strictObject, not silently ignored)", () => {
    const res = DurabilityConfigSchema.safeParse({ orchestrateResumee: true });
    expect(res.success).toBe(false);
  });
});
