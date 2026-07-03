// SPDX-License-Identifier: Apache-2.0
/**
 * acp-projection tests.
 *
 * Pure pass-through: every event visible, NO coalescing, no verbosity policy,
 * and groupedActivityIds is ALWAYS empty (IDE surfaces want full fidelity).
 */
import { describe, it, expect } from "vitest";
import type { ActivityEvent } from "../activity-event.js";
import { acpProjection } from "./acp-projection.js";

let seq = 0;
function ev(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  seq += 1;
  return {
    schemaVersion: 1,
    activityId: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    sessionKey: "s",
    agentId: "a",
    traceId: "t",
    ts: new Date(1_900_000_000_000 + seq * 100).toISOString(),
    phase: "end",
    status: "completed",
    kind: "tool",
    semanticPhase: "tool",
    toolName: "read",
    action: "file",
    durationMs: 50,
    ...overrides,
  } as ActivityEvent;
}

describe("acpProjection passes every event through with no policy", () => {
  it("keeps every event visible regardless of duration", () => {
    const fast = ev({ durationMs: 10, status: "completed" });
    const slow = ev({ durationMs: 9000, status: "completed" });
    const frame = acpProjection([fast, slow]);
    expect(frame.visibleEvents.map((e) => e.activityId)).toEqual([
      fast.activityId,
      slow.activityId,
    ]);
  });

  it("never coalesces same-tool events that the chat projection would group", () => {
    const base = 1_900_000_500_000;
    const a = ev({ ts: new Date(base).toISOString(), toolName: "read", action: "file" });
    const b = ev({ ts: new Date(base + 100).toISOString(), toolName: "read", action: "file" });
    const c = ev({ ts: new Date(base + 200).toISOString(), toolName: "read", action: "file" });
    const frame = acpProjection([a, b, c]);
    expect(frame.visibleEvents).toHaveLength(3);
  });

  it("always returns an empty groupedActivityIds map", () => {
    const base = 1_900_000_600_000;
    const a = ev({ ts: new Date(base).toISOString(), toolName: "read", action: "file" });
    const b = ev({ ts: new Date(base + 50).toISOString(), toolName: "read", action: "file" });
    const frame = acpProjection([a, b]);
    expect(frame.groupedActivityIds).toEqual({});
  });

  it("builds a changeSet against the previous frame without dropping anything", () => {
    const a = ev();
    const prev = acpProjection([a]);
    const b = ev();
    const next = acpProjection([a, b], prev);
    expect(next.frameSeq).toBe(1);
    expect(next.changeSet.added).toEqual([b.activityId]);
    expect(next.visibleEvents).toHaveLength(2);
  });

  it("marks an event whose status changed as edited and a dropped one as removed", () => {
    const running = ev({
      activityId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      status: "running",
      phase: "start",
      durationMs: undefined,
    });
    const stale = ev({ activityId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" });
    const prev = acpProjection([running, stale]);

    const completed = ev({
      activityId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      status: "completed",
      phase: "end",
      durationMs: 4000,
    });
    // `stale` is gone from the new stream → it must show up as removed.
    const next = acpProjection([completed], prev);
    expect(next.changeSet.edited).toContain("dddddddd-dddd-dddd-dddd-dddddddddddd");
    expect(next.changeSet.removed).toContain("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
  });
});
