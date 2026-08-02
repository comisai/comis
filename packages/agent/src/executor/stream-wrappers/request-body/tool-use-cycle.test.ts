// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for tool-use cycle detection — the window in which the provider forbids altering the newest
 * assistant turn's thinking blocks.
 */
import { describe, it, expect } from "vitest";
import { findLatestAssistantIndex, isToolResultCarrier, isUnclosedToolUseCycle } from "./tool-use-cycle.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const carrier = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });
const asstTool = (id: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "r" }, { type: "tool_use", id, name: "x", input: {} }] });
const asstText = (t: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "r" }, { type: "text", text: t }] });

describe("findLatestAssistantIndex", () => {
  it("returns the newest assistant index, or -1 when there is none", () => {
    expect(findLatestAssistantIndex([user("a"), asstText("b"), user("c")])).toBe(1);
    expect(findLatestAssistantIndex([user("a")])).toBe(-1);
  });
});

describe("isToolResultCarrier", () => {
  it("returns true for a tool_result-only user message and for a top-level tool message", () => {
    expect(isToolResultCarrier(carrier("t1"))).toBe(true);
    expect(isToolResultCarrier({ role: "tool", content: [] })).toBe(true);
  });

  it("rejects a real user turn and an empty message", () => {
    expect(isToolResultCarrier(user("hello"))).toBe(false);
    expect(isToolResultCarrier({ role: "user", content: [] })).toBe(false);
  });

  it("rejects a mixed message that also carries user text", () => {
    // A turn that says something as well as returning a result is a real user turn.
    expect(isToolResultCarrier({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "also, stop" }],
    })).toBe(false);
  });
});

describe("isUnclosedToolUseCycle", () => {
  it("is true while only tool_result carriers follow the tool_use turn", () => {
    const msgs = [user("u1"), asstTool("t1"), carrier("t1")];
    expect(isUnclosedToolUseCycle(msgs, 1)).toBe(true);
  });

  it("is true when the tool_use turn is last (first iteration, nothing returned yet)", () => {
    expect(isUnclosedToolUseCycle([user("u1"), asstTool("t1")], 1)).toBe(true);
  });

  it("is FALSE once a real user turn closes the cycle — the strip may then proceed", () => {
    const msgs = [user("u1"), asstTool("t1"), carrier("t1"), asstText("done"), user("next")];
    expect(isUnclosedToolUseCycle(msgs, 1)).toBe(false);
  });

  it("is FALSE for an assistant turn with no tool_use at all", () => {
    expect(isUnclosedToolUseCycle([user("u1"), asstText("a1")], 1)).toBe(false);
  });
});
