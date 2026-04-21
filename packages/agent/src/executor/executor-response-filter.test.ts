// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for executor-response-filter.ts — focused on empty-response recovery.
 *
 * The private `extractVisibleText` logic is tested indirectly through the
 * exported `recoverEmptyFinalResponse` function.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { recoverEmptyFinalResponse } from "./executor-response-filter.js";
import type { ComisLogger } from "@comis/infra";

/** Minimal mock logger satisfying ComisLogger for recovery tests. */
function mockLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    audit: vi.fn(),
  } as unknown as ComisLogger;
}

describe("recoverEmptyFinalResponse", () => {
  it("returns original response when non-empty", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "Hello, world!",
      textEmitted: true,
      messages: [],
      logger: mockLogger(),
    });
    expect(result).toBe("Hello, world!");
  });

  it("returns empty string when textEmitted is false", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: false,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Some earlier text" }],
        },
      ],
      logger: mockLogger(),
    });
    expect(result).toBe("");
  });

  it("recovers visible text from earlier assistant turn", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is your answer." }],
        },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "pondering..." }],
        },
      ],
      logger: mockLogger(),
    });
    expect(result).toBe("Here is your answer.");
  });

  it("skips text blocks that are entirely <think> tags (root cause of false empty responses)", () => {
    const thinkOnlyText =
      "<think>The user asked about X. Let me reason through this carefully. " +
      "I need to consider A, B, and C factors before responding.</think>";
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Explain X" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "The real visible answer about X." },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning..." },
            { type: "text", text: thinkOnlyText },
          ],
        },
      ],
      logger: mockLogger(),
    });
    // Should skip the think-only message (index 2) and recover from index 1
    expect(result).toBe("The real visible answer about X.");
  });

  it("returns empty string when ALL text blocks are think-only", () => {
    const thinkOnly = "<think>Some internal reasoning</think>";
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: thinkOnly },
          ],
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    // No visible text found — returns original empty response
    expect(result).toBe("");
  });

  it("recovers text that has both <think> tags and visible content", () => {
    const mixedText =
      "<think>Internal reasoning here.</think>Here is the actual answer.";
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: mixedText }],
        },
      ],
      logger: mockLogger(),
    });
    // Should strip the think tags and return the visible portion
    expect(result).toBe("Here is the actual answer.");
  });

  it("handles <thinking> variant tags the same as <think>", () => {
    const thinkingOnly = "<thinking>Deep reasoning about the topic.</thinking>";
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Visible response" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: thinkingOnly }],
        },
      ],
      logger: mockLogger(),
    });
    expect(result).toBe("Visible response");
  });

  it("recovers from silent-token final response (NO_REPLY)", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "NO_REPLY",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is the real response." }],
        },
      ],
      logger: mockLogger(),
    });
    expect(result).toBe("Here is the real response.");
  });

  it("respects userMessageIndex boundary", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Previous execution text" }],
        },
        { role: "user", content: "New question" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "..." }],
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 1,
    });
    // Should NOT recover text from index 0 (before userMessageIndex)
    expect(result).toBe("");
  });

  it("suppresses recovery when message tool was used (NO_REPLY is intentional)", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "NO_REPLY",
      textEmitted: true,
      messages: [
        { role: "user", content: "Compare AAPL vs MSFT", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Now let me generate the chart:" },
            { type: "toolCall", id: "tc1", name: "exec", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "exec", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc2", name: "message", arguments: { action: "send", text: "AAPL vs MSFT report" } },
          ],
          stopReason: "toolUse",
          timestamp: 4,
        },
        { role: "toolResult", toolCallId: "tc2", toolName: "message", content: [{ type: "text", text: '{"messageId":"5094"}' }], isError: false, timestamp: 5 },
        {
          role: "assistant",
          content: [{ type: "text", text: "NO_REPLY" }],
          stopReason: "stop",
          timestamp: 6,
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    expect(result).toBe("NO_REPLY");
  });

  it("suppresses recovery when notify tool was used", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "NO_REPLY",
      textEmitted: true,
      messages: [
        { role: "user", content: "Send me the report", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Sending the report now." },
            { type: "toolCall", id: "tc1", name: "notify", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "notify", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [{ type: "text", text: "NO_REPLY" }],
          stopReason: "stop",
          timestamp: 4,
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    expect(result).toBe("NO_REPLY");
  });

  it("still recovers when no delivery tool was used (genuine empty response)", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "NO_REPLY",
      textEmitted: true,
      messages: [
        { role: "user", content: "Do something", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here is your answer." },
            { type: "toolCall", id: "tc1", name: "exec", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "exec", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
        {
          role: "assistant",
          content: [{ type: "text", text: "NO_REPLY" }],
          stopReason: "stop",
          timestamp: 4,
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 0,
    });
    // No delivery tool → recovery should still fire, returning pre-tool commentary
    expect(result).toBe("Here is your answer.");
  });

  it("respects userMessageIndex when checking for delivery tools", () => {
    const result = recoverEmptyFinalResponse({
      extractedResponse: "NO_REPLY",
      textEmitted: true,
      messages: [
        // Previous execution had a message tool call
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc0", name: "message", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 1,
        },
        { role: "toolResult", toolCallId: "tc0", toolName: "message", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 2 },
        // New execution starts here
        { role: "user", content: "New question", timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Working on it." },
            { type: "toolCall", id: "tc1", name: "exec", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 4,
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "exec", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 5 },
        {
          role: "assistant",
          content: [{ type: "text", text: "NO_REPLY" }],
          stopReason: "stop",
          timestamp: 6,
        },
      ],
      logger: mockLogger(),
      userMessageIndex: 2,
    });
    // message tool is from previous execution (before userMessageIndex=2),
    // so recovery should still fire for the current execution
    expect(result).toBe("Working on it.");
  });

  it("logs recovery info when text is recovered", () => {
    const logger = mockLogger();
    recoverEmptyFinalResponse({
      extractedResponse: "",
      textEmitted: true,
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered text here" }],
        },
      ],
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("recovered text from earlier turn"),
        recoveredLength: expect.any(Number),
      }),
      expect.stringContaining("recovered visible text"),
    );
  });
});
