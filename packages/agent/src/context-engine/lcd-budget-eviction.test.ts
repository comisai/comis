// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD budget-eviction unit.
 *
 * {@link evictHistoryUnderBudget} is a PURE function over the evictable
 * history prefix (the assembler splits `history` from the protected `freshTail` at
 * the documented `lcd-assembler.ts` seam; this unit shrinks ONLY `history`). It
 * keeps the NEWEST whole steps that fit a token budget and drops the OLDEST,
 * NEVER splitting a `tool_use`/`tool_result` pair — it evicts whole STEPS.
 *
 * A step = an assistant (or a leading user/summary) message + the `toolResult`
 * messages immediately following it (the inseparable unit; a `tool_result`'s
 * tokens are bound to the assistant `tool_use` that produced it). The headline
 * invariants asserted here:
 *  - the kept array NEVER starts with an ORPHAN `toolResult` (no split pair),
 *  - when even the single newest step cannot fit, the result is EMPTY (never a
 *    partial step — the fresh tail still ships via the assembler),
 *  - the kept suffix is the NEWEST contiguous run that fits the budget,
 *  - the input array is NOT mutated (purity).
 *
 * No store, no LLM, no clock — the per-message token counts are SUPPLIED by the
 * caller (stored `tokenCount` for store history, `estimateMessageTokens`
 * for live), so the function never re-estimates.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, it, expect } from "vitest";
import { evictHistoryUnderBudget } from "./lcd-budget-eviction.js";

// ---------------------------------------------------------------------------
// Fixtures (mirrors lcd-assembler.test.ts message shapes)
// ---------------------------------------------------------------------------

const FIXED_CREATED_AT = 1000;

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: FIXED_CREATED_AT } as Message;
}

function assistantText(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "stop",
    timestamp: FIXED_CREATED_AT,
  } as unknown as Message;
}

function assistantToolCall(id: string, name: string, args: unknown): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "toolUse",
    timestamp: FIXED_CREATED_AT,
  } as unknown as Message;
}

function toolResult(id: string, name: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: FIXED_CREATED_AT,
  } as unknown as Message;
}

/** A {msg, tokens} entry — the eviction input element. */
function item(msg: Message, tokens: number): { msg: AgentMessage; tokens: number } {
  return { msg: msg as AgentMessage, tokens };
}

function roleOf(m: AgentMessage): string {
  return (m as unknown as { role: string }).role;
}

function textOf(m: AgentMessage): string {
  const c = (m as unknown as { content: unknown }).content;
  if (typeof c === "string") return c;
  const arr = c as { type: string; text?: string }[];
  return arr.find((b) => b.type === "text")?.text ?? "";
}

function toolCallId(m: AgentMessage): string | undefined {
  const c = (m as unknown as { content?: unknown }).content;
  if (!Array.isArray(c)) return undefined;
  const tc = (c as { type?: string; id?: string }[]).find((b) => b.type === "toolCall");
  return tc?.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evictHistoryUnderBudget", () => {
  it("under-budget evictable prefix is returned UNCHANGED (no eviction)", () => {
    const evictable = [
      item(userMsg("u0"), 10),
      item(assistantText("a0"), 10),
      item(userMsg("u1"), 10),
      item(assistantText("a1"), 10),
    ];
    // Sum = 40, budget 100 → everything fits.
    const out = evictHistoryUnderBudget(evictable, 100);
    expect(out.map(textOf)).toEqual(["u0", "a0", "u1", "a1"]);
  });

  it("budget exactly equal to the total keeps the WHOLE prefix", () => {
    const evictable = [
      item(userMsg("u0"), 10),
      item(assistantText("a0"), 10),
      item(userMsg("u1"), 10),
    ];
    // Sum = 30, budget exactly 30 → keep all (<=, not <).
    const out = evictHistoryUnderBudget(evictable, 30);
    expect(out.map(textOf)).toEqual(["u0", "a0", "u1"]);
  });

  it("over budget drops the OLDEST whole steps, keeps the NEWEST contiguous run that fits", () => {
    // Four single-message steps (user/assistant text alternating), each 10 tokens.
    const evictable = [
      item(userMsg("u0"), 10),
      item(assistantText("a0"), 10),
      item(userMsg("u1"), 10),
      item(assistantText("a1"), 10),
    ];
    // Budget 25 → newest-kept: a1(10)+u1(10)=20 fits; adding a0 → 30 > 25 stop.
    // Kept (original order) = [u1, a1].
    const out = evictHistoryUnderBudget(evictable, 25);
    expect(out.map(textOf)).toEqual(["u1", "a1"]);
  });

  it("a step = assistant tool_use + its toolResults is kept or dropped WHOLE (never split)", () => {
    // Step A (old): user(u0). Step B (newest): assistant(tu_1) + toolResult(tu_1).
    const evictable = [
      item(userMsg("u0"), 10),
      item(assistantToolCall("tu_1", "read", { path: "/a" }), 30),
      item(toolResult("tu_1", "read", "contents"), 30),
    ];
    // Budget 70 → newest step (assistant+result = 60) fits; adding u0 → 70 still
    // fits exactly. Kept = whole prefix.
    const out = evictHistoryUnderBudget(evictable, 70);
    expect(out.map(roleOf)).toEqual(["user", "assistant", "toolResult"]);

    // Budget 60 → newest step (60) fits; adding u0 → 70 > 60 stop. Kept = the
    // WHOLE newest step (assistant + its result), the user dropped — NOT a half step.
    const out2 = evictHistoryUnderBudget(evictable, 60);
    expect(out2.map(roleOf)).toEqual(["assistant", "toolResult"]);
    // The kept array's FIRST message is the assistant tool_use, never an orphan
    // toolResult.
    expect(roleOf(out2[0]!)).toBe("assistant");
    expect(toolCallId(out2[0]!)).toBe("tu_1");
  });

  it("the kept array NEVER starts with an orphan toolResult (no split pair)", () => {
    // Newest step is an assistant tool_use + TWO toolResults (multi-result step).
    const evictable = [
      item(userMsg("u0"), 10),
      item(assistantText("a0"), 10),
      item(assistantToolCall("tu_2", "grep", { q: "x" }), 50),
      item(toolResult("tu_2", "grep", "hit-1"), 40),
      item(toolResult("tu_2", "grep", "hit-2"), 40),
    ];
    // Budget 130 → newest step (assistant 50 + 40 + 40 = 130) fits exactly; adding
    // a0 → 140 > 130 stop. The boundary lands exactly on the step start, so the
    // result begins with the assistant tool_use — NOT an orphan toolResult.
    const out = evictHistoryUnderBudget(evictable, 130);
    expect(roleOf(out[0]!)).toBe("assistant");
    expect(toolCallId(out[0]!)).toBe("tu_2");
    // Both results for tu_2 are present (the whole step kept), and no result
    // appears without its preceding tool_use.
    const seenCalls = new Set<string>();
    for (const m of out) {
      if (roleOf(m) === "assistant") {
        const id = toolCallId(m);
        if (id) seenCalls.add(id);
      }
      if (roleOf(m) === "toolResult") {
        expect(seenCalls.has((m as unknown as { toolCallId: string }).toolCallId)).toBe(true);
      }
    }
    expect(out.filter((m) => roleOf(m) === "toolResult")).toHaveLength(2);
  });

  it("when even the single newest step cannot fit, returns EMPTY (never a partial step)", () => {
    // The newest step alone is an assistant tool_use (60) + result (60) = 120.
    const evictable = [
      item(userMsg("u0"), 10),
      item(assistantToolCall("tu_3", "read", {}), 60),
      item(toolResult("tu_3", "read", "big"), 60),
    ];
    // Budget 100 < the newest step's 120 → cannot fit one whole step → drop the
    // ENTIRE evictable prefix (the fresh tail still ships via the assembler).
    const out = evictHistoryUnderBudget(evictable, 100);
    expect(out).toEqual([]);
  });

  it("budget of 0 returns an EMPTY array (drop everything evictable)", () => {
    const evictable = [item(userMsg("u0"), 10), item(assistantText("a0"), 10)];
    expect(evictHistoryUnderBudget(evictable, 0)).toEqual([]);
  });

  it("a negative budget returns an EMPTY array (defensive; nothing fits)", () => {
    const evictable = [item(userMsg("u0"), 10)];
    expect(evictHistoryUnderBudget(evictable, -5)).toEqual([]);
  });

  it("an empty evictable prefix returns an empty array", () => {
    expect(evictHistoryUnderBudget([], 100)).toEqual([]);
  });

  it("the input array is NOT mutated (purity) and the return is a NEW array", () => {
    const evictable = [
      item(userMsg("u0"), 10),
      item(assistantText("a0"), 10),
      item(userMsg("u1"), 10),
      item(assistantText("a1"), 10),
    ];
    const before = [...evictable];
    const out = evictHistoryUnderBudget(evictable, 25);
    // Input length + element identity unchanged.
    expect(evictable).toHaveLength(4);
    expect(evictable).toEqual(before);
    for (let i = 0; i < before.length; i++) expect(evictable[i]).toBe(before[i]);
    // The return is a distinct array instance.
    expect(out).not.toBe(evictable as unknown as AgentMessage[]);
  });

  it("newest-kept is by POSITION, not by token size — a large newest message is kept over a smaller older one", () => {
    // The NEWEST message is large (90), the older ones are small (10 each). Budget
    // only fits the newest. Newest-kept ordering must keep the large newest, NOT
    // the cheaper older messages.
    const evictable = [
      item(userMsg("old-cheap-0"), 10),
      item(userMsg("old-cheap-1"), 10),
      item(assistantText("newest-expensive"), 90),
    ];
    // Budget 90 → newest (90) fits; adding old-cheap-1 → 100 > 90 stop.
    const out = evictHistoryUnderBudget(evictable, 90);
    expect(out.map(textOf)).toEqual(["newest-expensive"]);
  });

  it("keeps multiple whole steps when several fit, stopping at the first that would exceed", () => {
    // Steps: A=user(u0)+toolResult-less assistant baseline. Build 3 clean steps.
    // Step 1 (oldest): user(u0) 20. Step 2: assistant(a1) 20. Step 3 (newest): assistant(a2) 20.
    const evictable = [
      item(userMsg("u0"), 20),
      item(assistantText("a1"), 20),
      item(assistantText("a2"), 20),
    ];
    // Budget 45 → a2(20)+a1(20)=40 fits; adding u0 → 60 > 45 stop. Kept = [a1, a2].
    const out = evictHistoryUnderBudget(evictable, 45);
    expect(out.map(textOf)).toEqual(["a1", "a2"]);
  });
});
