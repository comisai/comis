// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the reasoning tag stripper context engine layer and
 * post-load role validation diagnostic.
 *
 * Verifies that inline reasoning tags are stripped from type:"text" blocks
 * in assistant messages, while type:"thinking" blocks and redacted blocks
 * are never touched. Also tests validateRoleAttribution for detecting
 * role alternation anomalies.
 */

import { describe, it, expect, vi } from "vitest";
import { createReasoningTagStripper, validateRoleAttribution } from "./reasoning-tag-stripper.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TokenBudget } from "./types.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeTextBlock(text: string) {
  return { type: "text" as const, text };
}

function makeThinkingBlock(text: string) {
  return { type: "thinking" as const, thinking: text };
}

function makeRedactedThinkingBlock() {
  return {
    type: "thinking" as const,
    thinking: "",
    redacted: true,
    thinkingSignature: "sig-abc",
  };
}

function makeAssistantMsg(content: unknown[]): AgentMessage {
  return { role: "assistant", content } as AgentMessage;
}

function makeUserMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

/** Stub budget with cache fence at -1 (no protection). */
const stubBudget: TokenBudget = {
  windowTokens: 200_000,
  systemTokens: 5_000,
  outputReserveTokens: 8_192,
  safetyMarginTokens: 10_000,
  contextRotBufferTokens: 50_000,
  availableHistoryTokens: 126_808,
  cacheFenceIndex: -1,
};
// ---------------------------------------------------------------------------
// createReasoningTagStripper tests
// ---------------------------------------------------------------------------

describe("createReasoningTagStripper", () => {
  it("strips <think> tags from text blocks, reports tagsStripped count", async () => {
    const onCleaned = vi.fn();
    const layer = createReasoningTagStripper(onCleaned);
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("Hello <think>internal thought</think> world")]),
    ];

    const result = await layer.apply(messages, stubBudget);

    const msg = result[0] as { content: Array<{ text: string }> };
    // stripReasoningTagsFromText removes tag+content, leaving surrounding spaces
    expect(msg.content[0].text).toBe("Hello  world");
    expect(onCleaned).toHaveBeenCalledWith({ tagsStripped: 1 });
  });

  it("strips <thinking>...</thinking> wrapping content", async () => {
    const onCleaned = vi.fn();
    const layer = createReasoningTagStripper(onCleaned);
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("<thinking>Let me think about this...</thinking>The answer is 42.")]),
    ];

    const result = await layer.apply(messages, stubBudget);

    const msg = result[0] as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe("The answer is 42.");
    expect(onCleaned).toHaveBeenCalledWith({ tagsStripped: 1 });
  });

  it("strips <thought> tags", async () => {
    const onCleaned = vi.fn();
    const layer = createReasoningTagStripper(onCleaned);
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("Before <thought>deep reasoning here</thought> after")]),
    ];

    const result = await layer.apply(messages, stubBudget);

    const msg = result[0] as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe("Before  after");
    expect(onCleaned).toHaveBeenCalledWith({ tagsStripped: 1 });
  });

  it("strips <antThinking> tags", async () => {
    const onCleaned = vi.fn();
    const layer = createReasoningTagStripper(onCleaned);
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("Start <antThinking>reflection</antThinking> end")]),
    ];

    const result = await layer.apply(messages, stubBudget);

    const msg = result[0] as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe("Start  end");
    expect(onCleaned).toHaveBeenCalledWith({ tagsStripped: 1 });
  });

  it("does NOT touch type:'thinking' content blocks", async () => {
    const onCleaned = vi.fn();
    const layer = createReasoningTagStripper(onCleaned);
    const thinkingBlock = makeThinkingBlock("internal reasoning");
    const messages: AgentMessage[] = [
      makeAssistantMsg([thinkingBlock, makeTextBlock("visible text")]),
    ];

    const result = await layer.apply(messages, stubBudget);

    // No changes should be made -- text block has no reasoning tags
    expect(result).toBe(messages); // reference equality
    const msg = result[0] as { content: unknown[] };
    expect(msg.content[0]).toBe(thinkingBlock); // same reference
    expect(onCleaned).not.toHaveBeenCalled();
  });

  it("preserves redacted thinking blocks", async () => {
    const layer = createReasoningTagStripper();
    const redacted = makeRedactedThinkingBlock();
    const messages: AgentMessage[] = [
      makeAssistantMsg([redacted, makeTextBlock("clean text")]),
    ];

    const result = await layer.apply(messages, stubBudget);

    // No changes should be made -- text block has no reasoning tags
    expect(result).toBe(messages); // reference equality
    const msg = result[0] as { content: unknown[] };
    expect(msg.content[0]).toBe(redacted);
  });

  it("does not modify messages at or before cacheFenceIndex", async () => {
    const onCleaned = vi.fn();
    const layer = createReasoningTagStripper(onCleaned);
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("<think>thought 0</think> text 0")]),
      makeAssistantMsg([makeTextBlock("<think>thought 1</think> text 1")]),
      makeAssistantMsg([makeTextBlock("<think>thought 2</think> text 2")]),
    ];

    const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 1 };
    const result = await layer.apply(messages, fencedBudget);

    // Messages at indices 0 and 1 should be untouched (fenced)
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);

    // Message at index 2 should have tags stripped
    const msg2 = result[2] as { content: Array<{ text: string }> };
    expect(msg2.content[0].text).toBe("text 2");
    expect(onCleaned).toHaveBeenCalledWith({ tagsStripped: 1 });
  });

  it("does not modify non-assistant messages (role: 'user')", async () => {
    const layer = createReasoningTagStripper();
    const userMsg = makeUserMsg("<think>should not be stripped</think> hello");
    const messages: AgentMessage[] = [userMsg];

    const result = await layer.apply(messages, stubBudget);

    expect(result).toBe(messages); // reference equality -- no changes
    const msg = result[0] as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe("<think>should not be stripped</think> hello");
  });

  it("returns original array reference when no changes are made", async () => {
    const layer = createReasoningTagStripper();
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("clean text without any tags")]),
      makeUserMsg("user message"),
    ];

    const result = await layer.apply(messages, stubBudget);

    expect(result).toBe(messages); // identity check -- same reference
  });

  it("preserves tags inside code blocks (inherited from stripReasoningTagsFromText)", async () => {
    const layer = createReasoningTagStripper();
    const codeContent = "```\n<think>preserved in code</think>\n```";
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock(codeContent)]),
    ];

    const result = await layer.apply(messages, stubBudget);

    // Code block content should not be modified
    expect(result).toBe(messages); // reference equality
    const msg = result[0] as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe(codeContent);
  });

  it("layer name is 'reasoning-tag-stripper'", () => {
    const layer = createReasoningTagStripper();
    expect(layer.name).toBe("reasoning-tag-stripper");
  });

  it("handles empty messages array", async () => {
    const layer = createReasoningTagStripper();
    const result = await layer.apply([], stubBudget);
    expect(result).toEqual([]);
  });

  it("strips from multiple text blocks in a single message", async () => {
    const onCleaned = vi.fn();
    const layer = createReasoningTagStripper(onCleaned);
    const messages: AgentMessage[] = [
      makeAssistantMsg([
        makeTextBlock("<think>one</think> first"),
        makeTextBlock("<thinking>two</thinking> second"),
      ]),
    ];

    const result = await layer.apply(messages, stubBudget);

    const msg = result[0] as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe("first");
    expect(msg.content[1].text).toBe("second");
    expect(onCleaned).toHaveBeenCalledWith({ tagsStripped: 2 });
  });
});

// ---------------------------------------------------------------------------
// validateRoleAttribution tests
// ---------------------------------------------------------------------------

describe("validateRoleAttribution", () => {
  it("logs WARN for consecutive same-role messages (user-user)", () => {
    const logger = createMockLogger();
    const messages: AgentMessage[] = [
      makeUserMsg("hello"),
      makeUserMsg("world"),
    ];

    validateRoleAttribution(messages, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        anomalyIndex: 1,
        expectedRole: "assistant",
        actualRole: "user",
        hint: "Session role attribution anomaly detected; repairOrphanedMessages may not have run",
        errorKind: "state",
      }),
      "Post-load role validation anomaly",
    );
  });

  it("logs WARN for consecutive assistant-assistant messages", () => {
    const logger = createMockLogger();
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("first")]),
      makeAssistantMsg([makeTextBlock("second")]),
    ];

    validateRoleAttribution(messages, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        anomalyIndex: 1,
        expectedRole: "user",
        actualRole: "assistant",
      }),
      "Post-load role validation anomaly",
    );
  });

  it("does not warn for valid alternation", () => {
    const logger = createMockLogger();
    const messages: AgentMessage[] = [
      makeUserMsg("hello"),
      makeAssistantMsg([makeTextBlock("hi")]),
      makeUserMsg("question"),
      makeAssistantMsg([makeTextBlock("answer")]),
    ];

    validateRoleAttribution(messages, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not warn for empty or single message arrays", () => {
    const logger = createMockLogger();

    validateRoleAttribution([], logger);
    expect(logger.warn).not.toHaveBeenCalled();

    validateRoleAttribution([makeUserMsg("solo")], logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports only the first anomaly", () => {
    const logger = createMockLogger();
    const messages: AgentMessage[] = [
      makeUserMsg("one"),
      makeUserMsg("two"),
      makeUserMsg("three"),
    ];

    validateRoleAttribution(messages, logger);

    // Should only fire once despite multiple anomalies
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
