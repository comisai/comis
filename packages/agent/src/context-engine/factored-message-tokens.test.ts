// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the SHARED factored per-message estimator (ISSUE #3).
 *
 * factoredMessageTokens is the single authority used by BOTH the pre-flight fit check
 * (lcd-preflight.ts) and the protected-fresh-tail bound (boundFreshTailTotalToResidual).
 * These tests pin: (1) the ASCII 3.5:1 form, (2) IN-01 multi-part/tool-result text
 * extraction (text ?? content per block, NOT summed), (3) TOK-01 dense-script inflation,
 * (4) messageText/factoredMessageTokens identity-by-construction (the factor input is the
 * same chars whose length is divided). The estimator-PARITY invariant (this == the
 * pre-flight's measure) is what removes the need for a fudge factor in the bound.
 */
import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText, factoredMessageTokens } from "./factored-message-tokens.js";
import { CHARS_PER_TOKEN_RATIO } from "./constants.js";

describe("factoredMessageTokens — the shared fresh-tail estimator", () => {
  it("string content: ASCII counts ceil(chars / CHARS_PER_TOKEN_RATIO) (factor 1.0)", () => {
    const text = "a".repeat(700); // pure ASCII → scriptTokenFactor 1.0
    const m = { role: "user", content: text } as AgentMessage;
    expect(factoredMessageTokens(m)).toBe(Math.ceil(700 / CHARS_PER_TOKEN_RATIO));
  });

  it("IN-01: array content sums each block's text ?? content (NOT text+content), via messageText", () => {
    const m = {
      role: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "toolResult", content: "world" }, // content fallback when no text
        { type: "image" }, // no text/content → contributes nothing
      ],
    } as unknown as AgentMessage;
    expect(messageText(m)).toBe("hello world");
    expect(factoredMessageTokens(m)).toBe(Math.ceil("hello world".length / CHARS_PER_TOKEN_RATIO));
  });

  it("TOK-01: a dense (Hebrew) message counts MORE tokens/char than the bare 3.5:1 form", () => {
    const hebrew = "שלום עולם זהו טקסט עברי ארוך מאוד לבדיקת הערכת אסימונים".repeat(10);
    const m = { role: "user", content: hebrew } as AgentMessage;
    // Dense-script factor > 1 → MORE tokens than the unfactored ceil(chars/3.5).
    expect(factoredMessageTokens(m)).toBeGreaterThan(Math.ceil(hebrew.length / CHARS_PER_TOKEN_RATIO));
  });

  it("empty / non-string non-array content → 0 tokens (fail-safe)", () => {
    expect(factoredMessageTokens({ role: "user", content: "" } as AgentMessage)).toBe(0);
    expect(factoredMessageTokens({ role: "user" } as AgentMessage)).toBe(0);
    expect(messageText({ role: "user", content: 42 } as unknown as AgentMessage)).toBe("");
  });
});
