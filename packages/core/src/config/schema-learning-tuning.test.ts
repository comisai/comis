// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
// Value imports so the RED state is reproducible from this test commit alone:
// vitest must RESOLVE both modules at runtime. `schema-learning-tuning.js` does
// not exist on the pre-patch code → the import throws and the suite is RED.
import { LearningTuningConfigSchema } from "./schema-learning-tuning.js";
import { PerAgentConfigSchema } from "./schema-agent/schema-agent-runtime.js";

/**
 * The per-agent `learningTuning` config (RANK-07).
 *
 * The on/off switch + tunables every later Phase-200 plan reads (the daemon
 * reward seam, the bandit job, the per-intent recall apply). Now defaults ON
 * (`enabled:true`, opt-out) so tuning works out of the box; the master kill
 * switch `memory.costFeatures.enabled` (default true) is the real gate. The
 * schema is `z.strictObject` (unknown keys rejected, SEC-01 — a smuggled
 * `trustAlpha`/trust knob is refused at parse) with `.default()` on every field.
 * It attaches to `PerAgentConfigSchema`.
 */
describe("LearningTuningConfigSchema — per-agent bandit/per-intent tuning config (default ON, opt-out)", () => {
  it("parse({}) yields the documented default-ON block (enabled:true, bandit, perIntent, exploration:0.1)", () => {
    expect(LearningTuningConfigSchema.parse({})).toEqual({
      enabled: true,
      learner: "bandit",
      perIntent: true,
      exploration: 0.1,
    });
  });

  it("is strict — a smuggled trustAlpha key throws (SEC-01: a trust weight can never enter the bandit via config)", () => {
    // T-200-01: z.strictObject (NOT z.object) rejects a smuggled trust knob at parse.
    expect(() => LearningTuningConfigSchema.parse({ trustAlpha: 0.9 })).toThrow();
    // No tunable STEP knob either (anti-pattern: a tunable step could overturn trust-first).
    expect(() => LearningTuningConfigSchema.parse({ step: 0.1 })).toThrow();
    expect(LearningTuningConfigSchema.safeParse({ bogusKey: 1 }).success).toBe(false);
  });

  it("learner enum accepts bandit/nudge only ('thompson' is rejected)", () => {
    expect(LearningTuningConfigSchema.parse({ learner: "nudge" }).learner).toBe("nudge");
    expect(LearningTuningConfigSchema.parse({ learner: "bandit" }).learner).toBe("bandit");
    expect(() => LearningTuningConfigSchema.parse({ learner: "thompson" })).toThrow();
  });

  it("exploration is bounded to [0,1]", () => {
    expect(() => LearningTuningConfigSchema.parse({ exploration: 1.5 })).toThrow();
    expect(() => LearningTuningConfigSchema.parse({ exploration: -0.1 })).toThrow();
    expect(LearningTuningConfigSchema.parse({ exploration: 0 }).exploration).toBe(0);
    expect(LearningTuningConfigSchema.parse({ exploration: 1 }).exploration).toBe(1);
  });

  it("attaches to PerAgentConfigSchema — a parsed agent config exposes learningTuning.enabled === true", () => {
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.learningTuning.enabled).toBe(true);
    expect(agent.learningTuning.learner).toBe("bandit");
    expect(agent.learningTuning.perIntent).toBe(true);
    expect(agent.learningTuning.exploration).toBe(0.1);
  });
});
