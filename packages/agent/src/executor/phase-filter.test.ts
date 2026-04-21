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

  it("delegates to SDK when no commentary blocks exist", () => {
    const session = {
      getLastAssistantText: vi.fn().mockReturnValue("sdk response"),
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
    expect(getVisibleAssistantText(session)).toBe("sdk response");
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

  it("delegates to SDK when messages is empty", () => {
    const session = {
      messages: [],
      getLastAssistantText: () => "sdk fallback",
    };
    expect(getVisibleAssistantText(session)).toBe("sdk fallback");
  });

  it("delegates to SDK when no messages property", () => {
    const session = {
      getLastAssistantText: () => "sdk fallback",
    };
    expect(getVisibleAssistantText(session)).toBe("sdk fallback");
  });

  it("returns empty string when no messages and no SDK method", () => {
    expect(getVisibleAssistantText({})).toBe("");
  });

  it("skips aborted assistant messages with empty content", () => {
    const session = {
      getLastAssistantText: vi.fn().mockReturnValue("sdk text"),
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
    // Last non-aborted assistant has no commentary → delegates to SDK
    expect(getVisibleAssistantText(session)).toBe("sdk text");
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
      getLastAssistantText: vi.fn().mockReturnValue("visible answer"),
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
    // No commentary → delegates to SDK
    expect(getVisibleAssistantText(session)).toBe("visible answer");
  });
});
