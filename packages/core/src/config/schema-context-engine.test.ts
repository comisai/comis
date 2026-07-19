// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ContextEngineConfigSchema } from "./schema-agent/index.js";

// ---------------------------------------------------------------------------
// ContextEngineConfigSchema
// ---------------------------------------------------------------------------

describe("ContextEngineConfigSchema", () => {
  // -------------------------------------------------------------------------
  // Core defaults
  // -------------------------------------------------------------------------

  it("produces valid defaults from empty object", () => {
    const result = ContextEngineConfigSchema.parse({});
    expect(result).toEqual({
      // Core
      enabled: true,
      // Shared
      thinkingKeepTurns: 10,
      replayDriftIdleMs: 30 * 60_000,
      // Empty default; runtime resolution picks fast-tier from primary
      // provider via pi-ai catalog (resolveCompactionModel).
      compactionModel: "",
      evictionMinAge: 15,
      outputEscalation: { enabled: true, escalatedMaxTokens: 32_768 },
      // Durable context
      freshTailTurns: 8,
      contextThreshold: 0.75,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 1_200,
      condensedTargetTokens: 2_000,
      maxExpandTokens: 4_000,
      maxRecallsPerDay: 10,
      recallTimeoutMs: 120_000,
      largeFileTokenThreshold: 25_000,
      annotationKeepWindow: 15,
      annotationTriggerChars: 200_000,
      // Post-batch continuation
      postBatchContinuation: { enabled: true, maxRetries: 2 },
      // Robustness / spend / deferred-compaction knobs
      deferCompaction: true,
      summarizerSpend: { maxTokensPerTenantPerHour: 500_000, maxTokensPerTenantPerDay: 5_000_000 },
      summarizerBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenTimeoutMs: 30_000 },
      // Capacity + prompt-security knobs
      budget: { effectiveContextCapSmall: 32_000, effectiveContextCapNano: 16_000, minVisibleOutputTokens: 768 },
      compactPrompt: { enabled: true, targetTokens: 3_000 },
      compaction: { preferEvictionByCapability: true, strongerSummarizerModel: "", summarizerFallbackProviders: [] },
      // LCD→LTM distillation (default-OFF)
      memory: { distillFromLcd: { enabled: false, minDepth: 1, dedupCosineThreshold: 0.92 } },
    });
  });

  it("accepts full override including durable context fields", () => {
    const result = ContextEngineConfigSchema.parse({
      enabled: false,
      thinkingKeepTurns: 5,
      compactionModel: "groq:llama-3.3-70b-versatile",
      evictionMinAge: 20,
      outputEscalation: { enabled: false, escalatedMaxTokens: 16_384 },
      freshTailTurns: 12,
      contextThreshold: 0.85,
      leafMinFanout: 10,
      condensedMinFanout: 6,
      condensedMinFanoutHard: 3,
      incrementalMaxDepth: 5,
      leafChunkTokens: 30_000,
      leafTargetTokens: 2_000,
      condensedTargetTokens: 3_000,
      maxExpandTokens: 8_000,
      maxRecallsPerDay: 20,
      recallTimeoutMs: 300_000,
      largeFileTokenThreshold: 50_000,
      annotationKeepWindow: 20,
      annotationTriggerChars: 400_000,
      summaryModel: "anthropic:claude-sonnet-4-5-20250929",
      summaryProvider: "anthropic",
    });
    expect(result).toEqual({
      enabled: false,
      thinkingKeepTurns: 5,
      replayDriftIdleMs: 30 * 60_000,
      compactionModel: "groq:llama-3.3-70b-versatile",
      evictionMinAge: 20,
      outputEscalation: { enabled: false, escalatedMaxTokens: 16_384 },
      freshTailTurns: 12,
      contextThreshold: 0.85,
      leafMinFanout: 10,
      condensedMinFanout: 6,
      condensedMinFanoutHard: 3,
      incrementalMaxDepth: 5,
      leafChunkTokens: 30_000,
      leafTargetTokens: 2_000,
      condensedTargetTokens: 3_000,
      maxExpandTokens: 8_000,
      maxRecallsPerDay: 20,
      recallTimeoutMs: 300_000,
      largeFileTokenThreshold: 50_000,
      annotationKeepWindow: 20,
      annotationTriggerChars: 400_000,
      summaryModel: "anthropic:claude-sonnet-4-5-20250929",
      summaryProvider: "anthropic",
      // Post-batch continuation defaults (not overridden in this test)
      postBatchContinuation: { enabled: true, maxRetries: 2 },
      // Robustness / spend knobs (not overridden in this test — default through)
      deferCompaction: true,
      summarizerSpend: { maxTokensPerTenantPerHour: 500_000, maxTokensPerTenantPerDay: 5_000_000 },
      summarizerBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenTimeoutMs: 30_000 },
      // Capacity + prompt-security knobs (not overridden in this test — default through)
      budget: { effectiveContextCapSmall: 32_000, effectiveContextCapNano: 16_000, minVisibleOutputTokens: 768 },
      compactPrompt: { enabled: true, targetTokens: 3_000 },
      compaction: { preferEvictionByCapability: true, strongerSummarizerModel: "", summarizerFallbackProviders: [] },
      // LCD→LTM distillation (not overridden in this test — default through)
      memory: { distillFromLcd: { enabled: false, minDepth: 1, dedupCosineThreshold: 0.92 } },
    });
  });

  // -------------------------------------------------------------------------
  // postBatchContinuation
  // -------------------------------------------------------------------------

  describe("postBatchContinuation", () => {
    it("rejects maxRetries > 5", () => {
      const result = ContextEngineConfigSchema.safeParse({
        postBatchContinuation: { enabled: true, maxRetries: 6 },
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // replayDriftIdleMs
  // -------------------------------------------------------------------------

  describe("replayDriftIdleMs", () => {
    it("defaults to 30 minutes (1_800_000 ms)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.replayDriftIdleMs).toBe(30 * 60_000);
    });

    it("accepts boundary values (60_000 and 24h)", () => {
      const min = ContextEngineConfigSchema.parse({ replayDriftIdleMs: 60_000 });
      expect(min.replayDriftIdleMs).toBe(60_000);

      const max = ContextEngineConfigSchema.parse({ replayDriftIdleMs: 24 * 60 * 60_000 });
      expect(max.replayDriftIdleMs).toBe(24 * 60 * 60_000);
    });

    it("rejects below minimum (59_999 ms)", () => {
      const result = ContextEngineConfigSchema.safeParse({ replayDriftIdleMs: 59_999 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (24h + 1ms)", () => {
      const result = ContextEngineConfigSchema.safeParse({ replayDriftIdleMs: 24 * 60 * 60_000 + 1 });
      expect(result.success).toBe(false);
    });

    it("rejects a non-integer replayDriftIdleMs", () => {
      const result = ContextEngineConfigSchema.safeParse({ replayDriftIdleMs: 60_500.5 });
      expect(result.success).toBe(false);
    });
  });

  it("rejects unknown keys (strictObject enforcement)", () => {
    const result = ContextEngineConfigSchema.safeParse({
      enabled: true,
      unknownField: "should be rejected",
    });
    expect(result.success).toBe(false);
  });

  // Regression: ensure no new required fields were added
  it("regression: empty object still valid (no new required fields)", () => {
    const result = ContextEngineConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // thinkingKeepTurns
  // -------------------------------------------------------------------------

  describe("thinkingKeepTurns", () => {
    it("defaults thinkingKeepTurns to 10 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.thinkingKeepTurns).toBe(10);
    });

    it("accepts boundary values (1 and 50)", () => {
      const min = ContextEngineConfigSchema.parse({ thinkingKeepTurns: 1 });
      expect(min.thinkingKeepTurns).toBe(1);

      const max = ContextEngineConfigSchema.parse({ thinkingKeepTurns: 50 });
      expect(max.thinkingKeepTurns).toBe(50);
    });

    it("rejects below minimum (0)", () => {
      const result = ContextEngineConfigSchema.safeParse({ thinkingKeepTurns: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (51)", () => {
      const result = ContextEngineConfigSchema.safeParse({ thinkingKeepTurns: 51 });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer values", () => {
      const result = ContextEngineConfigSchema.safeParse({ thinkingKeepTurns: 5.5 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // compactionModel
  // -------------------------------------------------------------------------

  describe("compactionModel", () => {
    it("defaults to empty string (runtime resolution via pi-ai catalog)", () => {
      // The schema default is "" — deliberately NOT a hardcoded Anthropic
      // literal. Empty string triggers
      // resolveCompactionModel() at runtime to pick the fast-tier model from
      // the agent's primary provider, so a primary of OpenRouter/Google/etc.
      // never cross-routes compaction to Claude.
      const result = ContextEngineConfigSchema.parse({});
      expect(result.compactionModel).toBe("");
    });

    it("accepts a provider:modelId string (operator override is preserved)", () => {
      const result = ContextEngineConfigSchema.parse({ compactionModel: "groq:llama-3.3-70b-versatile" });
      expect(result.compactionModel).toBe("groq:llama-3.3-70b-versatile");
    });

    it("accepts empty string (triggers runtime resolution downstream)", () => {
      const result = ContextEngineConfigSchema.parse({ compactionModel: "" });
      expect(result.compactionModel).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // evictionMinAge
  // -------------------------------------------------------------------------

  describe("evictionMinAge", () => {
    it("defaults evictionMinAge to 15 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.evictionMinAge).toBe(15);
    });

    it("accepts boundary values (3 and 50)", () => {
      const min = ContextEngineConfigSchema.parse({ evictionMinAge: 3 });
      expect(min.evictionMinAge).toBe(3);

      const max = ContextEngineConfigSchema.parse({ evictionMinAge: 50 });
      expect(max.evictionMinAge).toBe(50);
    });

    it("rejects below minimum (2)", () => {
      const result = ContextEngineConfigSchema.safeParse({ evictionMinAge: 2 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (51)", () => {
      const result = ContextEngineConfigSchema.safeParse({ evictionMinAge: 51 });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer values", () => {
      const result = ContextEngineConfigSchema.safeParse({ evictionMinAge: 10.5 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // freshTailTurns (DAG)
  // -------------------------------------------------------------------------

  describe("freshTailTurns", () => {
    it("defaults freshTailTurns to 8 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.freshTailTurns).toBe(8);
    });

    it("accepts boundary values (1 and 50)", () => {
      const min = ContextEngineConfigSchema.parse({ freshTailTurns: 1 });
      expect(min.freshTailTurns).toBe(1);

      const max = ContextEngineConfigSchema.parse({ freshTailTurns: 50 });
      expect(max.freshTailTurns).toBe(50);
    });

    it("rejects below minimum (0)", () => {
      const result = ContextEngineConfigSchema.safeParse({ freshTailTurns: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (51)", () => {
      const result = ContextEngineConfigSchema.safeParse({ freshTailTurns: 51 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // contextThreshold (DAG)
  // -------------------------------------------------------------------------

  describe("contextThreshold", () => {
    it("defaults contextThreshold to 0.75 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.contextThreshold).toBe(0.75);
    });

    it("accepts boundary values (0.1 and 0.95)", () => {
      const min = ContextEngineConfigSchema.parse({ contextThreshold: 0.1 });
      expect(min.contextThreshold).toBe(0.1);

      const max = ContextEngineConfigSchema.parse({ contextThreshold: 0.95 });
      expect(max.contextThreshold).toBe(0.95);
    });

    it("rejects below minimum (0.09)", () => {
      const result = ContextEngineConfigSchema.safeParse({ contextThreshold: 0.09 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (0.96)", () => {
      const result = ContextEngineConfigSchema.safeParse({ contextThreshold: 0.96 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // leafMinFanout (DAG)
  // -------------------------------------------------------------------------

  describe("leafMinFanout", () => {
    it("defaults leafMinFanout to 8 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.leafMinFanout).toBe(8);
    });

    it("accepts boundary values (2 and 20)", () => {
      const min = ContextEngineConfigSchema.parse({ leafMinFanout: 2 });
      expect(min.leafMinFanout).toBe(2);

      const max = ContextEngineConfigSchema.parse({ leafMinFanout: 20 });
      expect(max.leafMinFanout).toBe(20);
    });

    it("rejects below minimum (1)", () => {
      const result = ContextEngineConfigSchema.safeParse({ leafMinFanout: 1 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (21)", () => {
      const result = ContextEngineConfigSchema.safeParse({ leafMinFanout: 21 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // condensedMinFanout (DAG)
  // -------------------------------------------------------------------------

  describe("condensedMinFanout", () => {
    it("defaults condensedMinFanout to 4 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.condensedMinFanout).toBe(4);
    });

    it("accepts boundary values (2 and 20)", () => {
      const min = ContextEngineConfigSchema.parse({ condensedMinFanout: 2 });
      expect(min.condensedMinFanout).toBe(2);

      const max = ContextEngineConfigSchema.parse({ condensedMinFanout: 20 });
      expect(max.condensedMinFanout).toBe(20);
    });

    it("rejects below minimum (1)", () => {
      const result = ContextEngineConfigSchema.safeParse({ condensedMinFanout: 1 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (21)", () => {
      const result = ContextEngineConfigSchema.safeParse({ condensedMinFanout: 21 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // condensedMinFanoutHard (DAG)
  // -------------------------------------------------------------------------

  describe("condensedMinFanoutHard", () => {
    it("defaults condensedMinFanoutHard to 2 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.condensedMinFanoutHard).toBe(2);
    });

    it("accepts boundary values (2 and 10)", () => {
      const min = ContextEngineConfigSchema.parse({ condensedMinFanoutHard: 2 });
      expect(min.condensedMinFanoutHard).toBe(2);

      const max = ContextEngineConfigSchema.parse({ condensedMinFanoutHard: 10 });
      expect(max.condensedMinFanoutHard).toBe(10);
    });

    it("rejects below minimum (1)", () => {
      const result = ContextEngineConfigSchema.safeParse({ condensedMinFanoutHard: 1 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (11)", () => {
      const result = ContextEngineConfigSchema.safeParse({ condensedMinFanoutHard: 11 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // incrementalMaxDepth (DAG)
  // -------------------------------------------------------------------------

  describe("incrementalMaxDepth", () => {
    it("defaults incrementalMaxDepth to 0 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.incrementalMaxDepth).toBe(0);
    });

    it("accepts boundary values (-1 and 10)", () => {
      const min = ContextEngineConfigSchema.parse({ incrementalMaxDepth: -1 });
      expect(min.incrementalMaxDepth).toBe(-1);

      const max = ContextEngineConfigSchema.parse({ incrementalMaxDepth: 10 });
      expect(max.incrementalMaxDepth).toBe(10);
    });

    it("rejects below minimum (-2)", () => {
      const result = ContextEngineConfigSchema.safeParse({ incrementalMaxDepth: -2 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (11)", () => {
      const result = ContextEngineConfigSchema.safeParse({ incrementalMaxDepth: 11 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // leafChunkTokens (DAG)
  // -------------------------------------------------------------------------

  describe("leafChunkTokens", () => {
    it("defaults leafChunkTokens to 20000 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.leafChunkTokens).toBe(20_000);
    });

    it("accepts boundary values (1000 and 100000)", () => {
      const min = ContextEngineConfigSchema.parse({ leafChunkTokens: 1000 });
      expect(min.leafChunkTokens).toBe(1000);

      const max = ContextEngineConfigSchema.parse({ leafChunkTokens: 100_000 });
      expect(max.leafChunkTokens).toBe(100_000);
    });

    it("rejects below minimum (999)", () => {
      const result = ContextEngineConfigSchema.safeParse({ leafChunkTokens: 999 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (100001)", () => {
      const result = ContextEngineConfigSchema.safeParse({ leafChunkTokens: 100_001 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // leafTargetTokens (DAG)
  // -------------------------------------------------------------------------

  describe("leafTargetTokens", () => {
    it("defaults leafTargetTokens to 1200 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.leafTargetTokens).toBe(1_200);
    });

    it("accepts boundary values (96 and 5000)", () => {
      const min = ContextEngineConfigSchema.parse({ leafTargetTokens: 96 });
      expect(min.leafTargetTokens).toBe(96);

      const max = ContextEngineConfigSchema.parse({ leafTargetTokens: 5_000 });
      expect(max.leafTargetTokens).toBe(5_000);
    });

    it("rejects below minimum (95)", () => {
      const result = ContextEngineConfigSchema.safeParse({ leafTargetTokens: 95 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (5001)", () => {
      const result = ContextEngineConfigSchema.safeParse({ leafTargetTokens: 5_001 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // condensedTargetTokens (DAG)
  // -------------------------------------------------------------------------

  describe("condensedTargetTokens", () => {
    it("defaults condensedTargetTokens to 2000 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.condensedTargetTokens).toBe(2_000);
    });

    it("accepts boundary values (256 and 10000)", () => {
      const min = ContextEngineConfigSchema.parse({ condensedTargetTokens: 256 });
      expect(min.condensedTargetTokens).toBe(256);

      const max = ContextEngineConfigSchema.parse({ condensedTargetTokens: 10_000 });
      expect(max.condensedTargetTokens).toBe(10_000);
    });

    it("rejects below minimum (255)", () => {
      const result = ContextEngineConfigSchema.safeParse({ condensedTargetTokens: 255 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (10001)", () => {
      const result = ContextEngineConfigSchema.safeParse({ condensedTargetTokens: 10_001 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // maxExpandTokens (DAG)
  // -------------------------------------------------------------------------

  describe("maxExpandTokens", () => {
    it("defaults maxExpandTokens to 4000 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.maxExpandTokens).toBe(4_000);
    });

    it("accepts boundary values (500 and 50000)", () => {
      const min = ContextEngineConfigSchema.parse({ maxExpandTokens: 500 });
      expect(min.maxExpandTokens).toBe(500);

      const max = ContextEngineConfigSchema.parse({ maxExpandTokens: 50_000 });
      expect(max.maxExpandTokens).toBe(50_000);
    });

    it("rejects below minimum (499)", () => {
      const result = ContextEngineConfigSchema.safeParse({ maxExpandTokens: 499 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (50001)", () => {
      const result = ContextEngineConfigSchema.safeParse({ maxExpandTokens: 50_001 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // maxRecallsPerDay (DAG)
  // -------------------------------------------------------------------------

  describe("maxRecallsPerDay", () => {
    it("defaults maxRecallsPerDay to 10 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.maxRecallsPerDay).toBe(10);
    });

    it("accepts boundary values (1 and 100)", () => {
      const min = ContextEngineConfigSchema.parse({ maxRecallsPerDay: 1 });
      expect(min.maxRecallsPerDay).toBe(1);

      const max = ContextEngineConfigSchema.parse({ maxRecallsPerDay: 100 });
      expect(max.maxRecallsPerDay).toBe(100);
    });

    it("rejects below minimum (0)", () => {
      const result = ContextEngineConfigSchema.safeParse({ maxRecallsPerDay: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (101)", () => {
      const result = ContextEngineConfigSchema.safeParse({ maxRecallsPerDay: 101 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // recallTimeoutMs (DAG)
  // -------------------------------------------------------------------------

  describe("recallTimeoutMs", () => {
    it("defaults recallTimeoutMs to 120000 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.recallTimeoutMs).toBe(120_000);
    });

    it("accepts boundary values (10000 and 600000)", () => {
      const min = ContextEngineConfigSchema.parse({ recallTimeoutMs: 10_000 });
      expect(min.recallTimeoutMs).toBe(10_000);

      const max = ContextEngineConfigSchema.parse({ recallTimeoutMs: 600_000 });
      expect(max.recallTimeoutMs).toBe(600_000);
    });

    it("rejects below minimum (9999)", () => {
      const result = ContextEngineConfigSchema.safeParse({ recallTimeoutMs: 9_999 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (600001)", () => {
      const result = ContextEngineConfigSchema.safeParse({ recallTimeoutMs: 600_001 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // largeFileTokenThreshold (DAG)
  // -------------------------------------------------------------------------

  describe("largeFileTokenThreshold", () => {
    it("defaults largeFileTokenThreshold to 25000 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.largeFileTokenThreshold).toBe(25_000);
    });

    it("accepts boundary values (1000 and 200000)", () => {
      const min = ContextEngineConfigSchema.parse({ largeFileTokenThreshold: 1000 });
      expect(min.largeFileTokenThreshold).toBe(1000);

      const max = ContextEngineConfigSchema.parse({ largeFileTokenThreshold: 200_000 });
      expect(max.largeFileTokenThreshold).toBe(200_000);
    });

    it("rejects below minimum (999)", () => {
      const result = ContextEngineConfigSchema.safeParse({ largeFileTokenThreshold: 999 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (200001)", () => {
      const result = ContextEngineConfigSchema.safeParse({ largeFileTokenThreshold: 200_001 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // annotationKeepWindow (DAG)
  // -------------------------------------------------------------------------

  describe("annotationKeepWindow", () => {
    it("defaults annotationKeepWindow to 15 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.annotationKeepWindow).toBe(15);
    });

    it("accepts boundary values (1 and 50)", () => {
      const min = ContextEngineConfigSchema.parse({ annotationKeepWindow: 1 });
      expect(min.annotationKeepWindow).toBe(1);

      const max = ContextEngineConfigSchema.parse({ annotationKeepWindow: 50 });
      expect(max.annotationKeepWindow).toBe(50);
    });

    it("rejects below minimum (0)", () => {
      const result = ContextEngineConfigSchema.safeParse({ annotationKeepWindow: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (51)", () => {
      const result = ContextEngineConfigSchema.safeParse({ annotationKeepWindow: 51 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // annotationTriggerChars (DAG)
  // -------------------------------------------------------------------------

  describe("annotationTriggerChars", () => {
    it("defaults annotationTriggerChars to 200000 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.annotationTriggerChars).toBe(200_000);
    });

    it("accepts boundary values (10000 and 1000000)", () => {
      const min = ContextEngineConfigSchema.parse({ annotationTriggerChars: 10_000 });
      expect(min.annotationTriggerChars).toBe(10_000);

      const max = ContextEngineConfigSchema.parse({ annotationTriggerChars: 1_000_000 });
      expect(max.annotationTriggerChars).toBe(1_000_000);
    });

    it("rejects below minimum (9999)", () => {
      const result = ContextEngineConfigSchema.safeParse({ annotationTriggerChars: 9_999 });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (1000001)", () => {
      const result = ContextEngineConfigSchema.safeParse({ annotationTriggerChars: 1_000_001 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // summaryModel and summaryProvider (DAG optional)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // outputEscalation
  // -------------------------------------------------------------------------

  describe("outputEscalation", () => {
    it("defaults to { enabled: true, escalatedMaxTokens: 32768 }", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.outputEscalation).toEqual({
        enabled: true,
        escalatedMaxTokens: 32_768,
      });
    });

    it("accepts custom override", () => {
      const result = ContextEngineConfigSchema.parse({
        outputEscalation: { enabled: false, escalatedMaxTokens: 16_384 },
      });
      expect(result.outputEscalation).toEqual({
        enabled: false,
        escalatedMaxTokens: 16_384,
      });
    });

    it("accepts partial override (defaults fill in)", () => {
      const result = ContextEngineConfigSchema.parse({
        outputEscalation: { enabled: false },
      });
      expect(result.outputEscalation).toEqual({
        enabled: false,
        escalatedMaxTokens: 32_768,
      });
    });

    it("accepts boundary values for escalatedMaxTokens (4096 and 128000)", () => {
      const min = ContextEngineConfigSchema.parse({
        outputEscalation: { escalatedMaxTokens: 4096 },
      });
      expect(min.outputEscalation.escalatedMaxTokens).toBe(4096);

      const max = ContextEngineConfigSchema.parse({
        outputEscalation: { escalatedMaxTokens: 128_000 },
      });
      expect(max.outputEscalation.escalatedMaxTokens).toBe(128_000);
    });

    it("rejects escalatedMaxTokens below minimum (4095)", () => {
      const result = ContextEngineConfigSchema.safeParse({
        outputEscalation: { escalatedMaxTokens: 4095 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects escalatedMaxTokens above maximum (128001)", () => {
      const result = ContextEngineConfigSchema.safeParse({
        outputEscalation: { escalatedMaxTokens: 128_001 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer escalatedMaxTokens", () => {
      const result = ContextEngineConfigSchema.safeParse({
        outputEscalation: { escalatedMaxTokens: 8192.5 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys inside outputEscalation (strictObject)", () => {
      const result = ContextEngineConfigSchema.safeParse({
        outputEscalation: { enabled: true, unknownField: "bad" },
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // summaryModel and summaryProvider (DAG optional)
  // -------------------------------------------------------------------------

  describe("summaryModel", () => {
    it("is optional (omission valid)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.summaryModel).toBeUndefined();
    });

    it("accepts a string value", () => {
      const result = ContextEngineConfigSchema.parse({ summaryModel: "anthropic:claude-sonnet-4-5-20250929" });
      expect(result.summaryModel).toBe("anthropic:claude-sonnet-4-5-20250929");
    });
  });

  describe("summaryProvider", () => {
    it("is optional (omission valid)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.summaryProvider).toBeUndefined();
    });

    it("accepts a string value", () => {
      const result = ContextEngineConfigSchema.parse({ summaryProvider: "anthropic" });
      expect(result.summaryProvider).toBe("anthropic");
    });
  });

  // -------------------------------------------------------------------------
  // deferCompaction — deferred-by-default afterTurn compaction
  // -------------------------------------------------------------------------

  describe("deferCompaction", () => {
    it("defaults to true (afterTurn leaf + condense passes run off the per-conversation serializer, never blocking the turn)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.deferCompaction).toBe(true);
    });

    it("accepts false (inline compaction for deterministic tests)", () => {
      const result = ContextEngineConfigSchema.parse({ deferCompaction: false });
      expect(result.deferCompaction).toBe(false);
    });

    it("rejects a non-boolean value", () => {
      const result = ContextEngineConfigSchema.safeParse({ deferCompaction: "yes" });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // summarizerSpend — per-tenant summarizer token-spend ceilings
  // -------------------------------------------------------------------------

  describe("summarizerSpend", () => {
    it("defaults to a fully-populated object with sane per-tenant hour + day ceilings", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.summarizerSpend).toEqual({
        maxTokensPerTenantPerHour: 500_000,
        maxTokensPerTenantPerDay: 5_000_000,
      });
    });

    it("accepts a custom per-tenant ceiling override", () => {
      const result = ContextEngineConfigSchema.parse({
        summarizerSpend: { maxTokensPerTenantPerHour: 100_000, maxTokensPerTenantPerDay: 1_000_000 },
      });
      expect(result.summarizerSpend).toEqual({
        maxTokensPerTenantPerHour: 100_000,
        maxTokensPerTenantPerDay: 1_000_000,
      });
    });

    it("accepts a partial override (the other ceiling fills from default)", () => {
      const result = ContextEngineConfigSchema.parse({
        summarizerSpend: { maxTokensPerTenantPerHour: 250_000 },
      });
      expect(result.summarizerSpend).toEqual({
        maxTokensPerTenantPerHour: 250_000,
        maxTokensPerTenantPerDay: 5_000_000,
      });
    });

    it("accepts 0 (the cap-disabled sentinel) for both ceilings", () => {
      const result = ContextEngineConfigSchema.parse({
        summarizerSpend: { maxTokensPerTenantPerHour: 0, maxTokensPerTenantPerDay: 0 },
      });
      expect(result.summarizerSpend).toEqual({
        maxTokensPerTenantPerHour: 0,
        maxTokensPerTenantPerDay: 0,
      });
    });

    it("rejects a negative hourly ceiling", () => {
      const result = ContextEngineConfigSchema.safeParse({
        summarizerSpend: { maxTokensPerTenantPerHour: -1 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects a non-integer daily ceiling", () => {
      const result = ContextEngineConfigSchema.safeParse({
        summarizerSpend: { maxTokensPerTenantPerDay: 1_000.5 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys inside summarizerSpend (strictObject)", () => {
      const result = ContextEngineConfigSchema.safeParse({
        summarizerSpend: { maxTokensPerTenantPerHour: 1000, unknownField: "bad" },
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // budget.minVisibleOutputTokens
  // -------------------------------------------------------------------------

  describe("budget.minVisibleOutputTokens", () => {
    it("defaults to 768 when budget is omitted", () => {
      const result = ContextEngineConfigSchema.parse({});
      // The non-reasoning visible-output floor defaults to 768 tokens.
      expect(result.budget.minVisibleOutputTokens).toBe(768);
    });

    it("defaults are fully populated including minVisibleOutputTokens when budget is omitted entirely", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.budget).toEqual({
        effectiveContextCapSmall: 32_000,
        effectiveContextCapNano: 16_000,
        minVisibleOutputTokens: 768,
      });
    });

    it("accepts custom minVisibleOutputTokens override", () => {
      const result = ContextEngineConfigSchema.parse({
        budget: { minVisibleOutputTokens: 1024 },
      });
      expect(result.budget.minVisibleOutputTokens).toBe(1024);
    });

    it("accepts boundary values (256 and 8192)", () => {
      const min = ContextEngineConfigSchema.parse({
        budget: { minVisibleOutputTokens: 256 },
      });
      expect(min.budget.minVisibleOutputTokens).toBe(256);

      const max = ContextEngineConfigSchema.parse({
        budget: { minVisibleOutputTokens: 8_192 },
      });
      expect(max.budget.minVisibleOutputTokens).toBe(8_192);
    });

    it("rejects below minimum (255) — a floor too small to be useful", () => {
      const result = ContextEngineConfigSchema.safeParse({
        budget: { minVisibleOutputTokens: 255 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (8193) — a floor that would starve the input budget", () => {
      const result = ContextEngineConfigSchema.safeParse({
        budget: { minVisibleOutputTokens: 8_193 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer value", () => {
      const result = ContextEngineConfigSchema.safeParse({
        budget: { minVisibleOutputTokens: 512.5 },
      });
      expect(result.success).toBe(false);
    });

    it("fully-populated default literal works: parse({budget:{}}) gives all three budget fields", () => {
      // Zod does NOT re-parse inner field defaults from .default({}).
      // The .default({...}) literal on the parent must include ALL fields.
      const result = ContextEngineConfigSchema.parse({ budget: {} });
      expect(result.budget.effectiveContextCapSmall).toBe(32_000);
      expect(result.budget.effectiveContextCapNano).toBe(16_000);
      expect(result.budget.minVisibleOutputTokens).toBe(768);
    });
  });

  // -------------------------------------------------------------------------
  // summarizerBreaker — reuses CircuitBreakerConfigSchema
  // -------------------------------------------------------------------------

  describe("summarizerBreaker", () => {
    it("defaults to the shared CircuitBreakerConfigSchema defaults (threshold 5 / reset 60s / half-open 30s)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.summarizerBreaker).toEqual({
        failureThreshold: 5,
        resetTimeoutMs: 60_000,
        halfOpenTimeoutMs: 30_000,
      });
    });

    it("accepts a custom breaker override", () => {
      const result = ContextEngineConfigSchema.parse({
        summarizerBreaker: { failureThreshold: 3, resetTimeoutMs: 30_000, halfOpenTimeoutMs: 15_000 },
      });
      expect(result.summarizerBreaker).toEqual({
        failureThreshold: 3,
        resetTimeoutMs: 30_000,
        halfOpenTimeoutMs: 15_000,
      });
    });

    it("accepts a partial override (the rest fill from CircuitBreakerConfigSchema defaults)", () => {
      const result = ContextEngineConfigSchema.parse({
        summarizerBreaker: { failureThreshold: 2 },
      });
      expect(result.summarizerBreaker).toEqual({
        failureThreshold: 2,
        resetTimeoutMs: 60_000,
        halfOpenTimeoutMs: 30_000,
      });
    });

    it("rejects a non-positive failureThreshold (inherited from CircuitBreakerConfigSchema)", () => {
      const result = ContextEngineConfigSchema.safeParse({
        summarizerBreaker: { failureThreshold: 0 },
      });
      expect(result.success).toBe(false);
    });
  });
});
