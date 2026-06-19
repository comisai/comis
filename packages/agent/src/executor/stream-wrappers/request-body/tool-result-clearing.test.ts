// SPDX-License-Identifier: Apache-2.0
/**
 * Pure-function tests for tool-result-clearing.ts.
 *
 * Hosts the pure-function describes that test `clearStaleThinkingBlocks`
 * directly. Integration tests that wire through createRequestBodyInjector
 * remain in factory.test.ts because they exercise the full pipeline
 * (clearStaleToolResults + the microcompact trigger).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { clearStaleThinkingBlocks, stripTransientRecallFromHistory, stripReplayThinking, deferRecallToUncachedTail } from "./index.js";

/** A representative inline-recall block as envelope-wrapper prepends it (hybrid-memory-injector template). */
const recall = (content: string) =>
  `[Relevant context from memory: ${content} (recorded 2026-06-18)]\n`;
/** The stable per-turn envelope that follows the (transient) recall block. */
const envelope = (ts: string) =>
  `[System context]\n## Current Date & Time\n${ts}\n[End system context]\n\n`;

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

describe("stripReplayThinking (pure) — cache break #C1/#C2", () => {
  // Thinking blocks are cached in-memory WITH thinking on the active tool cycle (the
  // last assistant in the outgoing request, kept by the earlier C-FIX-6 design), but
  // the LCD (parts-codec F3) reconstructs assistant messages WITHOUT thinking. So the
  // active assistant is cached WITH thinking and re-sent WITHOUT it the next call (when
  // it becomes historical and gets stripped) → the cached prefix mutates → cache-read
  // collapse on thinking-heavy (coding) turns, re-written every turn boundary.
  //
  // cache #C2 (2026-06-19): the residual collapse was the keep-LAST exception itself —
  // it cached one assistant WITH thinking that the next call always strips. Fix: strip
  // thinking from EVERY replayed assistant message (no keep-last exception), making the
  // cached form byte-identical to the durable LCD form (zero historical thinking).
  // Anthropic tolerates a tool-use assistant with no thinking block as the active cycle
  // (validated live: zero 400s, correct multi-step coding, total cache-read +5%, write -38%).
  // Generation-time thinking is unaffected — this only strips the messages being REPLAYED.

  it("strips thinking from ALL replayed assistant messages, including the last (active) one", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "old reasoning" }, { type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "older reasoning" }, { type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "CURRENT reasoning" }, { type: "tool_use", id: "t2", name: "bash", input: {} }] },
    ];
    const stripped = stripReplayThinking(messages);
    expect(stripped).toBe(3); // idx 1, 3, AND 5 (the active assistant too)
    expect((messages[1]!.content as any[]).some(b => b.type === "thinking")).toBe(false);
    expect((messages[3]!.content as any[]).some(b => b.type === "thinking")).toBe(false);
    // The LAST/active assistant (idx 5) is ALSO stripped — no keep-last exception.
    expect((messages[5]!.content as any[]).some(b => b.type === "thinking")).toBe(false);
    // Non-thinking blocks (tool_use, text) are preserved.
    expect((messages[5]!.content as any[]).some(b => b.type === "tool_use")).toBe(true);
  });

  it("strips thinking even when only the last assistant message has it", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "current" }, { type: "text", text: "a2" }] },
    ];
    const stripped = stripReplayThinking(messages);
    expect(stripped).toBe(1);
    expect((messages[3]!.content as any[]).some(b => b.type === "thinking")).toBe(false);
    expect((messages[3]!.content as any[]).some(b => b.type === "text")).toBe(true);
  });

  it("no-op on a conversation with no thinking blocks (echo-style tool turns)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    expect(stripReplayThinking(messages)).toBe(0);
  });
});

describe("stripTransientRecallFromHistory (pure)", () => {
  // The inline RAG block is TRANSIENT (per-turn, query-varying) and must not live
  // in the CACHED PREFIX, or it mutates the prefix every request → cache miss.
  // It is kept ONLY on the latest user message (current turn, uncached tail) for
  // attention; stripped from every historical user message. (Mirrors the
  // LCD-ingest strip — the store/prefix must hold the actual conversation, not
  // the per-turn recall.)

  it("strips the leading recall block from a historical user message (string content)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: recall("cat facts") + envelope("2026-06-18T16:14:38.874Z") + "One fact about cats" },
      { role: "assistant", content: "A cat's nose print is unique." },
      { role: "user", content: recall("echo step-1") + envelope("2026-06-18T16:15:00.000Z") + "Run echo step-1" },
    ];

    const stripped = stripTransientRecallFromHistory(messages);

    expect(stripped).toBe(1); // only the historical (index 0) user message
    // Historical message: recall gone, stable envelope + text intact
    expect(messages[0]!.content).toBe(envelope("2026-06-18T16:14:38.874Z") + "One fact about cats");
    // Latest user message: recall KEPT (current-turn attention, uncached tail)
    expect(messages[2]!.content).toBe(recall("echo step-1") + envelope("2026-06-18T16:15:00.000Z") + "Run echo step-1");
  });

  it("strips from the first text block of a historical user message (array content)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [
        { type: "text", text: recall("cat facts") + envelope("2026-06-18T16:14:38.874Z") + "One fact about cats" },
      ]},
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: recall("now") + "current question" }] },
    ];

    const stripped = stripTransientRecallFromHistory(messages);

    expect(stripped).toBe(1);
    expect((messages[0]!.content as any[])[0].text).toBe(envelope("2026-06-18T16:14:38.874Z") + "One fact about cats");
    // latest kept
    expect((messages[2]!.content as any[])[0].text).toBe(recall("now") + "current question");
  });

  it("leaves messages without a recall block untouched", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: envelope("2026-06-18T16:14:38.874Z") + "plain question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "latest" },
    ];

    const stripped = stripTransientRecallFromHistory(messages);

    expect(stripped).toBe(0);
    expect(messages[0]!.content).toBe(envelope("2026-06-18T16:14:38.874Z") + "plain question");
  });

  it("is a no-op when there is only one user message (nothing historical)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: recall("x") + "only turn" },
    ];

    const stripped = stripTransientRecallFromHistory(messages);

    expect(stripped).toBe(0);
    expect(messages[0]!.content).toBe(recall("x") + "only turn"); // current turn keeps recall
  });
});

describe("deferRecallToUncachedTail (pure) — cache #C4", () => {
  // The current turn's recall block is cached (pi-ai marks the last user block) then
  // stripped when it goes historical (C-FIX-3) → cached-prefix mutation. Fix: split the
  // recall out of the cache-marked query block and append it as a SEPARATE trailing block
  // with NO cache_control, so it rides the uncached tail (visible to the model, never cached).

  it("splits recall off the cache-marked query block into a trailing UNCACHED block", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "assistant", content: "prior" },
      { role: "user", content: [
        // pi-ai marked the last block (query + prepended recall) with cache_control.
        { type: "text", text: recall("teal is my favorite color") + "What did I say my favorite color was?", cache_control: { type: "ephemeral" } },
      ] },
    ];
    const deferred = deferRecallToUncachedTail(messages);
    expect(deferred).toBe(1);
    const blocks = messages[1]!.content as Array<Record<string, unknown>>;
    expect(blocks.length).toBe(2);
    // Query block: recall removed, cache_control PRESERVED → stays cached + byte-stable.
    expect(blocks[0]!.text).toBe("What did I say my favorite color was?");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    // Trailing recall block: present (model still sees it) but NO cache_control (uncached tail).
    expect(blocks[1]!.text).toBe("[Relevant context from memory: teal is my favorite color (recorded 2026-06-18)]");
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it("handles string content (converts to query block + trailing recall block)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: recall("a fact") + "the query" },
    ];
    expect(deferRecallToUncachedTail(messages)).toBe(1);
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks.map(b => b.text)).toEqual(["the query", "[Relevant context from memory: a fact (recorded 2026-06-18)]"]);
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it("only operates on the LATEST user message, not historical ones", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: recall("old") + "old query" }] },
      { role: "assistant", content: "reply" },
      { role: "user", content: [{ type: "text", text: recall("new") + "new query", cache_control: { type: "ephemeral" } }] },
    ];
    expect(deferRecallToUncachedTail(messages)).toBe(1);
    // Historical user (idx 0) untouched (C-FIX-3 handles that one separately).
    expect((messages[0]!.content as Array<Record<string, unknown>>).length).toBe(1);
    // Latest user (idx 2) split into query + trailing recall.
    expect((messages[2]!.content as Array<Record<string, unknown>>).length).toBe(2);
  });

  it("no-op when the latest user message has no recall block", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "just a plain query", cache_control: { type: "ephemeral" } }] },
    ];
    expect(deferRecallToUncachedTail(messages)).toBe(0);
    expect((messages[0]!.content as Array<Record<string, unknown>>).length).toBe(1);
  });
});
