// SPDX-License-Identifier: Apache-2.0
/**
 * Pure-function tests for tool-result-clearing.ts
 * (Phase 42 EXEC-SPLIT-02 / EXEC-SPLIT-03 — module-aligned test neighbor).
 *
 * Hosts the pure-function describes that test `clearStaleThinkingBlocks`
 * directly. Integration tests that wire through createRequestBodyInjector
 * remain in factory.test.ts because they exercise the full pipeline
 * (clearStaleToolResults + the microcompact trigger).
 *
 * Lifted verbatim from request-body-injector.test.ts (the pre-split test
 * file at HEAD~1 prior to the rename to factory.test.ts).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { clearStaleThinkingBlocks } from "./index.js";

describe("clearStaleThinkingBlocks (pure)", () => {
  it("removes thinking blocks from assistant messages beyond keepWindow", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Let me think about this..." },
        { type: "text", text: "Response 1" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thinking again..." },
        { type: "text", text: "Response 2" },
      ]},
      { role: "user", content: [{ type: "text", text: "Last" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Final thought..." },
        { type: "text", text: "Response 3" },
      ]},
    ];

    // keepWindow = 1: only last assistant message keeps thinking blocks
    const cleared = clearStaleThinkingBlocks(messages, 1);

    expect(cleared).toBe(2); // 2 thinking blocks cleared from first 2 assistant messages
    // First assistant: thinking removed, text preserved
    expect((messages[1]!.content as any[]).length).toBe(1);
    expect((messages[1]!.content as any[])[0].type).toBe("text");
    // Second assistant: thinking removed, text preserved
    expect((messages[3]!.content as any[]).length).toBe(1);
    expect((messages[3]!.content as any[])[0].type).toBe("text");
    // Third assistant: within keepWindow, thinking preserved
    expect((messages[5]!.content as any[]).length).toBe(2);
    expect((messages[5]!.content as any[])[0].type).toBe("thinking");
  });

  it("preserves redacted_thinking blocks (block.redacted === true)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", redacted: true, data: "encrypted-signature" },
        { type: "thinking", thinking: "Normal thinking to be cleared" },
        { type: "text", text: "Response" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "text", text: "Latest response" },
      ]},
    ];

    // keepWindow = 1: first assistant beyond window
    const cleared = clearStaleThinkingBlocks(messages, 1);

    expect(cleared).toBe(1); // Only non-redacted thinking cleared
    const firstAssistantContent = messages[1]!.content as any[];
    expect(firstAssistantContent.length).toBe(2); // redacted_thinking + text
    expect(firstAssistantContent[0].type).toBe("thinking");
    expect(firstAssistantContent[0].redacted).toBe(true);
    expect(firstAssistantContent[1].type).toBe("text");
  });

  it("preserves text, tool_use, and image blocks in assistant messages", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "To be cleared" },
        { type: "text", text: "Response text" },
        { type: "tool_use", id: "tu_1", name: "bash", input: {} },
        { type: "image", source: { type: "base64", data: "abc" } },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [{ type: "text", text: "Latest" }] },
    ];

    const cleared = clearStaleThinkingBlocks(messages, 1);

    expect(cleared).toBe(1);
    const content = messages[1]!.content as any[];
    expect(content.length).toBe(3); // text + tool_use + image (thinking removed)
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("tool_use");
    expect(content[2].type).toBe("image");
  });

  it("preserves all thinking blocks within the keepWindow", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thought 1" },
        { type: "text", text: "Response 1" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thought 2" },
        { type: "text", text: "Response 2" },
      ]},
    ];

    // keepWindow = 5: all 2 assistant messages fit within window
    const cleared = clearStaleThinkingBlocks(messages, 5);

    expect(cleared).toBe(0);
    // Both messages should retain their thinking blocks
    expect((messages[1]!.content as any[]).length).toBe(2);
    expect((messages[3]!.content as any[]).length).toBe(2);
  });

  it("returns count of cleared blocks", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thought A" },
        { type: "thinking", thinking: "Thought B" },
        { type: "text", text: "Response 1" },
      ]},
      { role: "user", content: [{ type: "text", text: "Next" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Thought C" },
        { type: "text", text: "Response 2" },
      ]},
      { role: "user", content: [{ type: "text", text: "Last" }] },
      { role: "assistant", content: [
        { type: "text", text: "Response 3" },
      ]},
    ];

    // keepWindow = 1: first 2 assistants beyond window, 3rd within
    const cleared = clearStaleThinkingBlocks(messages, 1);

    // First assistant: 2 thinking blocks cleared, second assistant: 1 thinking cleared
    expect(cleared).toBe(3);
  });
});
