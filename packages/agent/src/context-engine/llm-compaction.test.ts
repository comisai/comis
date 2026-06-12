// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for LLM compaction context engine layer.
 *
 * Verifies trigger threshold, cooldown, quality validation, three-level
 * fallback, session persistence, and model override fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TokenBudget, CompactionLayerDeps } from "./types.js";
import { createLlmCompactionLayer, validateCompactionSummary } from "./llm-compaction.js";
import { COMPACTION_REQUIRED_SECTIONS, OVERSIZED_MESSAGE_CHARS_THRESHOLD } from "./constants.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock generateSummary from SDK
// ---------------------------------------------------------------------------

const mockGenerateSummary = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  generateSummary: (...args: unknown[]) => mockGenerateSummary(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Budget where 85% threshold would be ~108,800 tokens (128K * 0.85). */
const BUDGET: TokenBudget = {
  windowTokens: 128_000,
  systemTokens: 5_000,
  outputReserveTokens: 8_192,
  safetyMarginTokens: 6_400,
  contextRotBufferTokens: 32_000,
  availableHistoryTokens: 76_408,
};

function makeUserMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeToolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function createMockDeps(overrides?: {
  overrideModel?: CompactionLayerDeps["overrideModel"];
}): { deps: CompactionLayerDeps; logger: ReturnType<typeof createMockLogger>; mockSm: { fileEntries: unknown[]; _rewriteFile: ReturnType<typeof vi.fn> } } {
  const logger = createMockLogger();
  const mockSm = {
    fileEntries: [] as unknown[],
    _rewriteFile: vi.fn(),
  };
  const deps: CompactionLayerDeps = {
    logger: logger as unknown as CompactionLayerDeps["logger"],
    getSessionManager: () => mockSm,
    getModel: () => ({
      id: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      contextWindow: 128_000,
      reasoning: true,
    }),
    getApiKey: vi.fn().mockResolvedValue("test-api-key"),
    overrideModel: overrides?.overrideModel,
  };
  return { deps, logger, mockSm };
}

/** Build a valid summary with all 9 required sections. */
function buildValidSummary(): string {
  return `## Identifiers
- Agent: test-agent, Channel: discord, Thread: #general

## Primary Request and Intent
- User wants to implement structured compaction with semantic sections

## Decisions
- Decided to use TypeScript for type safety

## Files and Code
- File: src/context-engine/llm-compaction.ts:63
- \`buildComisCompactionInstructions()\` — returns structured prompt

## Errors and Resolutions
- (none)

## User Messages
- "Please update the compaction sections to be more semantic"

## Constraints
- Must be backwards compatible with existing compaction format

## Active Work
- Implementing the semantic section upgrade

## Next Steps
- Complete implementation
- Write tests
- Verify section count`;
}

/** Build an incomplete summary missing several of the 9 sections. */
function buildIncompleteSummary(): string {
  return `## Identifiers
- Agent: test-agent

## Decisions
- Decided to use TypeScript

## Constraints
- Must be backwards compatible`;
}

/**
 * Build a message array that will exceed the 85% threshold.
 * 128K window * 85% = 108,800 tokens = 435,200 chars (at 4 chars/token).
 * We need messages totaling > 435K chars.
 */
function buildLargeConversation(charTarget = 500_000): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const charsPerMessage = 10_000;
  const count = Math.ceil(charTarget / charsPerMessage);
  for (let i = 0; i < count; i++) {
    messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(charsPerMessage / 3)));
    messages.push(makeAssistantMsg("A" + i + ": " + "y".repeat(charsPerMessage / 3)));
    messages.push(makeToolResult(`tc_${i}`, "bash", "z".repeat(charsPerMessage / 3)));
  }
  return messages;
}

/** Build a small conversation that stays below 85% threshold. */
function buildSmallConversation(): AgentMessage[] {
  return [
    makeUserMsg("Hello"),
    makeAssistantMsg("Hi there"),
    makeUserMsg("How are you?"),
    makeAssistantMsg("I'm doing well."),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLlmCompactionLayer", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  // -------------------------------------------------------------------------
  // 1. Below threshold -- no compaction
  // -------------------------------------------------------------------------

  it("returns messages unchanged when below 85% of windowTokens", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSmallConversation();

    const result = await layer.apply(messages, BUDGET);

    expect(result).toBe(messages); // Same reference = no changes
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 1b. FLOOR-02 (Phase 176) — the pipeline-path parity verdict pins.
  //
  // The "pipeline" context engine has no CWF-02 preflight, no output-headroom
  // enforcement, and no proactive exhaustion classification (those are
  // dag-only). Its de-facto fit guard is THIS budget-aware 85% compaction
  // trigger (llm-compaction.ts: thresholdTokens =
  // floor(budget.windowTokens * COMPACTION_TRIGGER_PERCENT / 100)). These are
  // CHARACTERIZATION pins of existing behavior — the written half of the
  // FLOOR-02 verdict (the doc half lives in docs/reference/config-yaml.mdx).
  // The below-threshold direction is pinned above; these pin the other
  // direction (arms at threshold) and the threshold's derivation source.
  // -------------------------------------------------------------------------

  it("FLOOR-02-1: arms compaction when above 85% of budget.windowTokens (pipeline de-facto fit guard — parity verdict pin)", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    // 10 text messages × ~50K chars ≈ 500K chars ≈ 143K tokens (ratio 3.5) —
    // ABOVE floor(128_000 × 85 / 100) = 108_800 tokens, while messageCount 10
    // stays below the 60-message block-count trigger, so the firing trigger is
    // the 85% token threshold. Zoning: tail budget 76_408 × 3.5 ≈ 267K chars
    // fits ~5 messages; head 0 (no prefixAnchorTurns) → middle ≥ 3, so the
    // compaction actually runs (not just evaluates).
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(50_000)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(50_000)));
    }
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // The de-facto guard armed: summarization ran and the context was compacted.
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    expect(result).not.toBe(messages);
    // The trigger that fired is the budget-window token threshold (cooldown=5
    // did not suppress the FIRST trigger — turnsSinceLastCompaction starts at
    // Infinity, exactly as the :180 below-threshold pin relies on).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "token_threshold",
        thresholdTokens: Math.floor((BUDGET.windowTokens * 85) / 100),
        windowTokens: BUDGET.windowTokens,
        errorKind: "resource",
      }),
      "LLM compaction triggered: context exceeds 85% threshold",
    );
  });

  it("FLOOR-02-2: threshold derives from budget.windowTokens, not the model's configured contextWindow", async () => {
    const { deps, logger } = createMockDeps();
    // The deps' model declares contextWindow 128_000 (createMockDeps), but the
    // budget handed to the layer carries a SMALLER windowTokens — the shape a
    // served/capability-capped budget would have. The trigger must key on the
    // budget value.
    const smallBudget: TokenBudget = {
      windowTokens: 32_000, // ≪ deps.getModel().contextWindow (128_000)
      systemTokens: 2_000,
      outputReserveTokens: 4_096,
      safetyMarginTokens: 2_048,
      contextRotBufferTokens: 8_000,
      availableHistoryTokens: 15_856,
    };
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    // 10 text messages × ~16K chars ≈ 160K chars ≈ 46K tokens (ratio 3.5):
    //   ABOVE floor(32_000 × 85 / 100) = 27_200  (85% of budget.windowTokens)
    //   BELOW floor(128_000 × 85 / 100) = 108_800 (85% of the model's window)
    // If the threshold derived from the model's configured contextWindow, this
    // conversation would NOT trigger — the firing itself proves budget-keying.
    // Zoning: tail budget 15_856 × 3.5 ≈ 55K chars fits ~3 messages → middle 7 ≥ 3.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(16_000)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(16_000)));
    }
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, smallBudget);

    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    expect(result).not.toBe(messages);
    // The logged threshold is floor(budget.windowTokens × 85 / 100) — the
    // budget value, NOT floor(128_000 × 85 / 100) = 108_800 from the model.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "token_threshold",
        thresholdTokens: 27_200,
        windowTokens: 32_000,
      }),
      "LLM compaction triggered: context exceeds 85% threshold",
    );
  });

  // -------------------------------------------------------------------------
  // 2. Within cooldown -- no compaction
  // -------------------------------------------------------------------------

  it("skips compaction when within cooldown window even if above threshold", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    // First call: triggers compaction (turnsSinceLastCompaction starts at Infinity)
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    await layer.apply(largeMessages, BUDGET);

    // Reset mock for next calls
    mockGenerateSummary.mockReset();

    // Calls 2-5: within cooldown (turns 1-4), should NOT trigger
    for (let i = 0; i < 4; i++) {
      const result = await layer.apply(largeMessages, BUDGET);
      // Returns original messages because within cooldown
      expect(result).toBe(largeMessages);
    }

    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Level 1 success
  // -------------------------------------------------------------------------

  it("compacts with Level 1 when generateSummary returns valid summary", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    // Result should start with compaction summary
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(largeMessages.length);
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
    const firstContent = (result[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
    expect(firstContent).toContain("<summary>");
    expect(firstContent).toContain("## Identifiers");

    // generateSummary called once (Level 1 success on first attempt)
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);

    // Info log emitted
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackLevel: 1, attempts: 1 }),
      "LLM compaction complete",
    );
  });

  // -------------------------------------------------------------------------
  // 4. Level 1 retry then success
  // -------------------------------------------------------------------------

  it("retries Level 1 when first attempt returns incomplete summary", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    // First attempt: incomplete summary
    mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
    // Second attempt: valid summary
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    // Should succeed on second attempt
    expect(mockGenerateSummary).toHaveBeenCalledTimes(2);
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Level 1 exhausted, Level 2 success
  // -------------------------------------------------------------------------

  it("falls to Level 2 after 3 failed Level 1 attempts", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    // 3 failed Level 1 attempts (missing sections)
    mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
    mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
    mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
    // Level 2: succeeds
    mockGenerateSummary.mockResolvedValueOnce("Level 2 summary without sections");

    const result = await layer.apply(largeMessages, BUDGET);

    // 3 Level 1 attempts + 1 Level 2 = 4 calls
    expect(mockGenerateSummary).toHaveBeenCalledTimes(4);
    expect(result[0]).toBeDefined();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackLevel: 2 }),
      "LLM compaction complete",
    );
  });

  // -------------------------------------------------------------------------
  // 6. All levels exhausted, Level 3 fallback
  // -------------------------------------------------------------------------

  it("falls to Level 3 count-only note when all LLM calls fail", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    // All attempts throw
    mockGenerateSummary.mockRejectedValue(new Error("LLM unavailable"));

    const result = await layer.apply(largeMessages, BUDGET);

    // Level 3: count-only note
    const firstContent = (result[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
    expect(firstContent).toContain("[Context compacted:");
    expect(firstContent).toContain("messages summarized");
    expect(firstContent).toContain("No LLM summary available");

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackLevel: 3 }),
      "LLM compaction complete",
    );
  });

  // -------------------------------------------------------------------------
  // 7. Session persistence
  // -------------------------------------------------------------------------

  it("persists compaction to SessionManager via fileEntries and _rewriteFile", async () => {
    const { deps, mockSm } = createMockDeps();

    // Populate fileEntries with message entries
    mockSm.fileEntries = [
      { type: "message", message: { role: "user", content: "Q1" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A1" }] } },
      { type: "message", message: { role: "user", content: "Q2" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A2" }] } },
    ];

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // _rewriteFile should have been called
    expect(mockSm._rewriteFile).toHaveBeenCalledTimes(1);

    // fileEntries should start with the compaction summary entry
    const firstEntry = mockSm.fileEntries[0] as { type: string; message: { compactionSummary: boolean; content: Array<{ text: string }> } };
    expect(firstEntry.type).toBe("message");
    expect(firstEntry.message.compactionSummary).toBe(true);
    expect(firstEntry.message.content[0].text).toContain("<summary>");
  });

  // -------------------------------------------------------------------------
  // 8. Model override fallback
  // -------------------------------------------------------------------------

  it("falls back to session model when override model apiKey throws", async () => {
    const { deps, logger } = createMockDeps({
      overrideModel: {
        model: { id: "cheap-model", provider: "groq" },
        getApiKey: vi.fn().mockRejectedValue(new Error("No API key for groq")),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    // Should still succeed using session model
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);

    // WARN log about override failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Compaction model override failed; falling back to session model",
      }),
      "Compaction model override resolution failed",
    );

    // getApiKey on the main deps should have been called as fallback
    expect(deps.getApiKey).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. Cooldown resets after compaction
  // -------------------------------------------------------------------------

  it("resets cooldown after successful compaction, re-triggers after cooldown expires", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 3 }, deps);
    const largeMessages = buildLargeConversation();

    // First compaction
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    await layer.apply(largeMessages, BUDGET);

    // Turns 1-2: within cooldown (cooldown=3)
    const result1 = await layer.apply(largeMessages, BUDGET);
    expect(result1).toBe(largeMessages);
    const result2 = await layer.apply(largeMessages, BUDGET);
    expect(result2).toBe(largeMessages);

    // Turn 3: cooldown expired, should trigger again
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    const result3 = await layer.apply(largeMessages, BUDGET);
    expect(result3).not.toBe(largeMessages);
    expect((result3[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10. WARN-level log on compaction trigger
  // -------------------------------------------------------------------------

  it("emits WARN-level log (not DEBUG) when compaction triggers with errorKind and hint", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // WARN must be called with the compaction trigger message.
    // With 150 messages (> 60 block threshold), the block-count trigger fires first.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        blockThreshold: 60,
        trigger: "block_count",
        windowTokens: 128_000,
        messageCount: largeMessages.length,
        errorKind: "resource",
        hint: expect.stringMatching(/compaction|lookback/i),
      }),
      "LLM compaction triggered: message count exceeds cache lookback threshold",
    );

    // DEBUG must NOT have been called with the trigger message
    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const triggerDebugCalls = debugCalls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("LLM compaction triggered"),
    );
    expect(triggerDebugCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Layer name
  // -------------------------------------------------------------------------

  it("has name 'llm-compaction'", () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    expect(layer.name).toBe("llm-compaction");
  });

  // -------------------------------------------------------------------------
  // Error safety net
  // -------------------------------------------------------------------------

  it("returns unmodified messages if getApiKey throws (safety net)", async () => {
    const { deps, logger } = createMockDeps();
    (deps.getApiKey as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("No key"));
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    const result = await layer.apply(largeMessages, BUDGET);

    // Safety net returns original messages
    expect(result).toBe(largeMessages);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "LLM compaction failed; returning unmodified context",
      }),
      "LLM compaction layer error",
    );
  });

  // -------------------------------------------------------------------------
  // Repeated compaction safety
  // -------------------------------------------------------------------------

  describe("Repeated compaction safety", () => {
    it("Level 1 compaction across 3 cycles preserves message content", async () => {
      const { deps } = createMockDeps();
      const layer = createLlmCompactionLayer({ compactionCooldownTurns: 0 }, deps);

      // --- Cycle 1 ---
      const cycle1Summary = buildValidSummary();
      mockGenerateSummary.mockResolvedValueOnce(cycle1Summary);
      const cycle1Messages = buildLargeConversation();
      const cycle1Result = await layer.apply(cycle1Messages, BUDGET);

      // Cycle 1 assertions
      expect((cycle1Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      const cycle1Content = (cycle1Result[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
      expect(cycle1Content).toContain("<summary>");
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1);

      // --- Cycle 2 ---
      mockGenerateSummary.mockClear();
      const cycle2Summary = buildValidSummary().replace("test-agent", "test-agent-cycle2");
      mockGenerateSummary.mockResolvedValueOnce(cycle2Summary);

      // Build cycle 2 messages: cycle 1 summary + new large content
      const cycle2NewMessages = buildLargeConversation();
      const messagesForCycle2 = [cycle1Result[0], ...cycle2NewMessages];
      const cycle2Result = await layer.apply(messagesForCycle2, BUDGET);

      // Cycle 2 assertions
      expect((cycle2Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1);

      // Verify generateSummary received cycle 1 summary in its currentMessages argument
      const cycle2CallMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
      const cycle1SummaryInInput = cycle2CallMessages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("test-agent"));
        },
      );
      expect(cycle1SummaryInInput).toBe(true);

      // --- Cycle 3 ---
      mockGenerateSummary.mockClear();
      const cycle3Summary = buildValidSummary().replace("test-agent", "test-agent-cycle3");
      mockGenerateSummary.mockResolvedValueOnce(cycle3Summary);

      // Build cycle 3 messages: cycle 2 summary + new large content
      const cycle3NewMessages = buildLargeConversation();
      const messagesForCycle3 = [cycle2Result[0], ...cycle3NewMessages];
      const cycle3Result = await layer.apply(messagesForCycle3, BUDGET);

      // Cycle 3 assertions
      expect((cycle3Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1);

      // Verify generateSummary received cycle 2 summary in its currentMessages argument
      const cycle3CallMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
      const cycle2SummaryInInput = cycle3CallMessages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("test-agent-cycle2"));
        },
      );
      expect(cycle2SummaryInInput).toBe(true);
    });

    it("Level 2 fallback across 3 cycles preserves prior summaries", async () => {
      const { deps } = createMockDeps();
      const layer = createLlmCompactionLayer({ compactionCooldownTurns: 0 }, deps);

      // Helper to mock one Level 2 cycle: 3 L1 failures + 1 L2 success
      function mockLevel2Cycle(summaryText: string): void {
        mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
        mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
        mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
        mockGenerateSummary.mockResolvedValueOnce(summaryText);
      }

      // --- Cycle 1 (Level 2 path) ---
      mockLevel2Cycle("Cycle 1 L2 summary: user discussed API design");
      const cycle1Messages = buildLargeConversation();
      const cycle1Result = await layer.apply(cycle1Messages, BUDGET);

      expect(cycle1Result[0]).toBeDefined();
      expect((cycle1Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(4); // 3 L1 fails + 1 L2 success

      // --- Cycle 2 (Level 2 path) ---
      mockGenerateSummary.mockClear();
      mockLevel2Cycle("Cycle 2 L2 summary: user discussed testing strategy");
      const cycle2NewMessages = buildLargeConversation();
      const messagesForCycle2 = [cycle1Result[0], ...cycle2NewMessages];
      const cycle2Result = await layer.apply(messagesForCycle2, BUDGET);

      expect((cycle2Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(4);

      // Verify: the Level 2 call (4th call) received cycle 1 summary in its filtered messages
      const cycle2L2CallMessages = mockGenerateSummary.mock.calls[3][0] as AgentMessage[];
      const cycle1SummaryInL2Input = cycle2L2CallMessages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("Cycle 1 L2 summary"));
        },
      );
      expect(cycle1SummaryInL2Input).toBe(true);

      // --- Cycle 3 (Level 2 path) ---
      mockGenerateSummary.mockClear();
      mockLevel2Cycle("Cycle 3 L2 summary: user discussed deployment");
      const cycle3NewMessages = buildLargeConversation();
      const messagesForCycle3 = [cycle2Result[0], ...cycle3NewMessages];
      const cycle3Result = await layer.apply(messagesForCycle3, BUDGET);

      expect((cycle3Result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(4);

      // Verify: the Level 2 call (4th call) received cycle 2 summary
      const cycle3L2CallMessages = mockGenerateSummary.mock.calls[3][0] as AgentMessage[];
      const cycle2SummaryInL2Input = cycle3L2CallMessages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("Cycle 2 L2 summary"));
        },
      );
      expect(cycle2SummaryInL2Input).toBe(true);
    });

    it("Level 2 filtering does not drop compaction summary messages (< 50K chars)", async () => {
      const { deps } = createMockDeps();
      const layer = createLlmCompactionLayer({ compactionCooldownTurns: 0 }, deps);

      // Step 1: Create a compaction summary message (~2K chars, well below 50K)
      const priorSummaryContent = "Prior compaction summary: " + "x".repeat(2000);
      const priorSummary: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: `<summary>\n${priorSummaryContent}\n</summary>` }],
        compactionSummary: true,
      } as unknown as AgentMessage;

      // Step 2: Create oversized messages (each >50K chars to trigger Level 2 filtering)
      const oversizedContent = "z".repeat(OVERSIZED_MESSAGE_CHARS_THRESHOLD + 10_000);
      const oversized1 = makeUserMsg(oversizedContent);
      const oversized2 = makeAssistantMsg(oversizedContent);

      // Step 3: Create normal-sized messages
      const normalMessages = buildLargeConversation(400_000);

      // Step 4: Build message array with prior summary + oversized + normal
      const allMessages = [priorSummary, oversized1, oversized2, ...normalMessages];

      // Step 5: Mock Level 2 path (3 L1 failures + 1 L2 success)
      mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
      mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
      mockGenerateSummary.mockResolvedValueOnce(buildIncompleteSummary());
      mockGenerateSummary.mockResolvedValueOnce("Level 2 summary after filtering");

      const result = await layer.apply(allMessages, BUDGET);
      expect(result[0]).toBeDefined();

      // Step 6: Inspect the 4th call (Level 2) -- the filtered message set
      const level2Messages = mockGenerateSummary.mock.calls[3][0] as AgentMessage[];

      // The compaction summary (~2K chars) should be INCLUDED
      const summaryPresent = level2Messages.some(
        (m) => {
          const content = (m as unknown as { content: Array<{ text: string }> }).content;
          return Array.isArray(content) && content.some((c) => c.text?.includes("Prior compaction summary"));
        },
      );
      expect(summaryPresent).toBe(true);

      // Oversized messages (>50K chars) should be EXCLUDED
      const oversizedPresent = level2Messages.some(
        (m) => {
          const content = (m as unknown as { content: string | Array<{ text: string }> }).content;
          if (typeof content === "string") return content.length > OVERSIZED_MESSAGE_CHARS_THRESHOLD;
          if (Array.isArray(content)) return content.some((c) => c.text?.length > OVERSIZED_MESSAGE_CHARS_THRESHOLD);
          return false;
        },
      );
      expect(oversizedPresent).toBe(false);

      // Normal-sized messages should be INCLUDED
      expect(level2Messages.length).toBeGreaterThan(1); // at least summary + some normal messages
    });
  });
});

// ---------------------------------------------------------------------------
// discoveredTools metadata in compaction
// ---------------------------------------------------------------------------

describe("discoveredTools metadata in compaction", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("compaction summary message includes discoveredTools from deps", async () => {
    const { deps } = createMockDeps();
    deps.getDiscoveredTools = () => ["tool_a", "tool_b"];
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    // Summary message should carry discoveredTools metadata
    const summaryMsg = result[0] as unknown as { compactionSummary: boolean; discoveredTools: string[] };
    expect(summaryMsg.compactionSummary).toBe(true);
    expect(summaryMsg.discoveredTools).toEqual(["tool_a", "tool_b"]);
  });

  it("compaction summary includes empty discoveredTools when getter returns empty", async () => {
    const { deps } = createMockDeps();
    deps.getDiscoveredTools = () => [];
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    const summaryMsg = result[0] as unknown as { discoveredTools: string[] };
    expect(summaryMsg.discoveredTools).toEqual([]);
  });

  it("compaction summary includes empty discoveredTools when getter undefined", async () => {
    const { deps } = createMockDeps();
    // getDiscoveredTools is not set (undefined by default in createMockDeps)
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(largeMessages, BUDGET);

    const summaryMsg = result[0] as unknown as { discoveredTools: string[] };
    expect(summaryMsg.discoveredTools).toEqual([]);
  });

  it("persistCompaction writes discoveredTools to compaction entry", async () => {
    const { deps, mockSm } = createMockDeps();
    deps.getDiscoveredTools = () => ["mcp_search", "mcp_analyze"];

    // Populate fileEntries with message entries
    mockSm.fileEntries = [
      { type: "message", message: { role: "user", content: "Q1" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A1" }] } },
    ];

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // Inspect the persisted compaction entry in fileEntries
    const compactionEntry = mockSm.fileEntries[0] as {
      type: string;
      message: { compactionSummary: boolean; discoveredTools: string[]; content: Array<{ text: string }> };
    };
    expect(compactionEntry.type).toBe("message");
    expect(compactionEntry.message.compactionSummary).toBe(true);
    expect(compactionEntry.message.discoveredTools).toEqual(["mcp_search", "mcp_analyze"]);
    expect(compactionEntry.message.content[0].text).toContain("<summary>");
  });
});

// ---------------------------------------------------------------------------
// Resolver-integrated compaction model (overrideModel contract)
// ---------------------------------------------------------------------------
// These tests verify the downstream consumption contract that pi-executor's
// resolver-based getCompactionDeps relies on. The overrideModel is now
// populated by resolveOperationModel in pi-executor, rather than
// ad-hoc string parsing. These tests verify:
// 1. overrideModel.model is used for generateSummary when present
// 2. Fallback to getModel() when overrideModel is absent
// 3. overrideModel.getApiKey is used instead of primary getApiKey

describe("resolver-integrated compaction model selection", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("uses override model from resolver for compaction generateSummary call", async () => {
    const overrideModelObj = {
      id: "gemini-2.0-flash",
      provider: "google",
      contextWindow: 1_000_000,
      reasoning: false,
    };
    const { deps } = createMockDeps({
      overrideModel: {
        model: overrideModelObj,
        getApiKey: vi.fn().mockResolvedValue("google-api-key"),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // generateSummary should have been called with the override model (2nd arg)
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const modelArg = mockGenerateSummary.mock.calls[0][1];
    expect(modelArg).toBe(overrideModelObj);

    // API key should be from the override, not the primary
    const apiKeyArg = mockGenerateSummary.mock.calls[0][3];
    expect(apiKeyArg).toBe("google-api-key");
  });

  it("falls through to session model when no overrideModel is provided (agent_primary source)", async () => {
    const { deps } = createMockDeps(); // No overrideModel
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // generateSummary should have been called with getModel() result (2nd arg)
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const modelArg = mockGenerateSummary.mock.calls[0][1];
    expect(modelArg).toEqual({
      id: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      contextWindow: 128_000,
      reasoning: true,
    });

    // API key should be from primary getApiKey
    const apiKeyArg = mockGenerateSummary.mock.calls[0][3];
    expect(apiKeyArg).toBe("test-api-key");
  });

  it("override model API key uses resolved provider (not agent primary)", async () => {
    const googleOverrideKey = "google-resolved-provider-key";
    const { deps } = createMockDeps({
      overrideModel: {
        model: { id: "gemini-2.5-flash", provider: "google" },
        getApiKey: vi.fn().mockResolvedValue(googleOverrideKey),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // API key passed to generateSummary must be the override provider's key
    const apiKeyArg = mockGenerateSummary.mock.calls[0][3];
    expect(apiKeyArg).toBe(googleOverrideKey);

    // Primary getApiKey should NOT have been called
    expect(deps.getApiKey).not.toHaveBeenCalled();
  });

  it("overrideModel takes highest priority for compaction", async () => {
    // This test verifies the contract: when pi-executor passes overrideModel
    // (resolved via operationModels chain), that model is used for compaction,
    // not the session model.
    const subAgentCompactionModel = {
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      contextWindow: 200_000,
      reasoning: false,
    };
    const { deps } = createMockDeps({
      overrideModel: {
        model: subAgentCompactionModel,
        getApiKey: vi.fn().mockResolvedValue("sub-agent-key"),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const largeMessages = buildLargeConversation();

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(largeMessages, BUDGET);

    // The sub-agent compaction model should be passed to generateSummary
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const modelArg = mockGenerateSummary.mock.calls[0][1];
    expect(modelArg).toBe(subAgentCompactionModel);
    expect(modelArg.id).toBe("claude-haiku-4-5-20251001");
    expect(modelArg.provider).toBe("anthropic");

    // Sub-agent's API key used
    const apiKeyArg = mockGenerateSummary.mock.calls[0][3];
    expect(apiKeyArg).toBe("sub-agent-key");
  });
});

// ---------------------------------------------------------------------------
// validateCompactionSummary
// ---------------------------------------------------------------------------

describe("validateCompactionSummary", () => {
  it("returns valid=true for summary with all 9 required sections", () => {
    const result = validateCompactionSummary(buildValidSummary());
    expect(result.valid).toBe(true);
    expect(result.missingSections).toHaveLength(0);
  });

  it("returns valid=false with missing sections listed", () => {
    const result = validateCompactionSummary(buildIncompleteSummary());
    expect(result.valid).toBe(false);
    // Should be missing 6 sections (has Identifiers, Decisions, Constraints)
    expect(result.missingSections).toContain("Primary Request and Intent");
    expect(result.missingSections).toContain("Files and Code");
    expect(result.missingSections).toContain("Errors and Resolutions");
    expect(result.missingSections).toContain("User Messages");
    expect(result.missingSections).toContain("Active Work");
    expect(result.missingSections).toContain("Next Steps");
  });

  it("matches section headings case-insensitively", () => {
    let summary = "";
    for (const section of COMPACTION_REQUIRED_SECTIONS) {
      summary += `## ${section.toUpperCase()}\n- content\n\n`;
    }
    const result = validateCompactionSummary(summary);
    expect(result.valid).toBe(true);
  });

  it("returns all 9 sections as missing for empty string", () => {
    const result = validateCompactionSummary("");
    expect(result.valid).toBe(false);
    expect(result.missingSections).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// Anchor-based estimation in compaction
// ---------------------------------------------------------------------------

describe("anchor-based estimation in compaction", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("compaction uses anchor for threshold check when getTokenAnchor returns non-null", async () => {
    const { deps, logger } = createMockDeps();
    // Provide an anchor saying we have 120,000 input tokens (above 85% of 128K = 108,800)
    deps.getTokenAnchor = () => ({
      inputTokens: 120_000,
      messageCount: 20,
      timestamp: Date.now(),
    });

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    // Use a moderate-size conversation that would NOT trigger char-based compaction
    // but has enough messages (and large enough middle) for three-zone to proceed.
    // Tail budget = 76_408 * 4 = 305,632 chars. Each message ~50K chars. Tail fits ~6 messages.
    // 10 messages total - 0 head (no prefixAnchorTurns) - 6 tail = 4 middle (>= 3 minimum).
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(50_000)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(50_000)));
    }

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // With the anchor reporting 120K tokens, compaction should trigger even though
    // the actual char-based estimate is below threshold
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTokens: expect.any(Number),
        hint: expect.stringMatching(/compaction/i),
      }),
      "LLM compaction triggered: context exceeds 85% threshold",
    );
    expect(mockGenerateSummary).toHaveBeenCalled();
  });

  it("compaction falls back to char-based when getTokenAnchor returns null", async () => {
    const { deps } = createMockDeps();
    deps.getTokenAnchor = () => null;

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSmallConversation();

    const result = await layer.apply(messages, BUDGET);

    // Small conversation with null anchor: char-based estimate is below threshold
    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("compaction falls back to char-based when getTokenAnchor is not provided", async () => {
    const { deps } = createMockDeps();
    // getTokenAnchor is undefined by default in createMockDeps

    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSmallConversation();

    const result = await layer.apply(messages, BUDGET);

    // No anchor, small conversation: char-based below threshold
    expect(result).toBe(messages);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Three-zone middle-out compaction
// ---------------------------------------------------------------------------

describe("three-zone middle-out compaction", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  /**
   * Build a large conversation of user+assistant pairs.
   * Each message has ~charsPerMsg chars, producing `pairCount` pairs
   * (2 * pairCount messages total).
   *
   * Head budget = availableHistoryTokens * 4 = 76,408 * 4 = 305,632 chars.
   * Compaction trigger = 128K * 85% * 4 = 435,200 chars.
   * Use small head messages (~10K each, 4 * 10K = 40K < 305K budget)
   * and large middle/tail messages (~200K each) to exceed trigger threshold.
   */
  function buildThreeZoneConversation(pairCount: number, headCharsPerMsg = 10_000, bodyCharsPerMsg = 200_000): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < pairCount; i++) {
      const chars = i < 2 ? headCharsPerMsg : bodyCharsPerMsg;
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(chars)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(chars)));
    }
    return messages;
  }

  it("preserves head messages and summarizes only middle zone", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );
    // 5 user+assistant pairs = 10 messages.
    // Head (first 2 pairs): ~10K chars each = ~40K (fits 305K budget).
    // Body (pairs 3-5): ~200K chars each = ~1.2M total. Well above 435K trigger.
    const messages = buildThreeZoneConversation(5);

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // Head = first 2 user-turn cycles = messages[0..3] (user0, assistant0, user1, assistant1)
    // These must be the SAME object references (not copies)
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(result[2]).toBe(messages[2]);
    expect(result[3]).toBe(messages[3]);

    // Position 4 is the compaction summary
    const summaryMsg = result[4] as unknown as { compactionSummary: boolean; content: Array<{ text: string }> };
    expect(summaryMsg.compactionSummary).toBe(true);
    expect(summaryMsg.content[0].text).toContain("<summary>");

    // generateSummary must NOT have received head or tail messages
    const summarizedMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    // Head messages (0-3) should NOT be in the summarized set
    expect(summarizedMessages).not.toContain(messages[0]);
    expect(summarizedMessages).not.toContain(messages[1]);
    expect(summarizedMessages).not.toContain(messages[2]);
    expect(summarizedMessages).not.toContain(messages[3]);

    // Result ends with tail messages (last messages fitting budget)
    const lastResult = result[result.length - 1];
    expect(lastResult).toBe(messages[messages.length - 1]);
  });

  it("prefixAnchorTurns=0 uses tail-only behavior (backward compatible)", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 0 },
      deps,
    );
    const messages = buildThreeZoneConversation(5);

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // With prefixAnchorTurns=0, head is empty, so generateSummary receives the full middle
    // (all messages except tail)
    const summarizedMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    // The summarized set should contain some of the initial messages (no head preserved)
    expect(summarizedMessages).toContain(messages[0]);

    // Result[0] is the compaction summary (no preserved head)
    const firstMsg = result[0] as unknown as { compactionSummary: boolean };
    expect(firstMsg.compactionSummary).toBe(true);
  });

  it("falls back to tail-only when head exceeds budget", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );
    // Budget chars = availableHistoryTokens * 4 = 76_408 * 4 = 305,632
    // Head = first 2 user turns (4 messages). At 100K chars each = 400K, exceeds 305K budget.
    // Use large head messages to trigger the fallback.
    const messages = buildThreeZoneConversation(5, 100_000, 200_000);

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // Head exceeded budget, so it falls back to tail-only
    // Result[0] should be the compaction summary (no preserved head)
    const firstMsg = result[0] as unknown as { compactionSummary: boolean };
    expect(firstMsg.compactionSummary).toBe(true);

    // WARN log about falling back
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Head exceeds budget; falling back to tail-only compaction",
      }),
      "Cache-preserving compaction fallback to tail-only",
    );
  });

  it("skips compaction when middle zone is too small", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );
    // Use anchor to force threshold exceeded (small messages wouldn't trigger char-based)
    deps.getTokenAnchor = () => ({
      inputTokens: 120_000, // above 85% of 128K = 108,800
      messageCount: 6,
      timestamp: Date.now(),
    });
    // 3 user+assistant pairs = 6 messages. Head = 4 (2 user turns).
    // Budget is large enough for all remaining 2 messages as tail.
    // So middle = 6 - 4 (head) - 2 (tail) = 0, which is below MIN_MIDDLE_MESSAGES_FOR_COMPACTION (3).
    const messages: AgentMessage[] = [
      makeUserMsg("Q0: " + "x".repeat(1_000)),
      makeAssistantMsg("A0: " + "y".repeat(1_000)),
      makeUserMsg("Q1: " + "x".repeat(1_000)),
      makeAssistantMsg("A1: " + "y".repeat(1_000)),
      makeUserMsg("Q2: " + "x".repeat(1_000)),
      makeAssistantMsg("A2: " + "y".repeat(1_000)),
    ];

    const result = await layer.apply(messages, BUDGET);

    // Middle too small, so compaction is skipped
    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(result).toBe(messages);

    // V5 regression: when compaction is structurally infeasible (middle too small),
    // the trigger warn must NOT fire — otherwise we get a per-turn warn storm.
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const triggerWarnCalls = warnCalls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("LLM compaction triggered"),
    );
    expect(triggerWarnCalls).toHaveLength(0);
  });

  it("extends head boundary for pair safety (tool_use/tool_result)", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 1 },
      deps,
    );

    // user0, assistantWithToolUse0, toolResult0, user1, assistant1, ...more
    const assistantWithToolUse: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check..." + "z".repeat(50_000) },
        { type: "tool_use", id: "tc1", name: "web_search", input: { query: "test" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "tool_use",
      timestamp: Date.now(),
    } as AgentMessage;

    const messages: AgentMessage[] = [
      makeUserMsg("Q0: " + "x".repeat(50_000)),              // index 0 — head (1st user turn)
      assistantWithToolUse,                                    // index 1 — extended by pair safety
      makeToolResult("tc1", "web_search", "z".repeat(50_000)), // index 2 — extended by pair safety
      makeUserMsg("Q1: " + "x".repeat(100_000)),              // index 3 — middle
      makeAssistantMsg("A1: " + "y".repeat(100_000)),         // index 4 — middle
      makeUserMsg("Q2: " + "x".repeat(100_000)),              // index 5 — middle
      makeAssistantMsg("A2: " + "y".repeat(100_000)),         // index 6 — middle/tail
      makeUserMsg("Q3: " + "x".repeat(100_000)),              // index 7 — tail
      makeAssistantMsg("A3: " + "y".repeat(100_000)),         // index 8 — tail
    ];

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // Head should include user0, assistantWithToolUse, toolResult0 (3 messages via pair safety)
    expect(result[0]).toBe(messages[0]);   // user0
    expect(result[1]).toBe(messages[1]);   // assistantWithToolUse
    expect(result[2]).toBe(messages[2]);   // toolResult0

    // generateSummary should NOT include head messages
    const summarizedMessages = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(summarizedMessages).not.toContain(messages[0]);
    expect(summarizedMessages).not.toContain(messages[1]);
    expect(summarizedMessages).not.toContain(messages[2]);
  });

  it("persistCompaction preserves head entries and removes only middle", async () => {
    const { deps, mockSm } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );

    // 5 user+assistant pairs = 10 messages (small head, large body)
    const messages = buildThreeZoneConversation(5);

    // Pre-populate fileEntries matching the messages
    mockSm.fileEntries = messages.map((m) => ({ type: "message", message: m }));

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(messages, BUDGET);

    // Verify _rewriteFile was called
    expect(mockSm._rewriteFile).toHaveBeenCalledTimes(1);

    // Head entries (first 4 message entries) should still be present
    const msgEntries = (mockSm.fileEntries as Array<{ type: string; message: unknown }>).filter(
      (e) => e.type === "message",
    );
    // First 4 should be original head messages
    expect(msgEntries[0].message).toBe(messages[0]);
    expect(msgEntries[1].message).toBe(messages[1]);
    expect(msgEntries[2].message).toBe(messages[2]);
    expect(msgEntries[3].message).toBe(messages[3]);

    // Next entry should be the compaction summary
    const summaryEntry = msgEntries[4] as { message: { compactionSummary: boolean; content: Array<{ text: string }> } };
    expect(summaryEntry.message.compactionSummary).toBe(true);
    expect(summaryEntry.message.content[0].text).toContain("<summary>");

    // Tail entries should be preserved (last messages from the array)
    const lastEntry = msgEntries[msgEntries.length - 1] as { message: AgentMessage };
    expect(lastEntry.message).toBe(messages[messages.length - 1]);

    // Total entries should be less than original 10 (middle removed, summary added)
    expect(msgEntries.length).toBeLessThan(10);
  });

  it("empty middle with all messages fitting in head+tail returns unchanged", async () => {
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );
    // Use anchor to force threshold exceeded (small messages wouldn't trigger char-based)
    deps.getTokenAnchor = () => ({
      inputTokens: 120_000,
      messageCount: 4,
      timestamp: Date.now(),
    });
    // 2 user+assistant pairs = 4 messages with small content
    // Head covers all 4 (2 user turns). Tail also covers them.
    // Middle = 0 messages.
    const messages: AgentMessage[] = [
      makeUserMsg("Q0: short question"),
      makeAssistantMsg("A0: short answer"),
      makeUserMsg("Q1: another question"),
      makeAssistantMsg("A1: another answer"),
    ];

    const result = await layer.apply(messages, BUDGET);

    // Middle is 0 (< MIN_MIDDLE_MESSAGES_FOR_COMPACTION), so no compaction
    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(result).toBe(messages);

    // V5 regression: trigger warn must not fire when nothing was compacted.
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const triggerWarnCalls = warnCalls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("LLM compaction triggered"),
    );
    expect(triggerWarnCalls).toHaveLength(0);
  });

  it("does not warn-storm when block_count exceeds threshold but middle is structurally empty", async () => {
    // Reproduces the V5 production incident:
    //   messageCount climbs past CACHE_AWARE_COMPACTION_BLOCK_THRESHOLD (60)
    //   while every message is small enough that head+tail absorbs everything,
    //   leaving middle empty. Previously, every apply() call logged the trigger
    //   warn; we observed 19 warns in 90s while the count climbed 61 -> 113.
    const { deps, logger } = createMockDeps();
    const layer = createLlmCompactionLayer(
      // cooldown=0 so the storm path is exercised on every call
      { compactionCooldownTurns: 0, compactionPrefixAnchorTurns: 2 },
      deps,
    );

    // Build 70 small messages (> 60 block threshold) of tool_use/tool_result
    // pairs, all tiny — total chars stay well under the budget so the tail
    // absorbs everything below the head, leaving an empty middle.
    const messages: AgentMessage[] = [
      makeUserMsg("Q0: kick off"),
      makeAssistantMsg("A0: starting"),
    ];
    for (let i = 0; i < 34; i++) {
      messages.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: `tc${i}`, name: "exec", input: { command: "x" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "tool_use",
        timestamp: Date.now(),
      } as AgentMessage);
      messages.push(makeToolResult(`tc${i}`, "exec", `Failed: short ${i}`));
    }
    expect(messages.length).toBeGreaterThan(60); // confirm we trip block_count

    // Drive 20 consecutive apply() calls to mirror many LLM round-trips.
    for (let i = 0; i < 20; i++) {
      const result = await layer.apply(messages, BUDGET);
      expect(result).toBe(messages); // unchanged each turn
    }

    // generateSummary must never be called — middle is empty every iteration.
    expect(mockGenerateSummary).not.toHaveBeenCalled();

    // The trigger warn must fire ZERO times across all 20 calls.
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const triggerWarnCalls = warnCalls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("LLM compaction triggered"),
    );
    expect(triggerWarnCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C4/S4: capability-routed compaction + security pinning (pipeline layer)
// ---------------------------------------------------------------------------

import type { TypedEventBus } from "@comis/core";
import type { SecurityPinMarkers } from "./security-context-pinner.js";

function makeEventBus(): { bus: TypedEventBus; emits: Array<{ event: string; payload: Record<string, unknown> }> } {
  const emits: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const bus = {
    emit: (event: string, payload: Record<string, unknown>) => {
      emits.push({ event, payload });
      return true;
    },
  } as unknown as TypedEventBus;
  return { bus, emits };
}

describe("C4: capability-routed compaction (pipeline layer)", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("small + preferEviction=true: returns messages unchanged without LLM call, emits WARN + context:compaction_routed", async () => {
    const { bus, emits } = makeEventBus();
    const { deps, logger } = createMockDeps();
    deps.eventBus = bus;
    deps.agentId = "agent-x";
    deps.sessionKey = "sess-x";
    const layer = createLlmCompactionLayer(
      {
        compactionCooldownTurns: 5,
        compactionPrefixAnchorTurns: 0,
        capabilityClass: "small",
        preferEvictionByCapability: true,
        strongerSummarizerModel: "",
      },
      deps,
    );
    const largeMessages = buildLargeConversation();

    const result = await layer.apply(largeMessages, BUDGET);

    // No LLM call — eviction path taken
    expect(mockGenerateSummary).not.toHaveBeenCalled();
    // Returns messages unchanged
    expect(result).toBe(largeMessages);
    // WARN logged with C4 indicator
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("C4"),
        errorKind: "config",
        capabilityClass: "small",
        strategy: "eviction",
      }),
      "C4: compaction capability gate — eviction selected",
    );
    // context:compaction_routed event emitted
    const routed = emits.filter((e) => e.event === "context:compaction_routed");
    expect(routed.length).toBe(1);
    expect(routed[0]!.payload.capabilityClass).toBe("small");
    expect(routed[0]!.payload.strategy).toBe("eviction");
    expect(routed[0]!.payload.layer).toBe("pipeline");
    expect(typeof routed[0]!.payload.securityPinnedCount).toBe("number");
  });

  it("nano + preferEviction=true: returns messages unchanged without LLM call", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      {
        compactionCooldownTurns: 5,
        compactionPrefixAnchorTurns: 0,
        capabilityClass: "nano",
        preferEvictionByCapability: true,
        strongerSummarizerModel: "",
      },
      deps,
    );
    const largeMessages = buildLargeConversation();
    const result = await layer.apply(largeMessages, BUDGET);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(result).toBe(largeMessages);
  });

  it("small + preferEviction=false: falls through to LLM (opt-out)", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      {
        compactionCooldownTurns: 5,
        compactionPrefixAnchorTurns: 0,
        capabilityClass: "small",
        preferEvictionByCapability: false,
        strongerSummarizerModel: "",
      },
      deps,
    );
    const largeMessages = buildLargeConversation();
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    const result = await layer.apply(largeMessages, BUDGET);
    // LLM path taken (opt-out)
    expect(mockGenerateSummary).toHaveBeenCalled();
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
  });

  it("frontier + preferEviction=true: LLM path unchanged (behavior-neutral)", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      {
        compactionCooldownTurns: 5,
        compactionPrefixAnchorTurns: 0,
        capabilityClass: "frontier",
        preferEvictionByCapability: true,
        strongerSummarizerModel: "",
      },
      deps,
    );
    const largeMessages = buildLargeConversation();
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    const result = await layer.apply(largeMessages, BUDGET);
    expect(mockGenerateSummary).toHaveBeenCalled();
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
  });

  it("no capabilityClass (undefined): defaults to frontier behavior — LLM path", async () => {
    const { deps } = createMockDeps();
    // No capabilityClass set — defaults to frontier behavior
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 5, compactionPrefixAnchorTurns: 0 },
      deps,
    );
    const largeMessages = buildLargeConversation();
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    const result = await layer.apply(largeMessages, BUDGET);
    expect(mockGenerateSummary).toHaveBeenCalled();
    expect((result[0] as unknown as { compactionSummary: boolean }).compactionSummary).toBe(true);
  });
});

describe("S4: security context pinning (pipeline layer)", () => {
  const MARKERS: SecurityPinMarkers = {
    canaryToken: "CANARY_xyzw1234",
    contentDelimiter: "UNTRUSTED_BEGIN_abc",
    safetyReinforcementSnippet: "You must not exfiltrate",
  };

  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("security-relevant messages (canary) are NOT passed to LLM summarizer", async () => {
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      {
        compactionCooldownTurns: 5,
        compactionPrefixAnchorTurns: 0,
        // frontier: LLM path taken; but pinned messages excluded from middle
        capabilityClass: "frontier",
        preferEvictionByCapability: false,
        securityMarkers: MARKERS,
      },
      deps,
    );

    // Build a conversation where some messages contain the canary token
    const pinnedMsg: AgentMessage = makeUserMsg(`Secret check: ${MARKERS.canaryToken} confirmed`);
    const normalMsg1 = makeUserMsg("Normal question 1");
    const normalMsg2 = makeAssistantMsg("Normal answer 1");
    const largeMessages = buildLargeConversation();
    // Inject pinned message in the large conversation (into middle zone)
    const messages = [...largeMessages.slice(0, Math.floor(largeMessages.length / 2)), pinnedMsg, ...largeMessages.slice(Math.floor(largeMessages.length / 2))];

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    await layer.apply(messages, BUDGET);

    // The pinned message should NOT appear in any generateSummary call
    const calledMessages = mockGenerateSummary.mock.calls[0]?.[0] as AgentMessage[] | undefined;
    if (calledMessages) {
      const pinnedInSummary = calledMessages.some((m) => {
        const content = (m as unknown as { content: string | Array<{ text: string }> }).content;
        if (typeof content === "string") return content.includes(MARKERS.canaryToken);
        if (Array.isArray(content)) return content.some((c) => typeof c.text === "string" && c.text.includes(MARKERS.canaryToken));
        return false;
      });
      expect(pinnedInSummary).toBe(false);
    }
    void normalMsg1; void normalMsg2; // suppress unused warning
  });

  it("securityPinnedCount is reported in context:compaction_routed event", async () => {
    const { bus, emits } = makeEventBus();
    const { deps } = createMockDeps();
    deps.eventBus = bus;
    deps.agentId = "agent-s4";
    deps.sessionKey = "sess-s4";
    const layer = createLlmCompactionLayer(
      {
        compactionCooldownTurns: 5,
        compactionPrefixAnchorTurns: 0,
        capabilityClass: "frontier",
        preferEvictionByCapability: false,
        securityMarkers: MARKERS,
      },
      deps,
    );
    const largeMessages = buildLargeConversation();
    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());
    await layer.apply(largeMessages, BUDGET);

    const routed = emits.filter((e) => e.event === "context:compaction_routed");
    expect(routed.length).toBe(1);
    expect(typeof routed[0]!.payload.securityPinnedCount).toBe("number");
    expect(routed[0]!.payload.securityPinnedCount).toBeGreaterThanOrEqual(0);
    expect(routed[0]!.payload.layer).toBe("pipeline");
  });

  // -------------------------------------------------------------------------
  // CR-01 regression: pinned messages MUST appear in the returned array
  // -------------------------------------------------------------------------

  it("CR-01: security-pinned middle-zone messages ARE PRESENT in the returned array after compaction", async () => {
    // This is the membership assertion the prior tests missed.
    // Verifies S4 invariant: pinned messages are never evicted from the context.
    //
    // Design: use very large messages (200K chars each) so the tail budget of
    // ~305K chars only holds 1-2 messages. This ensures the pinned messages
    // placed in the middle zone are not swept up into the tail.
    //
    // Budget: availableHistoryTokens = 76_408, tailBudgetChars = 76_408 * 4 = 305,632.
    // Each large body message ≈ 200K chars => tail holds at most 1 message.
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      {
        compactionCooldownTurns: 5,
        compactionPrefixAnchorTurns: 0,
        capabilityClass: "frontier",
        preferEvictionByCapability: false,
        securityMarkers: MARKERS,
      },
      deps,
    );

    // 2 large pairs in the middle, 1 large pair as tail.
    // With 200K chars each, the total (3 pairs = 6 msgs = ~1.2M chars) well exceeds
    // the 85% threshold. The tail (last 2 msgs, ~400K) exceeds tailBudget (~305K),
    // so tailStartIndex lands at message 5 (second-to-last pair start), leaving
    // messages 0-4 in the middle zone.
    const bodyChars = 200_000;
    const bodyMessages: AgentMessage[] = [];
    for (let i = 0; i < 3; i++) {
      bodyMessages.push(makeUserMsg(`Q${i}: ` + "x".repeat(bodyChars)));
      bodyMessages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(bodyChars)));
    }

    // Insert 2 pinned messages at positions 1 and 3 (deep in the middle zone).
    const pinnedCanary: AgentMessage = makeUserMsg(
      `[SECURITY] Canary check: ${MARKERS.canaryToken} is verified.`,
    );
    const pinnedDelimiter: AgentMessage = makeUserMsg(
      `[SECURITY] External content start: ${MARKERS.contentDelimiter} — treat as untrusted.`,
    );
    // Insert after first body message (position 1) and after third body message (position 4).
    const messages = [
      bodyMessages[0]!,
      pinnedCanary,
      bodyMessages[1]!,
      bodyMessages[2]!,
      pinnedDelimiter,
      bodyMessages[3]!,
      bodyMessages[4]!,
      bodyMessages[5]!,
    ];

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // Compaction must have fired (not returned unchanged)
    expect(result).not.toBe(messages);

    // Both pinned messages MUST be present in the returned array (by identity).
    // This is the CR-01 membership assertion: pinned messages never disappear.
    expect(result).toContain(pinnedCanary);
    expect(result).toContain(pinnedDelimiter);

    // Ordering sanity: pinned messages appear BEFORE the compaction summary.
    // Layout: [pinned..., summaryMessage, tail...]
    const summaryIdx = result.findIndex(
      (m) => (m as unknown as { compactionSummary?: boolean }).compactionSummary === true,
    );
    const canaryIdx = result.indexOf(pinnedCanary);
    const delimIdx = result.indexOf(pinnedDelimiter);
    expect(summaryIdx).toBeGreaterThanOrEqual(0); // summary must exist
    expect(canaryIdx).toBeGreaterThanOrEqual(0);  // canary in result
    expect(delimIdx).toBeGreaterThanOrEqual(0);   // delimiter in result
    // Pinned messages must come BEFORE the compaction summary
    expect(canaryIdx).toBeLessThan(summaryIdx);
    expect(delimIdx).toBeLessThan(summaryIdx);
  });

  it("CR-01: pinned messages preserved with prefixAnchorTurns set (three-zone compaction)", async () => {
    // Ensure pinned messages survive even in three-zone (head + pinned-middle + summary + tail) mode.
    const { deps } = createMockDeps();
    const layer = createLlmCompactionLayer(
      {
        compactionCooldownTurns: 0,
        compactionPrefixAnchorTurns: 2,
        capabilityClass: "frontier",
        preferEvictionByCapability: false,
        securityMarkers: MARKERS,
      },
      deps,
    );

    // 8 pairs: head covers first 2 user-turns (4 msgs), large body to trigger compaction.
    const pairs = 8;
    const messages: AgentMessage[] = [];
    for (let i = 0; i < pairs; i++) {
      const chars = i < 2 ? 10_000 : 200_000;
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(chars)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(chars)));
    }

    // Insert a pinned message into the middle zone (after the head, before the tail).
    const pinnedSafety: AgentMessage = makeUserMsg(
      `NOTICE: ${MARKERS.safetyReinforcementSnippet} — this message must be retained.`,
    );
    // Insert at position 5 (in the middle zone, after the 4-message head).
    messages.splice(5, 0, pinnedSafety);

    mockGenerateSummary.mockResolvedValueOnce(buildValidSummary());

    const result = await layer.apply(messages, BUDGET);

    // Compaction must have fired.
    expect(result).not.toBe(messages);
    // The safety-pinned message must be present in the output.
    expect(result).toContain(pinnedSafety);
  });
});

// ---------------------------------------------------------------------------
// SUMW-01 (Phase 178): pipeline span clamp — the compaction input span must
// never exceed the RESOLVED summarizer's window minus output reserve minus
// prompt overhead. Today the layer feeds the WHOLE evictableMiddle to SDK
// generateSummary (:550 → compactWithFallback), unbounded relative to the
// summarizer — an `operationModels.compaction` 8K model handed a ~20K-token
// span is a provider overflow. These fixtures pin BOTH halves of the fix:
//   1. the clamp keys on the LOCAL resolved `model` (the same variable fed to
//      generateSummary — override wins over the session primary, Pitfall 2);
//   2. the un-summarized remainder of the middle zone is PRESERVED in the
//      output between the summary and the tail (:574 assembly — Pitfall 3:
//      a dropped remainder is silent, unrecoverable history deletion).
// Span budget arithmetic (values pinned deliberately — SUMMARIZER_PROMPT_
// OVERHEAD_TOKENS = 2_048, plan-adopted research A1; review CR-01 replaced the
// session outputReserveTokens with a SUMMARIZER-sized reserve so small windows
// never go permanently negative):
//   summaryReserve = min(budget.outputReserveTokens, max(1, ⌊W/4⌋))
//   maxSpanTokens  = W − summaryReserve − 2_048
//   8K override:   8_000 − 2_000 − 2_048 = 3_952  (the binding fixture)
//   200K override: 200_000 − 4_096 − 2_048 = 193_856 (the no-op I3 pin)
//   3K override:   3_000 − 750 − 2_048 = 202     (oldest msg alone exceeds →
//                  CR-01 single-message escalation, never a permanent skip)
// ---------------------------------------------------------------------------

import type { Message } from "@earendil-works/pi-ai";
import { scriptTokenFactor } from "@comis/core";
import { estimateMessageChars, estimateContextCharsWithDualRatio } from "../safety/token-estimator.js";
import { CHARS_PER_TOKEN_RATIO } from "./constants.js";

describe("SUMW-01: pipeline span clamp", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  /** The FLOOR-02-2 budget shape: a served/capability-capped small budget whose
   *  85% trigger threshold is floor(32_000 × 85 / 100) = 27_200 tokens. */
  const smallBudget: TokenBudget = {
    windowTokens: 32_000,
    systemTokens: 2_000,
    outputReserveTokens: 4_096,
    safetyMarginTokens: 2_048,
    contextRotBufferTokens: 8_000,
    availableHistoryTokens: 15_856,
  };

  /** maxSpanTokens for the 8K summarizer (see header): summaryReserve =
   *  min(4_096, ⌊8_000/4⌋) = 2_000 → 8_000 − 2_000 − 2_048. */
  const MAX_SPAN_TOKENS_8K = 8_000 - 2_000 - 2_048; // = 3_952

  /**
   * 30 text messages × ~4K chars ≈ 120K chars ≈ 34.3K tokens (ratio 3.5) —
   * ABOVE the 27_200 trigger threshold, while messageCount 30 stays below the
   * 60-message block-count trigger (so the firing trigger is token_threshold).
   * Zoning under smallBudget: tail budget 15_856 × 3.5 ≈ 55.5K chars fits the
   * last ~13 messages → middle ≈ 17 messages ≈ 68K chars ≈ 19.4K tokens —
   * the genuinely-overflowing ~20K-token span an 8K summarizer cannot take.
   */
  function buildSpanClampConversation(): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(4_000)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(4_000)));
    }
    return messages;
  }

  /** Accumulate per-message ceil(chars / 3.5) — mirrors the clamp's prefix walk. */
  function spanTokensOf(msgs: AgentMessage[]): number {
    let total = 0;
    for (const m of msgs) {
      total += Math.ceil(estimateMessageChars(m as unknown as Message) / CHARS_PER_TOKEN_RATIO);
    }
    return total;
  }

  /** Mirror the layer's tail walk (headEndIndex 0 — no prefixAnchorTurns in
   *  these fixtures): tailBudgetChars = availableHistoryTokens × ratio. */
  function mirrorTailStartIndex(messages: AgentMessage[], budget: TokenBudget): number {
    const tailBudgetChars = budget.availableHistoryTokens * CHARS_PER_TOKEN_RATIO;
    let tailStartIndex = messages.length;
    let tailChars = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgChars = estimateMessageChars(messages[i] as unknown as Message);
      if (tailChars + msgChars > tailBudgetChars) break;
      tailChars += msgChars;
      tailStartIndex = i;
    }
    return tailStartIndex;
  }

  function make8kOverrideDeps(): ReturnType<typeof createMockDeps> {
    return createMockDeps({
      overrideModel: {
        model: { id: "small-summarizer", provider: "ollama", contextWindow: 8_000 },
        getApiKey: vi.fn().mockResolvedValue("k"),
      },
    });
  }

  it("SUMW-01-P1: clamps the summarized span to the OVERRIDE summarizer's 8K window, not the primary's 128K", async () => {
    const { deps } = make8kOverrideDeps(); // primary getModel() stays at 128_000
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSpanClampConversation();
    const middleCount = mirrorTailStartIndex(messages, smallBudget); // middle = [0, tailStart)
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    await layer.apply(messages, smallBudget);

    expect(mockGenerateSummary).toHaveBeenCalled();
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    // The span fed to the summarizer fits the RESOLVED (override) window:
    // ≤ 8_000 − 2_000 − 2_048 = 3_952 tokens. A clamp keyed to the primary's
    // 128_000 would allow 121_856 tokens — i.e. the whole ~19.4K-token middle —
    // so this bound also proves override-keying (Pitfall 2).
    expect(spanArg.length).toBeGreaterThanOrEqual(1);
    const spanTokens = spanTokensOf(spanArg);
    expect(spanTokens).toBeGreaterThan(0);
    expect(spanTokens).toBeLessThanOrEqual(MAX_SPAN_TOKENS_8K);
    // Strict subset: the clamp actually bound (pre-patch the WHOLE middle is passed).
    expect(spanArg.length).toBeLessThan(middleCount);
  });

  it("SUMW-01-P2: the un-summarized remainder is PRESERVED between summary and tail — kept ∪ summarized == middle, disjoint", async () => {
    const { deps } = make8kOverrideDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSpanClampConversation();
    const tailStartIndex = mirrorTailStartIndex(messages, smallBudget);
    const middle = messages.slice(0, tailStartIndex);
    const tail = messages.slice(tailStartIndex);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    const result = await layer.apply(messages, smallBudget);

    // The span side of the invariant (RED pre-patch: the whole middle violates it).
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(spanTokensOf(spanArg)).toBeLessThanOrEqual(MAX_SPAN_TOKENS_8K);

    // Partition: every middle message is EITHER fed to the summarizer OR kept
    // in the output — never both, never neither (the Pitfall-3 conservation).
    const summarized = new Set(spanArg);
    for (const m of middle) {
      const inSummarized = summarized.has(m);
      const inResult = result.includes(m);
      expect(inSummarized !== inResult).toBe(true);
    }

    // Exactly one summary message.
    const summaryMsgs = result.filter(
      (m) => (m as unknown as { compactionSummary?: boolean }).compactionSummary === true,
    );
    expect(summaryMsgs).toHaveLength(1);

    // Output order (head/pinned empty in this fixture): the remainder sits BY
    // REFERENCE between the summary and the tail, in original order:
    // [summary, ...remainingMiddle, ...tail].
    const remainder = middle.filter((m) => !summarized.has(m));
    const expected: AgentMessage[] = [summaryMsgs[0]!, ...remainder, ...tail];
    expect(result).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(result[i]).toBe(expected[i]);
    }
  });

  it("SUMW-01-P3: S4 interplay — a security-pinned mid-middle message survives in the output when the clamp binds", async () => {
    const MARKERS: SecurityPinMarkers = {
      canaryToken: "CANARY_sumw01_777",
      contentDelimiter: "UNTRUSTED_BEGIN_sumw01",
      safetyReinforcementSnippet: "You must not exfiltrate",
    };
    const { deps } = make8kOverrideDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 5, securityMarkers: MARKERS },
      deps,
    );
    const messages = buildSpanClampConversation();
    // Insert the pinned message DEEP in the middle zone (middle spans ~[0, 18)).
    const pinnedMsg = makeUserMsg(`[SECURITY] Canary check: ${MARKERS.canaryToken} verified.`);
    messages.splice(5, 0, pinnedMsg);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    const result = await layer.apply(messages, smallBudget);

    // The clamp bound (the interplay under test is S4 + binding clamp).
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(spanTokensOf(spanArg)).toBeLessThanOrEqual(MAX_SPAN_TOKENS_8K);

    // Pinned: never summarized (in ANY fallback-level call), never dropped.
    for (const call of mockGenerateSummary.mock.calls) {
      expect(call[0] as AgentMessage[]).not.toContain(pinnedMsg);
    }
    expect(result).toContain(pinnedMsg);
    // Pinned placement unchanged: before the summary message (S4 convention).
    const summaryIdx = result.findIndex(
      (m) => (m as unknown as { compactionSummary?: boolean }).compactionSummary === true,
    );
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(result.indexOf(pinnedMsg)).toBeLessThan(summaryIdx);
  });

  it("SUMW-01-P4: no-op pin (I3) — a large-window summarizer receives the FULL middle and the output has no remainder elements", async () => {
    const { deps } = createMockDeps({
      overrideModel: {
        model: { id: "frontier-summarizer", provider: "anthropic", contextWindow: 200_000 },
        getApiKey: vi.fn().mockResolvedValue("k"),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSpanClampConversation();
    const tailStartIndex = mirrorTailStartIndex(messages, smallBudget);
    const middle = messages.slice(0, tailStartIndex);
    const tail = messages.slice(tailStartIndex);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    const result = await layer.apply(messages, smallBudget);

    // The summarizer received the FULL evictableMiddle (clamp does not bind:
    // 200_000 − 4_096 − 2_048 = 193_856 ≥ the ~19.4K-token middle).
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(spanArg).toHaveLength(middle.length);
    for (let i = 0; i < middle.length; i++) {
      expect(spanArg[i]).toBe(middle[i]);
    }

    // Output shape EXACTLY [...head(0), ...pinned(0), summary, ...tail] —
    // no remainder elements inserted (byte-identical to today's assembly).
    expect(result).toHaveLength(1 + tail.length);
    expect(
      (result[0] as unknown as { compactionSummary?: boolean }).compactionSummary,
    ).toBe(true);
    for (let i = 0; i < tail.length; i++) {
      expect(result[i + 1]).toBe(tail[i]);
    }
  });

  // INT-W1 (milestone integration WARNING 1): the served-window truth must
  // reach the pipeline Step-4 clamp too. Arithmetic for the served-bound
  // primary (configured 128_000 from getModel(), served 8_192):
  //   summarizerWindow = min(128_000, 8_192) = 8_192
  //   summaryReserve   = min(4_096, ⌊8_192/4⌋ = 2_048) = 2_048
  //   maxSpanTokens    = 8_192 − 2_048 − 2_048 = 4_096
  const MAX_SPAN_TOKENS_SERVED_8K = 8_192 - 2_048 - 2_048; // = 4_096

  it("INT-W1-P1 (flagship): a served-bound PRIMARY (no override, served 8_192) clamps the pipeline span to the SERVED window, not the configured 128K", async () => {
    // Pre-INT-W1: the Step-4 model is getModel() (configured 128_000) →
    // maxSpan 121_856 → the WHOLE ~19.4K-token middle in one call to a
    // provider serving 8K — silent input truncation of the summary source
    // (RED: the strict-subset assertion below fails).
    const { deps } = createMockDeps();
    deps.primaryServedWindow = 8_192; // the executor-reconcile-gated windowProvenance.served
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSpanClampConversation();
    const middleCount = mirrorTailStartIndex(messages, smallBudget);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    await layer.apply(messages, smallBudget);

    expect(mockGenerateSummary).toHaveBeenCalled();
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(spanArg.length).toBeGreaterThanOrEqual(1);
    const spanTokens = spanTokensOf(spanArg);
    expect(spanTokens).toBeGreaterThan(0);
    expect(spanTokens).toBeLessThanOrEqual(MAX_SPAN_TOKENS_SERVED_8K);
    // Strict subset: the served clamp actually bound (pre-INT-W1 the whole
    // middle is passed).
    expect(spanArg.length).toBeLessThan(middleCount);
  });

  it("INT-W1-P2 (provider scoping, WR-02): a cloud override summarizer is NOT clamped by the primary provider's served window", async () => {
    // The wiring site attaches NO servedWindow to a cross-provider override —
    // the override's own 200K window governs and the full middle is summarized
    // in one call (byte-identical to SUMW-01-P4). Pins that primaryServedWindow
    // can never leak onto an override candidate.
    const { deps } = createMockDeps({
      overrideModel: {
        model: { id: "cloud-summarizer", provider: "anthropic", contextWindow: 200_000 },
        getApiKey: vi.fn().mockResolvedValue("k"),
      },
    });
    deps.primaryServedWindow = 8_192;
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSpanClampConversation();
    const middleCount = mirrorTailStartIndex(messages, smallBudget);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    await layer.apply(messages, smallBudget);

    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(spanArg).toHaveLength(middleCount); // full middle — no served clamp
  });

  it("INT-W1-P3: when the override key fails and Step 4 falls back to the PRIMARY, the primary's served window binds the clamp (clamp/call agreement)", async () => {
    // The Step-4 try/catch decides WHICH model summarizes; the served value
    // must ride the SAME branch. Override (200K, key throws) → fallback model
    // = getModel() (128K) + primaryServedWindow 8_192 → span ≤ 4_096 tokens.
    // Pre-INT-W1: fallback window 128_000 → whole middle (RED).
    const { deps } = createMockDeps({
      overrideModel: {
        model: { id: "cloud-summarizer", provider: "anthropic", contextWindow: 200_000 },
        getApiKey: vi.fn().mockRejectedValue(new Error("key boom")),
      },
    });
    deps.primaryServedWindow = 8_192;
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSpanClampConversation();
    const middleCount = mirrorTailStartIndex(messages, smallBudget);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    await layer.apply(messages, smallBudget);

    expect(mockGenerateSummary).toHaveBeenCalled();
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(spanTokensOf(spanArg)).toBeLessThanOrEqual(MAX_SPAN_TOKENS_SERVED_8K);
    expect(spanArg.length).toBeLessThan(middleCount);
  });

  it("SUMW-01-P5 (review CR-01): degenerate summarizer — the single oldest message escalates through the ladder, remainder conserved, never a permanent skip", async () => {
    const { deps } = createMockDeps({
      overrideModel: {
        // maxSpanTokens = 3_000 − min(4_096, 750) − 2_048 = 202 — even the
        // oldest ~1_145-token message alone exceeds it (the cut===0 branch).
        model: { id: "degenerate-summarizer", provider: "ollama", contextWindow: 3_000 },
        getApiKey: vi.fn().mockResolvedValue("k"),
      },
    });
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSpanClampConversation();
    const tailStartIndex = mirrorTailStartIndex(messages, smallBudget);
    const middle = messages.slice(0, tailStartIndex);
    const tail = messages.slice(tailStartIndex);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    const result = await layer.apply(messages, smallBudget);

    // The pre-review code returned `messages` unchanged here (cut===0 skip) —
    // PERMANENTLY, since the oldest message never leaves the middle's head.
    // CR-01: that one message is escalated through compactWithFallback's
    // pre-existing Level-1/2/3 ladder instead — bounded (one message) and
    // ALWAYS shrinking (Level 3 is the guaranteed count-only note).
    expect(result).not.toBe(messages);
    expect(mockGenerateSummary).toHaveBeenCalled();
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(spanArg).toHaveLength(1);
    expect(spanArg[0]).toBe(middle[0]);

    // Conservation: [summary, ...middle.slice(1), ...tail] by reference.
    const summaryMsgs = result.filter(
      (m) => (m as unknown as { compactionSummary?: boolean }).compactionSummary === true,
    );
    expect(summaryMsgs).toHaveLength(1);
    const expected: AgentMessage[] = [summaryMsgs[0]!, ...middle.slice(1), ...tail];
    expect(result).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(result[i]).toBe(expected[i]);
    }
  });

  it("WR-01: durable-side conservation — remainder entries survive in fileEntries when an S4-pinned message interleaves LATE in the middle", async () => {
    // persistCompaction removed entries POSITIONALLY: the first
    // (pinned + span) middle message entries in file order. With a pinned
    // message sitting AFTER the span cut, the count-based removal reached past
    // the span into un-summarized REMAINDER entries — durable history deletion
    // the summary does not cover (exactly the Pitfall-3 loss the in-memory
    // conservation test P2 guards on the live side). Removal must be by
    // IDENTITY: exactly the summarized span's entries, nothing else.
    const MARKERS: SecurityPinMarkers = {
      canaryToken: "CANARY_wr01_late",
      contentDelimiter: "UNTRUSTED_BEGIN_wr01",
      safetyReinforcementSnippet: "You must not exfiltrate",
    };
    const { deps, mockSm } = make8kOverrideDeps();
    const layer = createLlmCompactionLayer(
      { compactionCooldownTurns: 5, securityMarkers: MARKERS },
      deps,
    );
    const messages = buildSpanClampConversation();
    // LATE in the middle (middle spans ~[0, 18); the 8K clamp cuts at ~3).
    const pinnedMsg = makeUserMsg(`[SECURITY] Canary check: ${MARKERS.canaryToken} verified.`);
    messages.splice(10, 0, pinnedMsg);
    // The durable session file mirrors the live array 1:1 (the positional model).
    mockSm.fileEntries = messages.map((m) => ({ type: "message", message: m }));
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    const result = await layer.apply(messages, smallBudget);
    expect(result).not.toBe(messages);

    // Premise guard: the clamp bound, and the pinned message was never summarized.
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    const summarized = new Set(spanArg);
    expect(spanArg.length).toBeGreaterThanOrEqual(1);
    expect(summarized.has(pinnedMsg)).toBe(false);

    const fileMsgs = (mockSm.fileEntries as Array<{ type: string; message: unknown }>)
      .filter((e) => e.type === "message")
      .map((e) => e.message);
    // EVERY un-summarized input message — the pinned one AND the whole
    // remainder — survives in the durable file; EVERY summarized one is gone.
    for (const m of messages) {
      if (summarized.has(m)) {
        expect(fileMsgs).not.toContain(m);
      } else {
        expect(fileMsgs).toContain(m);
      }
    }
    // Exactly one compaction summary entry was inserted.
    const summaryEntries = fileMsgs.filter(
      (m) => (m as { compactionSummary?: boolean }).compactionSummary === true,
    );
    expect(summaryEntries).toHaveLength(1);
  });

  it("WR-04: a toolResult-heavy span is measured with the layer's own dual-ratio estimate — every summarized span fits the budget in trigger units", async () => {
    // The clamp walk used a FLAT chars/3.5 per message while the layer's own
    // 85% trigger weights toolResult chars ×2 (estimateContextCharsWithDualRatio)
    // — so a toolResult-heavy span passed the walk at roughly HALF its
    // trigger-unit size and overflowed the summarizer (the SUMW-01 target
    // failure class recurring on structured-heavy middles). 18 triples
    // [user 200ch, assistant 200ch, toolResult 5_000ch]: dual total ≈ 53K
    // tokens > the 27_200 trigger; the raw-chars tail walk keeps ~10 triples,
    // leaving a middle with ≥ 2 toolResults so the walk's units are
    // load-bearing (each toolResult: flat ≈ 1_429 vs dual ≈ 2_858 tokens).
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 18; i++) {
      messages.push(makeUserMsg(`Q${i}: ` + "x".repeat(200)));
      messages.push(makeAssistantMsg(`A${i}: ` + "y".repeat(200)));
      messages.push(makeToolResult(`tc_${i}`, "bash", "z".repeat(5_000)));
    }
    const { deps } = make8kOverrideDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    await layer.apply(messages, smallBudget);

    expect(mockGenerateSummary).toHaveBeenCalled();
    // EVERY summarize call's span fits maxSpanTokens measured in the SAME
    // dual-ratio units the trigger uses. RED pre-fix: the flat walk admits
    // two toolResults whose dual-unit size (~6K) exceeds the 3_952 budget.
    for (const call of mockGenerateSummary.mock.calls) {
      const span = call[0] as AgentMessage[];
      const dualTokens = Math.ceil(
        estimateContextCharsWithDualRatio(span as unknown as Message[]) / CHARS_PER_TOKEN_RATIO,
      );
      expect(dualTokens).toBeLessThanOrEqual(MAX_SPAN_TOKENS_8K);
    }
  });

  it("CR-01: the playbook 8K summarizer under a frontier-session output reserve (8_192) compacts and CONVERGES below the 85% trigger", async () => {
    // THE review-CR-01 regression case: outputReserveTokens = 8_192 (the
    // OUTPUT_RESERVE_TOKENS default for any session whose model maxTokens ≥ 8_192)
    // makes the pre-review span budget 8_000 − 8_192 − 2_048 = −2_240 — NEGATIVE,
    // so every evaluation took the cut===0 skip: zero LLM calls, context grows
    // unboundedly, and the code/docs convergence claim was false. Post-fix the
    // reserve is summarizer-sized (min(8_192, 2_000) = 2_000 → budget 3_952) and
    // the backlog drains across re-fires until the 85% trigger goes quiet.
    const frontierReserveBudget: TokenBudget = { ...smallBudget, outputReserveTokens: 8_192 };
    const { deps } = make8kOverrideDeps();
    // cooldown 0: every apply() evaluates — the convergence loop below mirrors
    // successive turns without waiting out the cooldown.
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 0 }, deps);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    let current = buildSpanClampConversation();
    for (let i = 0; i < 20; i++) {
      const next = await layer.apply(current, frontierReserveBudget);
      if (next === current) break; // below threshold — drained (or, pre-fix, the permanent skip)
      current = next;
    }

    // RED pre-fix: the FIRST apply returns the same reference with ZERO LLM
    // calls and the context still above the trigger — nothing ever drains.
    expect(mockGenerateSummary).toHaveBeenCalled();
    // Every generateSummary call received the SUMMARIZER-sized reserve (the same
    // value the clamp budgeted), never the session's 8_192.
    for (const call of mockGenerateSummary.mock.calls) {
      expect(call[2]).toBe(2_000);
    }
    // Convergence: the final context sits at/below the 85% trigger threshold,
    // measured exactly the way the layer measures it (dual-ratio chars / 3.5).
    const finalTokens = Math.ceil(
      estimateContextCharsWithDualRatio(current as unknown as Message[]) / CHARS_PER_TOKEN_RATIO,
    );
    expect(finalTokens).toBeLessThanOrEqual(Math.floor(32_000 * 85 / 100));
  });

  // -------------------------------------------------------------------------
  // TOK-01 (Phase 179): the per-message clamp walk must be script-aware. The
  // flat dual-chars/3.5 measure under-counts a Hebrew message by ~1.8×, so a
  // Hebrew-heavy span passes the walk at ~0.55× its honest size and overflows
  // the summarizer — the SAME failure class WR-04 above closed for toolResults,
  // recurring on dense scripts. The dual-ratio CHAR walk stays authoritative;
  // only the divisor gains the per-message script factor.
  // -------------------------------------------------------------------------

  /** Mirror of the production clamp's per-message factor text: string content,
   *  or concatenated text/thinking fields + JSON.stringify of toolCall args. */
  function clampTextOf(m: AgentMessage): string {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((b: unknown) => {
        if (typeof b === "string") return b;
        if (b === null || typeof b !== "object") return "";
        const block = b as { type?: string; text?: string; thinking?: string; arguments?: unknown };
        if (typeof block.text === "string") return block.text;
        if (typeof block.thinking === "string") return block.thinking;
        if (block.type === "toolCall") {
          try {
            return JSON.stringify(block.arguments ?? {});
          } catch {
            return "";
          }
        }
        return "";
      })
      .join("");
  }

  it("TOK-01: a Hebrew-heavy middle is clamped script-aware — every summarized span fits the budget in FACTORED units", async () => {
    // Pre-patch: the prefix walk admits ~3 × 4_200-char Hebrew messages (flat
    // ≈ 1_200 tokens each) under the 3_952 budget, but their factored size is
    // ≈ 2_182 tokens each → the span overflows the summarizer ~1.8× → RED.
    const he = "שלום עולם זה מבחן ארוך מאוד לבדיקת חלוקה ";
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(makeUserMsg(he.repeat(100)));      // ~4_200 Hebrew chars
      messages.push(makeAssistantMsg(he.repeat(100)));
    }
    const { deps } = make8kOverrideDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    await layer.apply(messages, smallBudget);

    expect(mockGenerateSummary).toHaveBeenCalled();
    // EVERY summarize call's span fits maxSpanTokens measured script-aware —
    // per-message ceil(dualChars / (3.5 × scriptTokenFactor(text))), summed,
    // exactly mirroring the factored walk.
    for (const call of mockGenerateSummary.mock.calls) {
      const span = call[0] as AgentMessage[];
      const factoredTokens = span.reduce((sum, m) => {
        const text = clampTextOf(m);
        return (
          sum +
          Math.ceil(
            estimateContextCharsWithDualRatio([m] as unknown as Message[]) /
              (CHARS_PER_TOKEN_RATIO * scriptTokenFactor(text)),
          )
        );
      }, 0);
      expect(factoredTokens).toBeLessThanOrEqual(MAX_SPAN_TOKENS_8K);
    }
  });

  it("TOK-01 I1: a pure-ASCII middle clamps at the byte-identical flat cut point (factor 1.0 — Latin unchanged)", async () => {
    // The Latin guarantee: scriptTokenFactor(ascii) === 1 → the factored walk IS
    // today's flat walk. Mirror the production prefix walk with TODAY'S flat
    // math; the admitted span must be exactly that cut.
    const { deps } = make8kOverrideDeps();
    const layer = createLlmCompactionLayer({ compactionCooldownTurns: 5 }, deps);
    const messages = buildSpanClampConversation();
    const tailStart = mirrorTailStartIndex(messages, smallBudget);
    const middle = messages.slice(0, tailStart);
    mockGenerateSummary.mockResolvedValue(buildValidSummary());

    await layer.apply(messages, smallBudget);

    let walkedTokens = 0;
    let expectedCut = 0;
    for (const m of middle) {
      const t = Math.ceil(
        estimateContextCharsWithDualRatio([m] as unknown as Message[]) / CHARS_PER_TOKEN_RATIO,
      );
      if (walkedTokens + t > MAX_SPAN_TOKENS_8K) break;
      walkedTokens += t;
      expectedCut++;
    }
    const spanArg = mockGenerateSummary.mock.calls[0][0] as AgentMessage[];
    expect(spanArg.length).toBe(expectedCut);
  });
});
