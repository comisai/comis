// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the signed-replay state scrubber.
 *
 * Verifies in-place mutation, count accuracy, defensive handling of malformed
 * input, both block-type spellings (`toolCall` and `tool_call`), and that
 * non-assistant messages are untouched.
 */

import { describe, it, expect } from "vitest";
import { scrubSignedReplayStateInPlace } from "./signature-block-scrubber.js";

describe("scrubSignedReplayStateInPlace", () => {
  // -------------------------------------------------------------------------
  // Defensive cases
  // -------------------------------------------------------------------------

  it("returns zero counts for empty array", () => {
    const messages: unknown[] = [];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
    expect(messages).toEqual([]);
  });

  it("returns zero counts when messages is undefined", () => {
    const counts = scrubSignedReplayStateInPlace(undefined as unknown as unknown[]);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
  });

  it("returns zero counts when messages is not an array", () => {
    const counts = scrubSignedReplayStateInPlace("not an array" as unknown as unknown[]);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
  });

  it("tolerates message with content: null", () => {
    const messages: unknown[] = [{ role: "assistant", content: null }];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
  });

  it("tolerates message with non-array content", () => {
    const messages: unknown[] = [{ role: "assistant", content: 42 }];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
  });

  it("tolerates blocks lacking type", () => {
    const messages: unknown[] = [
      { role: "assistant", content: [{ foo: "bar" }, { type: "text", text: "hi" }] },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
  });

  it("tolerates null / non-object blocks", () => {
    const messages: unknown[] = [
      { role: "assistant", content: [null, undefined, 42, "string-block"] },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
  });

  // -------------------------------------------------------------------------
  // Pure user-only history
  // -------------------------------------------------------------------------

  it("returns zero counts for user-only history", () => {
    const messages: unknown[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "world" }] },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
    // Inputs untouched
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "world" }] },
    ]);
  });

  // -------------------------------------------------------------------------
  // Thinking block removal
  // -------------------------------------------------------------------------

  it("drops a single signed thinking block, preserves text", () => {
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal thought", thinkingSignature: "sig-abc" },
          { type: "text", text: "visible answer" },
        ],
      },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 1, thoughtSignaturesStripped: 0 });
    const m = messages[0] as { role: string; content: unknown[] };
    expect(m.content).toHaveLength(1);
    expect(m.content[0]).toEqual({ type: "text", text: "visible answer" });
  });

  it("drops redacted thinking blocks (more aggressive than steady-state cleaner)", () => {
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", redacted: true, thinkingSignature: "sig-redacted" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 1, thoughtSignaturesStripped: 0 });
    const m = messages[0] as { role: string; content: unknown[] };
    expect(m.content).toHaveLength(1);
    expect(m.content[0]).toEqual({ type: "text", text: "answer" });
  });

  it("drops multiple thinking blocks across multiple assistant messages", () => {
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t1" },
          { type: "text", text: "a1" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "u1" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t2" },
          { type: "thinking", thinking: "t3", redacted: true },
          { type: "text", text: "a2" },
        ],
      },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 3, thoughtSignaturesStripped: 0 });
    const m0 = messages[0] as { content: unknown[] };
    const m2 = messages[2] as { content: unknown[] };
    expect(m0.content).toHaveLength(1);
    expect(m2.content).toHaveLength(1);
    // User message untouched
    expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "u1" }] });
  });

  // -------------------------------------------------------------------------
  // thoughtSignature stripping on toolCall
  // -------------------------------------------------------------------------

  it("strips thoughtSignature from a toolCall block, preserves other fields", () => {
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "test_tool",
            args: { foo: "bar" },
            thoughtSignature: "sig-tool",
          },
        ],
      },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 1 });
    const m = messages[0] as { content: Array<Record<string, unknown>> };
    expect(m.content[0]).toEqual({
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "test_tool",
      args: { foo: "bar" },
    });
    expect(m.content[0]).not.toHaveProperty("thoughtSignature");
  });

  it("strips thoughtSignature from snake_case tool_call spelling too", () => {
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCallId: "call-2",
            toolName: "another_tool",
            args: {},
            thoughtSignature: "sig-tool-2",
          },
        ],
      },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 1 });
    const m = messages[0] as { content: Array<Record<string, unknown>> };
    expect(m.content[0]).not.toHaveProperty("thoughtSignature");
    expect(m.content[0]).toHaveProperty("toolCallId", "call-2");
  });

  it("does not touch toolCall blocks lacking thoughtSignature", () => {
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", toolCallId: "call-3", toolName: "tool", args: {} },
        ],
      },
    ];
    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 0, thoughtSignaturesStripped: 0 });
  });

  // -------------------------------------------------------------------------
  // Mixed history end-to-end
  // -------------------------------------------------------------------------

  it("handles mixed history: only thinking dropped + signatures stripped, others untouched", () => {
    const messages: unknown[] = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t" },
          { type: "text", text: "answer" },
          {
            type: "toolCall",
            toolCallId: "call-A",
            toolName: "tool",
            args: {},
            thoughtSignature: "sig-A",
          },
        ],
      },
      { role: "toolResult", toolCallId: "call-A", content: [{ type: "text", text: "result" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCallId: "call-B",
            toolName: "tool2",
            args: {},
            thoughtSignature: "sig-B",
          },
          { type: "text", text: "more" },
        ],
      },
    ];

    const counts = scrubSignedReplayStateInPlace(messages);
    expect(counts).toEqual({ blocksRemoved: 1, thoughtSignaturesStripped: 2 });

    // user message untouched
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "u1" }] });
    // toolResult untouched
    expect(messages[2]).toEqual({
      role: "toolResult",
      toolCallId: "call-A",
      content: [{ type: "text", text: "result" }],
    });

    // First assistant: thinking dropped, text preserved, toolCall preserved without signature
    const m1 = messages[1] as { content: Array<Record<string, unknown>> };
    expect(m1.content).toHaveLength(2);
    expect(m1.content[0]).toEqual({ type: "text", text: "answer" });
    expect(m1.content[1]).not.toHaveProperty("thoughtSignature");
    expect(m1.content[1]).toHaveProperty("toolCallId", "call-A");

    // Second assistant: tool_call preserved without signature, text preserved
    const m3 = messages[3] as { content: Array<Record<string, unknown>> };
    expect(m3.content).toHaveLength(2);
    expect(m3.content[0]).not.toHaveProperty("thoughtSignature");
    expect(m3.content[0]).toHaveProperty("toolCallId", "call-B");
    expect(m3.content[1]).toEqual({ type: "text", text: "more" });
  });

  it("mutates input in place (no copy returned)", () => {
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const messagesRef = messages;
    const m0 = messages[0] as { content: unknown[] };
    const contentRef = m0.content;

    scrubSignedReplayStateInPlace(messages);

    // Caller's array, message, and content array references all preserved
    expect(messages).toBe(messagesRef);
    expect((messages[0] as { content: unknown[] }).content).toBe(contentRef);
    expect(contentRef).toHaveLength(1);
  });
});
