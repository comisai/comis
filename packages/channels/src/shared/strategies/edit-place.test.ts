// SPDX-License-Identifier: Apache-2.0
/**
 * EditPlace strategy tests.
 *
 * EditPlace is the debounce/edit/delete sequencer used by edit-capable channels
 * (Telegram, Discord, Slack, WhatsApp). The hard contract:
 *   - rapid `apply(frame)` calls within 800ms collapse to ONE edit (debounce ≤1/800ms);
 *   - on finalize(success): edit→final, wait for `delivery.deliveredAtMs`, THEN delete
 *     (the delete fires only AFTER the deliveredAt point — proven by advancing the clock);
 *   - on finalize(failure): the ❌ form is the final edit and NO delete fires (kept);
 *   - on a trivial turn: the placeholder is deleted with no edit history.
 *
 * All timing goes through the injected TimerPort / ClockPort — NEVER raw
 * setTimeout / Date.now (globals.test.ts fails the build otherwise).
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
import { createEditPlaceRenderer } from "./edit-place.js";
import type { ActivityRenderActions } from "./actions.js";

const DEBOUNCE_MS = 800;
/** The ascii theme's markers: bracketed pure-ASCII tags, zero emoji. */
const ASCII_MARKERS = { success: "[OK]", failure: "[ERR]", subagent: "[SUB]", running: "[..]" } as const;

type Call =
  | { op: "send"; text: string; id: string }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string };

function makeRecordingActions(): {
  actions: ActivityRenderActions;
  calls: Call[];
} {
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

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "sess-a",
    agentId: "main",
    traceId: "trace-a",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    defaultLabel: "working",
    ...overrides,
  } as ActivityEvent;
}

function makeFrame(frameSeq: number, label: string): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: [makeEvent({ defaultLabel: label })],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

function receiptAt(deliveredAtMs: number): FinalDeliveryReceipt {
  return { ok: true, deliveredChunks: 1, lastChunkMessageId: "msg-final", deliveredAtMs };
}

describe("createEditPlaceRenderer", () => {
  it("reports an EditPlace identity that can edit and delete", () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });
    expect(r.strategy).toBe("EditPlace");
    expect(r.canEdit).toBe(true);
    expect(r.canDelete).toBe(true);
  });

  it("collapses multiple apply frames within the debounce window into a single edit", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });

    // Three rapid frames inside one 800ms window.
    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    await r.apply(makeFrame(2, "step 3"));

    // Nothing has been edited yet — the debounce timer has not fired.
    expect(calls.filter((c) => c.op === "edit")).toHaveLength(0);

    // Fire the debounce.
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const edits = calls.filter((c): c is Extract<Call, { op: "edit" }> => c.op === "edit");
    // Exactly one edit despite three frames — and it carries the LATEST frame's text.
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain("step 3");
  });

  it("on success edits to the final form, then deletes ONLY after the deliveredAt point", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    // deliveredAt is 1000ms in the future relative to the fake clock (now = 800 after the debounce advance).
    const deliveredAtMs = clock.now() + 1000;
    const outcome: TurnOutcome = { kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) };
    await r.finalize(outcome);
    // Let the final edit settle.
    await Promise.resolve();
    await Promise.resolve();

    // The final edit happened, but NO delete yet — we have not reached deliveredAt.
    expect(calls.some((c) => c.op === "edit")).toBe(true);
    expect(calls.some((c) => c.op === "delete")).toBe(false);

    // Advance the clock/timer to the deliveredAt point: now the delete fires.
    timer.advance(1000);
    await Promise.resolve();
    await Promise.resolve();

    const deletes = calls.filter((c): c is Extract<Call, { op: "delete" }> => c.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].id).toBe("msg-0"); // the original placeholder

    // Ordering: the delete is the LAST recorded op (after every edit).
    expect(calls[calls.length - 1].op).toBe("delete");
  });

  it("on failure edits to the ❌ form and NEVER deletes (keep the diagnostic trail)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent({ status: "failed" })],
    };
    await r.finalize(failure);
    await Promise.resolve();
    await Promise.resolve();

    // Even after advancing well past any conceivable deliveredAt, no delete is issued.
    timer.advance(100_000);
    await Promise.resolve();

    expect(calls.some((c) => c.op === "delete")).toBe(false);
    const edits = calls.filter((c): c is Extract<Call, { op: "edit" }> => c.op === "edit");
    // The final edit carries the ❌ failure marker.
    expect(edits[edits.length - 1].text).toContain("❌");
  });

  it("edit-place paints the ascii error marker on a failed finalize and drops the cross emoji", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock, markers: ASCII_MARKERS });

    await r.apply(makeFrame(0, "step 1"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    await r.finalize({ kind: "failure", errorKind: "timeout", failedEvents: [] });
    await Promise.resolve();
    await Promise.resolve();

    const edits = calls.filter((c): c is Extract<Call, { op: "edit" }> => c.op === "edit");
    const finalEdit = edits[edits.length - 1].text;
    expect(finalEdit).toBe("[ERR] timeout");
    expect(finalEdit).not.toContain("❌");
    expect(finalEdit).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("edit-place paints the ascii success marker on a successful finalize and drops the check emoji", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock, markers: ASCII_MARKERS });

    await r.apply(makeFrame(0, "step 1"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    // Non-trivial success → the final edit is the themed success closing line.
    const deliveredAtMs = clock.now() + 1000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();
    await Promise.resolve();

    const edits = calls.filter((c): c is Extract<Call, { op: "edit" }> => c.op === "edit");
    const successEdit = edits[edits.length - 1].text;
    expect(successEdit).toBe("[OK] done");
    expect(successEdit).not.toContain("✓");
    expect(successEdit).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("edit-place success closing line is byte-identical to the check-done glyph when markers are omitted", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions, calls } = makeRecordingActions();
    // No markers → default-parity: the success edit must still be exactly "✓ done".
    const r = createEditPlaceRenderer({ actions, timer, clock });

    await r.apply(makeFrame(0, "step 1"));
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    const deliveredAtMs = clock.now() + 1000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();
    await Promise.resolve();

    const edits = calls.filter((c): c is Extract<Call, { op: "edit" }> => c.op === "edit");
    expect(edits[edits.length - 1].text).toBe("✓ done");
  });

  it("unref's the debounce-edit and deliveredAt-gated delete timers so they never hold the event loop open", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });

    // First apply posts the placeholder; second apply schedules a debounce edit.
    await r.apply(makeFrame(0, "step 1"));
    await r.apply(makeFrame(1, "step 2"));
    const editTimer = timer.unrefRecord().find((e) => e.delay === DEBOUNCE_MS);
    expect(editTimer?.unrefCalled).toBe(true);

    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    // A future-dated success receipt schedules the gated delete — also unref'd.
    const deliveredAtMs = clock.now() + 1000;
    await r.finalize({ kind: "success", trivial: false, delivery: receiptAt(deliveredAtMs) });
    await Promise.resolve();
    const deleteTimer = timer.unrefRecord().find((e) => e.delay === 1000);
    expect(deleteTimer?.unrefCalled).toBe(true);
  });

  it("on a trivial turn deletes the placeholder with no edit history", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });

    // A single apply sends the placeholder; before the debounce edit fires, the
    // turn finalizes as trivial.
    await r.apply(makeFrame(0, "thinking"));

    const trivial: TurnOutcome = { kind: "success", trivial: true, delivery: receiptAt(clock.now()) };
    await r.finalize(trivial);
    await Promise.resolve();
    await Promise.resolve();
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();

    // Placeholder deleted; no edit ever applied (no edit history).
    expect(calls.some((c) => c.op === "delete")).toBe(true);
    expect(calls.some((c) => c.op === "edit")).toBe(false);
  });

  // --- elapsed-time fallback wiring (elapsedMs threading) ---
  //
  // EditPlace captures `startedAtMs` on the first apply() (via clock.now() if
  // a clock is injected) and passes `elapsedMs = clock.now() - startedAtMs`
  // as the 3rd arg to renderFrameText. The fallback "(running N s)"
  // appears in the sent/edited text whenever the frame has no plan snapshot
  // AND a clock is injected. These tests regression-lock the live production
  // path so the fallback is not silently inert.

  it("EditPlace passes elapsedMs=0 on the first apply (no time advancement) so the placeholder carries (running 0 s)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(1000);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });

    await r.apply(makeFrame(0, "step 1"));

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain("(running 0 s)");
  });

  it("EditPlace captures startedAtMs on first apply and the next debounced edit text contains (running 12 s) after 12 000 ms advancement", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(1000);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });

    // First apply at t=1000 captures startedAtMs and posts the placeholder.
    await r.apply(makeFrame(0, "step 1"));

    // Advance the clock by 12_000 ms; the next apply schedules an edit.
    clock.advance(12_000);
    await r.apply(makeFrame(1, "step 2"));

    // Fire the debounce so the edit lands.
    timer.advance(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    const edits = calls.filter((c): c is Extract<Call, { op: "edit" }> => c.op === "edit");
    expect(edits).toHaveLength(1);
    // Latest text computed at the apply() call site (clock.now()===13_000) carries 12s.
    expect(edits[0].text).toContain("(running 12 s)");
    expect(edits[0].text).toContain("step 2");
  });

  it("EditPlace does NOT emit elapsed fallback when frame.planSnapshot is present (no double-display)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(1000);
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer, clock });

    const frameWithPlan: ActivityRenderFrame = {
      frameSeq: 0,
      visibleEvents: [makeEvent({ defaultLabel: "step 1" })],
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

  it("EditPlace WITHOUT injected clock skips the elapsed fallback (graceful degrade)", async () => {
    const timer = createFakeTimers();
    const { actions, calls } = makeRecordingActions();
    // No clock dep — startedAtMs stays undefined → elapsedMs undefined → fallback skipped.
    const r = createEditPlaceRenderer({ actions, timer });

    await r.apply(makeFrame(0, "step 1"));

    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].text).not.toContain("(running");
  });
});
