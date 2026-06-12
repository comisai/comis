// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the extracted fresh-tail bounding module (B-8 + Issue-1).
 * The end-to-end behavior (assembly-level brick fix, A1/A2 invariants) is
 * pinned in lcd-assembler.test.ts; this file pins the module's own contract:
 * the cap math and the per-role bounding mechanics.
 */
import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { computeFreshTailCapChars, boundFreshTailMessages } from "./lcd-fresh-tail-bound.js";
import { LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS } from "./constants.js";

describe("computeFreshTailCapChars", () => {
  it("derives the cap from availableHistoryTokens (0.8 × H × 3.5 chars) on small windows", () => {
    // H = 20000 → 0.8 × 20000 × 3.5 = 56000 chars (below the 100K B-8 ceiling).
    expect(computeFreshTailCapChars(20_000)).toBe(56_000);
  });

  it("degrades to the historical 100K B-8 constant when H is huge (frontier/mid byte-identical)", () => {
    expect(computeFreshTailCapChars(500_000)).toBe(LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS);
  });

  it("never collapses below the 12K floor when H ≈ 0 (tiny messages must not be shredded)", () => {
    expect(computeFreshTailCapChars(0)).toBe(12_000);
    expect(computeFreshTailCapChars(100)).toBe(12_000);
  });
});

describe("boundFreshTailMessages", () => {
  function userString(text: string): AgentMessage {
    return { role: "user", content: text } as unknown as AgentMessage;
  }

  it("bounds an oversized STRING-content user message and restores the string shape", () => {
    const huge = "Z".repeat(50_000);
    const { freshTail, boundedMessages, charsRemoved } = boundFreshTailMessages(
      [userString(huge)],
      12_000,
    );
    const content = (freshTail[0] as unknown as { content: unknown }).content;
    expect(typeof content).toBe("string"); // shape preserved
    expect((content as string).length).toBeLessThan(huge.length);
    expect(content as string).toContain("truncated");
    expect((content as string).toLowerCase()).toContain("lossless");
    expect(boundedMessages).toBe(1);
    expect(charsRemoved).toBeGreaterThan(0);
  });

  it("returns messages below the cap referentially unchanged (A1 no-op)", () => {
    const small = userString("a normal question");
    const toolResult = {
      role: "toolResult",
      toolCallId: "tu_1",
      content: [{ type: "text", text: "small output" }],
    } as unknown as AgentMessage;
    const { freshTail, boundedMessages, boundedResults } = boundFreshTailMessages(
      [small, toolResult],
      12_000,
    );
    expect(freshTail[0]).toBe(small);
    expect(freshTail[1]).toBe(toolResult);
    expect(boundedMessages).toBe(0);
    expect(boundedResults).toBe(0);
  });

  it("bounds oversized toolResult block content and counts it as a result, not a message", () => {
    const tr = {
      role: "toolResult",
      toolCallId: "tu_big",
      content: [{ type: "text", text: "X".repeat(50_000) }],
    } as unknown as AgentMessage;
    const { freshTail, boundedResults, boundedMessages } = boundFreshTailMessages([tr], 12_000);
    const blocks = (freshTail[0] as unknown as { content: { text?: string }[] }).content;
    expect(blocks[0]!.text!.length).toBeLessThan(50_000);
    // toolCallId untouched (A2).
    expect((freshTail[0] as unknown as { toolCallId: string }).toolCallId).toBe("tu_big");
    expect(boundedResults).toBe(1);
    expect(boundedMessages).toBe(0);
  });

  it("passes non-text blocks (toolCall) through untouched while bounding sibling text blocks", () => {
    const call = { type: "toolCall", id: "tu_keep", name: "read", arguments: {} };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "Y".repeat(50_000) }, call],
    } as unknown as AgentMessage;
    const { freshTail } = boundFreshTailMessages([assistant], 12_000);
    const blocks = (freshTail[0] as unknown as { content: ({ type: string } & Record<string, unknown>)[] }).content;
    expect(blocks.find((b) => b.type === "toolCall")).toBe(call);
    expect((blocks.find((b) => b.type === "text") as { text: string }).text.length).toBeLessThan(
      50_000,
    );
  });

  it("leaves non-user/assistant/toolResult roles verbatim", () => {
    const system = { role: "system", content: "S".repeat(50_000) } as unknown as AgentMessage;
    const { freshTail, boundedMessages } = boundFreshTailMessages([system], 12_000);
    expect(freshTail[0]).toBe(system);
    expect(boundedMessages).toBe(0);
  });
});
