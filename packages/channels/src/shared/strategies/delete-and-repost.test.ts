// SPDX-License-Identifier: Apache-2.0
/**
 * DeleteAndRepost strategy tests.
 *
 * Used by Signal (no edit, has delete). Each render transition deletes the
 * previous activity message and posts a new one. On success the last activity
 * message is deleted after the answer lands; on failure the final ❌ message is
 * KEPT (the diagnostic trail).
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
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createDeleteAndRepostRenderer } from "./delete-and-repost.js";
import type { ActivityRenderActions } from "./actions.js";

type Call =
  | { op: "send"; text: string; id: string }
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
    async edit(): Promise<Result<void, ActivityRenderError>> {
      // DeleteAndRepost never edits.
      return ok(undefined);
    },
    async delete(id): Promise<Result<void, ActivityRenderError>> {
      calls.push({ op: "delete", id });
      return ok(undefined);
    },
  };
  return { actions, calls };
}

function makeEvent(label: string): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "s",
    agentId: "main",
    traceId: "t",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    defaultLabel: label,
  } as ActivityEvent;
}

function makeFrame(frameSeq: number, label: string): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: [makeEvent(label)],
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

describe("createDeleteAndRepostRenderer", () => {
  it("reports a DeleteAndRepost identity that can delete but not edit", () => {
    const { actions } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });
    expect(r.strategy).toBe("DeleteAndRepost");
    expect(r.canDelete).toBe(true);
    expect(r.canEdit).toBe(false);
  });

  it("deletes the previous activity message and posts a new one on each transition", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });

    await r.apply(makeFrame(0, "step 1")); // first: send only, nothing to delete
    await r.apply(makeFrame(1, "step 2")); // delete prev (msg-0) + send msg-1
    await r.apply(makeFrame(2, "step 3")); // delete prev (msg-1) + send msg-2

    // Per-transition send text carries the running 🔧 marker (eventLabel
    // re-derives it on tool-kind running events); the delete-prev +
    // send-next state-machine invariant is what this asserts.
    expect(calls).toEqual([
      { op: "send", text: "🔧 step 1", id: "msg-0" },
      { op: "delete", id: "msg-0" },
      { op: "send", text: "🔧 step 2", id: "msg-1" },
      { op: "delete", id: "msg-1" },
      { op: "send", text: "🔧 step 3", id: "msg-2" },
    ]);
  });

  it("on success deletes the last activity message after the answer lands", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    const success: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    await r.finalize(success);

    // The last activity message (msg-0) is deleted; nothing is kept.
    expect(calls.filter((c) => c.op === "delete").map((c) => c.id)).toEqual(["msg-0"]);
  });

  it("unref's the deliveredAt-gated success-delete timer so it never holds the event loop open", async () => {
    const { actions } = makeRecordingActions();
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const r = createDeleteAndRepostRenderer({ actions, timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    // A future-dated success receipt schedules the gated delete behind the timer.
    const deliveredAtMs = clock.now() + 1000;
    const success: TurnOutcome = {
      kind: "success",
      trivial: false,
      delivery: { ok: true, deliveredChunks: 1, lastChunkMessageId: "final", deliveredAtMs },
    };
    await r.finalize(success);

    const deleteTimer = timer.unrefRecord().find((e) => e.delay === 1000);
    expect(deleteTimer?.unrefCalled).toBe(true);
  });

  it("on failure deletes the running activity and posts a final ❌ message that is KEPT", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent("boom")],
    };
    await r.finalize(failure);

    // The final ❌ message exists and is the LAST send; it is never deleted.
    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    const lastSend = sends[sends.length - 1];
    expect(lastSend.text).toContain("❌");
    expect(lastSend.text).toContain("dependency");
    // The ❌ message id is NOT among the deletes (kept for diagnosis).
    const deletedIds = calls.filter((c) => c.op === "delete").map((c) => c.id);
    expect(deletedIds).not.toContain(lastSend.id);
  });

  it("delete-and-repost failure send omits the cross emoji under ascii", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions, markers: ASCII_MARKERS });

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({ kind: "failure", errorKind: "timeout", failedEvents: [] });

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    const lastSend = sends[sends.length - 1];
    expect(lastSend.text).toBe("[ERR] timeout");
    expect(lastSend.text).not.toContain("❌");
    expect(lastSend.text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("delete-and-repost failure send is byte-identical to the cross glyph when markers are omitted", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    await r.finalize({ kind: "failure", errorKind: "timeout", failedEvents: [] });

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends[sends.length - 1].text).toBe("❌ timeout");
  });

  // --- elapsed-time fallback wiring (elapsedMs threading) ---
  //
  // DeleteAndRepost captures `startedAtMs` on the first apply() and passes
  // `elapsedMs = clock.now() - startedAtMs` to renderFrameText on EVERY
  // repost. So a delete+repost cycle after 7.5 s of clock advancement
  // produces "(running 7 s)" in the latest send text (Math.floor(7500/1000)).

  it("DeleteAndRepost first send carries (running 0 s) when a clock is injected and the frame has no plan", async () => {
    const { actions, calls } = makeRecordingActions();
    const clock = createFakeClock(1000);
    const timer = createFakeTimers();
    const r = createDeleteAndRepostRenderer({ actions, timer, clock });

    await r.apply(makeFrame(0, "step 1"));

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain("(running 0 s)");
  });

  it("DeleteAndRepost passes elapsedMs into each repost — after 7 500 ms advancement the latest send contains (running 7 s)", async () => {
    const { actions, calls } = makeRecordingActions();
    const clock = createFakeClock(1000);
    const timer = createFakeTimers();
    const r = createDeleteAndRepostRenderer({ actions, timer, clock });

    // First apply at t=1000 captures startedAtMs and posts msg-0 (elapsedMs=0).
    await r.apply(makeFrame(0, "step 1"));

    // Advance 7.5s; next apply deletes msg-0 and reposts msg-1 with elapsedMs=7500.
    clock.advance(7_500);
    await r.apply(makeFrame(1, "step 2"));

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends).toHaveLength(2);
    // The MOST RECENT send (the repost) carries the elapsed text.
    expect(sends[sends.length - 1].text).toContain("(running 7 s)");
    expect(sends[sends.length - 1].text).toContain("step 2");
  });

  it("DeleteAndRepost WITHOUT clock dep skips the elapsed fallback (graceful degrade)", async () => {
    const { actions, calls } = makeRecordingActions();
    // No clock — startedAtMs stays undefined → elapsedMs undefined → fallback skipped.
    const r = createDeleteAndRepostRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).not.toContain("(running");
  });
});
