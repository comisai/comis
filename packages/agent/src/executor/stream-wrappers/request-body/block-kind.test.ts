// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the canonical content-block kind resolver.
 *
 * The request-body pipeline reads provider content blocks to decide what to strip, what to keep
 * byte-stable, and what to report as a cache-prefix mutation. Two wire shapes reach it: the
 * `type`-discriminated Anthropic Messages shape and the KEY-discriminated Bedrock Converse shape,
 * whose blocks carry no `type` field at all. A reader that only understands the first silently
 * classifies every Bedrock block as unknown.
 */
import { describe, it, expect } from "vitest";

import { blockKind, blockText, isThinkingBlock } from "./block-kind.js";

describe("blockKind", () => {
  it("returns the canonical kind for each Anthropic Messages block shape", () => {
    expect(blockKind({ type: "text", text: "hi" })).toBe("text");
    expect(blockKind({ type: "thinking", thinking: "r" })).toBe("thinking");
    expect(blockKind({ type: "redacted_thinking", data: "enc" })).toBe("redacted_thinking");
    expect(blockKind({ type: "tool_use", id: "t1", name: "x", input: {} })).toBe("tool_use");
    expect(blockKind({ type: "tool_result", tool_use_id: "t1" })).toBe("tool_result");
    expect(blockKind({ type: "image" })).toBe("image");
  });

  it("returns the canonical kind for each Bedrock Converse block shape", () => {
    // Bedrock blocks are key-discriminated and carry NO `type` field: the KEY is the kind.
    expect(blockKind({ text: "hi" })).toBe("text");
    expect(blockKind({ reasoningContent: { reasoningText: { text: "r", signature: "s" } } })).toBe("thinking");
    expect(blockKind({ toolUse: { toolUseId: "t1", name: "x", input: {} } })).toBe("tool_use");
    expect(blockKind({ toolResult: { toolUseId: "t1", content: [], status: "success" } })).toBe("tool_result");
    expect(blockKind({ cachePoint: { type: "default" } })).toBe("cache_marker");
    expect(blockKind({ image: { format: "png" } })).toBe("image");
  });

  it("returns the redacted kind for Bedrock encrypted reasoning", () => {
    expect(blockKind({ reasoningContent: { redactedContent: "enc" } })).toBe("redacted_thinking");
  });

  it("never reads a nested cachePoint type as the block's own kind", () => {
    // `{cachePoint:{type:"default"}}` has a nested `type` — resolving on it would report "default".
    expect(blockKind({ cachePoint: { type: "default" } })).not.toBe("default");
  });

  it("returns the tool_use kind for every canonical call-block alias", () => {
    for (const type of ["tool_use", "toolCall", "tool_call", "toolUse"]) {
      expect(blockKind({ type, id: "t1" })).toBe("tool_use");
    }
  });

  it("returns malformed for a non-object block and other for an unrecognised one", () => {
    expect(blockKind(null)).toBe("malformed");
    expect(blockKind(undefined)).toBe("malformed");
    expect(blockKind("raw")).toBe("malformed");
    expect(blockKind({ guardContent: {} })).toBe("other");
    expect(blockKind({})).toBe("other");
  });
});

describe("blockText", () => {
  it("returns the carried text for both wire shapes", () => {
    expect(blockText({ type: "text", text: "abc" })).toBe("abc");
    expect(blockText({ text: "abc" })).toBe("abc");
    expect(blockText({ type: "thinking", thinking: "xy" })).toBe("xy");
  });

  it("returns the reasoning text for a Bedrock reasoning block", () => {
    // Left unread, a reasoning block measures as zero-length and a thinking-driven prefix
    // mutation looks like a length-stable block-count change with no cause.
    expect(blockText({ reasoningContent: { reasoningText: { text: "deep" } } })).toBe("deep");
  });

  it("returns an empty string for a block carrying no text and for a malformed block", () => {
    expect(blockText({ toolUse: { toolUseId: "t1" } })).toBe("");
    expect(blockText({ cachePoint: { type: "default" } })).toBe("");
    expect(blockText(null)).toBe("");
  });

  it("never returns a structured object rendered as a string", () => {
    // `String(b.content)` on a tool_result yields "[object Object]" and pollutes length maths.
    expect(blockText({ type: "tool_result", content: [{ type: "text", text: "ok" }] })).not.toContain("[object");
  });
});

describe("isThinkingBlock", () => {
  it("returns true for reasoning in both wire shapes", () => {
    expect(isThinkingBlock({ type: "thinking", thinking: "r" })).toBe(true);
    expect(isThinkingBlock({ reasoningContent: { reasoningText: { text: "r" } } })).toBe(true);
  });

  it("returns false for redacted reasoning, which must survive replay", () => {
    // Redacted reasoning carries the encrypted signature the provider needs for continuity.
    expect(isThinkingBlock({ type: "redacted_thinking", data: "enc" })).toBe(false);
    expect(isThinkingBlock({ reasoningContent: { redactedContent: "enc" } })).toBe(false);
    expect(isThinkingBlock({ type: "thinking", thinking: "r", redacted: true })).toBe(false);
  });

  it("returns false for text and tool blocks in both wire shapes", () => {
    expect(isThinkingBlock({ type: "text", text: "hi" })).toBe(false);
    expect(isThinkingBlock({ text: "hi" })).toBe(false);
    expect(isThinkingBlock({ toolUse: { toolUseId: "t1" } })).toBe(false);
  });
});
