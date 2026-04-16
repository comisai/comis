import { describe, it, expect } from "vitest";
import { createObjectiveReinforcementLayer } from "./objective-reinforcement.js";
import type { TokenBudget } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal token budget for tests (layer doesn't use it). */
const mockBudget: TokenBudget = {
  windowTokens: 128_000,
  systemTokens: 10_000,
  outputReserveTokens: 4_096,
  safetyMarginTokens: 6_400,
  contextRotBufferTokens: 2_560,
  availableHistoryTokens: 104_944,
};

/** Create a user message with text content array. */
function userMsg(text: string, extras?: Record<string, unknown>) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
    ...extras,
  };
}

/** Create an assistant message with text content array. */
function assistantMsg(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic" as const,
    provider: "anthropic",
    model: "test-model",
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

/** Create a compaction summary message using the content text pattern. */
function compactionSummaryMsg(summary: string) {
  return userMsg(`[Compaction Summary]\n${summary}`);
}

/** Create a compaction summary message using the flag-based approach. */
function compactionSummaryFlagMsg(summary: string) {
  return {
    ...userMsg(summary),
    compactionSummary: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createObjectiveReinforcementLayer", () => {
  it("returns messages unchanged when objective is empty", async () => {
    const layer = createObjectiveReinforcementLayer("");
    const messages = [
      userMsg("Hello"),
      assistantMsg("Hi there"),
      compactionSummaryMsg("Previous conversation was about testing."),
    ];

    const result = await layer.apply(messages, mockBudget);
    expect(result).toEqual(messages);
  });

  it("returns messages unchanged when no compaction detected", async () => {
    const layer = createObjectiveReinforcementLayer("Find all bugs in the codebase");
    const messages = [
      userMsg("Hello"),
      assistantMsg("Hi there"),
      userMsg("Can you review my code?"),
    ];

    const result = await layer.apply(messages, mockBudget);
    expect(result).toEqual(messages);
  });

  it("injects objective after compaction summary", async () => {
    const layer = createObjectiveReinforcementLayer("Find all bugs in the codebase");
    const messages = [
      compactionSummaryMsg("Previous conversation discussed testing approaches."),
      assistantMsg("I see. Let me continue."),
    ];

    const result = await layer.apply(messages, mockBudget);

    // Should have one more message than input
    expect(result.length).toBe(messages.length + 1);

    // Reinforcement message should be at index 1 (after compaction summary at 0)
    const reinforcement = result[1]!;
    expect(reinforcement.role).toBe("user");
    expect("content" in reinforcement).toBe(true);
    if ("content" in reinforcement && Array.isArray(reinforcement.content)) {
      const textBlock = reinforcement.content[0];
      if (typeof textBlock === "object" && textBlock !== null && "text" in textBlock) {
        expect(textBlock.text).toContain("[Objective Reinforcement]");
        expect(textBlock.text).toContain("Find all bugs in the codebase");
        expect(textBlock.text).toContain("Stay focused on this objective");
      }
    }
  });

  it("does not duplicate injection", async () => {
    const layer = createObjectiveReinforcementLayer("Find all bugs");
    const messages = [
      compactionSummaryMsg("Previous conversation discussed testing."),
      userMsg("[Objective Reinforcement]\nYour primary objective: Find all bugs"),
      assistantMsg("Continuing with bug search."),
    ];

    const result = await layer.apply(messages, mockBudget);

    // Should NOT add another reinforcement
    expect(result).toEqual(messages);
    expect(result.length).toBe(messages.length);
  });

  it("does not mutate input array", async () => {
    const layer = createObjectiveReinforcementLayer("Find bugs");
    const messages = [
      compactionSummaryMsg("Previous conversation."),
      assistantMsg("Continuing."),
    ];
    const originalLength = messages.length;
    const originalMessages = [...messages];

    const result = await layer.apply(messages, mockBudget);

    // Original array should be unchanged
    expect(messages.length).toBe(originalLength);
    expect(messages).toEqual(originalMessages);

    // Result should be a new array
    expect(result).not.toBe(messages);
    expect(result.length).toBe(originalLength + 1);
  });

  it("detects compaction via content string pattern", async () => {
    const layer = createObjectiveReinforcementLayer("Analyze performance");
    // Use the text-based "[Compaction Summary]" marker
    const messages = [
      userMsg("[Compaction Summary]\nThe conversation covered performance analysis of the Node.js application."),
      assistantMsg("Understood. I will continue the analysis."),
    ];

    const result = await layer.apply(messages, mockBudget);

    expect(result.length).toBe(messages.length + 1);
    const reinforcement = result[1]!;
    expect(reinforcement.role).toBe("user");
    if ("content" in reinforcement && Array.isArray(reinforcement.content)) {
      const textBlock = reinforcement.content[0];
      if (typeof textBlock === "object" && textBlock !== null && "text" in textBlock) {
        expect(textBlock.text).toContain("Analyze performance");
      }
    }
  });

  it("detects compaction via compactionSummary flag", async () => {
    const layer = createObjectiveReinforcementLayer("Deploy to production");
    const messages = [
      compactionSummaryFlagMsg("Deployment discussion summary."),
      assistantMsg("Got it."),
    ];

    const result = await layer.apply(messages, mockBudget);

    expect(result.length).toBe(messages.length + 1);
    const reinforcement = result[1]!;
    if ("content" in reinforcement && Array.isArray(reinforcement.content)) {
      const textBlock = reinforcement.content[0];
      if (typeof textBlock === "object" && textBlock !== null && "text" in textBlock) {
        expect(textBlock.text).toContain("Deploy to production");
      }
    }
  });

  it("layer name is objective-reinforcement", () => {
    const layer = createObjectiveReinforcementLayer("test");
    expect(layer.name).toBe("objective-reinforcement");
  });
});
