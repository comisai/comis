// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
// Value imports so the RED state is reproducible from this test commit alone:
// vitest must RESOLVE both modules at runtime. `schema-learning-skills.js` does
// not exist on the pre-patch code → the import throws and the suite is RED.
import { LearningSkillsConfigSchema } from "./schema-learning-skills.js";
import { PerAgentConfigSchema } from "./schema-agent/schema-agent-runtime.js";

/**
 * The per-agent `learningSkills` config (SKILL-08 / SEC-01, design §7).
 *
 * Unlike every surrounding `memory*` cost feature (which defaults ON / opt-out),
 * learningSkills defaults OFF (`enabled:false`) — enabling it is a deliberate
 * operator opt-in, and the closing gate's byte-identity guarantee depends on the
 * default being disabled. The schema is `z.strictObject` (unknown keys rejected)
 * with `.default()` on every field. It attaches to `PerAgentConfigSchema`.
 */
describe("LearningSkillsConfigSchema — per-agent procedural-learning config (default OFF)", () => {
  it("parse({}) yields the documented default-OFF block (the verbatim design §7 defaults)", () => {
    const cfg = LearningSkillsConfigSchema.parse({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.validation.requireReproduction).toBe(true);
    expect(cfg.autoAdmitReadOnly).toBe(true);
    expect(cfg.approval.requireForMutating).toBe(true);
    expect(cfg.minConfidence).toBe(0.7);
    expect(cfg.promoteAtProofCount).toBe(3);
  });

  it("validation is a default-ON strict sub-block (requireReproduction:true — fail-closed)", () => {
    expect(LearningSkillsConfigSchema.parse({ validation: { requireReproduction: false } }).validation.requireReproduction).toBe(false);
    // strict: no smuggled keys in the sub-block.
    expect(
      LearningSkillsConfigSchema.safeParse({ validation: { requireReproduction: true, bogus: 1 } }).success,
    ).toBe(false);
  });

  it("approval is a default-ON strict sub-block (requireForMutating:true — the mutating gate)", () => {
    expect(LearningSkillsConfigSchema.parse({ approval: { requireForMutating: false } }).approval.requireForMutating).toBe(false);
    expect(
      LearningSkillsConfigSchema.safeParse({ approval: { requireForMutating: true, bogus: 1 } }).success,
    ).toBe(false);
  });

  it("is strict — an unknown top-level key fails safeParse (no silent passthrough)", () => {
    expect(LearningSkillsConfigSchema.safeParse({ bogusKey: 1 }).success).toBe(false);
  });

  it("rejects out-of-range minConfidence ([0,1]) and non-positive-int promoteAtProofCount", () => {
    expect(LearningSkillsConfigSchema.safeParse({ minConfidence: 1.5 }).success).toBe(false);
    expect(LearningSkillsConfigSchema.safeParse({ minConfidence: -0.1 }).success).toBe(false);
    expect(LearningSkillsConfigSchema.safeParse({ minConfidence: 0.7 }).success).toBe(true);
    expect(LearningSkillsConfigSchema.safeParse({ promoteAtProofCount: 0 }).success).toBe(false);
    expect(LearningSkillsConfigSchema.safeParse({ promoteAtProofCount: 1.5 }).success).toBe(false);
    expect(LearningSkillsConfigSchema.safeParse({ promoteAtProofCount: 3 }).success).toBe(true);
  });

  it("attaches to PerAgentConfigSchema — a parsed agent config exposes learningSkills.enabled === false", () => {
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.learningSkills.enabled).toBe(false);
    expect(agent.learningSkills.validation.requireReproduction).toBe(true);
    expect(agent.learningSkills.autoAdmitReadOnly).toBe(true);
    expect(agent.learningSkills.approval.requireForMutating).toBe(true);
    expect(agent.learningSkills.minConfidence).toBe(0.7);
    expect(agent.learningSkills.promoteAtProofCount).toBe(3);
  });
});
