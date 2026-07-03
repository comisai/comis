// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pure compaction zone helpers extracted from llm-compaction.ts
 * (file-size invariant split). Behavior is
 * additionally exercised end-to-end through llm-compaction.test.ts — these
 * pins hold the helpers' contracts directly.
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  clampFactorText,
  estimateRangeChars,
  extendHeadForPairSafety,
} from "./compaction-zone-helpers.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

function assistantWithToolCall(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }],
  } as unknown as AgentMessage;
}

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

describe("extendHeadForPairSafety", () => {
  it("extends past an assistant toolCall and its trailing toolResults (no orphaned pairs)", () => {
    const messages = [user("q"), assistantWithToolCall(), toolResult("r1"), toolResult("r2"), user("next")];
    expect(extendHeadForPairSafety(messages, 1)).toBe(4);
  });

  it("leaves the boundary unchanged when the next message is not a tool-using assistant", () => {
    const messages = [user("a"), user("b"), user("c")];
    expect(extendHeadForPairSafety(messages, 1)).toBe(1);
  });
});

describe("estimateRangeChars", () => {
  it("sums chars over the half-open range only", () => {
    const messages = [user("aaaa"), user("bbbb"), user("cccc")];
    const firstTwo = estimateRangeChars(messages, 0, 2);
    const all = estimateRangeChars(messages, 0, 3);
    expect(firstTwo).toBeGreaterThan(0);
    expect(all).toBeGreaterThan(firstTwo);
    expect(estimateRangeChars(messages, 1, 1)).toBe(0);
  });
});

describe("clampFactorText", () => {
  it("returns string content verbatim", () => {
    expect(clampFactorText(user("ספר על docker"))).toBe("ספר על docker");
  });

  it("concatenates text/thinking blocks and stringified toolCall arguments", () => {
    const m = {
      role: "assistant",
      content: [
        { type: "text", text: "head" },
        { type: "thinking", thinking: "mid" },
        { type: "toolCall", id: "t", name: "x", arguments: { a: 1 } },
      ],
    } as unknown as AgentMessage;
    expect(clampFactorText(m)).toBe(`headmid${JSON.stringify({ a: 1 })}`);
  });

  it("returns empty string for non-array, non-string content", () => {
    const m = { role: "assistant", content: undefined } as unknown as AgentMessage;
    expect(clampFactorText(m)).toBe("");
  });
});
