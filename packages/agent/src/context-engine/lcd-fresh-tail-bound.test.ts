// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the extracted fresh-tail bounding module (B-8 + Issue-1).
 * The end-to-end behavior (assembly-level brick fix, A1/A2 invariants) is
 * pinned in lcd-assembler.test.ts; this file pins the module's own contract:
 * the cap math and the per-role bounding mechanics.
 */
import { describe, it, expect, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { computeFreshTailCapChars, boundFreshTailMessages, boundProtectedFreshTail } from "./lcd-fresh-tail-bound.js";
import { factoredMessageTokens } from "./factored-message-tokens.js";
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

// ---------------------------------------------------------------------------
// ISSUE #3b: boundProtectedFreshTail — residual = window − S − FLOOR headroom −
// preamble, using the model's ACTUAL reasoningStyle (the value the pre-flight throws
// against). A native model reserves the native "low" floor (1792); a none model 768.
// ---------------------------------------------------------------------------
function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() };
}
function bigTail(): AgentMessage[] {
  const t: AgentMessage[] = [];
  for (let i = 0; i < 12; i++) {
    t.push({ role: "user", content: `q${i} `.repeat(500) } as AgentMessage);
    t.push({ role: "assistant", content: [{ type: "text", text: `a${i} `.repeat(500) }] } as unknown as AgentMessage);
  }
  return t;
}

describe("boundProtectedFreshTail — native vs none floor headroom (ISSUE #3b)", () => {
  it("a NATIVE-reasoning model reserves the native floor (1792): trims the tail to window − S − 1792", () => {
    const logger = makeLogger();
    const W = 8_192, S = 1_145;
    const tail = bigTail();
    const bounded = boundProtectedFreshTail(tail, {
      effectiveWindow: W, systemTokens: S, reasoningStyle: "native",
      minVisibleOutputTokens: undefined, freshTailPreambleTokens: 0,
      logger: logger as never, agentId: "a", sessionKey: "s",
    });
    const residualNative = W - S - 1_792; // 5255
    const factored = bounded.reduce((sum, m) => sum + factoredMessageTokens(m), 0);
    // Bounded to the NATIVE residual (allow one always-kept current step of slack).
    const oneStep = factoredMessageTokens(tail[0]!) + factoredMessageTokens(tail[1]!);
    expect(factored).toBeLessThanOrEqual(residualNative + oneStep);
    // The DEBUG logged the native floor headroom (the obs-loop proof).
    const call = logger.debug.mock.calls.find((c) => c[1] === "lcd protected fresh tail bounded to the pre-flight residual");
    expect((call?.[0] as { floorHeadroom?: number }).floorHeadroom).toBe(1_792);
    expect((call?.[0] as { reasoningStyle?: string }).reasoningStyle).toBe("native");
  });

  it("a NONE-reasoning model reserves only the visible floor (768): a LARGER residual than native", () => {
    const logger = makeLogger();
    const W = 8_192, S = 1_145;
    boundProtectedFreshTail(bigTail(), {
      effectiveWindow: W, systemTokens: S, reasoningStyle: "none",
      minVisibleOutputTokens: undefined, freshTailPreambleTokens: 0,
      logger: logger as never, agentId: "a", sessionKey: "s",
    });
    const call = logger.debug.mock.calls.find((c) => c[1] === "lcd protected fresh tail bounded to the pre-flight residual");
    expect((call?.[0] as { floorHeadroom?: number }).floorHeadroom).toBe(768);
    expect((call?.[0] as { freshTailResidual?: number }).freshTailResidual).toBe(W - S - 768); // 6279
  });

  it("an infinite window (frontier/mid) is a no-op — returns the same reference, no trim", () => {
    const logger = makeLogger();
    const tail = bigTail();
    const out = boundProtectedFreshTail(tail, {
      effectiveWindow: Infinity, systemTokens: 0, reasoningStyle: "native",
      minVisibleOutputTokens: undefined, freshTailPreambleTokens: 0,
      logger: logger as never, agentId: "a", sessionKey: "s",
    });
    expect(out).toBe(tail); // byte-identical reference
    expect(logger.debug).not.toHaveBeenCalled();
  });
});

describe("boundProtectedFreshTail — instrumentation + the live OpenAI growth repro (Fix C)", () => {
  // The live OpenAI gpt-5-nano @8192 shape: S=1145, native, residual ~5255. TINY turns
  // (a user Q + a short assistant A) that ACCUMULATE — the lead saw the tail GROW
  // 6493→8083→… because Fix C wasn't trimming. This drives boundProtectedFreshTail with
  // an over-residual multi-step tail and asserts the trim DOES reduce it ≤ the residual
  // and the per-step instrumentation is emitted.
  it("trims a growing multi-turn tail (small steps) below the native residual and logs the per-step breakdown", () => {
    const logger = makeLogger();
    const W = 8_192, S = 1_145;
    // 14 user+assistant turns; each ~430 factored tok → full tail ~12K ≫ residual 5255.
    const tail: AgentMessage[] = [];
    for (let i = 0; i < 14; i++) {
      tail.push({ role: "user", content: `turn ${i} question text here ` .repeat(75) } as AgentMessage);
      tail.push({ role: "assistant", content: [{ type: "text", text: `turn ${i} answer ` .repeat(75) }] } as unknown as AgentMessage);
    }
    const out = boundProtectedFreshTail(tail, {
      effectiveWindow: W, systemTokens: S, reasoningStyle: "native",
      minVisibleOutputTokens: undefined, freshTailPreambleTokens: 0,
      logger: logger as never, agentId: "a", sessionKey: "s",
    });
    const residual = W - S - 1_792; // 5255
    const outFactored = out.reduce((sum, m) => sum + factoredMessageTokens(m), 0);
    // Each step is small, so the trim CAN reduce the tail to ≤ residual (+ one kept step).
    const oneStep = factoredMessageTokens(tail[0]!) + factoredMessageTokens(tail[1]!);
    expect(outFactored).toBeLessThanOrEqual(residual + oneStep);
    // Instrumentation present: stepCount = 28 (14×2 non-toolResult msgs), dropped > 0.
    const call =
      logger.debug.mock.calls.find((c) => (c[0] as { step?: string }).step === "fresh-tail-bound") ??
      logger.warn.mock.calls.find((c) => (c[0] as { step?: string }).step === "fresh-tail-bound");
    expect(call, "fresh-tail-bound log must be emitted").toBeDefined();
    const p = call![0] as { stepCount: number; stepSizes: number[]; droppedSteps: number; freshTailResidual: number };
    expect(p.stepCount).toBe(28);
    expect(p.stepSizes.length).toBe(28); // NOT one giant step — grouping splits the turns
    expect(p.droppedSteps).toBeGreaterThan(0); // it actually trimmed
    expect(p.freshTailResidual).toBe(residual);
  });

  it("WARN fires when the protected tail CANNOT be trimmed below the residual (single oversized current turn)", () => {
    const logger = makeLogger();
    const W = 8_192, S = 1_145;
    const residual = W - S - 1_792; // 5255
    // A small older turn + a HUGE current turn that alone exceeds the residual → can't trim
    // below it (the last step is always kept) → the WARN (diagnosable-by-default) fires.
    const tail: AgentMessage[] = [
      { role: "user", content: "hi" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "hello" }] } as unknown as AgentMessage,
      { role: "user", content: "X".repeat(residual * 4) } as AgentMessage, // ~residual*4/3.5 ≫ residual
    ];
    boundProtectedFreshTail(tail, {
      effectiveWindow: W, systemTokens: S, reasoningStyle: "native",
      minVisibleOutputTokens: undefined, freshTailPreambleTokens: 0,
      logger: logger as never, agentId: "a", sessionKey: "s",
    });
    const warn = logger.warn.mock.calls.find((c) => c[1] === "lcd protected fresh tail STILL exceeds the residual after trimming");
    expect(warn, "the could-not-trim WARN must fire").toBeDefined();
    expect((warn![0] as { fitsResidual: boolean }).fitsResidual).toBe(false);
    expect((warn![0] as { errorKind: string }).errorKind).toBe("resource");
  });
});
