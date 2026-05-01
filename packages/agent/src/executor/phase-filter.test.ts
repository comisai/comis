// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for phase-filter.ts — phase-aware text extraction.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { parsePhase, isVisibleTextBlock, getVisibleAssistantText } from "./phase-filter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sig(phase?: string): string {
  const payload: Record<string, unknown> = { v: 1, id: "msg_test" };
  if (phase) payload.phase = phase;
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// parsePhase
// ---------------------------------------------------------------------------

describe("parsePhase", () => {
  it("extracts commentary phase", () => {
    expect(parsePhase(sig("commentary"))).toBe("commentary");
  });

  it("extracts final_answer phase", () => {
    expect(parsePhase(sig("final_answer"))).toBe("final_answer");
  });

  it("returns undefined when no phase field", () => {
    expect(parsePhase(sig())).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(parsePhase(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parsePhase("")).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(parsePhase("{bad json")).toBeUndefined();
  });

  it("returns undefined for non-v1 signature", () => {
    expect(parsePhase(JSON.stringify({ v: 2, id: "x", phase: "commentary" }))).toBeUndefined();
  });

  it("returns undefined for non-string input", () => {
    expect(parsePhase(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isVisibleTextBlock
// ---------------------------------------------------------------------------

describe("isVisibleTextBlock", () => {
  it("rejects commentary blocks", () => {
    expect(isVisibleTextBlock({ type: "text", text: "narration", textSignature: sig("commentary") })).toBe(false);
  });

  it("accepts final_answer blocks", () => {
    expect(isVisibleTextBlock({ type: "text", text: "hi", textSignature: sig("final_answer") })).toBe(true);
  });

  it("accepts blocks with no signature", () => {
    expect(isVisibleTextBlock({ type: "text", text: "hi" })).toBe(true);
  });

  it("accepts blocks with signature but no phase", () => {
    expect(isVisibleTextBlock({ type: "text", text: "hi", textSignature: sig() })).toBe(true);
  });

  it("rejects non-text blocks", () => {
    expect(isVisibleTextBlock({ type: "thinking", thinking: "hmm" })).toBe(false);
  });

  it("rejects blocks with non-string text", () => {
    expect(isVisibleTextBlock({ type: "text", text: 42 })).toBe(false);
  });

  it("rejects null/undefined", () => {
    expect(isVisibleTextBlock(null)).toBe(false);
    expect(isVisibleTextBlock(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getVisibleAssistantText
// ---------------------------------------------------------------------------

describe("getVisibleAssistantText", () => {
  it("filters out commentary and returns only final_answer text", () => {
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning..." },
            { type: "text", text: "Reading workspace files.", textSignature: sig("commentary") },
            { type: "text", text: "", textSignature: sig("commentary") },
            { type: "text", text: "Hey! How can I help?", textSignature: sig("final_answer") },
          ],
        },
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("Hey! How can I help?");
    // Should NOT call SDK method when phase filtering activates
    expect(session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it("returns last-assistant visible text directly when no commentary blocks exist", () => {
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("Hello world");
    // Function must NOT delegate to SDK on the no-commentary path (260501-egj).
    expect(session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it("returns empty string when only commentary blocks exist", () => {
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "internal narration", textSignature: sig("commentary") },
          ],
        },
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("");
  });

  it("returns '' when messages is empty", () => {
    const sdk = vi.fn();
    const session = {
      messages: [],
      getLastAssistantText: sdk,
    };
    expect(getVisibleAssistantText(session)).toBe("");
    expect(sdk).not.toHaveBeenCalled();
  });

  it("returns '' when session has no messages property", () => {
    const sdk = vi.fn();
    const session = {
      getLastAssistantText: sdk,
    };
    expect(getVisibleAssistantText(session)).toBe("");
    expect(sdk).not.toHaveBeenCalled();
  });

  it("returns empty string when no messages and no SDK method", () => {
    expect(getVisibleAssistantText({})).toBe("");
  });

  it("skips aborted assistant messages with empty content", () => {
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
        },
        {
          role: "assistant",
          stopReason: "aborted",
          content: [],
        },
      ],
    };
    // Last non-aborted assistant has no commentary → returns its text directly
    // (no SDK delegation on the no-commentary path — 260501-egj).
    expect(getVisibleAssistantText(session)).toBe("first response");
    expect(session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it("filters commentary from the last assistant message only", () => {
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "old response" }],
        },
        { role: "user", content: [{ type: "text", text: "follow up" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking out loud", textSignature: sig("commentary") },
            { type: "text", text: "new response", textSignature: sig("final_answer") },
          ],
        },
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("new response");
  });

  it("handles mixed content types (thinking + text) without commentary", () => {
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "deep thought" },
            { type: "text", text: "visible answer" },
          ],
        },
      ],
    };
    // No commentary → returns text-block text directly via isVisibleTextBlock
    // (filters thinking, keeps text).
    expect(getVisibleAssistantText(session)).toBe("visible answer");
    expect(session.getLastAssistantText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getVisibleAssistantText — synthetic + empty-error filtering (260501-egj)
// ---------------------------------------------------------------------------

describe("getVisibleAssistantText — synthetic + empty-error filtering", () => {
  // Helpers — minimal plain-object fixtures matching the SDK shape.
  const make = (overrides: Record<string, unknown>) => ({
    role: "assistant",
    content: [],
    stopReason: "stop",
    model: "claude-sonnet-4-5",
    ...overrides,
  });
  const userMsg = (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  });
  const llmAssistant = (text: string) =>
    make({ content: [{ type: "text", text }] });
  const syntheticAssistant = (text: string) =>
    make({ model: "synthetic", content: [{ type: "text", text }] });
  const emptyErrorAssistant = (model = "qwen/qwen3-coder:free") =>
    make({ model, content: [], stopReason: "error" });
  const abortedEmptyAssistant = () =>
    make({ content: [], stopReason: "aborted" });

  it("returns '' when only assistant is synthetic-injected", () => {
    const session = {
      messages: [
        userMsg("hi"),
        syntheticAssistant("(daemon restarted to apply the change — continuing)"),
      ],
    };
    // No getLastAssistantText on session — confirms function does not depend on it.
    expect(getVisibleAssistantText(session)).toBe("");
  });

  it("skips synthetic and returns prior LLM assistant text", () => {
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        userMsg("hi"),
        llmAssistant("hello"),
        syntheticAssistant("(daemon restarted...)"),
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("hello");
    expect(session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it("skips empty-error assistant and returns prior LLM assistant text", () => {
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        userMsg("hi"),
        llmAssistant("hello"),
        emptyErrorAssistant(),
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("hello");
    expect(session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it("production-repro: synthetic + sysctx-user + empty-error → '' (260501-egj)", () => {
    // Exact JSONL shape from session 678314278~peer~678314278.jsonl (2026-05-01 07:10:18 UTC).
    // Before the fix this returned the 51-char synthetic placeholder, defeating the
    // candidateResponse === "" gate at executor-prompt-runner.ts:407 and preventing
    // 260501-cur's rate_limited branch from firing.
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        userMsg("Switch to openrouter Qwen3 Coder (free)"),
        syntheticAssistant("(daemon restarted to apply the change — continuing)"),
        {
          role: "user",
          content: "[system: daemon restarted to apply config change — continuing previous turn]",
        },
        emptyErrorAssistant("qwen/qwen3-coder:free"),
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("");
    expect(session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it("regression: aborted-empty filter still works", () => {
    const session = {
      messages: [
        userMsg("hi"),
        llmAssistant("hello"),
        abortedEmptyAssistant(),
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("hello");
  });

  it("commentary branch operates on filtered last assistant (synthetic skipped first)", () => {
    const sigPhase = (phase: string) =>
      JSON.stringify({ v: 1, id: "msg_x", phase });
    const session = {
      messages: [
        userMsg("hi"),
        syntheticAssistant("(daemon restarted...)"),
        make({
          content: [
            {
              type: "text",
              text: "internal narration",
              textSignature: sigPhase("commentary"),
            },
            {
              type: "text",
              text: "the answer",
              textSignature: sigPhase("final_answer"),
            },
          ],
        }),
      ],
    };
    // After synthetic filter, last assistant carries commentary → commentary branch fires.
    expect(getVisibleAssistantText(session)).toBe("the answer");
  });

  it("returns '' on empty messages array", () => {
    expect(getVisibleAssistantText({ messages: [] })).toBe("");
  });

  it("returns '' when all assistants are filtered (synthetic + empty-error only)", () => {
    const session = {
      messages: [
        userMsg("hi"),
        syntheticAssistant("(daemon restarted...)"),
        emptyErrorAssistant(),
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getVisibleAssistantText — cross-turn walk-back bound (260501-gyy)
// ---------------------------------------------------------------------------

describe("getVisibleAssistantText — cross-turn walk-back bound (260501-gyy)", () => {
  // Local helpers — re-defined inline (parallel to the 260501-egj block above)
  // so each describe block is independently readable. Byte-identical signatures.
  const make = (overrides: Record<string, unknown>) => ({
    role: "assistant",
    content: [],
    stopReason: "stop",
    model: "claude-sonnet-4-5",
    ...overrides,
  });
  const userMsg = (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  });
  const llmAssistant = (text: string) =>
    make({ content: [{ type: "text", text }] });
  const syntheticAssistant = (text: string) =>
    make({ model: "synthetic", content: [{ type: "text", text }] });
  const emptyErrorAssistant = (model = "qwen/qwen3-coder:free") =>
    make({ model, content: [], stopReason: "error" });

  it("production-repro: pre-restart claude scaffolding does NOT leak across synthetic-user boundary (260501-gyy)", () => {
    // Mirrors the production session JSONL shape from
    // /Users/.../678314278~peer~678314278.jsonl (2026-05-01 08:54 UTC).
    // Before FIX 1 the find() walk skipped synthetic + 2 toolResults +
    // empty-error and returned the 91-char Claude scaffolding "Great! The API
    // key is stored. Now let me switch your agent to use the Qwen 2.5 Coder
    // model:". After FIX 1 the user-message at index 5 (synthetic-user
    // continuation-replay) bounds the walk and the function returns "".
    const session = {
      getLastAssistantText: vi.fn(),
      messages: [
        userMsg("Switch to Qwen 2.5 Coder"),
        {
          role: "assistant",
          stopReason: "toolUse",
          model: "claude-sonnet-4-5",
          content: [
            {
              type: "text",
              text:
                "Great! The API key is stored. Now let me switch your agent to use the Qwen 2.5 Coder model:",
            },
            { type: "toolCall", toolCallId: "tc1", name: "providers_manage" },
            { type: "toolCall", toolCallId: "tc2", name: "gateway" },
          ],
        },
        { role: "tool", content: [{ type: "toolResult", toolCallId: "tc1", isError: false }] },
        { role: "tool", content: [{ type: "toolResult", toolCallId: "tc2", isError: false }] },
        syntheticAssistant("(daemon restarted to apply the change — continuing)"),
        {
          role: "user",
          content:
            "[system: daemon restarted to apply a config change. The result of your previous tool call is in the conversation above — react to it naturally...]",
        },
        emptyErrorAssistant("qwen/qwen-2.5-coder-32b-instruct:free"),
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("");
    expect(session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it("single-turn happy path: returns text of the only assistant in current turn", () => {
    const session = {
      messages: [userMsg("hi"), llmAssistant("hello")],
    };
    expect(getVisibleAssistantText(session)).toBe("hello");
  });

  it("returns '' when last message is user (no assistant produced yet in current turn)", () => {
    // Walk starts at index 1 (the user) → BOUND HIT immediately → undefined → "".
    const session = {
      messages: [llmAssistant("foo"), userMsg("hi")],
    };
    expect(getVisibleAssistantText(session)).toBe("");
  });

  it("multi-turn: returns most-recent-turn assistant text, NOT prior-turn assistant text", () => {
    const session = {
      messages: [
        userMsg("first"),
        llmAssistant("foo"),
        userMsg("second"),
        llmAssistant("bar"),
        syntheticAssistant("(restart)"),
      ],
    };
    // Walk: synthetic skipped → bar matches → returns "bar" (NOT "foo").
    expect(getVisibleAssistantText(session)).toBe("bar");
  });

  it("does NOT walk past user boundary even when current-turn assistants are all skipped", () => {
    // The user-message at index 2 bounds the walk; llmAssistant("foo") is
    // across the bound and is not returned.
    const session = {
      messages: [
        userMsg("first"),
        llmAssistant("foo"),
        userMsg("second"),
        emptyErrorAssistant(),
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("");
  });

  it("walks past aborted-empty within current turn but stops at user-bound", () => {
    // Aborted-empty skipped → user-bound at index 2 hits → undefined → "".
    const session = {
      messages: [
        userMsg("first"),
        llmAssistant("foo"),
        userMsg("second"),
        { role: "assistant", content: [], stopReason: "aborted", model: "claude-sonnet-4-5" },
      ],
    };
    expect(getVisibleAssistantText(session)).toBe("");
  });
});
