// SPDX-License-Identifier: Apache-2.0
/**
 * TestSink strategy tests.
 *
 * The TestSink is the Echo terminus: it records every `apply(frame)` and the
 * single `finalize(outcome)` with full payload, applies NO coalescing, and
 * reflects the TestSink strategy identity. The acceptance test asserts this
 * recorder received the canonical stream.
 */
import { describe, it, expect } from "vitest";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
} from "@comis/core";
import { createTestSink } from "./test-sink.js";

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "sess-a",
    agentId: "main",
    traceId: "trace-a",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    ...overrides,
  } as ActivityEvent;
}

function makeFrame(frameSeq: number, events: readonly ActivityEvent[]): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

const RECEIPT: FinalDeliveryReceipt = {
  ok: true,
  deliveredChunks: 1,
  lastChunkMessageId: "msg-final",
  deliveredAtMs: 5000,
};

describe("createTestSink", () => {
  it("reflects the TestSink strategy identity with delete/edit disabled", () => {
    const sink = createTestSink();
    expect(sink.strategy).toBe("TestSink");
    expect(sink.canDelete).toBe(false);
    expect(sink.canEdit).toBe(false);
  });

  it("records three apply frames in order plus the finalize outcome with full payload", async () => {
    const sink = createTestSink();
    const f0 = makeFrame(0, [makeEvent({ activityId: "00000000-0000-0000-0000-000000000000" })]);
    const f1 = makeFrame(1, [makeEvent({ activityId: "00000000-0000-0000-0000-000000000001" })]);
    const f2 = makeFrame(2, [makeEvent({ activityId: "00000000-0000-0000-0000-000000000002" })]);

    const r0 = await sink.apply(f0);
    const r1 = await sink.apply(f1);
    const r2 = await sink.apply(f2);
    expect(r0.ok && r1.ok && r2.ok).toBe(true);

    const outcome: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    const fin = await sink.finalize(outcome);
    expect(fin.ok).toBe(true);

    // All three frames recorded verbatim, in order.
    expect(sink.recorded.frames).toHaveLength(3);
    expect(sink.recorded.frames.map((f) => f.frameSeq)).toEqual([0, 1, 2]);
    expect(sink.recorded.frames[0]).toBe(f0);
    expect(sink.recorded.frames[2]).toBe(f2);

    // The outcome is recorded with its full payload (the FinalDeliveryReceipt survives).
    expect(sink.recorded.outcome).toEqual(outcome);
    expect(sink.recorded.outcome?.kind).toBe("success");
    if (sink.recorded.outcome?.kind === "success") {
      expect(sink.recorded.outcome.delivery.deliveredAtMs).toBe(5000);
    }
  });

  it("applies no coalescing — duplicate-shaped frames are recorded as distinct entries", async () => {
    const sink = createTestSink();
    const ev = makeEvent();
    await sink.apply(makeFrame(0, [ev]));
    await sink.apply(makeFrame(1, [ev]));
    // Echo fidelity: identical event content across two frames yields two records.
    expect(sink.recorded.frames).toHaveLength(2);
    expect(sink.recorded.frames[0].visibleEvents[0]).toBe(ev);
    expect(sink.recorded.frames[1].visibleEvents[0]).toBe(ev);
  });

  it("records a failure outcome with its errorKind payload", async () => {
    const sink = createTestSink();
    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent({ status: "failed" })],
    };
    await sink.finalize(failure);
    expect(sink.recorded.outcome).toEqual(failure);
    if (sink.recorded.outcome?.kind === "failure") {
      expect(sink.recorded.outcome.errorKind).toBe("dependency");
    }
  });
});
