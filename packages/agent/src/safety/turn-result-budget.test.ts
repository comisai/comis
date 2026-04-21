// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { applyTurnResultBudget } from "./turn-result-budget.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeToolResultMessage(
  toolName: string,
  text: string,
  toolCallId?: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCallId ?? `tc-${toolName}`,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5-20250929",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

/** Generate a string of exactly N chars. */
function chars(n: number, ch = "x"): string {
  return ch.repeat(n);
}

/** Extract the text from a tool result message's first content block. */
function getToolText(msg: Message): string {
  const tr = msg as ToolResultMessage;
  const block = tr.content[0];
  return block.type === "text" ? block.text : "";
}

// ---------------------------------------------------------------------------
// applyTurnResultBudget
// ---------------------------------------------------------------------------

describe("applyTurnResultBudget", () => {
  // 1. Under budget: 3 tool results totaling 100K chars
  it("returns messages unchanged when aggregate tool results are under budget", () => {
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeToolResultMessage("bash", chars(30_000), "tc-1"),
      makeToolResultMessage("file_read", chars(30_000), "tc-2"),
      makeToolResultMessage("web_fetch", chars(40_000), "tc-3"),
    ];

    const result = applyTurnResultBudget(messages);

    expect(result.budgetExceeded).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.toolMetas).toHaveLength(3);
    for (const meta of result.toolMetas) {
      expect(meta.truncated).toBe(false);
    }
  });

  // 2. Over budget: 3 tool results totaling 300K chars
  it("truncates proportionally when aggregate exceeds budget", () => {
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeToolResultMessage("bash", chars(100_000), "tc-1"),
      makeToolResultMessage("file_read", chars(100_000), "tc-2"),
      makeToolResultMessage("web_fetch", chars(100_000), "tc-3"),
    ];

    const result = applyTurnResultBudget(messages);

    expect(result.budgetExceeded).toBe(true);
    expect(result.toolMetas).toHaveLength(3);

    for (const meta of result.toolMetas) {
      expect(meta.truncated).toBe(true);
      expect(meta.fullChars).toBe(100_000);
      expect(meta.returnedChars).toBeLessThan(100_000);
      expect(meta.returnedChars).toBeGreaterThan(0);
    }

    // Total returned chars should be roughly <= 200K (plus truncation notices)
    const totalReturned = result.toolMetas.reduce((s, m) => s + m.returnedChars, 0);
    // Allow some overhead from truncation notice text
    expect(totalReturned).toBeLessThan(250_000);
  });

  // 3. Minimum guarantee: each gets at least 500 chars even when budget exhausted
  it("guarantees minimum chars per tool when budget is very small", () => {
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeToolResultMessage("t1", chars(50_000), "tc-1"),
      makeToolResultMessage("t2", chars(50_000), "tc-2"),
      makeToolResultMessage("t3", chars(50_000), "tc-3"),
      makeToolResultMessage("t4", chars(50_000), "tc-4"),
      makeToolResultMessage("t5", chars(50_000), "tc-5"),
    ];

    const result = applyTurnResultBudget(messages, {
      maxTurnChars: 1000,
      minCharsPerTool: 500,
    });

    expect(result.budgetExceeded).toBe(true);
    expect(result.toolMetas).toHaveLength(5);

    for (const meta of result.toolMetas) {
      expect(meta.truncated).toBe(true);
      // Each tool should get at least minCharsPerTool (500) of actual content
      // returned chars includes truncation notice, but text should have at least 500 useful chars
      expect(meta.returnedChars).toBeGreaterThanOrEqual(500);
    }
  });

  // 4. Turn boundary: only tool results after last assistant message are candidates
  it("only enforces budget on tool results after the last assistant message", () => {
    const earlyToolText = chars(50_000);
    const messages: Message[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("first response"),
      makeToolResultMessage("bash", earlyToolText, "tc-early-1"),
      makeToolResultMessage("file_read", chars(50_000), "tc-early-2"),
      makeAssistantMessage("second response"),
      makeToolResultMessage("bash", chars(200_000), "tc-late-1"),
      makeToolResultMessage("web_fetch", chars(200_000), "tc-late-2"),
    ];

    const result = applyTurnResultBudget(messages);

    // Early tool results (before last assistant) should be unchanged
    const earlyTool = result.messages[2] as ToolResultMessage;
    expect(getToolText(earlyTool)).toBe(earlyToolText);

    // Budget should be exceeded by the late tool results (400K > 200K)
    expect(result.budgetExceeded).toBe(true);

    // Only the 2 late tool results should be in toolMetas
    expect(result.toolMetas).toHaveLength(2);
    expect(result.toolMetas[0].toolCallId).toBe("tc-late-1");
    expect(result.toolMetas[1].toolCallId).toBe("tc-late-2");
  });

  // 5. No assistant message: all toolResult messages are considered current turn
  it("treats all tool results as current turn when no assistant message exists", () => {
    const messages: Message[] = [
      makeToolResultMessage("bash", chars(150_000), "tc-1"),
      makeToolResultMessage("file_read", chars(150_000), "tc-2"),
    ];

    const result = applyTurnResultBudget(messages);

    expect(result.budgetExceeded).toBe(true);
    expect(result.toolMetas).toHaveLength(2);
    for (const meta of result.toolMetas) {
      expect(meta.truncated).toBe(true);
    }
  });

  // 6. Empty messages: returns empty array, budgetExceeded=false, empty toolMetas
  it("handles empty messages array", () => {
    const result = applyTurnResultBudget([]);

    expect(result.messages).toEqual([]);
    expect(result.budgetExceeded).toBe(false);
    expect(result.toolMetas).toEqual([]);
  });

  // 7. Mixed message types: only toolResult messages are affected
  it("passes through non-toolResult messages in current turn unchanged", () => {
    const userText = "user input between tools";
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeUserMessage(userText),
      makeToolResultMessage("bash", chars(150_000), "tc-1"),
      makeUserMessage("another user message"),
      makeToolResultMessage("file_read", chars(150_000), "tc-2"),
    ];

    const result = applyTurnResultBudget(messages);

    expect(result.budgetExceeded).toBe(true);

    // User messages should be unchanged
    const userMsg1 = result.messages[1] as UserMessage;
    expect(userMsg1.role).toBe("user");
    expect(userMsg1.content).toBe(userText);

    const userMsg2 = result.messages[3] as UserMessage;
    expect(userMsg2.role).toBe("user");
    expect(userMsg2.content).toBe("another user message");

    // Only toolResult messages in toolMetas
    expect(result.toolMetas).toHaveLength(2);
  });

  // 8. Single tool result over budget
  it("truncates a single massive tool result to maxTurnChars", () => {
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeToolResultMessage("bash", chars(300_000), "tc-1"),
    ];

    const result = applyTurnResultBudget(messages);

    expect(result.budgetExceeded).toBe(true);
    expect(result.toolMetas).toHaveLength(1);
    expect(result.toolMetas[0].truncated).toBe(true);
    expect(result.toolMetas[0].fullChars).toBe(300_000);
    // The returned text should be substantially smaller than original
    expect(result.toolMetas[0].returnedChars).toBeLessThan(300_000);
  });

  // 9. Metadata accuracy
  it("reports accurate metadata for each tool result", () => {
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeToolResultMessage("bash", chars(80_000), "tc-bash-42"),
      makeToolResultMessage("file_read", chars(120_000), "tc-file-17"),
      makeToolResultMessage("web_fetch", chars(100_000), "tc-web-99"),
    ];

    const result = applyTurnResultBudget(messages);

    expect(result.budgetExceeded).toBe(true);
    expect(result.toolMetas).toHaveLength(3);

    // Check tool name and call ID are correct
    expect(result.toolMetas[0].toolName).toBe("bash");
    expect(result.toolMetas[0].toolCallId).toBe("tc-bash-42");
    expect(result.toolMetas[0].fullChars).toBe(80_000);

    expect(result.toolMetas[1].toolName).toBe("file_read");
    expect(result.toolMetas[1].toolCallId).toBe("tc-file-17");
    expect(result.toolMetas[1].fullChars).toBe(120_000);

    expect(result.toolMetas[2].toolName).toBe("web_fetch");
    expect(result.toolMetas[2].toolCallId).toBe("tc-web-99");
    expect(result.toolMetas[2].fullChars).toBe(100_000);

    // returnedChars should match the actual text length in the returned message
    for (let i = 0; i < result.toolMetas.length; i++) {
      const meta = result.toolMetas[i];
      // Offset by 1 for the leading assistant message
      const msg = result.messages[i + 1] as ToolResultMessage;
      const textBlock = msg.content.find(b => b.type === "text") as { type: "text"; text: string };
      expect(meta.returnedChars).toBe(textBlock.text.length);
    }
  });

  // 10. Custom options
  it("respects custom maxTurnChars and minCharsPerTool options", () => {
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeToolResultMessage("bash", chars(30_000), "tc-1"),
      makeToolResultMessage("file_read", chars(30_000), "tc-2"),
    ];

    // Custom budget of 50K (total is 60K, should exceed)
    const result = applyTurnResultBudget(messages, {
      maxTurnChars: 50_000,
      minCharsPerTool: 1000,
    });

    expect(result.budgetExceeded).toBe(true);
    expect(result.toolMetas).toHaveLength(2);
    for (const meta of result.toolMetas) {
      expect(meta.truncated).toBe(true);
      // Should get at least 1000 chars (custom minimum)
      expect(meta.returnedChars).toBeGreaterThanOrEqual(1000);
    }
  });

  // Additional edge case: budget notice format
  it("appends turn budget notice to truncated tool results", () => {
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeToolResultMessage("bash", chars(300_000), "tc-1"),
    ];

    const result = applyTurnResultBudget(messages);

    const toolMsg = result.messages[1] as ToolResultMessage;
    const text = getToolText(toolMsg);
    expect(text).toContain("[Turn result budget exceeded");
    expect(text).toContain("chars used)");
    expect(text).toContain("Reduce output size in tool calls.]");
  });

  // Edge case: messages array with only non-toolResult messages
  it("returns unchanged when current turn has no tool results", () => {
    const messages: Message[] = [
      makeAssistantMessage("plan"),
      makeUserMessage("hello"),
    ];

    const result = applyTurnResultBudget(messages);

    expect(result.budgetExceeded).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.toolMetas).toEqual([]);
  });
});
