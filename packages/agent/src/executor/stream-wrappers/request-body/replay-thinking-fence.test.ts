// SPDX-License-Identifier: Apache-2.0
/**
 * `stripReplayThinking` must not mutate content that is already cached.
 *
 * LIVE (comis-moshe 2026-08-02): `thinking-cleared,block-count-changed` at idx 17 and 21. The
 * newest assistant in an open tool cycle keeps its thinking (the provider requires it there), so it
 * is CACHED in that form — and stripping it once a newer assistant arrives rewrites an already-sent
 * message, once per tool cycle.
 *
 * @module
 */

import { describe, expect, it } from "vitest";

import { stripReplayThinking } from "./tool-result-clearing.js";

const thinking = () => ({ type: "thinking", thinking: "deliberating" });
const text = (t: string) => ({ type: "text", text: t });

/** Historical assistants carrying thinking, then a trailing open tool cycle. */
function conversation() {
  return [
    { role: "user", content: [text("q1")] },
    { role: "assistant", content: [thinking(), text("a1")] },
    { role: "user", content: [text("q2")] },
    { role: "assistant", content: [thinking(), text("a2")] },
    { role: "user", content: [text("q3")] },
    { role: "assistant", content: [thinking(), { type: "tool_use", id: "t" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] },
  ] as Array<Record<string, unknown>>;
}

const thinkingAt = (msgs: Array<Record<string, unknown>>, i: number) =>
  (msgs[i]!.content as Array<Record<string, unknown>>).some(b => b.type === "thinking");

describe("stripReplayThinking fence-awareness", () => {
  it("leaves an already-cached assistant's thinking exactly as it was sent", () => {
    const msgs = conversation();
    // Fence covers indices 0..3 — that content is already in the provider's cache.
    stripReplayThinking(msgs, 3);
    expect(thinkingAt(msgs, 1)).toBe(true);
    expect(thinkingAt(msgs, 3)).toBe(true);
  });

  it("still strips ABOVE the fence, so the durable no-thinking form is what gets cached next", () => {
    const msgs = conversation();
    msgs.push({ role: "assistant", content: [thinking(), text("newer")] });
    stripReplayThinking(msgs, 3);
    // Index 5 sits above the fence and is no longer the newest — it strips.
    expect(thinkingAt(msgs, 5)).toBe(false);
  });

  it("keeps the provider-required thinking on the newest open tool cycle", () => {
    const msgs = conversation();
    stripReplayThinking(msgs, 3);
    expect(thinkingAt(msgs, 5)).toBe(true);
  });

  it("strips everywhere when no fence is set, preserving the previous contract", () => {
    const msgs = conversation();
    stripReplayThinking(msgs);
    expect(thinkingAt(msgs, 1)).toBe(false);
    expect(thinkingAt(msgs, 3)).toBe(false);
    expect(thinkingAt(msgs, 5)).toBe(true); // the open cycle is still preserved
  });
});
