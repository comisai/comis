import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context, Message } from "@mariozechner/pi-ai";
import { createToolResultSizeBouncer } from "./tool-result-size-bouncer.js";
import { createMockLogger, createMockStreamFn, makeAssistantMessage, makeContext } from "./__test-helpers.js";

describe("createToolResultSizeBouncer", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let base: ReturnType<typeof createMockStreamFn>;

  function makeToolResultMessage(
    toolName: string,
    text: string,
    toolCallId?: string,
  ): Message {
    return {
      role: "toolResult",
      toolCallId: toolCallId ?? `tc-${toolName}`,
      toolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    };
  }

  beforeEach(() => {
    logger = createMockLogger();
    base = createMockStreamFn();
  });

  it("passes through toolResult messages under maxChars unchanged", () => {
    const { wrapper } = createToolResultSizeBouncer(50_000, logger);
    const wrappedFn = wrapper(base);

    const shortText = "x".repeat(100);
    const toolMsg = makeToolResultMessage("bash", shortText);
    const context = makeContext([toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    // Should pass original context reference (no truncation needed)
    expect(base.mock.calls[0][1]).toBe(context);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("truncates toolResult messages exceeding maxChars", () => {
    const { wrapper } = createToolResultSizeBouncer(50_000, logger);
    const wrappedFn = wrapper(base);

    const longText = "a".repeat(80_000);
    const toolMsg = makeToolResultMessage("web_fetch", longText);
    const context = makeContext([toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    const calledContext = base.mock.calls[0][1] as Context;
    const calledToolResult = calledContext.messages[0] as any;
    const resultText = calledToolResult.content[0].text;

    // Text should be shorter than original
    expect(resultText.length).toBeLessThan(80_000);
    // Should contain truncation marker
    expect(resultText).toContain("truncated");

    // WARN log should have been emitted with required fields
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "web_fetch",
        originalChars: 80_000,
        truncatedChars: expect.any(Number),
        hint: expect.stringContaining("web_fetch"),
        errorKind: "resource",
      }),
      "Tool result truncated",
    );
  });

  it("does not modify user or assistant messages", () => {
    const { wrapper } = createToolResultSizeBouncer(1_000, logger);
    const wrappedFn = wrapper(base);

    const userMsg: Message = {
      role: "user",
      content: "x".repeat(5_000), // Over 1000 chars but it's a user message
      timestamp: Date.now(),
    };

    const assistantMsg = makeAssistantMessage([
      { type: "text", text: "y".repeat(5_000) },
    ]);

    // Tool result under limit
    const toolMsg = makeToolResultMessage("bash", "short output");
    const context = makeContext([userMsg, assistantMsg, toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    // Should pass original context since no toolResult was truncated
    expect(base.mock.calls[0][1]).toBe(context);
    // User and assistant should be same reference
    const calledContext = base.mock.calls[0][1] as Context;
    expect(calledContext.messages[0]).toBe(userMsg);
    expect(calledContext.messages[1]).toBe(assistantMsg);
  });

  it("handles multiple toolResult messages independently", () => {
    const { wrapper } = createToolResultSizeBouncer(1_000, logger);
    const wrappedFn = wrapper(base);

    const shortTool = makeToolResultMessage("bash", "short output");
    const longTool = makeToolResultMessage("web_fetch", "z".repeat(5_000));
    const context = makeContext([shortTool, longTool]);
    const model = {} as any;

    wrappedFn(model, context);

    const calledContext = base.mock.calls[0][1] as Context;
    // Short tool should be same reference (untouched)
    expect(calledContext.messages[0]).toBe(shortTool);
    // Long tool should be truncated
    const truncatedTool = calledContext.messages[1] as any;
    expect(truncatedTool.content[0].text.length).toBeLessThan(5_000);
    expect(truncatedTool.content[0].text).toContain("truncated");

    // Only one WARN (for the oversized one)
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "web_fetch" }),
      "Tool result truncated",
    );
  });

  it("returns a named wrapper function for logging in composeStreamWrappers", () => {
    const { wrapper } = createToolResultSizeBouncer(50_000, logger);
    expect(wrapper.name).toBe("toolResultSizeBouncer");
  });

  it("creates a shallow copy of context -- does not mutate original", () => {
    const { wrapper } = createToolResultSizeBouncer(1_000, logger);
    const wrappedFn = wrapper(base);

    const originalText = "a".repeat(5_000);
    const toolMsg = makeToolResultMessage("bash", originalText);
    const context = makeContext([toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    // Original context should be unchanged
    expect(context.messages[0]).toBe(toolMsg);
    expect((context.messages[0] as any).content[0].text).toBe(originalText);
  });

  it("includes tool hint in truncated output when truncationHints map has the tool", () => {
    const hints = new Map([["bash", "Use head/tail/grep to limit output"]]);
    const { wrapper } = createToolResultSizeBouncer(1_000, logger, hints);
    const wrappedFn = wrapper(base);

    const toolMsg = makeToolResultMessage("bash", "x".repeat(5_000));
    const context = makeContext([toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    const calledContext = base.mock.calls[0][1] as Context;
    const resultText = (calledContext.messages[0] as any).content[0].text;
    expect(resultText).toContain("Hint: Use head/tail/grep to limit output");
  });

  it("deduplicates WARN logs for same (toolName, toolCallId) across LLM calls", () => {
    const { wrapper } = createToolResultSizeBouncer(1_000, logger);
    const wrappedFn = wrapper(base);

    // Same tool result message appearing in two separate LLM calls
    const toolMsg = makeToolResultMessage("bash", "x".repeat(5_000), "tc-bash-001");
    const context = makeContext([toolMsg]);
    const model = {} as any;

    // First LLM call -- should log
    wrappedFn(model, context);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Second LLM call with same toolCallId -- should NOT log again
    wrappedFn(model, context);
    expect(logger.warn).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it("getTruncationSummary returns correct counts", () => {
    const { wrapper, getTruncationSummary } = createToolResultSizeBouncer(1_000, logger);
    const wrappedFn = wrapper(base);

    // Two different tools truncated
    const tool1 = makeToolResultMessage("bash", "x".repeat(5_000), "tc-001");
    const tool2 = makeToolResultMessage("web_fetch", "y".repeat(3_000), "tc-002");
    const context = makeContext([tool1, tool2]);
    const model = {} as any;

    wrappedFn(model, context);

    const summary = getTruncationSummary();
    expect(summary.truncatedTools).toBe(2);
    expect(summary.totalTruncatedChars).toBeGreaterThan(0);
  });

  it("getTruncationSummary returns zeros when no truncation occurred", () => {
    const { wrapper, getTruncationSummary } = createToolResultSizeBouncer(50_000, logger);
    const wrappedFn = wrapper(base);

    const toolMsg = makeToolResultMessage("bash", "short");
    const context = makeContext([toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    const summary = getTruncationSummary();
    expect(summary.truncatedTools).toBe(0);
    expect(summary.totalTruncatedChars).toBe(0);
  });

  it("accumulates chars across multiple LLM calls even when deduped", () => {
    const { wrapper, getTruncationSummary } = createToolResultSizeBouncer(1_000, logger);
    const wrappedFn = wrapper(base);

    const toolMsg = makeToolResultMessage("bash", "x".repeat(5_000), "tc-bash-001");
    const context = makeContext([toolMsg]);
    const model = {} as any;

    // First call
    wrappedFn(model, context);
    const afterFirst = getTruncationSummary();

    // Second call with same toolCallId (deduped WARN, but chars still accumulate)
    wrappedFn(model, context);
    const afterSecond = getTruncationSummary();

    // Chars should have accumulated (doubled)
    expect(afterSecond.totalTruncatedChars).toBeGreaterThan(afterFirst.totalTruncatedChars);
    // But truncatedTools should stay at 1 (dedup key already seen)
    expect(afterSecond.truncatedTools).toBe(1);
  });
});

