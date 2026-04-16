/**
 * Integration test: Tool result size guard (TEST-03)
 *
 * Proves that the toolResultSizeBouncer stream wrapper truncates oversized
 * tool results through the built dist output. Imports from @comis/agent
 * (resolved via vitest alias to packages/agent/dist/).
 */

import { describe, it, expect, vi } from "vitest";
import { createToolResultSizeBouncer, composeStreamWrappers } from "@comis/agent";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function createMockStreamFn() {
  return vi.fn().mockReturnValue("stream-result");
}

function makeToolResultMessage(toolName: string, text: string, toolCallId: string = "tc-1") {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
  };
}

function makeContext(messages: any[]) {
  return {
    systemPrompt: "test system prompt",
    tools: [],
    messages,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resilience-size-guard integration (TEST-03)", () => {
  it("passes through tool results under the limit unchanged", { timeout: 10_000 }, () => {
    const logger = createMockLogger();
    const next = createMockStreamFn();

    const bouncer = createToolResultSizeBouncer(50_000, logger);
    const wrapped = bouncer(next);

    const shortText = "a".repeat(100);
    const context = makeContext([makeToolResultMessage("web_fetch", shortText)]);

    wrapped({ id: "test", provider: "anthropic" } as any, context as any, {});

    // next should have been called with the original context unchanged
    expect(next).toHaveBeenCalledTimes(1);
    const passedContext = next.mock.calls[0][1];
    expect(passedContext.messages[0].content[0].text).toBe(shortText);
    expect(passedContext.messages[0].content[0].text.length).toBe(100);

    // No warn should have been emitted
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("truncates tool results exceeding the limit with WARN logging", { timeout: 10_000 }, () => {
    const logger = createMockLogger();
    const next = createMockStreamFn();

    const bouncer = createToolResultSizeBouncer(500, logger);
    const wrapped = bouncer(next);

    const bigText = "x".repeat(5000);
    const context = makeContext([makeToolResultMessage("web_fetch", bigText)]);

    wrapped({ id: "test", provider: "anthropic" } as any, context as any, {});

    expect(next).toHaveBeenCalledTimes(1);
    const passedContext = next.mock.calls[0][1];
    const truncatedText = passedContext.messages[0].content[0].text;

    // Should be significantly smaller than the original 5000 chars
    expect(truncatedText.length).toBeLessThan(5000);
    // Should contain the truncation marker
    expect(truncatedText).toContain("chars truncated");

    // Logger.warn should have been called with required fields
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnArgs = logger.warn.mock.calls[0][0];
    expect(warnArgs.toolName).toBe("web_fetch");
    expect(warnArgs.originalChars).toBe(5000);
    expect(typeof warnArgs.truncatedChars).toBe("number");
    expect(warnArgs.truncatedChars).toBeLessThan(5000);
    expect(warnArgs.hint).toContain("web_fetch");
    expect(warnArgs.errorKind).toBe("resource");
  });

  it("non-toolResult messages pass through unchanged", { timeout: 10_000 }, () => {
    const logger = createMockLogger();
    const next = createMockStreamFn();

    const bouncer = createToolResultSizeBouncer(100, logger);
    const wrapped = bouncer(next);

    const userMsg = { role: "user" as const, content: [{ type: "text", text: "a".repeat(500) }] };
    const assistantMsg = {
      role: "assistant" as const,
      content: [{ type: "text", text: "b".repeat(500) }],
    };
    const context = makeContext([userMsg, assistantMsg]);

    wrapped({ id: "test", provider: "anthropic" } as any, context as any, {});

    expect(next).toHaveBeenCalledTimes(1);
    const passedContext = next.mock.calls[0][1];

    // Messages should be unchanged
    expect(passedContext.messages[0].content[0].text).toBe("a".repeat(500));
    expect(passedContext.messages[1].content[0].text).toBe("b".repeat(500));

    // No warn should have been emitted
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("truncates only oversized toolResult messages among multiple", { timeout: 10_000 }, () => {
    const logger = createMockLogger();
    const next = createMockStreamFn();

    const bouncer = createToolResultSizeBouncer(500, logger);
    const wrapped = bouncer(next);

    const smallToolResult = makeToolResultMessage("read_file", "a".repeat(100), "tc-1");
    const bigToolResult = makeToolResultMessage("web_fetch", "x".repeat(5000), "tc-2");
    const context = makeContext([smallToolResult, bigToolResult]);

    wrapped({ id: "test", provider: "anthropic" } as any, context as any, {});

    expect(next).toHaveBeenCalledTimes(1);
    const passedContext = next.mock.calls[0][1];

    // The bouncer processes each toolResult independently against maxChars.
    // Small tool result (100 chars < 500 maxChars): passes through unchanged.
    // Big tool result (5000 chars > 500 maxChars): gets truncated.
    const msg0Text = passedContext.messages[0].content[0].text;
    const msg1Text = passedContext.messages[1].content[0].text;

    // Small one passes through unchanged (100 < 500)
    expect(msg0Text).toBe("a".repeat(100));

    // The big one must be truncated
    expect(msg1Text.length).toBeLessThan(5000);
    expect(msg1Text).toContain("chars truncated");

    // Logger.warn should have been called once (only for the oversized web_fetch)
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnCall = logger.warn.mock.calls[0][0];
    expect(warnCall.toolName).toBe("web_fetch");
    expect(warnCall.originalChars).toBe(5000);
  });
});
