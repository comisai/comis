// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-strategy finalize-arm coverage.
 *
 * The per-strategy test files pin the success/failure/trivial contract.
 * This file exercises the remaining reachable `TurnOutcome` arms — `silent`,
 * `aborted`, and `success_with_recovered_failures` — plus the `eventLabel`
 * fallback chain, so the strategy bodies meet the per-package coverage floor and
 * the keep-vs-delete decision is pinned for every outcome kind. The unreachable
 * exhaustive `never` defaults are exercised via the house pattern (an
 * out-of-union value cast through `as unknown`).
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
import type { ActivityRenderActions } from "./actions.js";
import { createEditPlaceRenderer } from "./edit-place.js";
import { createDeleteAndRepostRenderer } from "./delete-and-repost.js";
import { createAppendOnlyRenderer } from "./append-only.js";
import { createLinePerEventRenderer } from "./line-per-event.js";
import { createDigestOnlyRenderer } from "./digest-only.js";

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

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "s", agentId: "main", traceId: "t",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress", status: "running", kind: "tool", semanticPhase: "tool",
    defaultLabel: "working",
    ...overrides,
  } as ActivityEvent;
}

function makeFrame(events: readonly ActivityEvent[], added: readonly string[] = []): ActivityRenderFrame {
  return {
    frameSeq: 0,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added, edited: [], removed: [] },
  };
}

const RECEIPT: FinalDeliveryReceipt = {
  ok: true, deliveredChunks: 1, lastChunkMessageId: "final", deliveredAtMs: 0,
};

/** Actions port whose send/edit/delete all fail with the given render error. */
function makeFailingActions(
  error: ActivityRenderError,
): ActivityRenderActions {
  return {
    async send(): Promise<Result<string, ActivityRenderError>> {
      return { ok: false, error };
    },
    async edit(): Promise<Result<void, ActivityRenderError>> {
      return { ok: false, error };
    },
    async delete(): Promise<Result<void, ActivityRenderError>> {
      return { ok: false, error };
    },
  };
}

const RATE_LIMITED: ActivityRenderError = { kind: "rate_limited", retryAfterMs: 1000 };

const SILENT: TurnOutcome = { kind: "silent", reason: "NO_REPLY" };
const ABORTED: TurnOutcome = { kind: "aborted", reason: "user_cancel" };
const RECOVERED: TurnOutcome = {
  kind: "success_with_recovered_failures",
  trivial: false,
  delivery: RECEIPT,
  recoveredFailures: [makeEvent({ status: "failed" })],
};

describe("EditPlace — remaining finalize arms", () => {
  it("deletes the placeholder on a silent outcome", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    await r.apply(makeFrame([makeEvent()]));
    await r.finalize(SILENT);
    expect(calls.some((c) => c.op === "delete")).toBe(true);
  });

  it("keeps the placeholder on an aborted outcome (no delete)", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    await r.apply(makeFrame([makeEvent()]));
    await r.finalize(ABORTED);
    expect(calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("treats success_with_recovered_failures like success (edit + delete after deliveredAt)", async () => {
    const { actions, calls } = makeRecordingActions();
    const clock = createFakeClock(0);
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock });
    await r.apply(makeFrame([makeEvent()]));
    await r.finalize(RECOVERED); // deliveredAtMs 0 ≤ now → immediate delete
    await Promise.resolve();
    expect(calls.some((c) => c.op === "edit")).toBe(true);
    expect(calls.some((c) => c.op === "delete")).toBe(true);
  });

  it("falls back through eventLabel: toolName then kind when defaultLabel is absent", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    // No defaultLabel → toolName.
    await r.apply(makeFrame([makeEvent({ defaultLabel: undefined, toolName: "web_search" })]));
    const sent = calls.find((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sent?.text).toContain("web_search");
  });

  it("uses kind when neither defaultLabel nor toolName is present", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    await r.apply(makeFrame([makeEvent({ defaultLabel: undefined, toolName: undefined, kind: "memory" })]));
    const sent = calls.find((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sent?.text).toContain("memory");
  });

  it("returns ok on an out-of-union outcome kind (exhaustive default)", async () => {
    const { actions } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    const res = await r.finalize({ kind: "__bogus__" } as unknown as TurnOutcome);
    expect(res.ok).toBe(true);
  });
});

describe("DeleteAndRepost — remaining finalize arms", () => {
  it("deletes on silent and keeps on aborted", async () => {
    const a = makeRecordingActions();
    const ra = createDeleteAndRepostRenderer({ actions: a.actions });
    await ra.apply(makeFrame([makeEvent()]));
    await ra.finalize(SILENT);
    expect(a.calls.some((c) => c.op === "delete")).toBe(true);

    const b = makeRecordingActions();
    const rb = createDeleteAndRepostRenderer({ actions: b.actions });
    await rb.apply(makeFrame([makeEvent()]));
    await rb.finalize(ABORTED);
    expect(b.calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("treats success_with_recovered_failures as success (deletes last activity)", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });
    await r.apply(makeFrame([makeEvent()]));
    await r.finalize(RECOVERED);
    expect(calls.some((c) => c.op === "delete")).toBe(true);
  });

  it("schedules the success delete via the timer when the receipt is in the future", async () => {
    const { actions, calls } = makeRecordingActions();
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const r = createDeleteAndRepostRenderer({ actions, timer, clock });
    await r.apply(makeFrame([makeEvent()]));
    const future: TurnOutcome = {
      kind: "success", trivial: false,
      delivery: { ...RECEIPT, deliveredAtMs: 500 },
    };
    await r.finalize(future);
    expect(calls.some((c) => c.op === "delete")).toBe(false); // not yet
    timer.advance(500);
    await Promise.resolve();
    expect(calls.some((c) => c.op === "delete")).toBe(true); // fired after deliveredAt
  });

  it("returns ok on an out-of-union outcome kind (exhaustive default)", async () => {
    const { actions } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });
    const res = await r.finalize({ kind: "__bogus__" } as unknown as TurnOutcome);
    expect(res.ok).toBe(true);
  });
});

describe("AppendOnly — remaining finalize arms", () => {
  it("emits nothing on silent / aborted / recovered-success", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });
    await r.apply(makeFrame([makeEvent()]));
    const before = calls.length;
    await r.finalize(SILENT);
    await r.finalize(ABORTED);
    await r.finalize(RECOVERED);
    expect(calls.length).toBe(before);
  });

  it("returns ok on an out-of-union outcome kind (exhaustive default)", async () => {
    const { actions } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });
    const res = await r.finalize({ kind: "__bogus__" } as unknown as TurnOutcome);
    expect(res.ok).toBe(true);
  });
});

describe("LinePerEvent — remaining finalize arms", () => {
  it("emits no closing line on silent / aborted", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });
    await r.apply(makeFrame([makeEvent({ activityId: "a" })], ["a"]));
    const before = calls.length;
    await r.finalize(SILENT);
    await r.finalize(ABORTED);
    expect(calls.length).toBe(before);
  });

  it("emits the closing summary without a duration suffix when no clock is injected", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions }); // no clock
    await r.apply(makeFrame([makeEvent({ activityId: "a" })], ["a"]));
    await r.finalize({ kind: "success", trivial: false, delivery: RECEIPT });
    const closing = calls[calls.length - 1] as Extract<Call, { op: "send" }>;
    expect(closing.text).toContain("✓ done");
    expect(closing.text).not.toContain("s ·"); // no elapsed suffix
  });

  it("treats success_with_recovered_failures as a success closing line", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });
    await r.apply(makeFrame([makeEvent({ activityId: "a" })], ["a"]));
    await r.finalize(RECOVERED);
    expect((calls[calls.length - 1] as Extract<Call, { op: "send" }>).text).toContain("✓ done");
  });

  it("skips an added id that is not present in visibleEvents", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });
    // changeSet references "ghost" but it is not in visibleEvents → no line.
    await r.apply(makeFrame([makeEvent({ activityId: "a" })], ["ghost"]));
    expect(calls.filter((c) => c.op === "send")).toHaveLength(0);
  });

  it("returns ok on an out-of-union outcome kind (exhaustive default)", async () => {
    const { actions } = makeRecordingActions();
    const r = createLinePerEventRenderer({ actions });
    const res = await r.finalize({ kind: "__bogus__" } as unknown as TurnOutcome);
    expect(res.ok).toBe(true);
  });
});

describe("DigestOnly — remaining finalize arms", () => {
  it("emits nothing on silent / aborted / recovered-success", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });
    await r.apply(makeFrame([makeEvent()]));
    await r.finalize(SILENT);
    await r.finalize(ABORTED);
    await r.finalize(RECOVERED);
    expect(calls).toHaveLength(0);
  });

  it("emits a header-only digest when the trail is empty on failure", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });
    // No apply() call → empty trail.
    await r.finalize({ kind: "failure", errorKind: "internal", failedEvents: [] });
    const sent = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("[FAILED] internal");
  });

  it("returns ok on an out-of-union outcome kind (exhaustive default)", async () => {
    const { actions } = makeRecordingActions();
    const r = createDigestOnlyRenderer({ actions });
    const res = await r.finalize({ kind: "__bogus__" } as unknown as TurnOutcome);
    expect(res.ok).toBe(true);
  });
});

describe("error propagation + guard arms", () => {
  it("EditPlace propagates a failing placeholder send out of apply", async () => {
    const r = createEditPlaceRenderer({
      actions: makeFailingActions(RATE_LIMITED),
      timer: createFakeTimers(),
      clock: createFakeClock(0),
    });
    const res = await r.apply(makeFrame([makeEvent()]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("rate_limited");
  });

  it("EditPlace propagates a failing edit out of finalize(success)", async () => {
    // Placeholder sends OK once, then every later op fails.
    let sent = false;
    const actions: ActivityRenderActions = {
      async send(): Promise<Result<string, ActivityRenderError>> {
        sent = true;
        return ok("msg-0");
      },
      async edit(): Promise<Result<void, ActivityRenderError>> {
        return { ok: false, error: RATE_LIMITED };
      },
      async delete(): Promise<Result<void, ActivityRenderError>> {
        return ok(undefined);
      },
    };
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    await r.apply(makeFrame([makeEvent()]));
    expect(sent).toBe(true);
    const res = await r.finalize({ kind: "success", trivial: false, delivery: RECEIPT });
    expect(res.ok).toBe(false);
  });

  it("EditPlace propagates a failing edit out of finalize(failure)", async () => {
    let sent = false;
    const actions: ActivityRenderActions = {
      async send(): Promise<Result<string, ActivityRenderError>> {
        sent = true;
        return ok("msg-0");
      },
      async edit(): Promise<Result<void, ActivityRenderError>> {
        return { ok: false, error: RATE_LIMITED };
      },
      async delete(): Promise<Result<void, ActivityRenderError>> {
        return ok(undefined);
      },
    };
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    await r.apply(makeFrame([makeEvent()]));
    expect(sent).toBe(true);
    const res = await r.finalize({ kind: "failure", errorKind: "internal", failedEvents: [] });
    expect(res.ok).toBe(false);
  });

  it("EditPlace finalize(success) deletes immediately when no clock is injected", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers() }); // no clock
    await r.apply(makeFrame([makeEvent()]));
    await r.finalize({ kind: "success", trivial: false, delivery: { ...RECEIPT, deliveredAtMs: 999_999 } });
    // No clock → delete fires immediately regardless of deliveredAtMs.
    expect(calls.some((c) => c.op === "delete")).toBe(true);
  });

  it("DeleteAndRepost propagates a failing send out of apply", async () => {
    const r = createDeleteAndRepostRenderer({ actions: makeFailingActions(RATE_LIMITED) });
    const res = await r.apply(makeFrame([makeEvent()]));
    expect(res.ok).toBe(false);
  });

  it("DeleteAndRepost propagates a failing ❌ send out of finalize(failure)", async () => {
    // First send (apply) OK; the failure-path send fails.
    let calls = 0;
    const actions: ActivityRenderActions = {
      async send(): Promise<Result<string, ActivityRenderError>> {
        calls += 1;
        return calls === 1 ? ok("msg-0") : { ok: false, error: RATE_LIMITED };
      },
      async edit(): Promise<Result<void, ActivityRenderError>> {
        return ok(undefined);
      },
      async delete(): Promise<Result<void, ActivityRenderError>> {
        return ok(undefined);
      },
    };
    const r = createDeleteAndRepostRenderer({ actions });
    await r.apply(makeFrame([makeEvent()]));
    const res = await r.finalize({ kind: "failure", errorKind: "internal", failedEvents: [] });
    expect(res.ok).toBe(false);
  });

  it("AppendOnly propagates a failing opening send out of apply", async () => {
    const r = createAppendOnlyRenderer({ actions: makeFailingActions(RATE_LIMITED) });
    const res = await r.apply(makeFrame([makeEvent()]));
    expect(res.ok).toBe(false);
  });

  it("AppendOnly does not open on an empty-text frame", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createAppendOnlyRenderer({ actions });
    // visibleEvents empty → renderFrameText is "" → no open.
    await r.apply(makeFrame([]));
    expect(calls).toHaveLength(0);
  });

  it("AppendOnly propagates a failing ❌ follow-up out of finalize(failure)", async () => {
    const r = createAppendOnlyRenderer({ actions: makeFailingActions(RATE_LIMITED) });
    const res = await r.finalize({ kind: "failure", errorKind: "internal", failedEvents: [] });
    expect(res.ok).toBe(false);
  });

  it("LinePerEvent propagates a failing line send out of apply", async () => {
    const r = createLinePerEventRenderer({ actions: makeFailingActions(RATE_LIMITED) });
    const res = await r.apply(makeFrame([makeEvent({ activityId: "a" })], ["a"]));
    expect(res.ok).toBe(false);
  });

  it("LinePerEvent propagates a failing closing send out of finalize", async () => {
    const r = createLinePerEventRenderer({ actions: makeFailingActions(RATE_LIMITED) });
    const res = await r.finalize({ kind: "success", trivial: false, delivery: RECEIPT });
    expect(res.ok).toBe(false);
  });

  it("DigestOnly propagates a failing digest send out of finalize(failure)", async () => {
    const r = createDigestOnlyRenderer({ actions: makeFailingActions(RATE_LIMITED) });
    const res = await r.finalize({ kind: "failure", errorKind: "internal", failedEvents: [] });
    expect(res.ok).toBe(false);
  });

  it("EditPlace finalize(success) before any apply is a safe no-op (no placeholder to edit/delete)", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    const res = await r.finalize({ kind: "success", trivial: false, delivery: RECEIPT });
    expect(res.ok).toBe(true);
    // No messageId was ever created → no edit, no delete.
    expect(calls).toHaveLength(0);
  });

  it("EditPlace finalize(failure) before any apply is a safe no-op", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createEditPlaceRenderer({ actions, timer: createFakeTimers(), clock: createFakeClock(0) });
    const res = await r.finalize({ kind: "failure", errorKind: "internal", failedEvents: [] });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("EditPlace cancels a previously-armed deliveredAt delete on a repeated finalize", async () => {
    const { actions, calls } = makeRecordingActions();
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const r = createEditPlaceRenderer({ actions, timer, clock });
    await r.apply(makeFrame([makeEvent()]));
    // First finalize arms a future delete (deliveredAt 1000ms out).
    await r.finalize({ kind: "success", trivial: false, delivery: { ...RECEIPT, deliveredAtMs: 1000 } });
    expect(calls.some((c) => c.op === "delete")).toBe(false);
    // Second finalize (failure) cancels the armed delete and keeps the message.
    await r.finalize({ kind: "failure", errorKind: "internal", failedEvents: [] });
    timer.advance(5000);
    await Promise.resolve();
    // The previously-armed delete was cancelled → message kept.
    expect(calls.some((c) => c.op === "delete")).toBe(false);
  });
});
