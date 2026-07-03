// SPDX-License-Identifier: Apache-2.0
/**
 * The collapsed learning config.
 *
 * The whole learning layer is configured by ONE `schema-learning.ts` (~10 keys)
 * with a single `learning.enabled` master gate nested under `memory.enabled` —
 * no per-loop config flags. This suite pins the ground truth of that shape:
 *  - the ~10-key shape parses with every field defaulted (nested `.default()`);
 *  - `memory.enabled` is the master kill-switch
 *    and the recall keepers nest under `memory.recall`;
 *  - `learning.enabled` is the single layer gate (no learningSkills.enabled /
 *    learningTuning.enabled / learningForgetting.enabled per-loop gates);
 *  - a bare AppConfig loads (the learning layer fully defaults);
 *  - a config carrying a nonexistent per-loop key (learningSkills/learningTuning/learningForgetting)
 *    is REJECTED at parse (`z.strictObject` unrecognized-key — the operator-update
 *    path, no compat shim);
 *  - `learningOutcome.minConfidenceToLearn` is its own key
 *    (the outcome-resolution floor — a SEPARATE consumer from `learning.reflect.minConfidence`).
 *
 * Value imports (not type-only) so vitest must RESOLVE `schema-learning.js` at
 * runtime — a missing or broken module fails the suite loudly instead of
 * type-checking silently.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { LearningConfigSchema } from "./schema-learning.js";
import { MemoryConfigSchema } from "./schema-memory.js";
import { LearningOutcomeConfigSchema } from "./schema-learning-outcome.js";
import { PerAgentConfigSchema } from "./schema-agent/schema-agent-runtime.js";
import { AppConfigSchema } from "./schema.js";

describe("LearningConfigSchema — the collapsed ~10-key learning layer", () => {
  it("parse({}) fills the documented default block (enabled + reflect + forget, all nested-defaulted)", () => {
    expect(LearningConfigSchema.parse({})).toEqual({
      enabled: true,
      reflect: {
        // best-out-of-box: every-3h cadence + raised doc cap (cost-ignored).
        schedule: "0 */3 * * *",
        minConfidence: 0.6,
        promoteAtProofCount: 3,
        maxDocsPerRun: 100,
      },
      forget: {
        maxDormantDays: 365, // best-out-of-box: remember ~a year (forget less aggressively)
        failureEvictionFloor: 3,
        highProofFloor: 5,
      },
    });
  });

  it("the nested reflect/forget objects have their own .default() (a partial config fills them in)", () => {
    const parsed = LearningConfigSchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
    // One flag force-disables the whole layer, but the nested defaults still fill.
    expect(parsed.reflect).toEqual({
      schedule: "0 */3 * * *",
      minConfidence: 0.6,
      promoteAtProofCount: 3,
      maxDocsPerRun: 100,
    });
    expect(parsed.forget).toEqual({ maxDormantDays: 365, failureEvictionFloor: 3, highProofFloor: 5 });
  });

  it("is strict — a smuggled/unknown knob throws at parse (z.strictObject)", () => {
    expect(() => LearningConfigSchema.parse({ bogusKnob: 1 })).toThrow();
    expect(() => LearningConfigSchema.parse({ reflect: { bogus: 1 } })).toThrow();
    expect(LearningConfigSchema.safeParse({ forget: { halfLifeDays: 7 } }).success).toBe(false);
  });

  it("reflect.minConfidence is bounded to [0,1]; the cost-bound caps are positive integers", () => {
    expect(() => LearningConfigSchema.parse({ reflect: { minConfidence: 1.5 } })).toThrow();
    expect(() => LearningConfigSchema.parse({ reflect: { minConfidence: -0.1 } })).toThrow();
    expect(() => LearningConfigSchema.parse({ reflect: { maxDocsPerRun: 0 } })).toThrow();
    expect(() => LearningConfigSchema.parse({ forget: { maxDormantDays: -1 } })).toThrow();
    expect(LearningConfigSchema.parse({ reflect: { minConfidence: 0 } }).reflect.minConfidence).toBe(0);
  });
});

describe("MemoryConfigSchema — memory.enabled master gate + memory.recall nesting", () => {
  it("memory.enabled is the master kill-switch and defaults true (opt-out posture)", () => {
    expect(MemoryConfigSchema.parse({}).enabled).toBe(true);
    expect(MemoryConfigSchema.parse({ enabled: false }).enabled).toBe(false);
  });

  it("the recall keepers nest under memory.recall (embeddingModel/embeddingDimensions/rerankerModel)", () => {
    const recall = MemoryConfigSchema.parse({}).recall;
    expect(recall).toEqual({
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
      rerankerModel: "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf",
    });
  });

  it("a costFeatures key is REJECTED (z.strictObject — memory.enabled is the only master gate, no alias)", () => {
    expect(() => MemoryConfigSchema.parse({ costFeatures: { enabled: true } })).toThrow();
    // The recall keys only exist nested — a config using a flat shape is rejected too.
    expect(MemoryConfigSchema.safeParse({ embeddingModel: "x" }).success).toBe(false);
  });

  it("the memory engine-substrate keepers stay (dbPath/walMode/compaction/retention/reranker plumbing)", () => {
    const m = MemoryConfigSchema.parse({});
    expect(m.dbPath).toBe("memory.db");
    expect(m.walMode).toBe(true);
    expect(m.rerankerModelsDir).toBe("models");
    expect(m.rerankerGpu).toBe("auto");
    expect(m.rerankerThreads).toBe(4);
    expect(m.compaction.enabled).toBe(true);
    expect(m.retention.maxAgeDays).toBe(0);
  });
});

describe("PerAgentConfigSchema — the collapsed learning block + per-loop-key rejection", () => {
  it("a parsed agent config exposes a fully-defaulted learning block nested under the agent (NOT top-level)", () => {
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.learning.enabled).toBe(true);
    expect(agent.learning.reflect.promoteAtProofCount).toBe(3);
    expect(agent.learning.forget.failureEvictionFloor).toBe(3);
  });

  it("rejects each per-loop key (learningSkills/learningTuning/learningForgetting) — Unrecognized key (z.strictObject)", () => {
    expect(() => PerAgentConfigSchema.parse({ learningSkills: { enabled: true } })).toThrow(/Unrecognized key/);
    expect(() => PerAgentConfigSchema.parse({ learningTuning: { enabled: true } })).toThrow(/Unrecognized key/);
    expect(() => PerAgentConfigSchema.parse({ learningForgetting: { enabled: true } })).toThrow(/Unrecognized key/);
  });

  it("learningOutcome.minConfidenceToLearn stays its own key (the outcome-resolution floor, default 0.6)", () => {
    // A SEPARATE consumer from learning.reflect.minConfidence — they happen to share 0.6 but
    // are NOT merged (avoids an ambiguous single source). The keeper block stays on the agent.
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.learningOutcome.minConfidenceToLearn).toBe(0.6);
    expect(LearningOutcomeConfigSchema.parse({}).minConfidenceToLearn).toBe(0.6);
    // And the two floors are independent: learning.reflect.minConfidence is its own field.
    expect(agent.learning.reflect.minConfidence).toBe(0.6);
  });
});

describe("AppConfigSchema — bare load + the live-config canary", () => {
  it("AppConfigSchema.parse({}) succeeds — the learning layer fully defaults (bare config loads)", () => {
    const cfg = AppConfigSchema.parse({});
    expect(cfg.memory.enabled).toBe(true);
    expect(cfg.memory.recall.embeddingModel).toBe("text-embedding-3-small");
  });

  it("live-config canary: a fixture mirroring the live ~/.comis/config.yaml shape parses cleanly", () => {
    // The live config carries memory.enabled + memory.recall + a per-agent learning block —
    // none of the rejected keys (learningSkills/learningTuning/learningForgetting/costFeatures).
    const live = {
      memory: {
        enabled: true,
        recall: { embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536 },
      },
      agents: {
        default: {
          provider: "anthropic",
          learning: { enabled: true, reflect: { schedule: "0 3 * * *" } },
        },
      },
    };
    const parsed = AppConfigSchema.parse(live);
    expect(parsed.memory.enabled).toBe(true);
    expect(parsed.agents.default!.learning.enabled).toBe(true);
    expect(parsed.agents.default!.learning.reflect.schedule).toBe("0 3 * * *");
  });

  it("a live config carrying a per-loop learning key is rejected at parse (the documented operator-update path)", () => {
    expect(() =>
      AppConfigSchema.parse({ agents: { default: { learningSkills: { enabled: true } } } }),
    ).toThrow();
  });
});
