// SPDX-License-Identifier: Apache-2.0
/**
 * chat-projection tests.
 *
 * Pure (events, config) -> ActivityRenderFrame. Verbosity policy: silent->empty,
 * quiet->failures+approvals, normal->coalesced, verbose->all. Builds a changeSet
 * by diffing against a passed-in previous frame and preserves groupedActivityIds.
 */
import { describe, it, expect } from "vitest";
import type { ActivityEvent } from "../activity-event.js";
import type {
  ActivityRenderFrame,
  PlanSnapshot,
} from "../channel-activity-renderer.js";
import { chatProjection } from "./chat-projection.js";

let seq = 0;
function ev(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  seq += 1;
  return {
    schemaVersion: 1,
    activityId: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    sessionKey: "s",
    agentId: "a",
    traceId: "t",
    ts: new Date(1_800_000_000_000 + seq * 2000).toISOString(),
    phase: "end",
    status: "completed",
    kind: "tool",
    semanticPhase: "tool",
    toolName: "read",
    action: "file",
    durationMs: 3000,
    ...overrides,
  } as ActivityEvent;
}

describe("chatProjection applies the verbosity policy", () => {
  it("returns an empty visible set at silent verbosity", () => {
    const frame = chatProjection([ev(), ev({ status: "failed", errorKind: "network" })], {
      verbosity: "silent",
    });
    expect(frame.visibleEvents).toHaveLength(0);
  });

  it("shows only failures and approvals at quiet verbosity", () => {
    const ok = ev({ status: "completed" });
    const failed = ev({ status: "failed", errorKind: "network" });
    const approval = ev({
      kind: "approval",
      status: "running",
      approval: {
        shortId: "ABCDEF123456",
        choices: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
    });
    const frame = chatProjection([ok, failed, approval], { verbosity: "quiet" });
    const ids = frame.visibleEvents.map((e) => e.activityId);
    expect(ids).toContain(failed.activityId);
    expect(ids).toContain(approval.activityId);
    expect(ids).not.toContain(ok.activityId);
  });

  it("coalesces at normal verbosity (drops fast successes)", () => {
    const fast = ev({ durationMs: 100, status: "completed" });
    const slow = ev({ durationMs: 5000, status: "completed", toolName: "web_search" });
    const frame = chatProjection([fast, slow], { verbosity: "normal" });
    const ids = frame.visibleEvents.map((e) => e.activityId);
    expect(ids).not.toContain(fast.activityId);
    expect(ids).toContain(slow.activityId);
  });

  it("shows every event at verbose verbosity", () => {
    const a = ev({ durationMs: 50 });
    const b = ev({ durationMs: 60 });
    const frame = chatProjection([a, b], { verbosity: "verbose" });
    expect(frame.visibleEvents.map((e) => e.activityId)).toEqual([a.activityId, b.activityId]);
  });

  it("preserves groupedActivityIds from coalescing", () => {
    const base = 1_800_500_000_000;
    const a = ev({
      activityId: "11111111-1111-1111-1111-111111111111",
      ts: new Date(base).toISOString(),
      toolName: "read",
      action: "file",
      durationMs: 3000,
    });
    const b = ev({
      activityId: "22222222-2222-2222-2222-222222222222",
      ts: new Date(base + 300).toISOString(),
      toolName: "read",
      action: "file",
      durationMs: 3000,
    });
    const frame = chatProjection([a, b], { verbosity: "normal" });
    const groups = Object.values(frame.groupedActivityIds);
    expect(groups.some((g) => g.includes(a.activityId) && g.includes(b.activityId))).toBe(true);
  });

  it("builds a changeSet diffing against the previous frame", () => {
    const a = ev({ durationMs: 5000, toolName: "web_search" });
    const prev: ActivityRenderFrame = {
      frameSeq: 0,
      visibleEvents: [a],
      groupedActivityIds: {},
      planSnapshot: undefined,
      changeSet: { added: [a.activityId], edited: [], removed: [] },
    };
    const b = ev({ durationMs: 5000, toolName: "memory_store", semanticPhase: "memory" });
    const next = chatProjection([a, b], { verbosity: "verbose" }, prev);
    expect(next.frameSeq).toBe(1);
    expect(next.changeSet.added).toContain(b.activityId);
    expect(next.changeSet.added).not.toContain(a.activityId);
  });

  it("marks an event whose status changed as edited in the changeSet", () => {
    const running = ev({
      activityId: "44444444-4444-4444-4444-444444444444",
      status: "running",
      phase: "start",
      durationMs: undefined,
    });
    const prev = chatProjection([running], { verbosity: "verbose" });
    const completed = ev({
      activityId: "44444444-4444-4444-4444-444444444444",
      status: "completed",
      phase: "end",
      durationMs: 5000,
    });
    const next = chatProjection([completed], { verbosity: "verbose" }, prev);
    expect(next.changeSet.edited).toContain("44444444-4444-4444-4444-444444444444");
  });

  it("marks an event dropped since the previous frame as removed", () => {
    const a = ev({ durationMs: 5000, toolName: "web_search" });
    const b = ev({ durationMs: 5000, toolName: "memory_store", semanticPhase: "memory" });
    const prev = chatProjection([a, b], { verbosity: "verbose" });
    // `a` is gone from the new event stream.
    const next = chatProjection([b], { verbosity: "verbose" }, prev);
    expect(next.changeSet.removed).toContain(a.activityId);
    expect(next.visibleEvents.map((e) => e.activityId)).toEqual([b.activityId]);
  });

  it("defends the closed verbosity union with an empty frame on an out-of-union value", () => {
    // The exhaustive-never default arm (AGENTS.md §2.8) is unreachable by design;
    // an out-of-union cast exercises the defensive branch (house pattern).
    const frame = chatProjection([ev(), ev({ status: "failed", errorKind: "network" })], {
      verbosity: "loud" as unknown as "normal",
    });
    expect(frame.visibleEvents).toHaveLength(0);
    expect(frame.groupedActivityIds).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Plan-snapshot threading (4th arg).
//
// The rendered frame must carry the latest SEP `PlanSnapshot` so the
// chat surfaces can prefix `[x]/[~]/[ ]` lines above the event list. The
// coordinator captures the latest snapshot from `planStream.subscribe` and
// passes it as the projection's 4th arg; the projection writes
// `planSnapshot: latestPlanSnapshot ?? prevFrame?.planSnapshot` (latest wins
// per turn — silent-forward of prevFrame would mask a re-extracted plan).
// ---------------------------------------------------------------------------

describe("chatProjection threads the latest plan snapshot", () => {
  it("writes latestPlanSnapshot when supplied as the 4th argument", () => {
    const latestPlanSnapshot: PlanSnapshot = {
      entries: [
        { id: "0", label: "step a", status: "in_progress" },
      ],
    };
    const frame = chatProjection(
      [ev()],
      { verbosity: "verbose" },
      undefined,
      latestPlanSnapshot,
    );
    expect(frame.planSnapshot).toBe(latestPlanSnapshot);
  });

  it("falls back to prevFrame.planSnapshot when the 4th argument is undefined", () => {
    const prevSnapshot: PlanSnapshot = {
      entries: [{ id: "0", label: "prev step", status: "done" }],
    };
    const prevFrame: ActivityRenderFrame = {
      frameSeq: 0,
      visibleEvents: [],
      groupedActivityIds: {},
      planSnapshot: prevSnapshot,
      changeSet: { added: [], edited: [], removed: [] },
    };
    const frame = chatProjection(
      [ev()],
      { verbosity: "verbose" },
      prevFrame,
    );
    expect(frame.planSnapshot).toBe(prevSnapshot);
  });

  it("uses the latestPlanSnapshot in preference to prevFrame.planSnapshot when both are supplied (latest wins)", () => {
    const prevSnapshot: PlanSnapshot = {
      entries: [{ id: "0", label: "old", status: "in_progress" }],
    };
    const latestPlanSnapshot: PlanSnapshot = {
      entries: [{ id: "0", label: "new", status: "in_progress" }],
    };
    const prevFrame: ActivityRenderFrame = {
      frameSeq: 0,
      visibleEvents: [],
      groupedActivityIds: {},
      planSnapshot: prevSnapshot,
      changeSet: { added: [], edited: [], removed: [] },
    };
    const frame = chatProjection(
      [ev()],
      { verbosity: "verbose" },
      prevFrame,
      latestPlanSnapshot,
    );
    expect(frame.planSnapshot).toBe(latestPlanSnapshot);
    expect(frame.planSnapshot).not.toBe(prevSnapshot);
  });
});
