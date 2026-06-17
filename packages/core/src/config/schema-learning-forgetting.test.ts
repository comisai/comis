// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
// Value imports so the RED state is reproducible from this test commit alone:
// vitest must RESOLVE both modules at runtime. `schema-learning-forgetting.js`
// does not exist on the pre-patch code → the import throws and the suite is RED.
import { LearningForgettingConfigSchema } from "./schema-learning-forgetting.js";
import { PerAgentConfigSchema } from "./schema-agent/schema-agent-runtime.js";

/**
 * The per-agent `learningForgetting` config (FORGET-06).
 *
 * The on/off switch + tunables for wrongness-based soft eviction (the lifecycle
 * sweep's `failurePenalty` + `strengthThreshold`). Defaults OFF
 * (`enabled:false`) so the rest of the phase ships byte-identical until an
 * operator opts in. The schema is `z.strictObject` (unknown keys rejected,
 * SEC-01 — a smuggled `halfLifeDays` knob (FORGET-05) is refused at parse) with
 * `.default()` on every field; the nested `eviction` object has its own
 * `.default()`. It attaches to `PerAgentConfigSchema`.
 */
describe("LearningForgettingConfigSchema — per-agent soft-eviction config (default OFF)", () => {
  it("parse({}) yields the documented default-OFF block (enabled:false, eviction{enabled:true, strengthThreshold:0.2}, failurePenalty:0.5)", () => {
    expect(LearningForgettingConfigSchema.parse({})).toEqual({
      enabled: false,
      eviction: { enabled: true, strengthThreshold: 0.2 },
      failurePenalty: 0.5,
    });
  });

  it("the nested eviction object has its own .default() (a partial config fills it in)", () => {
    expect(LearningForgettingConfigSchema.parse({ failurePenalty: 0.3 }).eviction).toEqual({
      enabled: true,
      strengthThreshold: 0.2,
    });
  });

  it("is strict — a smuggled halfLifeDays key throws (FORGET-05: no new decay knob in v1)", () => {
    // T-200-02: z.strictObject rejects an unknown key at parse (top-level + nested).
    expect(() => LearningForgettingConfigSchema.parse({ halfLifeDays: 7 })).toThrow();
    expect(() => LearningForgettingConfigSchema.parse({ eviction: { foo: 1 } })).toThrow();
    expect(LearningForgettingConfigSchema.safeParse({ bogusKey: 1 }).success).toBe(false);
  });

  it("strengthThreshold and failurePenalty are bounded to [0,1]", () => {
    expect(() => LearningForgettingConfigSchema.parse({ failurePenalty: 1.5 })).toThrow();
    expect(() => LearningForgettingConfigSchema.parse({ failurePenalty: -0.1 })).toThrow();
    expect(() =>
      LearningForgettingConfigSchema.parse({ eviction: { strengthThreshold: 1.5 } }),
    ).toThrow();
    expect(
      LearningForgettingConfigSchema.parse({ eviction: { strengthThreshold: 0 } }).eviction
        .strengthThreshold,
    ).toBe(0);
  });

  it("attaches to PerAgentConfigSchema — a parsed agent config exposes learningForgetting.enabled === false", () => {
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.learningForgetting.enabled).toBe(false);
    expect(agent.learningForgetting.eviction).toEqual({ enabled: true, strengthThreshold: 0.2 });
    expect(agent.learningForgetting.failurePenalty).toBe(0.5);
  });
});
