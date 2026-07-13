// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DurabilityConfigSchema } from "./schema-agent-autonomy-durability.js";
import { AutonomyConfigSchema } from "./schema-agent-autonomy.js";

/**
 * The durability posture's `orchestrateResume` toggle — the single gate every
 * resumable-orchestrate behavior nests under. Full-capability-by-default: it (and
 * the durability master `enabled`) ship `.default(true)`, nested INSIDE
 * `DurabilityConfigSchema`, so an omitted block materializes durable+resumable ON
 * and a typo'd key is rejected by the `strictObject` rather than silently ignored.
 */
describe("DurabilityConfigSchema.orchestrateResume (default-on resume gate)", () => {
  it("resolves to true when the durability block is parsed with no override (field default)", () => {
    const cfg = DurabilityConfigSchema.parse({});
    expect(cfg.orchestrateResume).toBe(true);
    // Durability master gate is also on by default (full capability out of the box).
    expect(cfg.enabled).toBe(true);
  });

  it("resolves to true when the WHOLE durability block is omitted (parent .default() factory carries it)", () => {
    // AutonomyConfigSchema wires `durability: DurabilityConfigSchema.default(() =>
    // DurabilityConfigSchema.parse({}))` — a re-parsing factory, so an omitted
    // block materializes every field default INCLUDING orchestrateResume:true.
    // No autonomy config ⇒ durable resume ON out of the box.
    const autonomy = AutonomyConfigSchema.parse({});
    expect(autonomy.durability.orchestrateResume).toBe(true);
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
