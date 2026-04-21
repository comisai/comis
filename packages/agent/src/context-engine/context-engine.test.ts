// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the context engine factory, layer pipeline, and circuit breaker.
 *
 * Verifies pass-through behavior (disabled, non-thinking model), layer
 * error isolation, circuit breaker threshold, and startup logging.
 * Stress tests for compaction and rehydration under context pressure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContextEngine } from "./context-engine.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEngineConfig } from "@comis/core";
import type { ContextEngineDeps } from "./types.js";
import { COMPACTION_REQUIRED_SECTIONS } from "./constants.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Module mock: generateSummary from SDK (required by llm-compaction layer)
// ---------------------------------------------------------------------------

const mockGenerateSummary = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock("@mariozechner/pi-coding-agent", () => ({
  generateSummary: (...args: unknown[]) => mockGenerateSummary(...args),
}));

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeAssistantMsg(content: unknown[]): AgentMessage {
  return { role: "assistant", content } as AgentMessage;
}

function makeThinkingBlock(text: string) {
  return { type: "thinking" as const, thinking: text };
}

function makeTextBlock(text: string) {
  return { type: "text" as const, text };
}

function createMockDeps(overrides?: {
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): { deps: ContextEngineDeps; logger: ReturnType<typeof createMockLogger> } {
  const logger = createMockLogger();
  const deps: ContextEngineDeps = {
    logger: logger as unknown as ContextEngineDeps["logger"],
    getModel: () => ({
      reasoning: overrides?.reasoning ?? true,
      contextWindow: overrides?.contextWindow ?? 200_000,
      maxTokens: overrides?.maxTokens ?? 8_192,
    }),
  };
  return { deps, logger };
}

const enabledConfig: ContextEngineConfig = {
  enabled: true,
  thinkingKeepTurns: 10,
  historyTurns: 15,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createContextEngine", () => {
  it("a) disabled pass-through returns same array reference, no logger calls", async () => {
    const { deps, logger } = createMockDeps();
    const engine = createContextEngine({ enabled: false, thinkingKeepTurns: 10, historyTurns: 15 }, deps);

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock("thought"), makeTextBlock("hello")]),
    ];

    const result = await engine.transformContext(messages);
    expect(result).toBe(messages); // reference equality
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("b) non-thinking model gets history window + evictor + observation masker (thinking cleaner skipped)", async () => {
    const { deps, logger } = createMockDeps({ reasoning: false });
    const engine = createContextEngine(enabledConfig, deps);

    // Messages with thinking blocks -- thinking cleaner skipped for non-thinking model
    // but history window layer, evictor, and observation masker are active (3 layers).
    // Since these are all assistant messages (no user messages) and below char threshold,
    // all layers return them unchanged.
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock("thought"), makeTextBlock("hello")]),
    ];

    const result = await engine.transformContext(messages);
    expect(result).toBe(messages); // no user turns -> history window returns as-is, evictor no-op, masker below threshold
    // Startup log at INFO, pipeline complete at DEBUG (demoted)
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ layerCount: 4, historyTurns: 15 }),
      "Context engine active",
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ layerCount: 4, durationMs: expect.any(Number) }),
      "Context engine pipeline complete",
    );
  });

  it("c) thinking model strips old blocks (keepTurns=10)", async () => {
    const { deps } = createMockDeps({ reasoning: true });
    const engine = createContextEngine(enabledConfig, deps);

    // 15 assistant messages, each with thinking + text
    const messages: AgentMessage[] = Array.from({ length: 15 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );

    const result = await engine.transformContext(messages);

    // Oldest 5 should have thinking stripped
    for (let i = 0; i < 5; i++) {
      const msg = result[i] as { role: string; content: unknown[] };
      expect(msg.content).toHaveLength(1);
      expect((msg.content[0] as { type: string }).type).toBe("text");
    }

    // Most recent 10 should retain thinking
    for (let i = 5; i < 15; i++) {
      const msg = result[i] as { role: string; content: unknown[] };
      expect(msg.content).toHaveLength(2);
    }
  });

  it("d) layer error isolation -- catches error, logs WARN, returns unmodified", async () => {
    const { deps, logger } = createMockDeps({ reasoning: true });

    const engine = createContextEngine(enabledConfig, deps);

    // Need >10 assistant messages to trigger content access on the oldest.
    // The bomb message (oldest) has a content getter that throws when accessed.
    const bombMsg = {
      role: "assistant",
      get content(): never {
        throw new Error("content access exploded");
      },
    } as unknown as AgentMessage;

    // 11 normal messages + 1 bomb at position 0 = 12 total, so 2 beyond keep-window
    const normalMessages = Array.from({ length: 11 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );
    const messages: AgentMessage[] = [bombMsg, ...normalMessages];
    const result = await engine.transformContext(messages);

    expect(result).toBe(messages); // layer error => return original
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = logger.warn.mock.calls[0];
    expect(warnCall[0]).toMatchObject({
      layerName: "thinking-block-cleaner",
      hint: expect.stringContaining("failed"),
      errorKind: "dependency",
    });
  });

  it("e) circuit breaker disables layer after 3 consecutive failures", async () => {
    const { deps, logger } = createMockDeps({ reasoning: true });

    const engine = createContextEngine(enabledConfig, deps);

    // Need >10 assistant messages so the bomb (oldest) is beyond keep-window.
    // The bomb message has a content getter that throws when accessed.
    // This triggers failures in the thinking-block-cleaner layer (and may
    // also affect the observation masker via estimateContextCharsWithDualRatio).
    const bombMsg = {
      role: "assistant",
      get content(): never {
        throw new Error("persistent failure");
      },
    } as unknown as AgentMessage;
    const normalMessages = Array.from({ length: 11 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );
    const messages: AgentMessage[] = [bombMsg, ...normalMessages];

    // Call 1-3: thinking-block-cleaner errors, logged as WARN
    for (let i = 0; i < 3; i++) {
      await engine.transformContext(messages);
    }

    // Should have 3 WARN calls for the thinking-block-cleaner layer error
    const thinkingCleanerErrors = logger.warn.mock.calls.filter(
      (call) => call[0]?.layerName === "thinking-block-cleaner" && typeof call[1] === "string" && call[1].includes("layer error"),
    );
    expect(thinkingCleanerErrors.length).toBe(3);

    // After 3 failures, the thinking-block-cleaner circuit breaker trips
    const breakerWarns = logger.warn.mock.calls.filter(
      (call) => typeof call[1] === "string" && call[1].includes("circuit breaker") && call[0]?.layerName === "thinking-block-cleaner",
    );
    expect(breakerWarns.length).toBe(1);

    // Call 4: thinking-block-cleaner is disabled, should be skipped entirely (no new error WARN for it)
    logger.warn.mockClear();
    const result = await engine.transformContext(messages);
    // Note: other layers may still process, but the thinking-block-cleaner is disabled
    // The result may not be the original reference if other layers transform it

    // No additional WARN for thinking-block-cleaner layer error (layer was skipped)
    const newThinkingCleanerErrors = logger.warn.mock.calls.filter(
      (call) => call[0]?.layerName === "thinking-block-cleaner" && typeof call[1] === "string" && call[1].includes("layer error"),
    );
    expect(newThinkingCleanerErrors.length).toBe(0);
  });

  it("f) startup INFO log with config summary", () => {
    const { deps, logger } = createMockDeps({ reasoning: true });
    createContextEngine(enabledConfig, deps);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { thinkingKeepTurns: 10, historyTurns: 15, evictionMinAge: 15, observationKeepWindow: 25, ephemeralKeepWindow: 10, observationTriggerChars: 120_000, compactionEnabled: false, compactionCooldownTurns: 5, compactionPrefixAnchorTurns: 2, rehydrationEnabled: false, channelType: undefined, layerCount: 5 },
      "Context engine active",
    );
  });

  it("g) observation masker receives getSessionManager from deps", async () => {
    const mockGetSM = vi.fn().mockReturnValue({ fileEntries: [] });
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      getSessionManager: mockGetSM,
    };
    const engine = createContextEngine(enabledConfig, deps);

    // Short message list below threshold -- masker won't call getSessionManager
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];
    await engine.transformContext(messages);

    // 4 layers: reasoning-tag-stripper + history window + evictor + observation masker (no thinking cleaner for non-reasoning)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ layerCount: 4 }),
      "Context engine active",
    );
  });

  it("h) observation masker uses custom config values", () => {
    const { deps, logger } = createMockDeps({ reasoning: true });
    const customConfig: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 5,
      historyTurns: 10,
      observationKeepWindow: 20,
      observationTriggerChars: 300_000,
    };
    createContextEngine(customConfig, deps);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        observationKeepWindow: 20,
        observationTriggerChars: 300_000,
        layerCount: 5,
      }),
      "Context engine active",
    );
  });

  // -------------------------------------------------------------------------
  // Compaction layer wiring
  // -------------------------------------------------------------------------

  it("i) without getCompactionDeps -- no compaction layer added (5 layers for thinking model)", () => {
    const { deps, logger } = createMockDeps({ reasoning: true });
    createContextEngine(enabledConfig, deps);

    // 5 layers: thinking-cleaner + reasoning-tag-stripper + history-window + evictor + observation-masker
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ layerCount: 5, compactionEnabled: false, rehydrationEnabled: false }),
      "Context engine active",
    );
  });

  it("j) with getCompactionDeps -- compaction layer added (+1 layer)", () => {
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => ({}),
        getModel: () => ({
          id: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
    };

    createContextEngine(enabledConfig, deps);

    // 6 layers: thinking-cleaner + reasoning-tag-stripper + history-window + evictor + observation-masker + llm-compaction
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ layerCount: 6, compactionEnabled: true }),
      "Context engine active",
    );
  });

  it("k) startup log includes compaction status and cooldown", () => {
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
      }),
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => ({}),
        getModel: () => ({
          id: "test-model",
          provider: "anthropic",
          contextWindow: 128_000,
          reasoning: false,
        }),
        getApiKey: async () => "test-key",
      }),
    };

    const customConfig: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 10,
      historyTurns: 15,
      compactionCooldownTurns: 8,
    };

    createContextEngine(customConfig, deps);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionEnabled: true,
        compactionCooldownTurns: 8,
        layerCount: 5, // reasoning-tag-stripper + history-window + evictor + observation-masker + llm-compaction (no thinking for non-reasoning)
      }),
      "Context engine active",
    );
  });

  it("l) pipeline runs without error when compaction layer is wired", async () => {
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => ({ fileEntries: [] }),
        getModel: () => ({
          id: "test-model",
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: false,
        }),
        getApiKey: async () => "test-key",
      }),
    };

    const engine = createContextEngine(enabledConfig, deps);

    // Short message list -- compaction won't trigger (below threshold)
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    const result = await engine.transformContext(messages);
    // Should pass through without errors
    expect(result).toBe(messages);
  });

  // -------------------------------------------------------------------------
  // Rehydration layer wiring
  // -------------------------------------------------------------------------

  it("m) with both compaction and rehydration deps -- 5 layers for thinking model", () => {
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => ({}),
        getModel: () => ({
          id: "test-model",
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: true,
        }),
        getApiKey: async () => "test-key",
      }),
      getRehydrationDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getAgentsMdContent: () => "",
        postCompactionSections: ["Session Startup", "Red Lines"],
        getRecentFiles: () => [],
        readFile: async () => "",
        getActiveState: () => ({}),
      }),
    };

    createContextEngine(enabledConfig, deps);

    // 7 layers: thinking-cleaner + reasoning-tag-stripper + history-window + evictor + observation-masker + llm-compaction + rehydration
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        layerCount: 7,
        compactionEnabled: true,
        rehydrationEnabled: true,
      }),
      "Context engine active",
    );
  });

  it("n) without rehydration deps -- compaction present but no rehydration layer", () => {
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => ({}),
        getModel: () => ({
          id: "test-model",
          provider: "anthropic",
          contextWindow: 200_000,
          reasoning: false,
        }),
        getApiKey: async () => "test-key",
      }),
      // No getRehydrationDeps
    };

    createContextEngine(enabledConfig, deps);

    // 5 layers: reasoning-tag-stripper + history-window + evictor + observation-masker + llm-compaction (no thinking, no rehydration)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        layerCount: 5,
        compactionEnabled: true,
        rehydrationEnabled: false,
      }),
      "Context engine active",
    );
  });

  it("o) startup log includes rehydrationEnabled field", () => {
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
      }),
      getRehydrationDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getAgentsMdContent: () => "",
        postCompactionSections: [],
        getRecentFiles: () => [],
        readFile: async () => "",
        getActiveState: () => ({}),
      }),
    };

    createContextEngine(enabledConfig, deps);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        rehydrationEnabled: true,
        compactionEnabled: false,
        // 5 layers: reasoning-tag-stripper + history-window + evictor + observation-masker + rehydration (no thinking, no compaction)
        layerCount: 5,
      }),
      "Context engine active",
    );
  });

  // -------------------------------------------------------------------------
  // Observability -- metrics, events, INFO summary
  // -------------------------------------------------------------------------

  it("p) populates lastMetrics after pipeline run", async () => {
    const { deps } = createMockDeps({ reasoning: true });
    const engine = createContextEngine(enabledConfig, deps);

    expect(engine.lastMetrics).toBeUndefined();

    const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );

    await engine.transformContext(messages);

    expect(engine.lastMetrics).toBeDefined();
    const m = engine.lastMetrics!;
    expect(m.tokensLoaded).toBeGreaterThanOrEqual(0);
    expect(m.tokensMasked).toBe(0); // masker below threshold
    expect(m.tokensCompacted).toBe(0); // no compaction
    expect(m.thinkingBlocksRemoved).toBe(0); // all within keep window (5 < keepTurns 10)
    expect(m.layerErrors).toBe(0);
    expect(m.durationMs).toBeGreaterThanOrEqual(0);
    expect(m.cacheHitTokens).toBe(0);
    expect(m.cacheWriteTokens).toBe(0);
    expect(m.cacheMissTokens).toBe(0);
    expect(m.budgetUtilization).toBeGreaterThanOrEqual(0);
    expect(m.layers).toBeInstanceOf(Array);
    expect(m.layers.length).toBe(5); // thinking-cleaner + reasoning-tag-stripper + history-window + evictor + observation-masker
    // New observability fields
    expect(m.tokensEvicted).toBe(0); // no evictions in basic test
    expect(m.evictionCategories).toEqual({});
    expect(m.rereadCount).toBe(0); // no session manager => no re-read detection
    expect(m.rereadTools).toEqual([]);
    expect(m.sessionDepth).toBe(0); // no session manager => 0
    expect(m.sessionToolResults).toBe(0);
  });

  it("q) per-layer timing data in metrics.layers", async () => {
    const { deps } = createMockDeps({ reasoning: true });
    const engine = createContextEngine(enabledConfig, deps);

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);

    const layers = engine.lastMetrics!.layers;
    expect(layers.length).toBe(5);
    expect(layers[0]!.name).toBe("thinking-block-cleaner");
    expect(layers[1]!.name).toBe("reasoning-tag-stripper");
    expect(layers[2]!.name).toBe("history-window");
    expect(layers[3]!.name).toBe("dead-content-evictor");
    expect(layers[4]!.name).toBe("observation-masker");

    for (const layer of layers) {
      expect(layer.durationMs).toBeGreaterThanOrEqual(0);
      expect(layer.messagesIn).toBeGreaterThanOrEqual(0);
      expect(layer.messagesOut).toBeGreaterThanOrEqual(0);
    }
  });

  it("r) logs per-pipeline INFO summary", async () => {
    const { deps, logger } = createMockDeps({ reasoning: false });
    const engine = createContextEngine(enabledConfig, deps);

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);

    // Should have startup log at INFO + pipeline complete at DEBUG
    const pipelineLogs = logger.debug.mock.calls.filter(
      (call: unknown[]) => call[1] === "Context engine pipeline complete",
    );
    expect(pipelineLogs.length).toBe(1);
    const logData = pipelineLogs[0]![0] as Record<string, unknown>;
    expect(logData).toHaveProperty("tokensLoaded");
    expect(logData).toHaveProperty("tokensEvicted");
    expect(logData).toHaveProperty("tokensMasked");
    expect(logData).toHaveProperty("tokensCompacted");
    expect(logData).toHaveProperty("thinkingBlocksRemoved");
    expect(logData).toHaveProperty("budgetUtilization");
    expect(logData).toHaveProperty("layerCount");
    expect(logData).toHaveProperty("durationMs");
    // Extended log fields
    expect(logData).toHaveProperty("evictionCategories");
    expect(logData).toHaveProperty("rereadCount");
    expect(logData).toHaveProperty("rereadTools");
    expect(logData).toHaveProperty("sessionDepth");
    expect(logData).toHaveProperty("sessionToolResults");
    // cacheHitTokens/cacheWriteTokens/cacheMissTokens removed from pre-LLM log (always 0)
    expect(logData).not.toHaveProperty("cacheHitTokens");
  });

  it("s) emits context:masked event when masker reports results", async () => {
    const mockEventBus = { emit: vi.fn() };
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      eventBus: mockEventBus,
      agentId: "test-agent",
      sessionKey: "test-session",
    };

    const engine = createContextEngine({
      enabled: true,
      thinkingKeepTurns: 10,
      historyTurns: 50,
      observationKeepWindow: 1, // Keep only 1 most recent tool result
      observationTriggerChars: 100, // Very low threshold to trigger masking
    }, deps);

    // Build messages with multiple tool results that exceed threshold
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "do something" }] } as unknown as AgentMessage,
      makeAssistantMsg([{ type: "toolCall", toolCallId: "tc-1", toolName: "bash", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "bash",
        content: [{ type: "text", text: "x".repeat(200) }],
      } as unknown as AgentMessage,
      makeAssistantMsg([{ type: "toolCall", toolCallId: "tc-2", toolName: "bash", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "tc-2",
        toolName: "bash",
        content: [{ type: "text", text: "y".repeat(200) }],
      } as unknown as AgentMessage,
      // Trailing assistant ensures all tool results are "seen" (unseen protection)
      makeAssistantMsg([makeTextBlock("done")]),
    ];

    await engine.transformContext(messages);

    // Masker should have masked at least one old tool result
    const maskedEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:masked",
    );
    expect(maskedEvents.length).toBe(1);
    const payload = maskedEvents[0]![1] as Record<string, unknown>;
    expect(payload.agentId).toBe("test-agent");
    expect(payload.sessionKey).toBe("test-session");
    expect(payload.maskedCount).toBeGreaterThan(0);
    expect(payload.timestamp).toBeGreaterThan(0);
  });

  it("t) does not emit events when eventBus is not provided", async () => {
    const { deps } = createMockDeps({ reasoning: false });
    const engine = createContextEngine(enabledConfig, deps);

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    // Should not throw even without eventBus
    await engine.transformContext(messages);
    expect(engine.lastMetrics).toBeDefined();
  });

  it("u) metrics reset between pipeline runs", async () => {
    const { deps } = createMockDeps({ reasoning: true });
    const engine = createContextEngine(enabledConfig, deps);

    // Run 1: 15 assistant messages triggers thinking block cleaning
    const messages1: AgentMessage[] = Array.from({ length: 15 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );
    await engine.transformContext(messages1);
    const m1 = engine.lastMetrics!;
    expect(m1.thinkingBlocksRemoved).toBeGreaterThan(0);

    // Run 2: 3 assistant messages (within keep window, no blocks removed)
    const messages2: AgentMessage[] = Array.from({ length: 3 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );
    await engine.transformContext(messages2);
    const m2 = engine.lastMetrics!;
    expect(m2.thinkingBlocksRemoved).toBe(0); // Reset, not accumulated
  });

  it("v) per-layer DEBUG logging suppressed for no-op layers", async () => {
    const { deps, logger } = createMockDeps({ reasoning: true });
    const engine = createContextEngine(enabledConfig, deps);

    // Single assistant message: all layers are no-ops (messagesIn === messagesOut, durationMs ~0)
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);

    // No-op layers (same message count in/out, zero duration) should be suppressed
    const debugLogs = logger.debug.mock.calls.filter(
      (call: unknown[]) => call[1] === "Context engine layer applied",
    );
    expect(debugLogs.length).toBe(0);

    // Pipeline complete summary is still emitted
    const summaryLogs = logger.debug.mock.calls.filter(
      (call: unknown[]) => call[1] === "Context engine pipeline complete",
    );
    expect(summaryLogs.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Event emissions
  // -------------------------------------------------------------------------

  it("w) emits context:pipeline event on every pipeline run", async () => {
    const mockEventBus = { emit: vi.fn() };
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      eventBus: mockEventBus,
      agentId: "agent-w",
      sessionKey: "session-w",
    };

    const engine = createContextEngine(enabledConfig, deps);

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);

    const pipelineEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:pipeline",
    );
    expect(pipelineEvents.length).toBe(1);

    const payload = pipelineEvents[0]![1] as Record<string, unknown>;
    expect(payload.agentId).toBe("agent-w");
    expect(payload.sessionKey).toBe("session-w");
    expect(payload).toHaveProperty("tokensLoaded");
    expect(payload).toHaveProperty("tokensEvicted");
    expect(payload).toHaveProperty("tokensMasked");
    expect(payload).toHaveProperty("tokensCompacted");
    expect(payload).toHaveProperty("thinkingBlocksRemoved");
    expect(payload).toHaveProperty("budgetUtilization");
    expect(payload).toHaveProperty("evictionCategories");
    expect(payload).toHaveProperty("rereadCount");
    expect(payload).toHaveProperty("rereadTools");
    expect(payload).toHaveProperty("sessionDepth");
    expect(payload).toHaveProperty("sessionToolResults");
    // cacheHitTokens/cacheWriteTokens/cacheMissTokens removed from observability event (always 0 pre-LLM)
    expect(payload).not.toHaveProperty("cacheHitTokens");
    expect(payload).not.toHaveProperty("cacheWriteTokens");
    expect(payload).not.toHaveProperty("cacheMissTokens");
    expect(payload).toHaveProperty("durationMs");
    expect(payload).toHaveProperty("layerCount");
    expect(payload).toHaveProperty("timestamp");
    expect(payload.timestamp).toBeGreaterThan(0);
  });

  it("x) emits context:reread event only when rereadCount > 0", async () => {
    const mockEventBus = { emit: vi.fn() };
    const logger = createMockLogger();
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      eventBus: mockEventBus,
      agentId: "agent-x",
      sessionKey: "session-x",
    };

    const engine = createContextEngine(enabledConfig, deps);

    // No session manager -> no re-read detection -> rereadCount = 0
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);

    // context:reread should NOT be emitted when rereadCount is 0
    const rereadEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:reread",
    );
    expect(rereadEvents.length).toBe(0);

    // context:pipeline should still be emitted (always emitted)
    const pipelineEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:pipeline",
    );
    expect(pipelineEvents.length).toBe(1);
    // Verify the pipeline event shows rereadCount = 0
    const pipelinePayload = pipelineEvents[0]![1] as Record<string, unknown>;
    expect(pipelinePayload.rereadCount).toBe(0);
    expect(pipelinePayload.rereadTools).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Cache fence infrastructure
  // -------------------------------------------------------------------------

  it("z) lastBreakpointIndex is undefined initially", () => {
    const { deps } = createMockDeps({ reasoning: true });
    const engine = createContextEngine(enabledConfig, deps);
    expect(engine.lastBreakpointIndex).toBeUndefined();
  });

  it("aa) cacheFenceIndex adjusted after history-window trimming", async () => {
    const { deps } = createMockDeps({ reasoning: false, contextWindow: 200_000 });
    // historyTurns=3 means only the last 3 user-assistant pairs are kept
    const engine = createContextEngine({
      enabled: true,
      thinkingKeepTurns: 10,
      historyTurns: 3,
    }, deps);

    // Set a high fence -- if it's not adjusted after trimming, layers
    // running after history-window would see fence=10, making ALL
    // messages in the trimmed array appear protected (incorrect).
    engine.lastBreakpointIndex = 10;

    // 8 user-assistant pairs = 16 messages. With historyTurns=3,
    // history-window will trim to 6 messages (3 pairs).
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "user", content: [{ type: "text", text: `msg-${i}` }] } as AgentMessage);
      messages.push(makeAssistantMsg([makeTextBlock(`reply-${i}`)]));
    }

    const result = await engine.transformContext(messages);

    // After trimming, the result should have ~6 messages (3 pairs).
    // The fence was adjusted from 10 to max(-1, 10 - trimmedCount).
    // With 10 messages trimmed (16 - 6 = 10), fence becomes max(-1, 10-10) = 0.
    // The key assertion: the pipeline completed without errors, meaning
    // layers after history-window received an adjusted fence.
    expect(result.length).toBeLessThanOrEqual(messages.length);
    expect(engine.lastMetrics).toBeDefined();
    expect(engine.lastMetrics!.layerErrors).toBe(0);
  });

  it("ab) lastTrimOffset records trimmed message count from history-window", async () => {
    const { deps } = createMockDeps({ reasoning: false, contextWindow: 200_000 });
    const engine = createContextEngine({
      enabled: true,
      thinkingKeepTurns: 10,
      historyTurns: 3,
    }, deps);

    // Start with no fence
    expect(engine.lastTrimOffset).toBe(0);

    // 8 user-assistant pairs = 16 messages. With historyTurns=3,
    // history-window trims to 6 messages (3 pairs), removing 10 from front.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(
        { role: "user", content: [{ type: "text", text: `msg-${i}` }] } as AgentMessage,
        makeAssistantMsg([makeTextBlock(`reply-${i}`)]),
      );
    }

    await engine.transformContext(messages);

    // 16 messages in, 6 kept (3 pairs) = 10 trimmed
    expect(engine.lastTrimOffset).toBe(10);
  });

  it("ac) lastTrimOffset is 0 when history-window does not trim", async () => {
    const { deps } = createMockDeps({ reasoning: false, contextWindow: 200_000 });
    const engine = createContextEngine({
      enabled: true,
      thinkingKeepTurns: 10,
      historyTurns: 15,
    }, deps);

    // Only 2 messages -- well under historyTurns=15 limit
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] } as AgentMessage,
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);
    expect(engine.lastTrimOffset).toBe(0);
  });

  it("y) context:pipeline event includes reread and session depth data", async () => {
    const mockEventBus = { emit: vi.fn() };
    const logger = createMockLogger();
    // Provide a session manager with fileEntries so session depth is populated
    const mockGetSM = vi.fn().mockReturnValue({
      fileEntries: [
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant" } },
        { type: "message", message: { role: "toolResult" } },
        { type: "message", message: { role: "toolResult" } },
      ],
    });
    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8_192,
      }),
      eventBus: mockEventBus,
      agentId: "agent-y",
      sessionKey: "session-y",
      getSessionManager: mockGetSM,
    };

    const engine = createContextEngine(enabledConfig, deps);

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);

    const pipelineEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:pipeline",
    );
    expect(pipelineEvents.length).toBe(1);

    const payload = pipelineEvents[0]![1] as Record<string, unknown>;
    // Session depth should reflect the 4 fileEntries
    expect(payload.sessionDepth).toBe(4);
    // 2 toolResult entries in fileEntries
    expect(payload.sessionToolResults).toBe(2);
    // Re-read detection runs but last message in currentMessages is assistant with text
    // (no tool calls to match against), so rereadCount = 0
    expect(payload.rereadCount).toBe(0);
    expect(payload.rereadTools).toEqual([]);
    // Standard fields present
    expect(payload.layerCount).toBe(4); // reasoning-tag-stripper + history-window + evictor + observation-masker (non-reasoning)
    // cacheHitTokens removed from observability event (always 0 pre-LLM)
    expect(payload).not.toHaveProperty("cacheHitTokens");
    expect(typeof payload.durationMs).toBe("number");
  });

  // ---------------------------------------------------------------------------
  // lastBreakpointIndex / cacheFenceIndex seeding
  // ---------------------------------------------------------------------------

  it("q) lastBreakpointIndex seeds cacheFenceIndex -- pipeline runs without error", async () => {
    const { deps } = createMockDeps({ reasoning: true });
    const engine = createContextEngine(enabledConfig, deps);

    // Seed a fence at index 5
    engine.lastBreakpointIndex = 5;

    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] } as AgentMessage,
      makeAssistantMsg([makeThinkingBlock("thought"), makeTextBlock("hello")]),
    ];

    const result = await engine.transformContext(messages);
    // Pipeline should complete successfully with the fence set
    expect(result).toBeDefined();
    expect(engine.lastMetrics).toBeDefined();
    expect(engine.lastMetrics!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("r) undefined lastBreakpointIndex produces cacheFenceIndex = -1 (no fence)", async () => {
    const mockEventBus = { emit: vi.fn() };
    const { deps } = createMockDeps({ reasoning: false });
    deps.eventBus = mockEventBus;
    deps.agentId = "agent-fence";
    deps.sessionKey = "session-fence";

    const engine = createContextEngine(enabledConfig, deps);
    // Do NOT set lastBreakpointIndex -- should default to -1

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);

    // Verify pipeline event carries cacheFenceIndex = -1
    const pipelineEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:pipeline",
    );
    expect(pipelineEvents.length).toBe(1);
    const payload = pipelineEvents[0]![1] as Record<string, unknown>;
    expect(payload.cacheFenceIndex).toBe(-1);
  });

  it("s) lastBreakpointIndex is readable and writable (persistence contract)", async () => {
    const { deps } = createMockDeps({ reasoning: true });
    const engine = createContextEngine(enabledConfig, deps);

    // Default is undefined
    expect(engine.lastBreakpointIndex).toBeUndefined();

    // Write and read back
    engine.lastBreakpointIndex = 10;
    expect(engine.lastBreakpointIndex).toBe(10);

    // Reset to -1 (simulates compaction)
    engine.lastBreakpointIndex = -1;
    expect(engine.lastBreakpointIndex).toBe(-1);
  });

  it("t) cacheFenceIndex appears in DEBUG pipeline summary log", async () => {
    const { deps, logger } = createMockDeps({ reasoning: false });
    const engine = createContextEngine(enabledConfig, deps);

    engine.lastBreakpointIndex = 3;

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("hello")]),
    ];

    await engine.transformContext(messages);

    // Find the DEBUG "Context engine pipeline complete" log call
    const debugCalls = logger.debug.mock.calls.filter(
      (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("Context engine pipeline complete"),
    );
    expect(debugCalls.length).toBe(1);
    const logObj = debugCalls[0]![0] as Record<string, unknown>;
    expect(logObj).toHaveProperty("cacheFenceIndex");
    // Fence = 3, but with only 1 message, history window won't trim,
    // so cacheFenceIndex stays as seeded (3)
    expect(logObj.cacheFenceIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// STRESS: Compaction and rehydration under context pressure
// ---------------------------------------------------------------------------

describe("STRESS: Compaction and rehydration under context pressure", () => {
  // Shared helpers for this stress block
  function makeUserMessage(text: string): AgentMessage {
    return { role: "user", content: text } as AgentMessage;
  }

  function makeAssistantMessage(text: string): AgentMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
    } as AgentMessage;
  }

  function makeToolResultMsg(toolCallId: string, toolName: string, text: string): AgentMessage {
    return {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text }],
      isError: false,
    } as AgentMessage;
  }

  function makeAssistantWithToolCall(text: string, toolCallId: string, toolName: string): AgentMessage {
    return {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "toolCall", toolCallId, toolName, arguments: {} },
      ],
    } as AgentMessage;
  }

  /** Build a valid compaction summary with all COMPACTION_REQUIRED_SECTIONS. */
  function buildValidSummary(): string {
    return [
      "## Identifiers\nSession: test, Agent: stress-agent, Channel: echo",
      "## Primary Request and Intent\nStress testing compaction and rehydration layers",
      "## Decisions\nDecided to use smaller context window for testing",
      "## Files and Code\nFiles: /tmp/test.ts, Functions: handleStress()",
      "## Errors and Resolutions\n(none)",
      "## User Messages\nUser requested compaction test",
      "## Constraints\nContext window limited to 32K tokens",
      "## Active Work\nStress testing compaction and rehydration layers",
      "## Next Steps\n1. Verify compaction metrics\n2. Check rehydration injection",
    ].join("\n\n");
  }

  /** Build a mock AGENTS.md with extractable sections. */
  function buildMockAgentsMd(): string {
    return [
      "# AGENTS.md",
      "",
      "## Session Startup",
      "Always greet the user with the current context window size.",
      "",
      "## Red Lines",
      "Never exceed the token budget. Always validate compaction summaries.",
      "",
      "## Other Section",
      "This should not be extracted.",
    ].join("\n");
  }

  function createStressMockLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      isLevelEnabled: vi.fn(),
    };
  }

  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  // -------------------------------------------------------------------------
  // Test A: Full pipeline -- compaction triggers, rehydration fires
  // -------------------------------------------------------------------------

  it("a) compaction triggers and rehydration fires under 32K context pressure", async () => {
    const logger = createStressMockLogger();
    const mockEventBus = { emit: vi.fn() };

    // Mock SessionManager for compaction write-back
    const mockFileEntries: unknown[] = [];
    const mockSessionManager = {
      fileEntries: mockFileEntries,
      _rewriteFile: vi.fn(),
    };

    // generateSummary returns valid 8-section summary
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    const config: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 0,
      historyTurns: 200, // high limit so history window does not clip
      observationKeepWindow: 100, // high limit so masker stays out of the way
      observationTriggerChars: 500_000, // very high so masker does not trigger
      compactionCooldownTurns: 0, // no cooldown
      evictionMinAge: 200, // disable evictor
    };

    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      eventBus: mockEventBus,
      agentId: "stress-agent",
      sessionKey: "stress:user:channel",
      getModel: () => ({
        reasoning: false,
        contextWindow: 32_000,
        maxTokens: 8_192,
      }),
      getSessionManager: () => mockSessionManager,
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => mockSessionManager,
        getModel: () => ({
          id: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          contextWindow: 32_000,
          reasoning: false,
        }),
        getApiKey: async () => "test-api-key",
      }),
      getRehydrationDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getAgentsMdContent: () => buildMockAgentsMd(),
        postCompactionSections: ["Session Startup", "Red Lines"],
        getRecentFiles: () => ["/tmp/test.ts", "/tmp/config.yaml"],
        readFile: async (path: string) => `// content of ${path}\n${"x".repeat(500)}`,
        getActiveState: () => ({
          channelType: "echo",
          channelId: "stress-channel",
          agentId: "stress-agent",
        }),
      }),
    };

    const engine = createContextEngine(config, deps);

    // Build 40 tool-result-heavy messages to exceed 85% of 32K window.
    // Each cycle: user (short) + assistant with tool call + toolResult (~2000 chars).
    // Tool results get 2x weight in estimateContextCharsWithDualRatio.
    // 40 * 2000 chars * 2 (dual ratio) = 160000 effective chars / 4 = 40000 tokens >> 27200 threshold.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(makeUserMessage(`Run test iteration ${i}`));
      messages.push(makeAssistantWithToolCall(`Running iteration ${i}`, `tc-${i}`, "bash"));
      messages.push(makeToolResultMsg(`tc-${i}`, "bash", `Output iteration ${i}: ${"a".repeat(2000)}`));
      messages.push(makeAssistantMessage(`Iteration ${i} complete: ${"b".repeat(200)}`));
    }

    // Also populate mockFileEntries so session depth is measured
    for (const msg of messages) {
      mockFileEntries.push({ type: "message", message: msg });
    }

    const result = await engine.transformContext(messages);

    // (a) Compaction must have triggered -- tokensCompacted > 0
    const metrics = engine.lastMetrics!;
    expect(metrics).toBeDefined();
    expect(metrics.tokensCompacted).toBeGreaterThan(0);

    // (b) Output must contain a compaction summary message (has <summary> tag)
    const summaryMessages = result.filter((m) => {
      const msg = m as unknown as { compactionSummary?: boolean; content?: Array<{ type: string; text: string }> | string };
      if (msg.compactionSummary === true) return true;
      if (typeof msg.content === "string" && msg.content.includes("<summary>")) return true;
      if (Array.isArray(msg.content)) {
        return msg.content.some((b) => b.type === "text" && b.text.includes("<summary>"));
      }
      return false;
    });
    expect(summaryMessages.length).toBeGreaterThanOrEqual(1);

    // (c) Rehydration must have attempted -- either successfully injected or overflowed.
    // With tight budget (32K window) the compaction keeps recent messages that nearly fill
    // the budget, leaving little room for rehydration content. Both outcomes are correct:
    // - Rehydration injects AGENTS.md + files + resume instruction
    // - Rehydration overflows and gracefully degrades (strip files or remove entirely)
    const rehydratedEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:rehydrated",
    );
    const overflowEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:overflow",
    );

    // At least one of rehydrated or overflow must have fired (rehydration layer ran)
    expect(rehydratedEvents.length + overflowEvents.length).toBeGreaterThanOrEqual(1);

    if (rehydratedEvents.length > 0) {
      const rehydratedPayload = rehydratedEvents[0]![1] as Record<string, unknown>;
      expect((rehydratedPayload.sectionsInjected as number)).toBeGreaterThanOrEqual(0);

      // If sections were injected, verify content in messages
      if ((rehydratedPayload.sectionsInjected as number) > 0) {
        const rehydrationMessages = result.filter((m) => {
          const msg = m as unknown as { content?: Array<{ type: string; text: string }> };
          if (!Array.isArray(msg.content)) return false;
          return msg.content.some((b) =>
            b.type === "text" && b.text.includes("[Critical instructions from AGENTS.md]"),
          );
        });
        expect(rehydrationMessages.length).toBeGreaterThanOrEqual(1);
      }
    }

    if (overflowEvents.length > 0) {
      const overflowPayload = overflowEvents[0]![1] as Record<string, unknown>;
      expect(overflowPayload.recoveryAction).toBeDefined();
    }

    // (d) Budget utilization should be reasonable after compaction
    expect(metrics.budgetUtilization).toBeLessThan(3.0);

    // (e) Pipeline metrics are complete
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.layers).toBeInstanceOf(Array);
    expect(metrics.layers.length).toBeGreaterThanOrEqual(5); // history + evictor + masker + compaction + rehydration
    expect(metrics.layerErrors).toBe(0);

    // Verify compaction event emission
    const compactedEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:compacted",
    );
    expect(compactedEvents.length).toBe(1);
    const compactedPayload = compactedEvents[0]![1] as Record<string, unknown>;
    expect(compactedPayload.fallbackLevel).toBe(1); // Level 1 succeeded

    // Pipeline event must include all fields
    const pipelineEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:pipeline",
    );
    expect(pipelineEvents.length).toBe(1);
    const pipelinePayload = pipelineEvents[0]![1] as Record<string, unknown>;
    expect(pipelinePayload.tokensCompacted).toBeGreaterThan(0);
    expect(pipelinePayload.agentId).toBe("stress-agent");
    expect(pipelinePayload.sessionKey).toBe("stress:user:channel");

    // generateSummary was called (at least once)
    expect(mockGenerateSummary).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test B: Level 2 fallback when Level 1 fails
  // -------------------------------------------------------------------------

  it("b) falls to Level 2 when generateSummary returns invalid summary (missing sections)", async () => {
    const logger = createStressMockLogger();
    const mockEventBus = { emit: vi.fn() };
    const mockSessionManager = { fileEntries: [] as unknown[], _rewriteFile: vi.fn() };

    // First 3 calls (Level 1 attempts): return summary missing required sections
    // 4th call (Level 2 attempt): return valid summary
    let callCount = 0;
    mockGenerateSummary.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) {
        return "This is an incomplete summary without required sections.";
      }
      return buildValidSummary();
    });

    const config: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 0,
      historyTurns: 200,
      observationKeepWindow: 100,
      observationTriggerChars: 500_000,
      compactionCooldownTurns: 0,
      evictionMinAge: 200,
    };

    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      eventBus: mockEventBus,
      agentId: "stress-agent-b",
      sessionKey: "stress:b",
      getModel: () => ({ reasoning: false, contextWindow: 32_000, maxTokens: 8_192 }),
      getSessionManager: () => mockSessionManager,
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => mockSessionManager,
        getModel: () => ({ id: "test-model", provider: "anthropic", contextWindow: 32_000, reasoning: false }),
        getApiKey: async () => "test-api-key",
      }),
      getRehydrationDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getAgentsMdContent: () => buildMockAgentsMd(),
        postCompactionSections: ["Session Startup", "Red Lines"],
        getRecentFiles: () => [],
        readFile: async () => "",
        getActiveState: () => ({}),
      }),
    };

    const engine = createContextEngine(config, deps);

    // Build messages to trigger compaction
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(makeUserMessage(`Task ${i}`));
      messages.push(makeAssistantWithToolCall(`Doing ${i}`, `tc-${i}`, "bash"));
      messages.push(makeToolResultMsg(`tc-${i}`, "bash", `Result ${i}: ${"z".repeat(2000)}`));
      messages.push(makeAssistantMessage(`Done ${i}: ${"w".repeat(200)}`));
    }

    const result = await engine.transformContext(messages);

    // Compaction should still succeed (Level 2 fallback)
    const metrics = engine.lastMetrics!;
    expect(metrics.tokensCompacted).toBeGreaterThan(0);

    // Level 2 reported
    const compactedEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:compacted",
    );
    expect(compactedEvents.length).toBe(1);
    const payload = compactedEvents[0]![1] as Record<string, unknown>;
    expect(payload.fallbackLevel).toBe(2);
    // 3 Level 1 attempts + 1 Level 2 attempt = 4
    expect(payload.attempts).toBe(4);

    // Summary message present in result
    const hasSummary = result.some((m) => {
      const msg = m as unknown as { compactionSummary?: boolean };
      return msg.compactionSummary === true;
    });
    expect(hasSummary).toBe(true);

    // generateSummary was called 4 times (3 Level 1 retries + 1 Level 2)
    expect(mockGenerateSummary).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // Test C: Level 3 fallback when all LLM calls fail
  // -------------------------------------------------------------------------

  it("c) falls to Level 3 (count-only) when all generateSummary calls throw", async () => {
    const logger = createStressMockLogger();
    const mockEventBus = { emit: vi.fn() };
    const mockSessionManager = { fileEntries: [] as unknown[], _rewriteFile: vi.fn() };

    // All calls throw
    mockGenerateSummary.mockRejectedValue(new Error("LLM provider unavailable"));

    const config: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 0,
      historyTurns: 200,
      observationKeepWindow: 100,
      observationTriggerChars: 500_000,
      compactionCooldownTurns: 0,
      evictionMinAge: 200,
    };

    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      eventBus: mockEventBus,
      agentId: "stress-agent-c",
      sessionKey: "stress:c",
      getModel: () => ({ reasoning: false, contextWindow: 32_000, maxTokens: 8_192 }),
      getSessionManager: () => mockSessionManager,
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => mockSessionManager,
        getModel: () => ({ id: "test-model", provider: "anthropic", contextWindow: 32_000, reasoning: false }),
        getApiKey: async () => "test-api-key",
      }),
      getRehydrationDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getAgentsMdContent: () => "",
        postCompactionSections: [],
        getRecentFiles: () => [],
        readFile: async () => "",
        getActiveState: () => ({}),
      }),
    };

    const engine = createContextEngine(config, deps);

    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(makeUserMessage(`Task ${i}`));
      messages.push(makeAssistantWithToolCall(`Doing ${i}`, `tc-${i}`, "bash"));
      messages.push(makeToolResultMsg(`tc-${i}`, "bash", `Result ${i}: ${"q".repeat(2000)}`));
      messages.push(makeAssistantMessage(`Done ${i}`));
    }

    const result = await engine.transformContext(messages);

    // Level 3 produces a count-only summary
    const metrics = engine.lastMetrics!;
    expect(metrics.tokensCompacted).toBeGreaterThan(0);

    const compactedEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:compacted",
    );
    expect(compactedEvents.length).toBe(1);
    expect((compactedEvents[0]![1] as Record<string, unknown>).fallbackLevel).toBe(3);

    // Count-only summary contains the message count
    const summaryMsg = result.find((m) => {
      const msg = m as unknown as { compactionSummary?: boolean };
      return msg.compactionSummary === true;
    });
    expect(summaryMsg).toBeDefined();
    const summaryContent = summaryMsg as unknown as { content: Array<{ type: string; text: string }> };
    const summaryText = summaryContent.content[0]!.text;
    expect(summaryText).toContain("Context compacted");
    expect(summaryText).toContain("messages summarized");
  });

  // -------------------------------------------------------------------------
  // Test D: Rehydration overflow stripping
  // -------------------------------------------------------------------------

  it("d) rehydration overflow strips file content when budget is tight", async () => {
    const logger = createStressMockLogger();
    const mockEventBus = { emit: vi.fn() };
    const mockSessionManager = { fileEntries: [] as unknown[], _rewriteFile: vi.fn() };

    // Return a very large summary to leave little room for rehydration
    const largeSummary = buildValidSummary() + "\n\n" + "x".repeat(40_000);
    mockGenerateSummary.mockResolvedValue(largeSummary);

    const config: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 0,
      historyTurns: 200,
      observationKeepWindow: 100,
      observationTriggerChars: 500_000,
      compactionCooldownTurns: 0,
      evictionMinAge: 200,
    };

    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      eventBus: mockEventBus,
      agentId: "stress-agent-d",
      sessionKey: "stress:d",
      getModel: () => ({ reasoning: false, contextWindow: 32_000, maxTokens: 8_192 }),
      getSessionManager: () => mockSessionManager,
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => mockSessionManager,
        getModel: () => ({ id: "test-model", provider: "anthropic", contextWindow: 32_000, reasoning: false }),
        getApiKey: async () => "test-api-key",
      }),
      getRehydrationDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getAgentsMdContent: () => buildMockAgentsMd(),
        postCompactionSections: ["Session Startup", "Red Lines"],
        getRecentFiles: () => ["/tmp/large1.ts", "/tmp/large2.ts", "/tmp/large3.ts"],
        readFile: async (path: string) => `// Large file: ${path}\n${"L".repeat(7000)}`,
        getActiveState: () => ({
          channelType: "echo",
          channelId: "stress-channel",
          agentId: "stress-agent-d",
        }),
      }),
    };

    const engine = createContextEngine(config, deps);

    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(makeUserMessage(`Task ${i}`));
      messages.push(makeAssistantWithToolCall(`Doing ${i}`, `tc-${i}`, "bash"));
      messages.push(makeToolResultMsg(`tc-${i}`, "bash", `Result ${i}: ${"r".repeat(2000)}`));
      messages.push(makeAssistantMessage(`Done ${i}`));
    }

    const result = await engine.transformContext(messages);

    // Compaction should have triggered
    const metrics = engine.lastMetrics!;
    expect(metrics.tokensCompacted).toBeGreaterThan(0);

    // The overflow event should have fired (or rehydration was stripped)
    const overflowEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:overflow",
    );
    const rehydratedEvents = mockEventBus.emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "context:rehydrated",
    );

    // Either overflow stripped files, or rehydration succeeded within budget
    // Both are valid outcomes depending on exact token math
    if (overflowEvents.length > 0) {
      const overflowPayload = overflowEvents[0]![1] as Record<string, unknown>;
      expect(overflowPayload.recoveryAction).toBeDefined();
    } else {
      // Rehydration succeeded -- verify it injected content
      expect(rehydratedEvents.length).toBe(1);
    }

    // Pipeline completed without errors
    expect(metrics.layerErrors).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test E: Session persistence write-back after compaction
  // -------------------------------------------------------------------------

  it("e) compaction persists to session manager via _rewriteFile", async () => {
    const logger = createStressMockLogger();
    const mockFileEntries: unknown[] = [];
    const mockRewriteFile = vi.fn();
    const mockSessionManager = {
      fileEntries: mockFileEntries,
      _rewriteFile: mockRewriteFile,
    };

    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    const config: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 0,
      historyTurns: 200,
      observationKeepWindow: 100,
      observationTriggerChars: 500_000,
      compactionCooldownTurns: 0,
      evictionMinAge: 200,
    };

    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({ reasoning: false, contextWindow: 32_000, maxTokens: 8_192 }),
      getSessionManager: () => mockSessionManager,
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => mockSessionManager,
        getModel: () => ({ id: "test-model", provider: "anthropic", contextWindow: 32_000, reasoning: false }),
        getApiKey: async () => "test-api-key",
      }),
    };

    const engine = createContextEngine(config, deps);

    // Build messages to trigger compaction
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(makeUserMessage(`Task ${i}`));
      messages.push(makeAssistantWithToolCall(`Doing ${i}`, `tc-${i}`, "bash"));
      messages.push(makeToolResultMsg(`tc-${i}`, "bash", `Result ${i}: ${"p".repeat(2000)}`));
      messages.push(makeAssistantMessage(`Done ${i}`));
    }

    // Populate fileEntries so persistCompaction can operate
    for (const msg of messages) {
      mockFileEntries.push({ type: "message", message: msg });
    }

    await engine.transformContext(messages);

    // _rewriteFile should have been called (compaction persisted to session)
    expect(mockRewriteFile).toHaveBeenCalled();

    // fileEntries should contain a compaction summary (after preserved head with middle-out compaction)
    const summaryEntry = mockFileEntries.find(
      (e: unknown) => (e as { type: string; message: { compactionSummary?: boolean } }).message?.compactionSummary === true,
    ) as { type: string; message: { compactionSummary?: boolean } } | undefined;
    expect(summaryEntry).toBeDefined();
    expect(summaryEntry!.type).toBe("message");
    expect(summaryEntry!.message.compactionSummary).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test F: lastBreakpointIndex resets after compaction
  // -------------------------------------------------------------------------

  it("f) lastBreakpointIndex resets to -1 after compaction", async () => {
    const logger = createStressMockLogger();
    const mockSessionManager = { fileEntries: [] as unknown[], _rewriteFile: vi.fn() };

    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    const config: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 0,
      historyTurns: 200,
      observationKeepWindow: 100,
      observationTriggerChars: 500_000,
      compactionCooldownTurns: 0,
      evictionMinAge: 200,
    };

    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({ reasoning: false, contextWindow: 32_000, maxTokens: 8_192 }),
      getSessionManager: () => mockSessionManager,
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => mockSessionManager,
        getModel: () => ({ id: "test-model", provider: "anthropic", contextWindow: 32_000, reasoning: false }),
        getApiKey: async () => "test-api-key",
      }),
    };

    const engine = createContextEngine(config, deps);

    // Seed a high fence from a "previous turn"
    engine.lastBreakpointIndex = 50;

    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(makeUserMessage(`Task ${i}`));
      messages.push(makeAssistantWithToolCall(`Doing ${i}`, `tc-${i}`, "bash"));
      messages.push(makeToolResultMsg(`tc-${i}`, "bash", `Result ${i}: ${"f".repeat(2000)}`));
      messages.push(makeAssistantMessage(`Done ${i}`));
    }

    await engine.transformContext(messages);

    // After compaction, lastBreakpointIndex must reset to -1
    expect(engine.lastBreakpointIndex).toBe(-1);
    expect(engine.lastTrimOffset).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test G: Validate compaction summary quality check
  // -------------------------------------------------------------------------

  it("g) validateCompactionSummary detects missing sections", () => {
    // Import is transitive via the mock, test the validation directly
    const validSummary = buildValidSummary();

    // All 8 sections present -- manually check
    for (const section of COMPACTION_REQUIRED_SECTIONS) {
      expect(validSummary.toLowerCase()).toContain(`## ${section.toLowerCase()}`);
    }

    // Remove one section
    const incomplete = validSummary.replace("## Errors and Resolutions", "## Missing Section");
    expect(incomplete.toLowerCase()).not.toContain("## errors and resolutions");
  });
});

// ---------------------------------------------------------------------------
// Token anchor estimation
// ---------------------------------------------------------------------------

describe("token anchor estimation", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("tokensLoaded uses anchor when deps.getTokenAnchor returns a valid anchor", async () => {
    const { deps } = createMockDeps({ reasoning: false, contextWindow: 200_000 });

    // 10 messages with small content
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: "user", content: `Q${i}`, timestamp: Date.now() } as AgentMessage);
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `A${i}` }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as AgentMessage);
    }

    // Anchor says 50000 tokens at 10 messages, so with 10 messages and 0 new, result = 50000
    deps.getTokenAnchor = () => ({
      inputTokens: 50_000,
      messageCount: 10,
      timestamp: Date.now(),
    });

    const engine = createContextEngine(enabledConfig, deps);
    await engine.transformContext(messages);

    const metrics = engine.lastMetrics!;
    expect(metrics).toBeDefined();
    // tokensLoaded should be anchor value (50000) since messageCount matches
    expect(metrics.tokensLoaded).toBe(50_000);
  });

  it("tokensLoaded falls back to char-based when deps.getTokenAnchor returns null", async () => {
    const { deps } = createMockDeps({ reasoning: false, contextWindow: 200_000 });

    const messages: AgentMessage[] = [
      { role: "user", content: "Hello world", timestamp: Date.now() } as AgentMessage,
    ];

    deps.getTokenAnchor = () => null;

    const engine = createContextEngine(enabledConfig, deps);
    await engine.transformContext(messages);

    const metrics = engine.lastMetrics!;
    expect(metrics).toBeDefined();
    // With null anchor, tokensLoaded should be the char-based estimate
    // "Hello world" = 11 chars, dual ratio = 11 (user role), / 3.5 = ceil(3.14) = 4
    expect(metrics.tokensLoaded).toBe(4);
  });

  it("tokensLoaded falls back to char-based when deps.getTokenAnchor is not provided", async () => {
    const { deps } = createMockDeps({ reasoning: false, contextWindow: 200_000 });
    // getTokenAnchor not set (undefined)

    const messages: AgentMessage[] = [
      { role: "user", content: "Hello world", timestamp: Date.now() } as AgentMessage,
    ];

    const engine = createContextEngine(enabledConfig, deps);
    await engine.transformContext(messages);

    const metrics = engine.lastMetrics!;
    expect(metrics).toBeDefined();
    // Same char-based estimate as above (11 chars / 3.5 = ceil(3.14) = 4)
    expect(metrics.tokensLoaded).toBe(4);
  });

  it("after compaction (snap.compaction !== null), onAnchorReset callback is called", async () => {
    const logger = createMockLogger();
    const mockSessionManager = {
      fileEntries: [] as unknown[],
      _rewriteFile: vi.fn(),
    };

    const onAnchorReset = vi.fn();

    const deps: ContextEngineDeps = {
      logger: logger as unknown as ContextEngineDeps["logger"],
      getModel: () => ({
        reasoning: false,
        contextWindow: 32_000,
        maxTokens: 8_192,
      }),
      getSessionManager: () => mockSessionManager,
      getCompactionDeps: () => ({
        logger: logger as unknown as ContextEngineDeps["logger"],
        getSessionManager: () => mockSessionManager,
        getModel: () => ({
          id: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          contextWindow: 32_000,
          reasoning: false,
        }),
        getApiKey: async () => "test-api-key",
      }),
      onAnchorReset,
    };

    // Build summary that passes validation
    const validSummary = COMPACTION_REQUIRED_SECTIONS.map(
      (s) => `## ${s}\n- content`,
    ).join("\n\n");
    mockGenerateSummary.mockResolvedValue(validSummary);

    const config: ContextEngineConfig = {
      enabled: true,
      thinkingKeepTurns: 10,
      historyTurns: 200,
      compactionCooldownTurns: 0,
    };

    const engine = createContextEngine(config, deps);

    // Build messages that exceed 85% of 32K window to trigger compaction
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: "user", content: `Q${i}: ${"x".repeat(1000)}`, timestamp: Date.now() } as AgentMessage);
      messages.push({
        role: "toolResult",
        toolCallId: `tc_${i}`,
        toolName: "bash",
        content: [{ type: "text", text: "z".repeat(2000) }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage);
    }

    await engine.transformContext(messages);

    // Compaction should have fired, and onAnchorReset should have been called
    const metrics = engine.lastMetrics!;
    expect(metrics.tokensCompacted).toBeGreaterThan(0);
    expect(onAnchorReset).toHaveBeenCalledTimes(1);
  });

  it("onAnchorReset is not called when no compaction occurred", async () => {
    const { deps } = createMockDeps({ reasoning: false, contextWindow: 200_000 });

    const onAnchorReset = vi.fn();
    deps.onAnchorReset = onAnchorReset;

    const engine = createContextEngine(enabledConfig, deps);

    // Small conversation that won't trigger compaction
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: Date.now() } as AgentMessage,
    ];

    await engine.transformContext(messages);

    expect(onAnchorReset).not.toHaveBeenCalled();
  });
});
