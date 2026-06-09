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
      version: "dag",
      // Shared
      thinkingKeepTurns: 10,
      replayDriftIdleMs: 30 * 60_000,
      // Empty default; runtime resolution picks fast-tier from primary
      // provider via pi-ai catalog (resolveCompactionModel).
      compactionModel: "",
      evictionMinAge: 15,
      // Pipeline
      historyTurns: 15,
      observationKeepWindow: 25,
      observationTriggerChars: 120_000,
      observationDeactivationChars: 80_000,
      ephemeralKeepWindow: 10,
      compactionCooldownTurns: 5,
      compactionPrefixAnchorTurns: 2,
      outputEscalation: { enabled: true, escalatedMaxTokens: 32_768 },
      // DAG
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
      // Post-batch continuation (replaces SEP nudge enforcement)
      postBatchContinuation: { enabled: true, maxRetries: 2 },
      // Robustness / spend / deferred-compaction knobs (Phase 132 C4 + R1)
      deferCompaction: true,
      summarizerSpend: { maxTokensPerTenantPerHour: 500_000, maxTokensPerTenantPerDay: 5_000_000 },
      summarizerBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenTimeoutMs: 30_000 },
      // Phase 152 capacity + prompt-security knobs (C1/C2/C4)
      budget: { effectiveContextCapSmall: 32_000, effectiveContextCapNano: 16_000 },
      compactPrompt: { enabled: true, targetTokens: 3_000 },
      compaction: { preferEvictionByCapability: true, strongerSummarizerModel: "" },
    });
  });

  it("accepts full override including DAG fields", () => {
    const result = ContextEngineConfigSchema.parse({
      enabled: false,
      version: "dag",
      thinkingKeepTurns: 5,
      compactionModel: "groq:llama-3.3-70b-versatile",
      evictionMinAge: 20,
      historyTurns: 20,
      historyTurnOverrides: { dm: 10, group: 5, "trader-1": 30 },
      observationKeepWindow: 30,
      observationTriggerChars: 300_000,
      observationDeactivationChars: 200_000,
      compactionCooldownTurns: 10,
      compactionPrefixAnchorTurns: 4,
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
      version: "dag",
      thinkingKeepTurns: 5,
      replayDriftIdleMs: 30 * 60_000,
      compactionModel: "groq:llama-3.3-70b-versatile",
      evictionMinAge: 20,
      historyTurns: 20,
      historyTurnOverrides: { dm: 10, group: 5, "trader-1": 30 },
      observationKeepWindow: 30,
      observationTriggerChars: 300_000,
      observationDeactivationChars: 200_000,
      ephemeralKeepWindow: 10,
      compactionCooldownTurns: 10,
      compactionPrefixAnchorTurns: 4,
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
      // Phase 132 knobs (not overridden in this test — default through)
      deferCompaction: true,
      summarizerSpend: { maxTokensPerTenantPerHour: 500_000, maxTokensPerTenantPerDay: 5_000_000 },
      summarizerBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenTimeoutMs: 30_000 },
      // Phase 152 knobs (not overridden in this test — default through)
      budget: { effectiveContextCapSmall: 32_000, effectiveContextCapNano: 16_000 },
      compactPrompt: { enabled: true, targetTokens: 3_000 },
      compaction: { preferEvictionByCapability: true, strongerSummarizerModel: "" },
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
  // version
  // -------------------------------------------------------------------------

  describe("version", () => {
    it("version defaults to 'dag' when unset (Phase 133 re-enables dag as the default working-context engine)", () => {
      // Phase 133 (the v2.12 GA keystone) flips the default pipeline -> dag.
      // The lossless LCD (dag) engine is now the live default for every agent
      // that omits `version`; the simpler sequential-layer pipeline engine is
      // the first-class opt-in. This is the durable regression gate for the
      // keystone flip.
      const result = ContextEngineConfigSchema.parse({});
      expect(result.version).toBe("dag");
    });

    it("accepts the explicit 'pipeline' version value", () => {
      const result = ContextEngineConfigSchema.parse({ version: "pipeline" });
      expect(result.version).toBe("pipeline");
    });

    it("explicit version 'dag' parses to 'dag' (the default LCD engine, explicitly pinned)", () => {
      // "dag" (the LCD engine) is the default since Phase 133; pinning it
      // explicitly is equivalent to omitting `version`. Selecting it does not
      // throw; with a context store wired the factory builds the LCD engine,
      // and a storeless caller falls back to pipeline with a logged warning
      // (see the c2 test in
      // packages/agent/src/context-engine/context-engine.test.ts).
      expect(() => ContextEngineConfigSchema.parse({ version: "dag" })).not.toThrow();
      const result = ContextEngineConfigSchema.parse({ version: "dag" });
      expect(result.version).toBe("dag");
    });

    it("rejects unknown version string", () => {
      const result = ContextEngineConfigSchema.safeParse({ version: "unknown" });
      expect(result.success).toBe(false);
    });
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
      // Schema default changed from a hardcoded Anthropic literal
      // ("anthropic:claude-haiku-4-5-20250929") to "". Empty string triggers
      // resolveCompactionModel() at runtime to pick the fast-tier model from
      // the agent's primary provider — closes the cross-provider routing bug
      // where switching primary to OpenRouter still routed compaction to Claude.
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
    it("defaults to 15 (user-locked, not design's 10)", () => {
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
  // historyTurns
  // -------------------------------------------------------------------------

  describe("historyTurns", () => {
    it("defaults historyTurns to 15 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.historyTurns).toBe(15);
    });

    it("accepts valid int in range [3, 100]", () => {
      const low = ContextEngineConfigSchema.parse({ historyTurns: 3 });
      expect(low.historyTurns).toBe(3);

      const mid = ContextEngineConfigSchema.parse({ historyTurns: 50 });
      expect(mid.historyTurns).toBe(50);

      const high = ContextEngineConfigSchema.parse({ historyTurns: 100 });
      expect(high.historyTurns).toBe(100);
    });

    it("rejects values below 3", () => {
      const result = ContextEngineConfigSchema.safeParse({ historyTurns: 2 });
      expect(result.success).toBe(false);
    });

    it("rejects values above 100", () => {
      const result = ContextEngineConfigSchema.safeParse({ historyTurns: 101 });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer values", () => {
      const result = ContextEngineConfigSchema.safeParse({ historyTurns: 10.5 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // historyTurnOverrides
  // -------------------------------------------------------------------------

  describe("historyTurnOverrides", () => {
    it("accepts { dm: 10, group: 5 }", () => {
      const result = ContextEngineConfigSchema.parse({
        historyTurnOverrides: { dm: 10, group: 5 },
      });
      expect(result.historyTurnOverrides).toEqual({ dm: 10, group: 5 });
    });

    it("is optional (omission is valid)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.historyTurnOverrides).toBeUndefined();
    });

    it("rejects override values below 1", () => {
      const result = ContextEngineConfigSchema.safeParse({
        historyTurnOverrides: { dm: 0 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects override values above 100", () => {
      const result = ContextEngineConfigSchema.safeParse({
        historyTurnOverrides: { dm: 101 },
      });
      expect(result.success).toBe(false);
    });

    it("accepts per-agent overrides (Record<string, number>)", () => {
      const result = ContextEngineConfigSchema.parse({
        historyTurnOverrides: { "trader-1": 30, "trader-2": 25 },
      });
      expect(result.historyTurnOverrides).toEqual({ "trader-1": 30, "trader-2": 25 });
    });
  });

  // -------------------------------------------------------------------------
  // observationKeepWindow
  // -------------------------------------------------------------------------

  describe("observationKeepWindow", () => {
    it("defaults to 25 (updated from 15)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.observationKeepWindow).toBe(25);
    });

    it("accepts custom override", () => {
      const result = ContextEngineConfigSchema.parse({ observationKeepWindow: 30 });
      expect(result.observationKeepWindow).toBe(30);
    });

    it("accepts boundary values (1 and 50)", () => {
      const min = ContextEngineConfigSchema.parse({ observationKeepWindow: 1 });
      expect(min.observationKeepWindow).toBe(1);

      const max = ContextEngineConfigSchema.parse({ observationKeepWindow: 50 });
      expect(max.observationKeepWindow).toBe(50);
    });

    it("rejects 0 (below minimum)", () => {
      const result = ContextEngineConfigSchema.safeParse({ observationKeepWindow: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects 51 (above maximum)", () => {
      const result = ContextEngineConfigSchema.safeParse({ observationKeepWindow: 51 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // observationTriggerChars
  // -------------------------------------------------------------------------

  describe("observationTriggerChars", () => {
    it("defaults to 120000 (updated from 200000)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.observationTriggerChars).toBe(120_000);
    });

    it("accepts custom override", () => {
      const result = ContextEngineConfigSchema.parse({ observationTriggerChars: 500_000 });
      expect(result.observationTriggerChars).toBe(500_000);
    });

    it("accepts boundary values (50000 and 1000000)", () => {
      const min = ContextEngineConfigSchema.parse({ observationTriggerChars: 50_000 });
      expect(min.observationTriggerChars).toBe(50_000);

      const max = ContextEngineConfigSchema.parse({ observationTriggerChars: 1_000_000 });
      expect(max.observationTriggerChars).toBe(1_000_000);
    });

    it("rejects 49999 (below minimum)", () => {
      const result = ContextEngineConfigSchema.safeParse({ observationTriggerChars: 49_999 });
      expect(result.success).toBe(false);
    });

    it("rejects 1000001 (above maximum)", () => {
      const result = ContextEngineConfigSchema.safeParse({ observationTriggerChars: 1_000_001 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // compactionCooldownTurns
  // -------------------------------------------------------------------------

  describe("compactionCooldownTurns", () => {
    it("defaults compactionCooldownTurns to 5 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.compactionCooldownTurns).toBe(5);
    });

    it("accepts custom override", () => {
      const result = ContextEngineConfigSchema.parse({ compactionCooldownTurns: 10 });
      expect(result.compactionCooldownTurns).toBe(10);
    });

    it("accepts boundary values (1 and 50)", () => {
      const min = ContextEngineConfigSchema.parse({ compactionCooldownTurns: 1 });
      expect(min.compactionCooldownTurns).toBe(1);

      const max = ContextEngineConfigSchema.parse({ compactionCooldownTurns: 50 });
      expect(max.compactionCooldownTurns).toBe(50);
    });

    it("rejects 0 (below minimum)", () => {
      const result = ContextEngineConfigSchema.safeParse({ compactionCooldownTurns: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects 51 (above maximum)", () => {
      const result = ContextEngineConfigSchema.safeParse({ compactionCooldownTurns: 51 });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer values", () => {
      const result = ContextEngineConfigSchema.safeParse({ compactionCooldownTurns: 3.5 });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // compactionPrefixAnchorTurns
  // -------------------------------------------------------------------------

  describe("compactionPrefixAnchorTurns", () => {
    it("defaults compactionPrefixAnchorTurns to 2 when unset", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.compactionPrefixAnchorTurns).toBe(2);
    });

    it("validates compactionPrefixAnchorTurns range (0-10)", () => {
      // min boundary
      expect(() => ContextEngineConfigSchema.parse({ compactionPrefixAnchorTurns: 0 })).not.toThrow();
      // max boundary
      expect(() => ContextEngineConfigSchema.parse({ compactionPrefixAnchorTurns: 10 })).not.toThrow();
      // below min -- negative
      expect(() => ContextEngineConfigSchema.parse({ compactionPrefixAnchorTurns: -1 })).toThrow();
      // above max
      expect(() => ContextEngineConfigSchema.parse({ compactionPrefixAnchorTurns: 11 })).toThrow();
      // non-integer
      expect(() => ContextEngineConfigSchema.parse({ compactionPrefixAnchorTurns: 1.5 })).toThrow();
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
  // deferCompaction (C4) — deferred-by-default afterTurn compaction
  // -------------------------------------------------------------------------

  describe("deferCompaction", () => {
    it("defaults to true (afterTurn leaf + condense passes run off the per-conversation serializer, never blocking the turn)", () => {
      const result = ContextEngineConfigSchema.parse({});
      expect(result.deferCompaction).toBe(true);
    });

    it("accepts false (inline pre-132 behaviour for deterministic tests)", () => {
      const result = ContextEngineConfigSchema.parse({ deferCompaction: false });
      expect(result.deferCompaction).toBe(false);
    });

    it("rejects a non-boolean value", () => {
      const result = ContextEngineConfigSchema.safeParse({ deferCompaction: "yes" });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // summarizerSpend (R1) — per-tenant summarizer token-spend ceilings
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
  // budget.minVisibleOutputTokens (Fix 3 / Phase 166 CWF-02)
  // -------------------------------------------------------------------------

  describe("budget.minVisibleOutputTokens", () => {
    it("defaults to 768 when budget is omitted", () => {
      const result = ContextEngineConfigSchema.parse({});
      // CWF-02: non-reasoning floor defaults to 768 tokens.
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

    it("rejects below minimum (255) — CWF-02 threat T-166-02-01", () => {
      const result = ContextEngineConfigSchema.safeParse({
        budget: { minVisibleOutputTokens: 255 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects above maximum (8193) — CWF-02 threat T-166-02-01", () => {
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
  // summarizerBreaker (R1) — reuses CircuitBreakerConfigSchema
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
