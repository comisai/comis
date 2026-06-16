// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
// Value imports so the RED state is reproducible from this test commit alone:
// vitest must RESOLVE both modules at runtime. `schema-learning-outcome.js` does
// not exist on the pre-patch code → the import throws and the suite is RED.
import { LearningOutcomeConfigSchema } from "./schema-learning-outcome.js";
import { PerAgentConfigSchema } from "./schema-agent/schema-agent-runtime.js";
import type { AgentEvents } from "../event-bus/events-agent.js";

/**
 * The per-agent `learningOutcome` config (OUTCOME-09).
 *
 * Unlike every surrounding `memory*` cost feature (which defaults ON / opt-out),
 * learningOutcome defaults OFF (`enabled:false`) — enabling it is a deliberate
 * operator opt-in, and the closing gate's byte-identity guarantee depends on the
 * default being disabled. The schema is `z.strictObject` (unknown keys rejected)
 * with `.default()` on every field. It attaches to `PerAgentConfigSchema`.
 */
describe("LearningOutcomeConfigSchema — per-agent outcome-signal config (default OFF)", () => {
  it("parse({}) yields the documented default-OFF block (enabled:false, tool/pipeline sources, judge off)", () => {
    const cfg = LearningOutcomeConfigSchema.parse({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.sources).toEqual(["tool", "pipeline"]);
    expect(cfg.judge.enabled).toBe(false);
    expect(cfg.minConfidenceToLearn).toBe(0.6);
    expect(cfg.retentionDays).toBe(30);
    expect(cfg.reactionMap.success).toEqual(["👍", "✅"]);
    expect(cfg.reactionMap.failure).toEqual(["👎", "❌"]);
  });

  it("is strict — an unknown key fails safeParse (no silent passthrough)", () => {
    const result = LearningOutcomeConfigSchema.safeParse({ bogusKey: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range minConfidenceToLearn ([0,1]) and non-positive-int retentionDays", () => {
    expect(LearningOutcomeConfigSchema.safeParse({ minConfidenceToLearn: 1.5 }).success).toBe(false);
    expect(LearningOutcomeConfigSchema.safeParse({ minConfidenceToLearn: -0.1 }).success).toBe(false);
    expect(LearningOutcomeConfigSchema.safeParse({ retentionDays: 0 }).success).toBe(false);
    expect(LearningOutcomeConfigSchema.safeParse({ retentionDays: 1.5 }).success).toBe(false);
    expect(LearningOutcomeConfigSchema.safeParse({ retentionDays: 30 }).success).toBe(true);
  });

  it("only accepts tool/pipeline as deterministic source enum members", () => {
    expect(LearningOutcomeConfigSchema.safeParse({ sources: ["tool"] }).success).toBe(true);
    expect(LearningOutcomeConfigSchema.safeParse({ sources: ["judge"] }).success).toBe(false);
  });

  it("attaches to PerAgentConfigSchema — a parsed agent config exposes learningOutcome.enabled === false", () => {
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.learningOutcome.enabled).toBe(false);
    expect(agent.learningOutcome.sources).toEqual(["tool", "pipeline"]);
  });
});

/**
 * The `learning:outcome_observed` event payload (OUTCOME-08).
 *
 * Counts/ids/closed-enums ONLY — never message bodies, alpha values, or
 * procedure contents (SEC-01 §7). The strict event type is the compiler-level
 * proof: a payload object type-checks with the documented fields, and adding a
 * `body` field is rejected by the compiler.
 */
describe("learning:outcome_observed event payload — counts/ids only", () => {
  it("type-checks a counts/ids-only payload and rejects a body field at compile time", () => {
    const payload: AgentEvents["learning:outcome_observed"] = {
      agentId: "a",
      traceId: "trace-1",
      trajectoryId: "trace-1",
      outcome: "success",
      source: "tool",
      confidence: 0.9,
      timestamp: 1_000,
    };
    expect(payload.outcome).toBe("success");
    expectTypeOf(payload.outcome).toEqualTypeOf<"success" | "failure" | "corrected" | "unknown">();
    expectTypeOf(payload.source).toEqualTypeOf<
      "tool" | "pipeline" | "correction" | "judge" | "reaction" | "explicit"
    >();
    // A body/content field is NOT part of the payload — adding one is a type error.
    // @ts-expect-error -- learning:outcome_observed carries ids/counts/closed-enums ONLY, never bodies.
    const leak: AgentEvents["learning:outcome_observed"] = { ...payload, body: "secret message text" };
    void leak;
  });

  it("sessionKey is optional (a cron-context emit may have no session)", () => {
    const withoutSession: AgentEvents["learning:outcome_observed"] = {
      agentId: "a",
      traceId: "trace-1",
      trajectoryId: "trace-1",
      outcome: "unknown",
      source: "pipeline",
      confidence: 0,
      timestamp: 1_000,
    };
    expect(withoutSession.sessionKey).toBeUndefined();
  });
});
