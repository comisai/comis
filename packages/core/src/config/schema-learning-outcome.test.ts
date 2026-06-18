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
 * Like the surrounding `memory*` cost features, learningOutcome now defaults ON
 * (`enabled:true`) — the Verified-Learning loop works out of the box (opt-out).
 * The master kill switch `memory.costFeatures.enabled` (default true) is the real
 * gate; flipping it off force-disables the loop at the cron registration site.
 * `judge.enabled` now also defaults ON (opt-out) — the LLM outcome judge is the
 * FALLBACK source that learns from a CONVERSATIONAL turn (one with no
 * deterministic tool/pipeline outcome, which would otherwise resolve to `unknown`
 * and derive no learning). It is STILL force-disabled by `memory.costFeatures.
 * enabled: false` and only runs on an `unknown` resolve (bounds its cost). The
 * schema is `z.strictObject` (unknown keys rejected) with `.default()` on every
 * field. It attaches to `PerAgentConfigSchema`.
 */
describe("LearningOutcomeConfigSchema — per-agent outcome-signal config (default ON, opt-out)", () => {
  it("parse({}) yields the documented default-ON block (enabled:true, tool/pipeline sources, judge ON)", () => {
    const cfg = LearningOutcomeConfigSchema.parse({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.sources).toEqual(["tool", "pipeline"]);
    // judge now defaults ON (opt-out) — the conversational-turn fallback source.
    expect(cfg.judge.enabled).toBe(true);
    expect(cfg.minConfidenceToLearn).toBe(0.6);
    expect(cfg.retentionDays).toBe(30);
    expect(cfg.reactionMap.success).toEqual(["👍", "✅"]);
    expect(cfg.reactionMap.failure).toEqual(["👎", "❌"]);
  });

  it("judge.enabled is opt-out: an explicit `judge: { enabled: false }` is honored (and the sub-block is strict)", () => {
    expect(LearningOutcomeConfigSchema.parse({ judge: { enabled: false } }).judge.enabled).toBe(false);
    // Zod v4 footgun guard: a POPULATED outer default must still apply the inner
    // field default, so an empty `judge: {}` yields the ON default, not undefined.
    expect(LearningOutcomeConfigSchema.parse({ judge: {} }).judge.enabled).toBe(true);
    expect(LearningOutcomeConfigSchema.safeParse({ judge: { enabled: true, bogus: 1 } }).success).toBe(false);
  });

  it("correction is a default-ON cost-gate sub-block (enabled:true — opt-out, gated by the master cost switch)", () => {
    // CORRECT-01: the correction detector runs an LLM over untrusted follow-up
    // text. It now defaults ON (opt-out) so the loop works out of the box; the
    // master cost switch `memory.costFeatures.enabled` is the real gate.
    const cfg = LearningOutcomeConfigSchema.parse({});
    expect(cfg.correction.enabled).toBe(true);
    // Explicitly opting out is honored, and the sub-block is strict (no smuggled keys).
    expect(LearningOutcomeConfigSchema.parse({ correction: { enabled: false } }).correction.enabled).toBe(
      false,
    );
    expect(
      LearningOutcomeConfigSchema.safeParse({ correction: { enabled: false, bogus: 1 } }).success,
    ).toBe(false);
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

  it("attaches to PerAgentConfigSchema — a parsed agent config exposes learningOutcome.enabled === true", () => {
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.learningOutcome.enabled).toBe(true);
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
