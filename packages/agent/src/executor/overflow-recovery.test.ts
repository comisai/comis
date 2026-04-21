// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { createOverflowRecovery, type OverflowRecoveryConfig } from "./overflow-recovery.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test helpers
function makeToolResult(toolName: string, textContent: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${toolName}-${Math.random()}`,
    toolName,
    content: [{ type: "text", text: textContent }],
    isError: false,
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

function generateString(n: number): string {
  return "x".repeat(n);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOverflowRecovery", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  // 1. Phase 1: truncates oversized tool results to 30% of maxContextChars
  it("phase 1: truncates oversized tool results to 30% of maxContextChars", () => {
    const config: OverflowRecoveryConfig = { maxContextChars: 10_000 };
    const recovery = createOverflowRecovery(config, logger);

    // 30% of 10000 = 3000. Create a tool result with 8000 chars (exceeds 3000).
    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("I will use a tool"),
      makeToolResult("web_fetch", generateString(8000)),
    ];

    const result = recovery.recover(messages);

    expect(result.recovered).toBe(true);
    expect(result.action).toBe("truncated");
    expect(result.charsFreed).toBeGreaterThan(0);
    expect(result.recoveredMessages).toBeDefined();

    // The tool result should be truncated
    const recoveredTool = result.recoveredMessages!.find(m => m.role === "toolResult") as ToolResultMessage;
    const recoveredTextBlock = recoveredTool.content.find(b => b.type === "text");
    expect(recoveredTextBlock!.text!.length).toBeLessThan(8000);
  });

  // 2. Phase 1: leaves small tool results unchanged
  it("phase 1: leaves small tool results unchanged", () => {
    const config: OverflowRecoveryConfig = { maxContextChars: 10_000 };
    const recovery = createOverflowRecovery(config, logger);

    // 30% of 10000 = 3000. Create a tool result with only 500 chars (under 3000).
    const smallContent = generateString(500);
    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("I will use a tool"),
      makeToolResult("web_fetch", smallContent),
    ];

    const result = recovery.recover(messages);

    // Nothing should be freed since all results are small enough
    expect(result.recovered).toBe(false);
    expect(result.action).toBe("none");
    expect(result.charsFreed).toBe(0);
    expect(result.recoveredMessages).toBeUndefined();
  });

  // 3. Phase 2: emergency compacts when still over budget after truncation
  it("phase 2: emergency compacts when still over budget after truncation", () => {
    // Set maxContextChars very low so even after truncation, total exceeds budget
    const config: OverflowRecoveryConfig = { maxContextChars: 500 };
    const recovery = createOverflowRecovery(config, logger);

    // Create multiple tool results that individually are under 30% (150 chars)
    // but collectively exceed 500 chars total
    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("First response"),
      makeToolResult("tool_a", generateString(140)),
      makeToolResult("tool_b", generateString(140)),
      makeToolResult("tool_c", generateString(140)),
      makeAssistantMessage("Second response"),
      makeToolResult("tool_d", generateString(140)),
    ];

    const result = recovery.recover(messages);

    expect(result.recovered).toBe(true);
    // Phase 1 did not truncate (all under 150 = 30% of 500), but phase 2 compacted
    expect(result.action).toBe("compacted");
    expect(result.charsFreed).toBeGreaterThan(0);
    expect(result.recoveredMessages).toBeDefined();

    // Check that some tool results before last assistant are compacted
    const compactedMsgs = result.recoveredMessages!.filter(
      m => m.role === "toolResult" && (m as ToolResultMessage).content[0]?.type === "text" &&
        ((m as ToolResultMessage).content[0] as { text: string }).text.includes("emergency-compacted"),
    );
    expect(compactedMsgs.length).toBeGreaterThan(0);
  });

  // 4. Phase 2: protects tool results after last assistant message
  it("phase 2: protects tool results after last assistant message", () => {
    // maxContextChars=5000, truncationTarget = 1500 (30% of 5000).
    // Two old tool results (4000 chars each) get truncated by phase 1 to ~1500,
    // but total (~3000 + user/assistant overhead) still exceeds 5000,
    // triggering phase 2 compaction.
    const config: OverflowRecoveryConfig = { maxContextChars: 5000 };
    const recovery = createOverflowRecovery(config, logger);

    // Tool results before the last assistant are eligible for compaction,
    // but those after are protected (in-flight).
    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("First response"),
      makeToolResult("old_tool_a", generateString(4000)),
      makeToolResult("old_tool_b", generateString(4000)),
      makeAssistantMessage("Second response"),
      makeToolResult("new_tool", generateString(4000)), // after last assistant -- protected
    ];

    const result = recovery.recover(messages);

    expect(result.recovered).toBe(true);
    expect(result.recoveredMessages).toBeDefined();

    // old_tool_a (index 2) should be compacted
    const oldToolMsgA = result.recoveredMessages![2] as ToolResultMessage;
    const oldContentA = (oldToolMsgA.content[0] as { text: string }).text;
    expect(oldContentA).toContain("emergency-compacted");

    // old_tool_b (index 3) should also be compacted
    const oldToolMsgB = result.recoveredMessages![3] as ToolResultMessage;
    const oldContentB = (oldToolMsgB.content[0] as { text: string }).text;
    expect(oldContentB).toContain("emergency-compacted");

    // new_tool (index 5, after last assistant at index 4) should be protected
    const newToolMsg = result.recoveredMessages![5] as ToolResultMessage;
    const newContent = (newToolMsg.content[0] as { text: string }).text;
    expect(newContent).not.toContain("emergency-compacted");
  });

  // 5. Combined: both phases run and action='both' returned
  it("combined: both phases run and action='both' returned", () => {
    // maxContextChars=2000, truncationTarget = 600 (30%)
    const config: OverflowRecoveryConfig = { maxContextChars: 2000 };
    const recovery = createOverflowRecovery(config, logger);

    // One oversized result (triggers phase 1) + many small results that exceed budget (triggers phase 2)
    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("First"),
      makeToolResult("tool_a", generateString(400)),
      makeToolResult("tool_b", generateString(400)),
      makeToolResult("tool_c", generateString(400)),
      makeAssistantMessage("Second"),
      makeToolResult("big_tool", generateString(5000)), // oversized, triggers phase 1
    ];

    const result = recovery.recover(messages);

    expect(result.recovered).toBe(true);
    expect(result.action).toBe("both");
    expect(result.charsFreed).toBeGreaterThan(0);
    expect(result.recoveredMessages).toBeDefined();
  });

  // 6. No recovery needed: all results already small
  it("no recovery needed: all results already small", () => {
    const config: OverflowRecoveryConfig = { maxContextChars: 100_000 };
    const recovery = createOverflowRecovery(config, logger);

    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("Response"),
      makeToolResult("tool_a", "short"),
    ];

    const result = recovery.recover(messages);

    expect(result.recovered).toBe(false);
    expect(result.action).toBe("none");
    expect(result.charsFreed).toBe(0);
    expect(result.recoveredMessages).toBeUndefined();
  });

  // 7. Does not mutate original messages array
  it("does not mutate original messages array", () => {
    const config: OverflowRecoveryConfig = { maxContextChars: 10_000 };
    const recovery = createOverflowRecovery(config, logger);

    const originalContent = generateString(8000);
    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("Response"),
      makeToolResult("web_fetch", originalContent),
    ];

    // Keep references to originals
    const originalLength = messages.length;
    const originalMsg = messages[2] as ToolResultMessage;
    const originalMsgContent = originalMsg.content;

    const result = recovery.recover(messages);

    // Original array unchanged
    expect(messages.length).toBe(originalLength);
    expect(messages[2]).toBe(originalMsg);
    expect((messages[2] as ToolResultMessage).content).toBe(originalMsgContent);
    expect(((messages[2] as ToolResultMessage).content[0] as { text: string }).text).toBe(originalContent);

    // Recovered messages are a new array
    expect(result.recoveredMessages).not.toBe(messages);
    expect(result.recovered).toBe(true);
  });

  // 8. Logs phase 1 truncation at DEBUG and phase 2 compaction at DEBUG
  it("logs phase 1 truncation at DEBUG and phase 2 compaction at DEBUG", () => {
    const config: OverflowRecoveryConfig = { maxContextChars: 500 };
    const recovery = createOverflowRecovery(config, logger);

    // Oversized result (triggers phase 1 debug log) + total over budget (triggers phase 2 debug log)
    const messages: Message[] = [
      makeUserMessage("Hi"),
      makeAssistantMessage("First"),
      makeToolResult("tool_a", generateString(400)),
      makeAssistantMessage("Second"),
      makeToolResult("big_tool", generateString(2000)),
    ];

    recovery.recover(messages);

    // Should have DEBUG logs for truncation and compaction
    const debugCalls = logger.debug.mock.calls;
    const truncationLogs = debugCalls.filter(
      (c: any[]) => typeof c[1] === "string" && c[1].includes("truncated"),
    );
    const compactionLogs = debugCalls.filter(
      (c: any[]) => typeof c[1] === "string" && c[1].includes("emergency-compacted"),
    );

    expect(truncationLogs.length).toBeGreaterThan(0);
    expect(compactionLogs.length).toBeGreaterThan(0);

    // INFO logging is NOT done by recovery module (handled by caller)
    expect(logger.info).not.toHaveBeenCalled();
  });

  // 9. Custom truncationTargetRatio config works
  it("custom truncationTargetRatio config works", () => {
    // 10% of 10000 = 1000 instead of default 30% = 3000
    const config: OverflowRecoveryConfig = {
      maxContextChars: 10_000,
      truncationTargetRatio: 0.1,
    };
    const recovery = createOverflowRecovery(config, logger);

    // 2000 chars exceeds 1000 (10%) but is under 3000 (30%)
    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("Response"),
      makeToolResult("web_fetch", generateString(2000)),
    ];

    const result = recovery.recover(messages);

    // With 10% ratio: truncation target = 1000, so 2000 char result gets truncated
    expect(result.recovered).toBe(true);
    expect(result.action).toBe("truncated");

    // Verify it was truncated to roughly 1000 chars
    const recoveredTool = result.recoveredMessages!.find(m => m.role === "toolResult") as ToolResultMessage;
    const textBlock = recoveredTool.content.find(b => b.type === "text");
    // The truncated size should be significantly less than 2000
    expect(textBlock!.text!.length).toBeLessThan(2000);
  });

  // 10. Returns correct charsFreed count
  it("returns correct charsFreed count", () => {
    const config: OverflowRecoveryConfig = { maxContextChars: 10_000 };
    const recovery = createOverflowRecovery(config, logger);

    // 30% of 10000 = 3000. Tool result is 8000 chars.
    const originalSize = 8000;
    const messages: Message[] = [
      makeUserMessage("Hello"),
      makeAssistantMessage("Response"),
      makeToolResult("web_fetch", generateString(originalSize)),
    ];

    const result = recovery.recover(messages);

    expect(result.recovered).toBe(true);
    expect(result.charsFreed).toBeGreaterThan(0);

    // charsFreed should be approximately originalSize - truncationTarget
    // (not exact due to truncation marker overhead)
    const recoveredTool = result.recoveredMessages!.find(m => m.role === "toolResult") as ToolResultMessage;
    const recoveredSize = (recoveredTool.content[0] as { text: string }).text.length;
    expect(result.charsFreed).toBe(originalSize - recoveredSize);
  });
});
