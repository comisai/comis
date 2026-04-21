// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { Message, UserMessage, AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import {
  CHARS_PER_TOKEN,
  IMAGE_TOKEN_ESTIMATE,
  estimateMessageChars,
  estimateContextChars,
  estimateMessageTokens,
  estimateContextTokens,
  estimateWithAnchor,
} from "./token-estimator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function assistantMsg(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolResultMsg(content: ToolResultMessage["content"]): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc_1",
    toolName: "test_tool",
    content,
    isError: false,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// estimateMessageChars
// ---------------------------------------------------------------------------

describe("estimateMessageChars", () => {
  it("returns content.length for text-only UserMessage (string content)", () => {
    const msg = userMsg("Hello, world!");
    expect(estimateMessageChars(msg)).toBe(13);
  });

  it("sums text lengths for AssistantMessage with TextContent blocks", () => {
    const msg = assistantMsg([
      { type: "text", text: "First block." },
      { type: "text", text: "Second block." },
    ]);
    // 12 + 13 = 25
    expect(estimateMessageChars(msg)).toBe(25);
  });

  it("returns thinking.length for AssistantMessage with ThinkingContent", () => {
    const thinkingText = "Let me reason about this problem step by step.";
    const msg = assistantMsg([
      { type: "thinking", thinking: thinkingText },
    ]);
    expect(estimateMessageChars(msg)).toBe(thinkingText.length);
  });

  it("returns JSON.stringify(arguments).length for AssistantMessage with ToolCall", () => {
    const args = { query: "test search", limit: 10 };
    const msg = assistantMsg([
      { type: "toolCall", id: "tc_1", name: "search", arguments: args },
    ]);
    expect(estimateMessageChars(msg)).toBe(JSON.stringify(args).length);
  });

  it("returns IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN for ImageContent", () => {
    const msg = toolResultMsg([
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
    expect(estimateMessageChars(msg)).toBe(IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN);
  });

  it("returns correct sum for mixed TextContent + ImageContent", () => {
    const textContent = "Here is the image result:";
    const msg = toolResultMsg([
      { type: "text", text: textContent },
      { type: "image", data: "base64data", mimeType: "image/jpeg" },
    ]);
    const expected = textContent.length + IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
    expect(estimateMessageChars(msg)).toBe(expected);
  });

  it("returns 256 for unknown block types", () => {
    // Force an unknown block type via type assertion
    const msg = assistantMsg([
      { type: "unknown_type" as "text", text: "" },
    ]);
    // Override the block to truly be unknown
    (msg.content[0] as Record<string, unknown>).type = "server_tool_use";
    delete (msg.content[0] as Record<string, unknown>).text;
    expect(estimateMessageChars(msg)).toBe(256);
  });

  it("returns 0 for empty content array", () => {
    const msg = assistantMsg([]);
    expect(estimateMessageChars(msg)).toBe(0);
  });

  it("handles ToolCall with undefined arguments gracefully", () => {
    const msg = assistantMsg([
      { type: "toolCall", id: "tc_1", name: "noop", arguments: undefined as unknown as Record<string, never> },
    ]);
    // JSON.stringify({}).length = 2
    expect(estimateMessageChars(msg)).toBe(2);
  });

  describe("WeakMap caching", () => {
    it("returns cached value on second call with same message reference", () => {
      const cache = new WeakMap<Message, number>();
      const msg = userMsg("cached message");
      const first = estimateMessageChars(msg, cache);
      const second = estimateMessageChars(msg, cache);
      expect(first).toBe(second);
      expect(cache.get(msg)).toBe(first);
    });

    it("caches correctly across many calls (performance check)", () => {
      const cache = new WeakMap<Message, number>();
      const msg = assistantMsg([
        { type: "text", text: "A".repeat(10_000) },
        { type: "text", text: "B".repeat(5_000) },
      ]);

      // First call computes
      const expected = estimateMessageChars(msg, cache);
      expect(expected).toBe(15_000);

      // Subsequent calls use cache -- verify same result 1000 times
      for (let i = 0; i < 1000; i++) {
        expect(estimateMessageChars(msg, cache)).toBe(expected);
      }
    });

    it("does not cache when no cache provided", () => {
      const msg = userMsg("no cache");
      // Just verify it works without error
      expect(estimateMessageChars(msg)).toBe(8);
      expect(estimateMessageChars(msg)).toBe(8);
    });
  });
});

// ---------------------------------------------------------------------------
// estimateContextChars
// ---------------------------------------------------------------------------

describe("estimateContextChars", () => {
  it("sums correctly across array of messages", () => {
    const messages: Message[] = [
      userMsg("Hello"),          // 5
      assistantMsg([{ type: "text", text: "Hi there!" }]), // 9
      userMsg("How are you?"),   // 12
    ];
    expect(estimateContextChars(messages)).toBe(5 + 9 + 12);
  });

  it("returns 0 for empty message array", () => {
    expect(estimateContextChars([])).toBe(0);
  });

  it("passes cache through to per-message calls", () => {
    const cache = new WeakMap<Message, number>();
    const msg1 = userMsg("First");
    const msg2 = userMsg("Second");
    const messages = [msg1, msg2];

    const total = estimateContextChars(messages, cache);
    expect(total).toBe(5 + 6);

    // Verify both messages are now cached
    expect(cache.get(msg1)).toBe(5);
    expect(cache.get(msg2)).toBe(6);
  });

  it("handles mixed message types in context", () => {
    const messages: Message[] = [
      userMsg("Question"),
      assistantMsg([
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "Answer" },
      ]),
      assistantMsg([
        { type: "toolCall", id: "tc_1", name: "search", arguments: { q: "test" } },
      ]),
      toolResultMsg([
        { type: "text", text: "Result text" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ]),
    ];

    const expected =
      "Question".length +                                    // 8
      "Let me think...".length + "Answer".length +           // 15 + 6
      JSON.stringify({ q: "test" }).length +                 // 12
      "Result text".length + IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN; // 11 + 6400

    expect(estimateContextChars(messages)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// estimateMessageTokens (content-aware estimation)
// ---------------------------------------------------------------------------

describe("estimateMessageTokens", () => {
  it("uses 4:1 ratio for plain user text", () => {
    const msg = userMsg("A".repeat(100));
    // 100 chars / 4 = 25 tokens
    expect(estimateMessageTokens(msg)).toBe(25);
  });

  it("uses 3:1 ratio for tool result text content", () => {
    const msg = toolResultMsg([{ type: "text", text: "A".repeat(99) }]);
    // 99 chars / 3 = 33 tokens
    expect(estimateMessageTokens(msg)).toBe(33);
  });

  it("uses 3:1 ratio for toolCall arguments (JSON)", () => {
    const args = { query: "test search", limit: 10 };
    const msg = assistantMsg([
      { type: "toolCall", id: "tc_1", name: "search", arguments: args },
    ]);
    // JSON.stringify(args).length / 3, rounded up
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(JSON.stringify(args).length / 3));
  });

  it("uses 4:1 ratio for thinking blocks", () => {
    const thinking = "A".repeat(120);
    const msg = assistantMsg([{ type: "thinking", thinking }]);
    // 120 / 4 = 30 tokens
    expect(estimateMessageTokens(msg)).toBe(30);
  });

  it("returns IMAGE_TOKEN_ESTIMATE for images", () => {
    const msg = toolResultMsg([
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
    expect(estimateMessageTokens(msg)).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  it("estimates higher tokens than flat 4:1 for structured content", () => {
    const jsonContent = '{"files":[{"path":"src/index.ts","content":"export const x = 1;"}]}';
    const msgToolResult = toolResultMsg([{ type: "text", text: jsonContent }]);
    const msgUser = userMsg(jsonContent);

    const toolTokens = estimateMessageTokens(msgToolResult);
    const userTokens = estimateMessageTokens(msgUser);

    // Tool result (3:1) should produce more tokens than user text (4:1) for same content
    expect(toolTokens).toBeGreaterThan(userTokens);
  });

  it("handles string content on tool result messages", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tc_1",
      toolName: "bash",
      content: "A".repeat(90),
      isError: false,
      timestamp: Date.now(),
    };
    // 90 chars / 3 = 30 tokens (structured ratio)
    expect(estimateMessageTokens(msg)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// estimateContextTokens (content-aware estimation)
// ---------------------------------------------------------------------------

describe("estimateContextTokens", () => {
  it("sums content-aware tokens across messages", () => {
    const messages: Message[] = [
      userMsg("A".repeat(40)),      // 40/4 = 10 tokens
      toolResultMsg([{ type: "text", text: "B".repeat(30) }]),  // 30/3 = 10 tokens
    ];
    expect(estimateContextTokens(messages)).toBe(20);
  });

  it("returns 0 for empty array", () => {
    expect(estimateContextTokens([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// estimateWithAnchor
// ---------------------------------------------------------------------------

describe("estimateWithAnchor", () => {
  it("returns charBasedTokens when anchor is null (fallback behavior)", () => {
    const messages: Message[] = [userMsg("Hello"), assistantMsg([{ type: "text", text: "Hi" }])];
    const charBasedTokens = 500;
    expect(estimateWithAnchor(null, messages, charBasedTokens)).toBe(500);
  });

  it("returns anchor.inputTokens when newMessageCount is 0 (exact anchor)", () => {
    const messages: Message[] = [
      userMsg("Hello"),
      assistantMsg([{ type: "text", text: "Hi there" }]),
    ];
    const anchor = { inputTokens: 12345, messageCount: 2, timestamp: Date.now() };
    expect(estimateWithAnchor(anchor, messages, 500)).toBe(12345);
  });

  it("returns anchor.inputTokens + delta when new messages exist", () => {
    // Anchor recorded at 2 messages, now we have 3 messages
    const messages: Message[] = [
      userMsg("Hello"),
      assistantMsg([{ type: "text", text: "Hi there" }]),
      userMsg("A".repeat(100)), // new message: 100 chars / 4 = 25 tokens
    ];
    const anchor = { inputTokens: 10000, messageCount: 2, timestamp: Date.now() };
    const result = estimateWithAnchor(anchor, messages, 500);
    // Should be anchor.inputTokens (10000) + delta for the new message (25 tokens)
    expect(result).toBe(10000 + 25);
  });

  it("returns charBasedTokens when newMessageCount is negative (stale anchor after compaction)", () => {
    // Anchor was at 10 messages, but compaction reduced to 3
    const messages: Message[] = [
      userMsg("Summary"),
      assistantMsg([{ type: "text", text: "Response" }]),
      userMsg("Follow-up"),
    ];
    const anchor = { inputTokens: 50000, messageCount: 10, timestamp: Date.now() };
    const charBasedTokens = 750;
    expect(estimateWithAnchor(anchor, messages, charBasedTokens)).toBe(750);
  });

  it("for 20-message conversation with anchor at message 18, delta is less than 5% of total estimate", () => {
    // Build 20 messages: 10 user-assistant pairs, each ~200 chars
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(userMsg("A".repeat(200)));
      messages.push(assistantMsg([{ type: "text", text: "B".repeat(200) }]));
    }
    expect(messages.length).toBe(20);

    // Anchor recorded after 18 messages, so 2 new messages since
    const anchor = { inputTokens: 50000, messageCount: 18, timestamp: Date.now() };

    const charBasedTokens = 1000; // irrelevant, just the fallback
    const result = estimateWithAnchor(anchor, messages, charBasedTokens);

    // The delta should be small relative to the total (anchor.inputTokens)
    const delta = result - anchor.inputTokens;
    const deltaPercent = (delta / result) * 100;
    expect(deltaPercent).toBeLessThan(5);
    // Also verify the result is larger than the anchor (new messages added tokens)
    expect(result).toBeGreaterThan(anchor.inputTokens);
  });
});
