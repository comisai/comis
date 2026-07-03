// SPDX-License-Identifier: Apache-2.0
/**
 * LinePerEvent strategy tests (including the IRC line cap).
 *
 * Used by IRC (no edit, no delete, 512-char line cap). Emits one line per newly
 * surviving event; a line longer than 512 chars is truncated with "…". A closing
 * summary line is emitted: "✓ done · N steps · Xs" on success,
 * "[ERR] {errorKind}" on failure. No closing line on a trivial turn.
 */
import { describe, it, expect } from "vitest";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
  ActivityRenderError,
} from "@comis/core";
import type { ActivityStatusMarkers } from "@comis/core";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createLinePerEventRenderer } from "./line-per-event.js";
import type { ActivityRenderActions } from "./actions.js";

/** The locked `ascii` theme markers: every glyph is bracketed ASCII. */
const ASCII_MARKERS: ActivityStatusMarkers = {
  success: "[OK]",
  failure: "[ERR]",
  subagent: "[SUB]",
  running: "[..]",
};

function makeRecordingActions(): { actions: ActivityRenderActions; sent: string[] } {
  const sent: string[] = [];
  let seq = 0;
  const actions: ActivityRenderActions = {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      sent.push(text);
      return ok(`msg-${seq++}`);
    },
    async edit(): Promise<Result<void, ActivityRenderError>> {
      return ok(undefined);
    },
    async delete(): Promise<Result<void, ActivityRenderError>> {
      return ok(undefined);
    },
  };
  return { actions, sent };
}

function makeEvent(activityId: string, label: string): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId,
    sessionKey: "s", agentId: "main", traceId: "t",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress", status: "running", kind: "tool", semanticPhase: "tool",
    defaultLabel: label,
  } as ActivityEvent;
}

function makeFrame(
  frameSeq: number,
  events: readonly ActivityEvent[],
  added: readonly string[],
): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added, edited: [], removed: [] },
  };
}

const RECEIPT: FinalDeliveryReceipt = {
  ok: true, deliveredChunks: 1, lastChunkMessageId: "final", deliveredAtMs: 0,
};

describe("createLinePerEventRenderer", () => {
  it("reports a LinePerEvent identity that cannot edit or delete", () => {
    const { actions } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });
    expect(r.strategy).toBe("LinePerEvent");
    expect(r.canEdit).toBe(false);
    expect(r.canDelete).toBe(false);
  });

  it("emits exactly one line per newly added event", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });

    const e1 = makeEvent("a", "fetch logs");
    const e2 = makeEvent("b", "parse logs");
    await r.apply(makeFrame(0, [e1], ["a"]));
    await r.apply(makeFrame(1, [e1, e2], ["b"]));

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("fetch logs");
    expect(sent[1]).toContain("parse logs");
  });

  it("truncates a line longer than 512 chars with an ellipsis", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });

    const huge = "x".repeat(2000);
    await r.apply(makeFrame(0, [makeEvent("a", huge)], ["a"]));

    expect(sent).toHaveLength(1);
    expect(sent[0].length).toBeLessThanOrEqual(512);
    expect(sent[0].endsWith("…")).toBe(true);
  });

  it("emits a '✓ done · N steps' closing summary line on success", async () => {
    const { actions, sent } = makeRecordingActions();
    const clock = createFakeClock(0);
    const r = createLinePerEventRenderer({ actions, clock });

    await r.apply(makeFrame(0, [makeEvent("a", "step 1")], ["a"]));
    await r.apply(makeFrame(1, [makeEvent("a", "step 1"), makeEvent("b", "step 2")], ["b"]));
    clock.advance(1200);

    const success: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    await r.finalize(success);

    const closing = sent[sent.length - 1];
    expect(closing).toContain("✓ done");
    expect(closing).toContain("2 steps");
  });

  it("emits a '[ERR] {errorKind}' closing line on failure", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });

    await r.apply(makeFrame(0, [makeEvent("a", "step 1")], ["a"]));
    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "network",
      failedEvents: [],
    };
    await r.finalize(failure);

    const closing = sent[sent.length - 1];
    expect(closing).toContain("[ERR]");
    expect(closing).toContain("network");
  });

  it("emits no closing line on a trivial turn", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });
    const trivial: TurnOutcome = { kind: "success", trivial: true, delivery: RECEIPT };
    await r.finalize(trivial);
    expect(sent).toHaveLength(0);
  });

  it("emits a pure-ASCII success marker on the closing line under the ascii theme", async () => {
    const { actions, sent } = makeRecordingActions();
    const clock = createFakeClock(0);
    const r = createLinePerEventRenderer({ actions, clock, markers: ASCII_MARKERS });

    await r.apply(makeFrame(0, [makeEvent("a", "step 1")], ["a"]));
    clock.advance(800);
    const success: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    await r.finalize(success);

    const closing = sent[sent.length - 1];
    // The theme governs the MARKER glyph, not the IRC "·" layout separator (U+00B7
    // is theme-independent formatting present under every theme). Assert the
    // themed ASCII marker leads and the default check glyph "✓" (U+2713) is gone;
    // the marker prefix itself carries no non-ASCII codepoint (stricter than
    // Extended_Pictographic).
    const marker = closing.split(" done")[0];
    expect(marker).not.toMatch(/[^\x00-\x7F]/);
    expect(closing).not.toContain("✓");
    expect(closing.startsWith("[OK] done")).toBe(true);
  });

  it("emits a pure-ASCII failure closing line under the ascii theme markers", async () => {
    const { actions, sent } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions, markers: ASCII_MARKERS });

    await r.apply(makeFrame(0, [makeEvent("a", "step 1")], ["a"]));
    const failure: TurnOutcome = { kind: "failure", errorKind: "network", failedEvents: [] };
    await r.finalize(failure);

    const closing = sent[sent.length - 1];
    expect(closing).not.toMatch(/[^\x00-\x7F]/);
    expect(closing).toContain("[ERR]");
    expect(closing).toContain("network");
  });

  it("preserves the default check glyph on the success closing line when markers are absent", async () => {
    const { actions, sent } = makeRecordingActions();
    const clock = createFakeClock(0);
    const r = createLinePerEventRenderer({ actions, clock });

    await r.apply(makeFrame(0, [makeEvent("a", "step 1")], ["a"]));
    clock.advance(800);
    const success: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    await r.finalize(success);

    const closing = sent[sent.length - 1];
    // Byte-for-byte parity with the historical output: the literal check glyph stays.
    expect(closing).toContain("✓ done");
  });
});
