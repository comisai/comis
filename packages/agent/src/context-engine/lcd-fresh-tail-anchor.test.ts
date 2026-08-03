// SPDX-License-Identifier: Apache-2.0
/**
 * Fresh-tail anchoring tests.
 *
 * LIVE INCIDENT (comis-moshe 2026-08-02, Haiku 4.5): the fresh-tail start index is derived from the
 * live array's LENGTH, so a turn's tool loop marched it forward on every call and dropped messages
 * off the head of the prompt. Measured effect: `cache_read` 0 with ~101k cache creation re-paid per
 * call on Bedrock (0.0% hit ratio), ~16k per call on the native Anthropic path.
 *
 * @module
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearFreshTailAnchor,
  freshTailTurnKey,
  resetFreshTailAnchors,
  classifySynthesizedPlaceholders,
  resolveAnchoredFreshTailStart,
} from "./lcd-fresh-tail-anchor.js";

/** Tool results ride on user messages; only a REAL user turn opens a new turn. */
const isToolResultCarrier = (m: Record<string, unknown>): boolean =>
  Array.isArray(m.content)
  && (m.content as Array<Record<string, unknown>>).some(b => b.type === "tool_result" || "toolResult" in b);

const userTurn = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistantToolUse = () => ({ role: "assistant", content: [{ type: "tool_use", id: "t1" }] });
const toolResult = () => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] });

describe("freshTailTurnKey", () => {
  it("holds still across a turn's tool cycles", () => {
    const base = [userTurn("older"), { role: "assistant", content: [] }, userTurn("current turn")];
    const key = freshTailTurnKey(base, isToolResultCarrier);
    // Appending an assistant tool_use + its tool_result must NOT look like a new turn.
    const afterCycle = [...base, assistantToolUse(), toolResult()];
    expect(freshTailTurnKey(afterCycle, isToolResultCarrier)).toBe(key);
    const afterTwoCycles = [...afterCycle, assistantToolUse(), toolResult()];
    expect(freshTailTurnKey(afterTwoCycles, isToolResultCarrier)).toBe(key);
  });

  it("returns a different key when a genuinely new user turn arrives", () => {
    const first = [userTurn("current turn")];
    const second = [...first, { role: "assistant", content: [] }, userTurn("a new question")];
    expect(freshTailTurnKey(second, isToolResultCarrier)).not.toBe(
      freshTailTurnKey(first, isToolResultCarrier),
    );
  });

  it("distinguishes a REPEATED user message from the turn before it", () => {
    // A user can send the same text twice. Content identity would make the second "ok" inherit the
    // first one's anchor; the ordinal separates them.
    const first = [userTurn("ok")];
    const second = [userTurn("ok"), { role: "assistant", content: [] }, userTurn("ok")];
    expect(freshTailTurnKey(second, isToolResultCarrier)).not.toBe(
      freshTailTurnKey(first, isToolResultCarrier),
    );
  });

  it("re-derives when the conversation HEAD changed under an identical turn", () => {
    // Compaction replaces the head. Holding a boundary is only meaningful while the prefix it
    // protects is still the same prefix, so an identical trailing turn must not inherit the anchor.
    const before = [userTurn("original head"), assistantToolUse(), userTurn("same question")];
    const after = [userTurn("SUMMARY of prior conversation"), assistantToolUse(), userTurn("same question")];
    expect(freshTailTurnKey(after, isToolResultCarrier)).not.toBe(
      freshTailTurnKey(before, isToolResultCarrier),
    );
  });
});

describe("resolveAnchoredFreshTailStart", () => {
  const sessionKey = "tenant:agent:peer";
  /** A conversation whose messages are stable at every index (a turn only APPENDS). */
  const convo = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `m${i}` }],
  }));

  beforeEach(() => resetFreshTailAnchors());

  it("holds the boundary still while one turn's tool loop appends messages", () => {
    // Live shape: each tool cycle appends a pair, so the computed boundary marches forward.
    const computed = [4, 6, 8, 10, 12];
    const held = computed.map(c => resolveAnchoredFreshTailStart(sessionKey, "turn-A", c, convo));
    expect(held).toEqual([4, 4, 4, 4, 4]);
  });

  it("advances at a turn boundary so history still folds normally", () => {
    resolveAnchoredFreshTailStart(sessionKey, "turn-A", 4, convo);
    resolveAnchoredFreshTailStart(sessionKey, "turn-A", 10, convo);
    // A new turn re-derives the boundary — the window is kept still, never widened forever.
    expect(resolveAnchoredFreshTailStart(sessionKey, "turn-B", 12, convo)).toBe(12);
  });

  it("still lets the boundary move EARLIER within a turn", () => {
    // The in-flight coverage clamp widens the tail to carry unpersisted messages; suppressing that
    // would re-open the hole that swallowed a turn's own originating request.
    resolveAnchoredFreshTailStart(sessionKey, "turn-A", 8, convo);
    expect(resolveAnchoredFreshTailStart(sessionKey, "turn-A", 3, convo)).toBe(3);
    // ...and the earlier boundary is what is then held.
    expect(resolveAnchoredFreshTailStart(sessionKey, "turn-A", 9, convo)).toBe(3);
  });

  it("keeps sessions independent", () => {
    resolveAnchoredFreshTailStart("session-1", "turn-A", 4, convo);
    expect(resolveAnchoredFreshTailStart("session-2", "turn-A", 9, convo)).toBe(9);
    expect(resolveAnchoredFreshTailStart("session-1", "turn-A", 11, convo)).toBe(4);
  });

  it("passes the computed value through when there is no session or turn identity", () => {
    expect(resolveAnchoredFreshTailStart(undefined, "turn-A", 7, convo)).toBe(7);
    expect(resolveAnchoredFreshTailStart(sessionKey, undefined, 7, convo)).toBe(7);
  });

  it("re-derives when the message at the held boundary is no longer that message", () => {
    // An anchor must not outlive the prefix it protects: a turn key can repeat across genuinely
    // different arrays, and pinning a boundary into unrelated content would keep messages verbatim
    // that belong in history.
    resolveAnchoredFreshTailStart(sessionKey, "turn-A", 6, convo);
    const replaced = convo.map((m, i) =>
      i === 6 ? { role: "user", content: [{ type: "text", text: "DIFFERENT" }] } : m);
    expect(resolveAnchoredFreshTailStart(sessionKey, "turn-A", 12, replaced)).toBe(12);
  });

  it("re-derives after the anchor is cleared", () => {
    resolveAnchoredFreshTailStart(sessionKey, "turn-A", 4, convo);
    clearFreshTailAnchor(sessionKey);
    expect(resolveAnchoredFreshTailStart(sessionKey, "turn-A", 10, convo)).toBe(10);
  });
});

describe("resolveAnchoredFreshTailStart — cross-turn hysteresis", () => {
  const sessionKey = "tenant:agent:peer";
  const convo = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `m${i}` }],
  }));

  beforeEach(() => resetFreshTailAnchors());

  it("holds the boundary across turns that drift by only one message", () => {
    // LIVE: the boundary advanced once per TURN, re-writing the message zone every turn, so
    // cache_read never grew past the stable system prefix (pinned at exactly 80,865).
    resolveAnchoredFreshTailStart(sessionKey, "turn-1", 4, convo);
    const held = [2, 3, 4, 5, 6, 7].map((n, i) =>
      resolveAnchoredFreshTailStart(sessionKey, `turn-${n}`, 4 + i + 1, convo));
    expect(held).toEqual([4, 4, 4, 4, 4, 4]);
  });

  it("advances in ONE step once the drift is worth paying for", () => {
    resolveAnchoredFreshTailStart(sessionKey, "turn-1", 4, convo);
    // Drift of 8 crosses the threshold — the boundary jumps rather than creeping.
    expect(resolveAnchoredFreshTailStart(sessionKey, "turn-2", 12, convo)).toBe(12);
    // ...and the new position is then held again.
    expect(resolveAnchoredFreshTailStart(sessionKey, "turn-3", 13, convo)).toBe(12);
  });

  it("never advances mid-turn, however far the array grows", () => {
    resolveAnchoredFreshTailStart(sessionKey, "turn-1", 4, convo);
    // A long tool loop drifts well past the threshold; the boundary must still not move.
    expect(resolveAnchoredFreshTailStart(sessionKey, "turn-1", 30, convo)).toBe(4);
  });
});

describe("classifySynthesizedPlaceholders", () => {
  const MARK = "[tool result missing — synthesized placeholder]";
  const msg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

  it("attributes a placeholder below the seam to the evicted-history side", () => {
    const repaired = [msg("a"), msg(MARK), msg("b"), msg("c")];
    expect(classifySynthesizedPlaceholders(repaired, 3, MARK))
      .toEqual({ inHistory: 1, inFreshTail: 0, indices: [1] });
  });

  it("attributes a placeholder at or above the seam to the fresh-tail side", () => {
    const repaired = [msg("a"), msg("b"), msg(MARK)];
    expect(classifySynthesizedPlaceholders(repaired, 2, MARK))
      .toEqual({ inHistory: 0, inFreshTail: 1, indices: [2] });
  });

  it("counts the live shape: two placeholders in one assembly", () => {
    const repaired = [msg("a"), msg(MARK), msg("b"), msg(MARK), msg("c")];
    const out = classifySynthesizedPlaceholders(repaired, 3, MARK);
    expect(out.inHistory + out.inFreshTail).toBe(2);
  });

  it("reports nothing when the transcript needed no repair", () => {
    expect(classifySynthesizedPlaceholders([msg("a"), msg("b")], 1, MARK))
      .toEqual({ inHistory: 0, inFreshTail: 0, indices: [] });
  });
});
