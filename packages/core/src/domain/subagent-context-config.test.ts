import { describe, it, expect } from "vitest";
import { SubagentContextConfigSchema } from "./subagent-context-config.js";

// ---------------------------------------------------------------------------
// SubagentContextConfigSchema
// ---------------------------------------------------------------------------

describe("SubagentContextConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = SubagentContextConfigSchema.parse({});
    expect(result).toEqual({
      maxSpawnDepth: 3,
      maxChildrenPerAgent: 5,
      maxResultTokens: 4_000,
      resultRetentionMs: 86_400_000,
      condensationStrategy: "auto",
      includeParentHistory: "none",
      objectiveReinforcement: true,
      artifactPassthrough: true,
      autoCompactThreshold: 0.95,
      errorPreservation: true,
      narrativeCasting: true,
      resultTagPrefix: "Subagent Result",
      parentSummaryMaxTokens: 1_000,
      maxQueuedPerAgent: 10,
      queueTimeoutMs: 120_000,
      maxRunTimeoutMs: 600_000,
      perStepTimeoutMs: 60_000,
      graphStuckKillThresholdMs: 600_000,
      stuckKillThresholdMs: 180_000,
    });
    // condensationModel field has been deleted -- no longer in schema
    expect("condensationModel" in result).toBe(false);
  });

  it("accepts full override", () => {
    const result = SubagentContextConfigSchema.parse({
      maxSpawnDepth: 5,
      maxChildrenPerAgent: 10,
      maxResultTokens: 8_000,
      resultRetentionMs: 172_800_000,
      condensationStrategy: "always",
      includeParentHistory: "summary",
      objectiveReinforcement: false,
      artifactPassthrough: false,
      autoCompactThreshold: 0.8,
      errorPreservation: false,
      narrativeCasting: false,
      resultTagPrefix: "Custom Tag",
      parentSummaryMaxTokens: 2_000,
      maxQueuedPerAgent: 20,
      queueTimeoutMs: 60_000,
      maxRunTimeoutMs: 300_000,
      perStepTimeoutMs: 30_000,
      graphStuckKillThresholdMs: 900_000,
      stuckKillThresholdMs: 120_000,
    });
    expect(result.maxSpawnDepth).toBe(5);
    expect(result.maxChildrenPerAgent).toBe(10);
    expect(result.maxResultTokens).toBe(8_000);
    expect(result.resultRetentionMs).toBe(172_800_000);
    expect(result.condensationStrategy).toBe("always");
    expect(result.includeParentHistory).toBe("summary");
    expect(result.objectiveReinforcement).toBe(false);
    expect(result.artifactPassthrough).toBe(false);
    expect(result.autoCompactThreshold).toBe(0.8);
    expect(result.errorPreservation).toBe(false);
    expect(result.narrativeCasting).toBe(false);
    expect(result.resultTagPrefix).toBe("Custom Tag");
    expect(result.parentSummaryMaxTokens).toBe(2_000);
    expect(result.maxQueuedPerAgent).toBe(20);
    expect(result.queueTimeoutMs).toBe(60_000);
    expect(result.maxRunTimeoutMs).toBe(300_000);
    expect(result.perStepTimeoutMs).toBe(30_000);
    expect(result.graphStuckKillThresholdMs).toBe(900_000);
    expect(result.stuckKillThresholdMs).toBe(120_000);
  });

  it("rejects condensationModel key (strictObject enforcement)", () => {
    const result = SubagentContextConfigSchema.safeParse({ condensationModel: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects condensationModel key (strictObject enforcement)", () => {
    const result = SubagentContextConfigSchema.safeParse({ condensationModel: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strictObject enforcement)", () => {
    const result = SubagentContextConfigSchema.safeParse({ unknownField: true });
    expect(result.success).toBe(false);
  });

  it("rejects maxSpawnDepth below 1", () => {
    const result = SubagentContextConfigSchema.safeParse({ maxSpawnDepth: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects maxSpawnDepth above 10", () => {
    const result = SubagentContextConfigSchema.safeParse({ maxSpawnDepth: 11 });
    expect(result.success).toBe(false);
  });

  it("rejects autoCompactThreshold below 0.5", () => {
    const result = SubagentContextConfigSchema.safeParse({ autoCompactThreshold: 0.4 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid condensationStrategy", () => {
    const result = SubagentContextConfigSchema.safeParse({ condensationStrategy: "manual" });
    expect(result.success).toBe(false);
  });

  it("maxQueuedPerAgent defaults to 10", () => {
    const result = SubagentContextConfigSchema.parse({});
    expect(result.maxQueuedPerAgent).toBe(10);
  });

  it("queueTimeoutMs defaults to 120000", () => {
    const result = SubagentContextConfigSchema.parse({});
    expect(result.queueTimeoutMs).toBe(120_000);
  });

  it("maxQueuedPerAgent: 0 is valid (disables queuing)", () => {
    const result = SubagentContextConfigSchema.safeParse({ maxQueuedPerAgent: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxQueuedPerAgent).toBe(0);
  });

  it("rejects maxQueuedPerAgent above 50", () => {
    const result = SubagentContextConfigSchema.safeParse({ maxQueuedPerAgent: 51 });
    expect(result.success).toBe(false);
  });

  it("rejects queueTimeoutMs below 1000", () => {
    const result = SubagentContextConfigSchema.safeParse({ queueTimeoutMs: 999 });
    expect(result.success).toBe(false);
  });

  it("rejects queueTimeoutMs above 600000", () => {
    const result = SubagentContextConfigSchema.safeParse({ queueTimeoutMs: 600_001 });
    expect(result.success).toBe(false);
  });

  it("maxRunTimeoutMs defaults to 600000", () => {
    const result = SubagentContextConfigSchema.parse({});
    expect(result.maxRunTimeoutMs).toBe(600_000);
  });

  it("perStepTimeoutMs defaults to 60000", () => {
    const result = SubagentContextConfigSchema.parse({});
    expect(result.perStepTimeoutMs).toBe(60_000);
  });

  it("graphStuckKillThresholdMs defaults to 600000", () => {
    const result = SubagentContextConfigSchema.parse({});
    expect(result.graphStuckKillThresholdMs).toBe(600_000);
  });

  it("graphStuckKillThresholdMs accepts 0 (disables graph threshold)", () => {
    const result = SubagentContextConfigSchema.safeParse({ graphStuckKillThresholdMs: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.graphStuckKillThresholdMs).toBe(0);
  });

  it("stuckKillThresholdMs defaults to 180000", () => {
    const result = SubagentContextConfigSchema.parse({});
    expect(result.stuckKillThresholdMs).toBe(180_000);
  });

  it("stuckKillThresholdMs accepts 0 (disables regular threshold)", () => {
    const result = SubagentContextConfigSchema.safeParse({ stuckKillThresholdMs: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.stuckKillThresholdMs).toBe(0);
  });
});
