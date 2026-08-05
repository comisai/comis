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
import { clearStaleThinkingBlocks, stripTransientRecallFromHistory, stripReplayThinking, deferRecallToUncachedTail, stripTransientRecallFromResponsesInput, deferRecallToTrailingResponsesItem, stripReplayReasoningFromResponsesInput } from "./index.js";
import { clearStaleToolResults, COMPACTABLE_TOOL_NAMES } from "./tool-result-clearing.js";

/** A representative inline-recall block as envelope-wrapper prepends it (hybrid-memory-injector template). */
const recall = (content: string) =>
  `[Relevant context from memory: ${content} (recorded 2026-06-18)]\n`;
/** The stable per-turn envelope that follows the (transient) recall block. */
const envelope = (ts: string) =>
  `[System context]\n## Current Date & Time\n${ts}\n[End system context]\n\n`;

describe("clearStaleThinkingBlocks — clearing is sticky once sent", () => {
  // The fence guard protects a cached message from being stripped. But a message
  // is stripped BEFORE the fence reaches it, and once the fence advances past it
  // the guard restores its thinking — mutating content already sent in stripped
  // form. Live: 3 of 5 cached-region mutations were exactly this, logged as
  // "block-count-changed … assistant|b1|t0 -> assistant|b2|t1|[thinking,text]".
  function makeMessages(): Array<Record<string, unknown>> {
    return [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a2" }] },
      { role: "user", content: [{ type: "text", text: "q3" }] },
      { role: "assistant", content: [{ type: "text", text: "a3" }] },
    ];
  }
  const thinkingCount = (msgs: Array<Record<string, unknown>>, idx: number) =>
    (msgs[idx]!.content as Array<Record<string, unknown>>).filter((b) => b.type === "thinking").length;

  it("does not restore thinking to a message it already stripped once the fence advances", () => {
    const key = "session-sticky-a";
    // Call 1: message 1 is beyond the fence, so it is stripped and sent that way.
    const first = makeMessages();
    clearStaleThinkingBlocks(first, 1, 0, key);
    expect(thinkingCount(first, 1)).toBe(0);

    // Call 2: the fence has advanced past message 1. Without stickiness the
    // guard protects it and the thinking block comes back.
    const second = makeMessages();
    clearStaleThinkingBlocks(second, 1, 3, key);
    expect(thinkingCount(second, 1)).toBe(0);
  });

  it("keeps a distinct session unaffected", () => {
    const first = makeMessages();
    clearStaleThinkingBlocks(first, 1, 0, "session-sticky-b");
    const other = makeMessages();
    // A different session has stripped nothing, so the fence guard still applies.
    clearStaleThinkingBlocks(other, 1, 3, "session-sticky-c");
    expect(thinkingCount(other, 1)).toBe(1);
  });

  it("still protects a cached message that was never stripped", () => {
    const msgs = makeMessages();
    clearStaleThinkingBlocks(msgs, 1, 3, "session-sticky-d");
    expect(thinkingCount(msgs, 1)).toBe(1);
  });
});

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
    const cleared = clearStaleThinkingBlocks(messages, 1, 0);

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
    const cleared = clearStaleThinkingBlocks(messages, 1, 0);

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

    const cleared = clearStaleThinkingBlocks(messages, 1, 0);

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
    const cleared = clearStaleThinkingBlocks(messages, 5, 0);

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
    const cleared = clearStaleThinkingBlocks(messages, 1, 0);

    // First assistant: 2 thinking blocks cleared, second assistant: 1 thinking cleared
    expect(cleared).toBe(3);
  });
});

describe("stripReplayThinking (pure) — replayed-thinking cache stability", () => {
  // Historical assistant messages are stripped so the cached form matches the durable LCD
  // form (zero historical thinking), which keeps the prefix byte-stable turn-over-turn.
  //
  // The LATEST assistant message is EXCLUDED. Anthropic rejects a request whose newest
  // assistant turn has had its thinking content altered:
  // `messages.<n>.content.<k>: 'thinking' or 'redacted_thinking' blocks in the latest
  // assistant message cannot be modified`. Stripping it produced that 400 live
  // (comis-moshe, 2026-08-01, amazon-bedrock) and the retry re-sent the same mutated shape,
  // so the turn ended in consecutive empty assistant responses and the user got silence.
  // Generation-time thinking is unaffected — this only strips messages being REPLAYED.

  it("strips historical replayed assistant messages but never the latest one", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "old reasoning" }, { type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "older reasoning" }, { type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "CURRENT reasoning" }, { type: "tool_use", id: "t2", name: "bash", input: {} }] },
    ];
    const stripped = stripReplayThinking(messages);
    expect(stripped).toBe(2); // idx 1 and 3 only — idx 5 is the latest assistant
    expect((messages[1]!.content as any[]).some(b => b.type === "thinking")).toBe(false);
    expect((messages[3]!.content as any[]).some(b => b.type === "thinking")).toBe(false);
    // The latest assistant (idx 5) keeps its thinking — modifying it is a provider 400.
    expect((messages[5]!.content as any[]).some(b => b.type === "thinking")).toBe(true);
    // Non-thinking blocks (tool_use, text) are preserved.
    expect((messages[5]!.content as any[]).some(b => b.type === "tool_use")).toBe(true);
  });

  it("strips the latest assistant message when it is NOT in an unclosed tool-use cycle", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "current" }, { type: "text", text: "a2" }] },
    ];
    // No tool_use on that turn, so the provider's "cannot be modified" window does not apply and
    // stripping now keeps the message byte-stable for the rest of the conversation.
    const stripped = stripReplayThinking(messages);
    expect(stripped).toBe(1);
    expect((messages[3]!.content as any[]).some(b => b.type === "thinking")).toBe(false);
    expect((messages[3]!.content as any[]).some(b => b.type === "text")).toBe(true);
  });

  it("an ordinary conversational turn is stripped immediately — no per-turn prefix drift", () => {
    // The regression this replaces: preserving the latest assistant turn UNCONDITIONALLY meant every
    // turn kept its thinking and lost it one turn later, mutating the cached prefix at a marching
    // index on EVERY turn. Measured live as block-count-changed at idx 19 -> 21 -> 23 -> 27 -> 29.
    const sig = (m: Record<string, unknown>) => {
      const c = m.content as Array<Record<string, unknown>> | undefined;
      return `${m.role}|b${Array.isArray(c) ? c.length : 0}`;
    };
    let msgs: Array<Record<string, unknown>> = [];
    const hist: string[][] = [];
    for (let n = 1; n <= 6; n++) {
      msgs = msgs.map(m => ({ ...m, content: (m.content as unknown[]).slice() }));
      msgs.push({ role: "user", content: [{ type: "text", text: `u${n}` }] });
      msgs.push({ role: "assistant", content: [
        { type: "thinking", thinking: `r${n}` }, { type: "text", text: `a${n}` },
      ] });
      stripReplayThinking(msgs);
      hist.push(msgs.map(sig));
    }
    const drift: string[] = [];
    for (let e = 1; e < hist.length; e++) {
      for (let i = 0; i < hist[e - 1]!.length; i++) {
        if (hist[e - 1]![i] !== hist[e]![i]) drift.push(`exec${e}->${e + 1} idx${i}: ${hist[e - 1]![i]} -> ${hist[e]![i]}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("keeps thinking on an assistant turn whose tool-use cycle is still UNCLOSED", () => {
    // The provider forbids altering the newest assistant turn's thinking only while that turn is
    // being continued — tool_use emitted, tool_result coming back. That is the 400 window.
    const msgs: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "live" },
        { type: "tool_use", id: "t1", name: "mcp__vendor--slow_report", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    stripReplayThinking(msgs);
    expect((msgs[1]!.content as any[]).some(b => b.type === "thinking")).toBe(true);
  });

  it("strips that same turn once a real user message CLOSES the cycle", () => {
    const msgs: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "live" },
        { type: "tool_use", id: "t1", name: "x", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "next question" }] },
    ];
    stripReplayThinking(msgs);
    expect((msgs[1]!.content as any[]).some(b => b.type === "thinking")).toBe(false);
  });

  it("preserves a redacted_thinking sibling on the latest assistant message (the live 400 shape)", () => {
    // Live shape: the newest assistant turn carried thinking + redacted_thinking + tool_use.
    // Removing the plain thinking block changed that turn's thinking content -> 400.
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "old" }, { type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "live" },
        { type: "redacted_thinking", data: "enc" },
        { type: "tool_use", id: "t1", name: "mcp__vendor--slow_report", input: {} },
      ] },
    ];
    const before = JSON.stringify(messages[3]);
    stripReplayThinking(messages);
    expect(JSON.stringify(messages[3])).toBe(before);
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

describe("deferRecallToUncachedTail (pure) — recall off the cached prefix", () => {
  // The current turn's recall block is cached (pi-ai marks the last user block) then
  // stripped when it goes historical → cached-prefix mutation. Fix: split the
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

  it("does not parse a rendered locale heading while deferring recall", () => {
    const currentTurn =
      "[System context]\n" +
      "## Reply Language for This Turn\n" +
      "The current user message is authoritative for reply language.\n" +
      "Current message dominant script: Latin.\n" +
      "[End system context]\n\n" +
      "Show the current system status.";
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: recall("הקשר צי בעברית") + currentTurn },
    ];

    expect(deferRecallToUncachedTail(messages)).toBe(1);
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.text).toContain("הקשר צי בעברית");
    expect(blocks[0]!.text).toContain("## Reply Language for This Turn");
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it("only operates on the LATEST user message, not historical ones", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: recall("old") + "old query" }] },
      { role: "assistant", content: "reply" },
      { role: "user", content: [{ type: "text", text: recall("new") + "new query", cache_control: { type: "ephemeral" } }] },
    ];
    expect(deferRecallToUncachedTail(messages)).toBe(1);
    // Historical user (idx 0) untouched (the history strip handles that one separately).
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

describe("stripTransientRecallFromResponsesInput (pure) — OpenAI Responses input recall strip", () => {
  // OpenAI auto-cache collapses to the instructions+tools floor when a historical user input
  // item's recall block is stripped inconsistently. Fix: strip recall from ALL historical
  // user-message items (keep the latest), so the Responses `input` prefix is byte-stable.
  const recallStr = (c: string) => `[Relevant context from memory: ${c} (recorded 2026-06-18)]\n`;

  it("strips recall from historical user items (array content), keeps the latest user item", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("old fact") + "first query" }] },
      { type: "reasoning", summary: [] },
      { type: "function_call", name: "bash", arguments: "{}" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("new fact") + "second query" }] },
    ];
    const stripped = stripTransientRecallFromResponsesInput(input);
    expect(stripped).toBe(1); // only the historical user item (idx 0)
    expect((input[0]!.content as any[])[0].text).toBe("first query"); // recall removed
    // latest user item (idx 4) KEEPS its recall (the model needs it this turn)
    expect((input[4]!.content as any[])[0].text).toContain("[Relevant context from memory: new fact");
    // tool/reasoning/function_call items are untouched (tool-safe)
    expect(input[1]!.type).toBe("reasoning");
    expect(input[2]!.type).toBe("function_call");
  });

  it("handles string content + is a no-op when only the latest user item has recall", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: "plain historical query" },
      { type: "message", role: "assistant", content: "reply" },
      { type: "message", role: "user", content: recallStr("fact") + "current query" },
    ];
    expect(stripTransientRecallFromResponsesInput(input)).toBe(0); // historical user has no recall
    expect(input[2]!.content).toContain("[Relevant context from memory:"); // latest keeps it
  });

  it("matches real pi-ai user items (role:'user', NO item-level type)", () => {
    const input: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "input_text", text: recallStr("old") + "q1" }] },
      { type: "function_call_output", output: "ok" },
      { role: "user", content: [{ type: "input_text", text: recallStr("new") + "q2" }] },
    ];
    expect(stripTransientRecallFromResponsesInput(input)).toBe(1); // historical idx0 cleaned
    expect((input[0]!.content as any[])[0].text).toBe("q1");
    expect((input[2]!.content as any[])[0].text).toContain("[Relevant context from memory: new"); // latest kept
  });

  it("does NOT touch non-message items or assistant items", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("a") + "q1" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("b") + "q2" }] },
    ];
    // idx 1 is the latest user → kept; idx 0 historical → stripped
    expect(stripTransientRecallFromResponsesInput(input)).toBe(1);
    expect((input[0]!.content as any[])[0].text).toBe("q1");
    expect((input[1]!.content as any[])[0].text).toContain("[Relevant context from memory: b");
  });
});

describe("deferRecallToTrailingResponsesItem (pure) — latest-item recall defer", () => {
  const recallStr = (c: string) => `[Relevant context from memory: ${c} (recorded 2026-06-18)]\n`;

  it("moves recall off the latest user item (array content) into a trailing user item", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first query" }] },
      { type: "function_call", name: "bash", arguments: "{}" },
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("teal") + "current query" }] },
    ];
    const before = input.length;
    expect(deferRecallToTrailingResponsesItem(input)).toBe(1);
    // latest user item is now CLEAN (byte-identical to its future historical form)
    expect((input[2]!.content as any[])[0].text).toBe("current query");
    expect((input[2]!.content as any[])[0].text).not.toContain("[Relevant context from memory:");
    // a trailing user item carrying the recall was appended (uncached tail)
    expect(input.length).toBe(before + 1);
    const trailing = input[input.length - 1]!;
    expect(trailing.type).toBe("message");
    expect(trailing.role).toBe("user");
    expect((trailing.content as any[])[0].text).toContain("[Relevant context from memory: teal");
    // tool item untouched
    expect(input[1]!.type).toBe("function_call");
  });

  it("handles string content", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: "old" },
      { type: "message", role: "user", content: recallStr("fact") + "new query" },
    ];
    expect(deferRecallToTrailingResponsesItem(input)).toBe(1);
    expect(input[1]!.content).toBe("new query");
    expect(input.length).toBe(3);
    expect(input[2]!.content).toContain("[Relevant context from memory: fact");
  });

  it("does not synthesize state from prompt headings in the trailing recall item", () => {
    const currentTurn =
      "[System context]\n" +
      "## Reply Language for This Turn\n" +
      "The current user message is authoritative for reply language.\n" +
      "Current message dominant script: Latin.\n" +
      "[End system context]\n\n" +
      "Show the current system status.";
    const input: Array<Record<string, unknown>> = [
      {
        role: "user",
        content: [{ type: "input_text", text: recallStr("הקשר צי בעברית") + currentTurn }],
      },
    ];

    expect(deferRecallToTrailingResponsesItem(input)).toBe(1);
    const trailing = input[input.length - 1]!;
    const blocks = trailing.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toContain("הקשר צי בעברית");
  });

  it("is a no-op when the latest user item has no recall", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("a") + "historical" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "plain current query" }] },
    ];
    expect(deferRecallToTrailingResponsesItem(input)).toBe(0);
    expect(input.length).toBe(2); // nothing appended
  });

  it("matches real pi-ai user items (role:'user', NO item-level type) — defers + trailing has no type", () => {
    // The live pi-ai Responses input emits user items WITHOUT an item-level `type` field
    // (only assistant items carry type:"message"). The defer must match by role alone.
    const input: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "input_text", text: recallStr("h1") + "q1" }] },
      { type: "function_call", name: "bash", arguments: "{}" },
      { type: "function_call_output", output: "ok" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { role: "user", content: [{ type: "input_text", text: recallStr("cur") + "current" }] },
    ];
    expect(deferRecallToTrailingResponsesItem(input)).toBe(1);
    expect((input[4]!.content as any[])[0].text).toBe("current"); // latest cleaned
    const trailing = input[input.length - 1]!;
    expect(trailing.role).toBe("user");
    expect(trailing.type).toBeUndefined(); // mirrors the user-item shape (no type)
    expect((trailing.content as any[])[0].text).toContain("[Relevant context from memory: cur");
    expect(input[1]!.type).toBe("function_call"); // tool items untouched
  });

  it("keeps recall inline (no defer) when removing it would empty the query", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: recallStr("only") },
    ];
    expect(deferRecallToTrailingResponsesItem(input)).toBe(0);
    expect(input.length).toBe(1);
  });

  it("strip-historical + defer-latest together leave NO recall on any non-trailing user item (prefix-stable)", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("h1") + "q1" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("h2") + "q2" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok2" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: recallStr("cur") + "q3" }] },
    ];
    stripTransientRecallFromResponsesInput(input); // historical h1, h2 cleaned
    deferRecallToTrailingResponsesItem(input);     // latest cur deferred to trailing
    // every original user item is now clean
    expect((input[0]!.content as any[])[0].text).toBe("q1");
    expect((input[2]!.content as any[])[0].text).toBe("q2");
    expect((input[4]!.content as any[])[0].text).toBe("q3");
    // recall lives only in the trailing item (the uncached tail)
    const trailing = input[input.length - 1]!;
    expect((trailing.content as any[])[0].text).toContain("[Relevant context from memory: cur");
    // no recall on any item except the trailing one
    const nonTrailing = input.slice(0, -1);
    for (const it of nonTrailing) {
      const txt = Array.isArray(it.content) ? (it.content as any[]).map(b => b.text ?? "").join("") : String(it.content ?? "");
      expect(txt).not.toContain("[Relevant context from memory:");
    }
  });
});

describe("stripReplayReasoningFromResponsesInput (pure) — reasoning replay strip", () => {
  it("removes contentless reasoning placeholders, keeps everything else (prefix-stable)", () => {
    const input: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "input_text", text: "q1" }] },
      { type: "reasoning", id: "rs_1", summary: [] },           // contentless -> strip
      { type: "function_call", name: "bash", arguments: "{}" },
      { type: "function_call_output", output: "ok" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { type: "reasoning", id: "rs_2", summary: [] },           // contentless -> strip
      { role: "user", content: [{ type: "input_text", text: "q2" }] },
    ];
    const removed = stripReplayReasoningFromResponsesInput(input);
    expect(removed).toBe(2);
    // no reasoning items remain
    expect(input.some(it => it.type === "reasoning")).toBe(false);
    // everything else preserved in order
    expect(input.map(it => it.type ?? it.role)).toEqual(["user", "function_call", "function_call_output", "message", "user"]);
  });

  it("strips reasoning items regardless of encrypted_content (byte-stable prefix)", () => {
    const input: Array<Record<string, unknown>> = [
      { type: "reasoning", id: "rs_a", encrypted_content: "gAAAA-encrypted-blob", summary: [] },
      { type: "reasoning", id: "rs_b", summary: [] },
      { type: "function_call", name: "x", arguments: "{}" },
    ];
    expect(stripReplayReasoningFromResponsesInput(input)).toBe(2);
    expect(input.length).toBe(1);
    expect(input[0]!.type).toBe("function_call");
  });

  it("is a no-op when there are no reasoning items", () => {
    const input: Array<Record<string, unknown>> = [
      { role: "user", content: "q" },
      { type: "function_call", name: "x", arguments: "{}" },
    ];
    expect(stripReplayReasoningFromResponsesInput(input)).toBe(0);
    expect(input.length).toBe(2);
  });
});

describe("clearStaleToolResults COMPACTABLE_TOOL_NAMES (pure) — emitted-name matching", () => {
  // The latent bug class: COMPACTABLE_TOOL_NAMES listing provider/SDK
  // names (file_read/glob/exec_tool/list_dir/search_files) that match NONE of Comis's
  // emitted builtin tool names. The emitted names (from the builtin registrations) are
  // read / grep / find / ls / exec / web_fetch / web_search — the set must hold the
  // emitted names or the heaviest results (read/find/ls/exec) are NEVER cleared.
  //
  // INVARIANT: clearStaleToolResults only ever rewrites role:"tool"
  // results whose tool_use_id maps to a COMPACTABLE name — NEVER user / assistant / thinking
  // / recalled-memory content, and never a non-compactable tool result (edit/write/message).

  const STALE = "X".repeat(1500); // > MICROCOMPACT_MIN_CONTENT_LENGTH (1000)
  const PLACEHOLDER = "[Stale tool result cleared: idle > TTL]";

  /**
   * Build a message array with a stale tool_result for `toolName` at an index OUTSIDE
   * the keepWindow, plus a recent (kept) grep result so keepWindow=1 exposes the target.
   * Layout: [user, assistant(tool_use target), tool(target result), user,
   *          assistant(tool_use recent grep), tool(recent grep result)]
   * keepWindow=1 protects only the last tool_result (the recent grep), exposing the target.
   */
  function msgsWithStaleResult(toolName: string, toolUseId: string): Array<Record<string, unknown>> {
    return [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }] },
      { role: "tool", tool_use_id: toolUseId, content: [{ type: "text", text: STALE }] },
      { role: "user", content: [{ type: "text", text: "More" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "recent_grep", name: "grep", input: {} }] },
      { role: "tool", tool_use_id: "recent_grep", content: [{ type: "text", text: "D".repeat(1500) }] },
    ];
  }

  // Each of these FAILS on the pre-patch set (read/find/ls/exec are absent → not cleared).
  for (const name of ["read", "find", "ls", "exec"]) {
    it(`clears a stale ${name} tool_result over the compactable window`, () => {
      const messages = msgsWithStaleResult(name, `tu_${name}`);
      const cleared = clearStaleToolResults(messages, 1, -1);
      expect(cleared).toBeGreaterThanOrEqual(1);
      // The stale target result (idx 2) is replaced by the byte-stable placeholder.
      expect((messages[2]!.content as any[])[0].text).toBe(PLACEHOLDER);
      // The recent grep result (idx 5, within keepWindow) is preserved.
      expect((messages[5]!.content as any[])[0].text).toBe("D".repeat(1500));
    });
  }

  it("grep / web_fetch / web_search remain compactable (the names that already matched)", () => {
    for (const name of ["grep", "web_fetch", "web_search"]) {
      const messages = msgsWithStaleResult(name, `tu_${name}`);
      const cleared = clearStaleToolResults(messages, 1, -1);
      expect(cleared).toBeGreaterThanOrEqual(1);
      expect((messages[2]!.content as any[])[0].text).toBe(PLACEHOLDER);
    }
  });

  it("COMPACTABLE_TOOL_NAMES is exactly the seven emitted names (dead names removed)", () => {
    expect([...COMPACTABLE_TOOL_NAMES].sort()).toEqual(
      ["exec", "find", "grep", "ls", "read", "web_fetch", "web_search"],
    );
    // The dead provider/SDK names must be gone (no alias, no backward-compat).
    for (const dead of ["glob", "file_read", "exec_tool", "list_dir", "search_files"]) {
      expect(COMPACTABLE_TOOL_NAMES.has(dead)).toBe(false);
    }
  });

  it("INVARIANT: never clears a NON-compactable tool result (edit/write/message)", () => {
    for (const name of ["edit", "write", "message"]) {
      const messages = msgsWithStaleResult(name, `tu_${name}`);
      const cleared = clearStaleToolResults(messages, 1, -1);
      // Only the recent grep is in keepWindow; the non-compactable target stays untouched.
      expect((messages[2]!.content as any[])[0].text).toBe(STALE);
      // (cleared counts only the kept-window-excluded compactable results — here, none.)
      expect(cleared).toBe(0);
    }
  });

  it("INVARIANT: never clears user / assistant / thinking content", () => {
    const bigUser = "U".repeat(2000);
    const bigAssistantText = "A".repeat(2000);
    const bigThinking = "T".repeat(2000);
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: bigUser }] },                                  // idx 0
      { role: "assistant", content: [
        { type: "thinking", thinking: bigThinking },
        { type: "text", text: bigAssistantText },
        { type: "tool_use", id: "tu_read", name: "read", input: {} },
      ] },                                                                                            // idx 1
      { role: "tool", tool_use_id: "tu_read", content: [{ type: "text", text: STALE }] },              // idx 2 (compactable, cleared)
      { role: "user", content: [{ type: "text", text: "More" }] },                                    // idx 3
      { role: "assistant", content: [{ type: "tool_use", id: "recent_grep", name: "grep", input: {} }] }, // idx 4
      { role: "tool", tool_use_id: "recent_grep", content: [{ type: "text", text: "D".repeat(1500) }] }, // idx 5 (kept)
    ];
    clearStaleToolResults(messages, 1, -1);
    // User content untouched.
    expect((messages[0]!.content as any[])[0].text).toBe(bigUser);
    // Assistant text + thinking untouched (clearStaleToolResults touches role:"tool" only).
    const a = messages[1]!.content as any[];
    expect(a.find(b => b.type === "thinking").thinking).toBe(bigThinking);
    expect(a.find(b => b.type === "text").text).toBe(bigAssistantText);
    // The read tool_result WAS cleared (it is compactable + outside the window).
    expect((messages[2]!.content as any[])[0].text).toBe(PLACEHOLDER);
  });
});

describe("clearStaleThinkingBlocks — unknown cache fence must fail SAFE", () => {
  // Live incident (comis-moshe, 2026-08-01): a short-turn Hebrew chat never met the
  // minTokens gap, so NO message breakpoint was ever placed ("Cache fence unset in
  // mature session" x6) and the fence stayed -1. Every fence guard is
  // `if (idx <= fenceIndex) continue`, which with fenceIndex=-1 protects NOTHING, so the
  // sliding keepWindow cleared thinking from one ALREADY-CACHED assistant message per turn
  // ("Unstable prefix detected" x25, firstDivergentIndex marching 3 -> 11 -> 19,
  // assistant|b3|t0 -> b2|t0). The cached prefix mutated every turn, so cache_read was 0 on
  // 38 of 71 calls and a ~190K-token cache_write was re-paid each turn: $30.64 of $32.22.
  //
  // Invariant: when the cached extent is UNKNOWN, already-sent content must be treated as
  // possibly-cached and left byte-stable.
  const A = (i: number) => ({
    role: "assistant",
    content: [{ type: "thinking", thinking: `reasoning ${i}` }, { type: "text", text: `a${i}` }],
  });
  const U = (i: number) => ({ role: "user", content: [{ type: "text", text: `u${i}` }] });
  const sig = (m: Record<string, unknown>) =>
    `${m.role}|b${Array.isArray(m.content) ? (m.content as unknown[]).length : 0}`;

  it("keeps already-sent assistant messages byte-stable across turns when the fence is unset", () => {
    const keepWindow = 3;
    let msgs: Array<Record<string, unknown>> = [];
    const seen: string[][] = [];

    // Each iteration is one EXECUTION: append a turn, then run the pass as production does.
    for (let turn = 1; turn <= 8; turn++) {
      msgs = [...msgs.map(m => ({ ...m, content: (m.content as unknown[]).slice() })), U(turn), A(turn)];
      clearStaleThinkingBlocks(msgs, keepWindow, -1); // -1 == fence unset / cached extent unknown
      seen.push(msgs.map(sig));
    }

    const drift: string[] = [];
    for (let e = 1; e < seen.length; e++) {
      const prev = seen[e - 1]!, cur = seen[e]!;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== cur[i]) drift.push(`turn${e}->${e + 1} idx${i}: ${prev[i]} -> ${cur[i]}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("still clears beyond the keep window once the cached extent is known", () => {
    const msgs: Array<Record<string, unknown>> = [
      U(1), A(1), U(2), A(2), U(3), A(3), U(4), A(4),
    ];
    // Fence at 1 == messages 0..1 are cached; 2.. are safe to clear.
    const cleared = clearStaleThinkingBlocks(msgs, 1, 1);
    expect(cleared).toBeGreaterThan(0);
    expect((msgs[1]!.content as Array<Record<string, unknown>>).some(b => b.type === "thinking")).toBe(true);
  });
});
