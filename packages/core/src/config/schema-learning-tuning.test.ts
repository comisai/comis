// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { LearningTuningConfigSchema } from "./schema-learning-tuning.js";
import { PerAgentConfigSchema } from "./schema-agent/schema-agent-runtime.js";

/**
 * The per-agent `learningTuning` config — Phase 224 (v2.31).
 *
 * The UCB recall bandit was DELETED, taking the `learner` / `perIntent` / `exploration`
 * sub-fields with it. This block now carries ONLY `enabled` — the gate on the daemon's
 * outcome-rewarded usefulness-feedback write (RANK-01, `usefulnessStore.recordUsage` /
 * `recordFailure`), which is the FORGET-02 `failure_count` source and an explicit KEEPER.
 * Still defaults ON (`enabled:true`, opt-out); the master kill switch
 * `memory.costFeatures.enabled` (default true) is the real gate. The schema is
 * `z.strictObject` (unknown keys rejected, SEC-01) and attaches to `PerAgentConfigSchema`.
 */
describe("LearningTuningConfigSchema — the reward-write gate (bandit sub-fields deleted in 224)", () => {
  it("parse({}) yields ONLY the default-ON enabled flag (the bandit sub-fields are gone)", () => {
    expect(LearningTuningConfigSchema.parse({})).toEqual({ enabled: true });
  });

  it("the deleted bandit sub-fields are now REJECTED (strictObject — learner/perIntent/exploration no longer exist)", () => {
    // Phase 224: these were the bandit knobs; deleting them must make them unknown keys.
    expect(LearningTuningConfigSchema.safeParse({ learner: "bandit" }).success).toBe(false);
    expect(LearningTuningConfigSchema.safeParse({ perIntent: true }).success).toBe(false);
    expect(LearningTuningConfigSchema.safeParse({ exploration: 0.1 }).success).toBe(false);
  });

  it("is strict — a smuggled trustAlpha/step key throws (SEC-01: a trust weight can never enter via config)", () => {
    expect(() => LearningTuningConfigSchema.parse({ trustAlpha: 0.9 })).toThrow();
    expect(() => LearningTuningConfigSchema.parse({ step: 0.1 })).toThrow();
    expect(LearningTuningConfigSchema.safeParse({ bogusKey: 1 }).success).toBe(false);
  });

  it("enabled can be opted OFF explicitly (the per-agent override)", () => {
    expect(LearningTuningConfigSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("attaches to PerAgentConfigSchema — a parsed agent config exposes learningTuning.enabled === true (and nothing else)", () => {
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.learningTuning).toEqual({ enabled: true });
  });
});
