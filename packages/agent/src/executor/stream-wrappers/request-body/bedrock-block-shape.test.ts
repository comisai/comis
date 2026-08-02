// SPDX-License-Identifier: Apache-2.0
/**
 * Regression: the request-body pipeline must honour the Bedrock Converse block shape.
 *
 * Bedrock Converse content blocks are KEY-discriminated and carry no `type` field, so every
 * consumer that gated on `block.type` was inert whenever the served provider was Bedrock —
 * on a deployment whose only agent model was a Bedrock-hosted Claude, the entire replay-strip and
 * prefix-diagnostic layer did nothing.
 *
 * The load-bearing consequence is a permanent cache-prefix churn. The durable context store
 * reconstructs assistant messages WITHOUT reasoning, while the live SDK conversation still carries
 * it, so an assistant turn is sent as `[{reasoningContent},{text}]` on the turn it is generated and
 * as `[{text}]` once it is served from the store — a content-block count change at an
 * already-cached index, once per turn, at a marching index. `stripReplayThinking` exists to
 * collapse that difference and could not see the block.
 */
import { describe, it, expect } from "vitest";

import {
  clearStaleThinkingBlocks,
  deferRecallToUncachedTail,
  reorderContentForStablePrefix,
  stripReplayThinking,
  stripTransientRecallFromHistory,
} from "./tool-result-clearing.js";
import { classifyPrefixMutation, messageStructSig } from "./prefix-stability.js";
import { isToolResultCarrier, isUnclosedToolUseCycle } from "./tool-use-cycle.js";

/** Bedrock Converse assistant turn: reasoning + answer text. */
const bedrockAsst = (thinking: string, text: string) => ({
  role: "assistant",
  content: [
    { reasoningContent: { reasoningText: { text: thinking, signature: "sig" } } },
    { text },
  ] as Array<Record<string, unknown>>,
});

const bedrockUser = (text: string) => ({ role: "user", content: [{ text }] });
const blockOneText = (m: { content: unknown } | undefined) =>
  String((m?.content as Array<Record<string, unknown>>)[0]!.text ?? "");
const bedrockCarrier = (id: string) => ({
  role: "user",
  content: [{ toolResult: { toolUseId: id, content: [{ text: "ok" }], status: "success" } }],
});
const bedrockAsstCall = (id: string) => ({
  role: "assistant",
  content: [
    { reasoningContent: { reasoningText: { text: "r", signature: "sig" } } },
    { toolUse: { toolUseId: id, name: "x", input: {} } },
  ] as Array<Record<string, unknown>>,
});

describe("stripReplayThinking under the Bedrock Converse shape", () => {
  it("strips a reasoning block from a historical assistant turn", () => {
    const messages = [
      bedrockUser("q1"),
      bedrockAsst("deep reasoning", "answer one"),
      bedrockUser("q2"),
      bedrockAsst("more reasoning", "answer two"),
    ];

    expect(stripReplayThinking(messages)).toBe(2);
    // Only the answer text survives — matching the durable store's reconstructed form exactly,
    // which is what makes the cached prefix byte-stable turn over turn.
    expect(messages[1]!.content).toEqual([{ text: "answer one" }]);
    expect(messages[3]!.content).toEqual([{ text: "answer two" }]);
  });

  it("keeps reasoning on a newest assistant turn still inside an unclosed tool-use cycle", () => {
    const messages = [bedrockUser("q"), bedrockAsstCall("t1"), bedrockCarrier("t1")];

    expect(stripReplayThinking(messages)).toBe(0);
    expect(messages[1]!.content).toHaveLength(2);
  });

  it("preserves an encrypted Bedrock reasoning block, which replay may not drop", () => {
    const messages = [
      bedrockUser("q"),
      { role: "assistant", content: [{ reasoningContent: { redactedContent: "enc" } }, { text: "a" }] },
      bedrockUser("q2"),
      bedrockAsst("r", "b"),
    ];

    stripReplayThinking(messages);
    expect(messages[1]!.content).toHaveLength(2);
  });
});

describe("clearStaleThinkingBlocks under the Bedrock Converse shape", () => {
  it("clears reasoning from an assistant turn beyond the keep window and above the fence", () => {
    const messages = [
      bedrockUser("q1"),
      bedrockAsst("r1", "a1"),
      bedrockUser("q2"),
      bedrockAsst("r2", "a2"),
      bedrockUser("q3"),
      bedrockAsst("r3", "a3"),
    ];

    expect(clearStaleThinkingBlocks(messages, 1, 0)).toBe(2);
    expect(messages[1]!.content).toEqual([{ text: "a1" }]);
    expect(messages[3]!.content).toEqual([{ text: "a2" }]);
    // Within the keep window — untouched.
    expect(messages[5]!.content).toHaveLength(2);
  });
});

describe("tool-use cycle detection under the Bedrock Converse shape", () => {
  it("returns true for a toolResult-only Bedrock carrier message", () => {
    expect(isToolResultCarrier(bedrockCarrier("t1"))).toBe(true);
    expect(isToolResultCarrier(bedrockUser("hello"))).toBe(false);
  });

  it("returns true for a Bedrock toolUse turn whose results have not been closed by a user turn", () => {
    const messages = [bedrockUser("q"), bedrockAsstCall("t1"), bedrockCarrier("t1")];
    expect(isUnclosedToolUseCycle(messages, 1)).toBe(true);

    const closed = [...messages, bedrockUser("next")];
    expect(isUnclosedToolUseCycle(closed, 1)).toBe(false);
  });
});

/** The real injected form — the date-anchored terminator is what the extractor matches. */
const RECALL = "[Relevant context from memory: the preferred colour is teal (recorded 2026-08-02)]";

describe("inline-recall prefix stabilisers under the Bedrock Converse shape", () => {
  it("strips the transient recall block from a historical Bedrock user message", () => {
    // Left on history, the recall block makes a cached user message differ between requests — the
    // dominant turn-boundary re-write these stabilisers exist to prevent.
    const messages = [
      { role: "user", content: [{ text: `${RECALL}\n\nfirst question` }] },
      { role: "assistant", content: [{ text: "a1" }] },
      { role: "user", content: [{ text: `${RECALL}\n\nsecond question` }] },
    ];

    expect(stripTransientRecallFromHistory(messages)).toBe(1);
    expect(blockOneText(messages[0])).not.toContain("Relevant context from memory");
    // The latest user turn keeps it — it is functional input for the current turn.
    expect(blockOneText(messages[2])).toContain("Relevant context from memory");
  });

  it("defers the recall onto the uncached tail as a key-discriminated block", () => {
    const messages = [{ role: "user", content: [{ text: `${RECALL}\n\nthe question` }] }];

    expect(deferRecallToUncachedTail(messages)).toBe(1);
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    // A `{type:"text"}` block appended here carries no member Bedrock recognises and the provider
    // rejects the whole request.
    expect(blocks[1]).toEqual({ text: RECALL });
    expect(blocks[1]).not.toHaveProperty("type");
    expect(String(blocks[0]!.text).trim()).toBe("the question");
  });
});

describe("reorderContentForStablePrefix under the Bedrock Converse shape", () => {
  it("moves a Bedrock media block ahead of the text block", () => {
    const messages = [{ role: "user", content: [{ text: "caption" }, { image: { format: "png" } }] }];

    reorderContentForStablePrefix(messages);
    expect(messages[0]!.content).toEqual([{ image: { format: "png" } }, { text: "caption" }]);
  });
});

describe("messageStructSig under the Bedrock Converse shape", () => {
  it("counts a Bedrock reasoning block and names every block kind", () => {
    // Reading `b.type` directly pinned `t` at 0 and rendered both kinds as `unknown`, which is
    // exactly why a reasoning-driven mutation was twice attributed to something else.
    const sig = messageStructSig(bedrockAsst("deep", "answer"));
    expect(sig).toContain("|t1|");
    expect(sig).toContain("[thinking,text]");
    expect(sig).not.toContain("unknown");
  });

  it("counts reasoning text in the measured length", () => {
    // Left uncounted, dropping a reasoning block looked length-neutral — the signature that made
    // the live `b2 -> b1` at an identical `len1673` unexplainable.
    const withReasoning = messageStructSig(bedrockAsst("12345", "answer"));
    const withoutReasoning = messageStructSig({ role: "assistant", content: [{ text: "answer" }] });
    expect(withReasoning).toContain("|len11|");
    expect(withoutReasoning).toContain("|len6|");
  });

  it("names a Bedrock cache marker rather than reading its nested type", () => {
    const sig = messageStructSig({ role: "user", content: [{ text: "q" }, { cachePoint: { type: "default" } }] });
    expect(sig).toContain("[text,cache_marker]");
  });
});

describe("classifyPrefixMutation under the Bedrock Converse shape", () => {
  it("names a dropped Bedrock reasoning block as thinking-cleared", () => {
    // The live production signature pair this regression was written for: a block vanishes from an
    // already-cached assistant turn once it is served from the durable store instead of live memory.
    const prev = messageStructSig(bedrockAsst("deep reasoning", "answer"));
    const curr = messageStructSig({ role: "assistant", content: [{ text: "answer" }] });
    expect(classifyPrefixMutation(bedrockAsst("deep reasoning", "answer"), prev, curr))
      .toContain("thinking-cleared");
  });
});
