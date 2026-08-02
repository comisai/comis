// SPDX-License-Identifier: Apache-2.0
/**
 * The preserved-thinking window must stay OUT of the cached prefix.
 *
 * LIVE (comis-moshe 2026-08-02): `cache_read` pinned at exactly 80,865 on every call with ~18k
 * re-created each time — only the zones before the preserved-thinking assistant ever hit.
 *
 * @module
 */

import { describe, expect, it } from "vitest";

import { deferPreservedThinkingToUncachedTail } from "./tool-result-clearing.js";

const marker = () => ({ type: "text", text: "x", cache_control: { type: "ephemeral" } });
const plain = (t: string) => ({ type: "text", text: t });

/** The live shape: … user, assistant(thinking + tool_use), user(tool_result) with a trailing marker. */
function trailingToolCycle() {
  return [
    { role: "user", content: [plain("q1")] },
    { role: "assistant", content: [plain("a1")] },
    { role: "user", content: [marker()] },
    { role: "assistant", content: [{ type: "thinking", thinking: "d" }, { type: "tool_use", id: "tu_9" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_9", cache_control: { type: "ephemeral" } }] },
  ] as Array<Record<string, unknown>>;
}

const markedIndices = (msgs: Array<Record<string, unknown>>) =>
  msgs.flatMap((m, i) =>
    Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some(b => b.cache_control != null || "cachePoint" in b)
      ? [i] : []);

describe("deferPreservedThinkingToUncachedTail", () => {
  it("removes the marker that would cache through the preserved-thinking assistant", () => {
    const msgs = trailingToolCycle();
    expect(markedIndices(msgs)).toEqual([2, 4]);
    expect(deferPreservedThinkingToUncachedTail(msgs)).toBe(1);
    // The earlier zone survives; nothing at or after the preserved assistant (index 3) is cached.
    expect(markedIndices(msgs)).toEqual([2]);
  });

  it("keeps the tool_result content itself, removing only the marker", () => {
    const msgs = trailingToolCycle();
    deferPreservedThinkingToUncachedTail(msgs);
    const tail = msgs[4]!.content as Array<Record<string, unknown>>;
    expect(tail.some(b => b.type === "tool_result")).toBe(true);
  });

  it("removes a Bedrock cachePoint block in the same window", () => {
    const msgs = [
      { role: "user", content: [marker()] },
      { role: "assistant", content: [{ type: "thinking", thinking: "d" }, { type: "tool_use", id: "t" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }, { cachePoint: { type: "default" } }] },
    ] as Array<Record<string, unknown>>;
    expect(deferPreservedThinkingToUncachedTail(msgs)).toBe(1);
    expect(markedIndices(msgs)).toEqual([0]);
  });

  it("keeps the trailing marker when it is the ONLY one — caching nothing is worse", () => {
    const msgs = [
      { role: "user", content: [plain("q")] },
      { role: "assistant", content: [{ type: "thinking", thinking: "d" }, { type: "tool_use", id: "t" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", cache_control: { type: "ephemeral" } }] },
    ] as Array<Record<string, unknown>>;
    expect(deferPreservedThinkingToUncachedTail(msgs)).toBe(0);
    expect(markedIndices(msgs)).toEqual([2]);
  });

  it("does nothing when no tool cycle is open, so an ordinary turn caches its tail", () => {
    const msgs = [
      { role: "user", content: [marker()] },
      { role: "assistant", content: [plain("done")] },
      { role: "user", content: [marker()] },
    ] as Array<Record<string, unknown>>;
    expect(deferPreservedThinkingToUncachedTail(msgs)).toBe(0);
    expect(markedIndices(msgs)).toEqual([0, 2]);
  });
});
