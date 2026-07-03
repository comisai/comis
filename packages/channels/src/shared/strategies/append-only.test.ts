// SPDX-License-Identifier: Apache-2.0
/**
 * AppendOnly strategy tests.
 *
 * Used by iMessage / LINE (no edit, no delete). Posts one opening status. On
 * success NO closing is posted (the windowed-edit "✓ done" branch is not
 * available on these channels — assert no extra failure-marker). On failure
 * exactly one "❌ {errorKind}" follow-up is posted.
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
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createAppendOnlyRenderer } from "./append-only.js";
import type { ActivityRenderActions } from "./actions.js";

type Call =
  | { op: "send"; text: string; id: string }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string };

function makeRecordingActions(): { actions: ActivityRenderActions; calls: Call[] } {
  const calls: Call[] = [];
  let seq = 0;
  const actions: ActivityRenderActions = {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      const id = `msg-${seq++}`;
      calls.push({ op: "send", text, id });
      return ok(id);
    },
    async edit(id, text): Promise<Result<void, ActivityRenderError>> {
      calls.push({ op: "edit", id, text });
      return ok(undefined);
    },
    async delete(id): Promise<Result<void, ActivityRenderError>> {
      calls.push({ op: "delete", id });
      return ok(undefined);
    },
  };
  return { actions, calls };
}

function makeFrame(frameSeq: number, label: string): ActivityRenderFrame {
  const ev = {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "s", agentId: "main", traceId: "t",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start", status: "running", kind: "tool", semanticPhase: "tool",
    defaultLabel: label,
  } as ActivityEvent;
  return {
    frameSeq,
    visibleEvents: [ev],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

const RECEIPT: FinalDeliveryReceipt = {
  ok: true, deliveredChunks: 1, lastChunkMessageId: "final", deliveredAtMs: 0,
};

/** The ascii theme's markers: bracketed pure-ASCII tags, zero emoji. */
const ASCII_MARKERS = { success: "[OK]", failure: "[ERR]", subagent: "[SUB]", running: "[..]" } as const;

describe("createAppendOnlyRenderer", () => {
  it("reports an AppendOnly identity that cannot edit or delete", () => {
    const { actions } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });
    expect(r.strategy).toBe("AppendOnly");
    expect(r.canEdit).toBe(false);
    expect(r.canDelete).toBe(false);
  });

  it("posts exactly one opening status and never re-posts on subsequent frames", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));

    const sends = calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    expect((sends[0] as Extract<Call, { op: "send" }>).text).toContain("step 1");
  });

  it("on success posts NO closing follow-up and no failure marker", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    const success: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    await r.finalize(success);

    // Only the opening status was ever sent; no ❌, no edit, no delete.
    expect(calls.filter((c) => c.op === "send")).toHaveLength(1);
    expect(calls.some((c) => c.op === "edit")).toBe(false);
    expect(calls.some((c) => c.op === "delete")).toBe(false);
    expect(calls.some((c) => c.op === "send" && (c as Extract<Call, { op: "send" }>).text.includes("❌"))).toBe(false);
  });

  it("on failure posts exactly one '❌ {errorKind}' follow-up", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "timeout",
      failedEvents: [],
    };
    await r.finalize(failure);

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    // Opening status + one closing ❌ follow-up = 2 sends.
    expect(sends).toHaveLength(2);
    const closing = sends[1];
    expect(closing.text).toContain("❌");
    expect(closing.text).toContain("timeout");
    // No second failure follow-up.
    expect(sends.filter((s) => s.text.includes("❌"))).toHaveLength(1);
  });

  it("append-only failure send omits the cross emoji under ascii", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions, markers: ASCII_MARKERS });

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({ kind: "failure", errorKind: "timeout", failedEvents: [] });

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    const closing = sends[sends.length - 1];
    expect(closing.text).toBe("[ERR] timeout");
    expect(closing.text).not.toContain("❌");
    expect(closing.text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("append-only failure send is byte-identical to the cross glyph when markers are omitted", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({ kind: "failure", errorKind: "timeout", failedEvents: [] });

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends[sends.length - 1].text).toBe("❌ timeout");
  });

  it("on a trivial turn emits no activity at all", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });
    const trivial: TurnOutcome = { kind: "success", trivial: true, delivery: RECEIPT };
    await r.finalize(trivial);
    expect(calls).toHaveLength(0);
  });

  // --- elapsed-time fallback wiring (elapsedMs threading) ---
  //
  // AppendOnly accepts an optional `clock?: ClockPort` and
  // captures `startedAtMs` on first apply(). Because AppendOnly posts
  // ONCE — later apply() calls are no-ops — the elapsed fallback only ever
  // fires on the FIRST visible frame. That is acceptable because the first
  // frame is exactly the moment when no plan has yet arrived from SEP (the
  // plan stream lands after the first model tick). The (running 0 s) on the
  // first send is the visible elapsed-time fallback for iMessage AND LINE.

  it("AppendOnly accepts a clock dep and threads elapsedMs into renderFrameText — opening send carries (running 0 s)", async () => {
    const clock = createFakeClock(1000);
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions, clock });

    await r.apply(makeFrame(0, "step 1"));

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain("(running 0 s)");
  });

  it("AppendOnly WITHOUT clock dep skips the elapsed fallback (graceful degrade)", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).not.toContain("(running");
  });

  it("AppendOnly with clock + frame.planSnapshot present: skips fallback (no double-display)", async () => {
    const clock = createFakeClock(1000);
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions, clock });

    const frameWithPlan: ActivityRenderFrame = {
      frameSeq: 0,
      visibleEvents: [{
        schemaVersion: 1,
        activityId: "11111111-1111-1111-1111-111111111111",
        sessionKey: "s", agentId: "main", traceId: "t",
        ts: "2026-05-26T00:00:00.000Z",
        phase: "start", status: "running", kind: "tool", semanticPhase: "tool",
        defaultLabel: "step 1",
      } as ActivityEvent],
      groupedActivityIds: {},
      planSnapshot: {
        entries: [{ id: "0", label: "a", status: "in_progress" }],
      },
      changeSet: { added: [], edited: [], removed: [] },
    };
    await r.apply(frameWithPlan);

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).not.toContain("(running");
  });
});
