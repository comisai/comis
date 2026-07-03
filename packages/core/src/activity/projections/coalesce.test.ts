// SPDX-License-Identifier: Apache-2.0
/**
 * Coalesce engine tests.
 *
 * Pure rules engine: drop fast successes at `normal`, group
 * consecutive same-tool/same-action events <800ms apart, preserve failures
 * unconditionally, enforce the maxLines cap per verbosity.
 */
import { describe, it, expect } from "vitest";
import type { ActivityEvent } from "../activity-event.js";
import { coalesce, CHAT_COALESCE_RULES, type ActivityVerbosity } from "./coalesce.js";

let seq = 0;
function ev(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  seq += 1;
  return {
    schemaVersion: 1,
    activityId: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    sessionKey: "s",
    agentId: "a",
    traceId: "t",
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
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

describe("coalesce applies the chat coalescing rules", () => {
  it("drops sub-1500ms successful steps at normal verbosity", () => {
    const fast = ev({ durationMs: 900, status: "completed" });
    const slow = ev({ durationMs: 3000, status: "completed", toolName: "web_search" });
    const { visible } = coalesce([fast, slow], "normal");
    const ids = visible.map((e) => e.activityId);
    expect(ids).not.toContain(fast.activityId);
    expect(ids).toContain(slow.activityId);
  });

  it("keeps sub-1500ms successes at verbose verbosity", () => {
    const fast = ev({ durationMs: 200, status: "completed" });
    const { visible } = coalesce([fast], "verbose");
    expect(visible.map((e) => e.activityId)).toContain(fast.activityId);
  });

  it("never drops a failed event regardless of duration", () => {
    const failedFast = ev({ durationMs: 10, status: "failed", errorKind: "network" });
    const { visible } = coalesce([failedFast], "normal");
    expect(visible.map((e) => e.activityId)).toContain(failedFast.activityId);
  });

  it("groups consecutive same-tool/same-action events under 800ms apart", () => {
    const base = 1_700_000_500_000;
    const a = ev({
      activityId: "11111111-1111-1111-1111-111111111111",
      ts: new Date(base).toISOString(),
      toolName: "read",
      action: "file",
      durationMs: 3000,
    });
    const b = ev({
      activityId: "22222222-2222-2222-2222-222222222222",
      ts: new Date(base + 400).toISOString(),
      toolName: "read",
      action: "file",
      durationMs: 3000,
    });
    const c = ev({
      activityId: "33333333-3333-3333-3333-333333333333",
      ts: new Date(base + 700).toISOString(),
      toolName: "read",
      action: "file",
      durationMs: 3000,
    });
    const { visible, grouped } = coalesce([a, b, c], "normal");
    // Three same-tool events <800ms apart collapse to a single surrogate line.
    expect(visible).toHaveLength(1);
    const surrogateId = visible[0]!.activityId;
    expect(grouped[surrogateId]).toEqual([
      a.activityId,
      b.activityId,
      c.activityId,
    ]);
  });

  it("does not group events more than 800ms apart", () => {
    const base = 1_700_000_600_000;
    const a = ev({ ts: new Date(base).toISOString(), toolName: "read", action: "file" });
    const b = ev({ ts: new Date(base + 1500).toISOString(), toolName: "read", action: "file" });
    const { visible, grouped } = coalesce([a, b], "normal");
    expect(visible).toHaveLength(2);
    expect(Object.keys(grouped)).toHaveLength(0);
  });

  it("does not group different tools even within 800ms", () => {
    const base = 1_700_000_700_000;
    const a = ev({ ts: new Date(base).toISOString(), toolName: "read", action: "file" });
    const b = ev({ ts: new Date(base + 100).toISOString(), toolName: "web_search", action: "query" });
    const { visible } = coalesce([a, b], "normal");
    expect(visible).toHaveLength(2);
  });

  it("enforces the maxLines cap of 5 at normal", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      ev({
        activityId: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`,
        toolName: `tool${i}`,
        durationMs: 3000,
        ts: new Date(1_700_001_000_000 + i * 2000).toISOString(),
      }),
    );
    const { visible } = coalesce(many, "normal");
    expect(visible.length).toBeLessThanOrEqual(5);
    expect(CHAT_COALESCE_RULES.maxLines.normal).toBe(5);
  });

  it("exposes the full maxLines table {silent:0, quiet:2, normal:5, verbose:12}", () => {
    expect(CHAT_COALESCE_RULES.maxLines).toEqual({
      silent: 0,
      quiet: 2,
      normal: 5,
      verbose: 12,
    } satisfies Record<ActivityVerbosity, number>);
  });

  it("preserves failures even when maxLines would otherwise truncate them", () => {
    const successes = Array.from({ length: 8 }, (_, i) =>
      ev({
        activityId: `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, "0")}`,
        toolName: `t${i}`,
        durationMs: 3000,
        ts: new Date(1_700_002_000_000 + i * 2000).toISOString(),
      }),
    );
    const failure = ev({
      activityId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      status: "failed",
      errorKind: "network",
      durationMs: 10,
      ts: new Date(1_700_002_500_000).toISOString(),
    });
    const { visible } = coalesce([...successes, failure], "normal");
    expect(visible.map((e) => e.activityId)).toContain(failure.activityId);
    expect(visible.length).toBeLessThanOrEqual(5);
  });

  // ---------------------------------------------------------------------------
  // Phase-pair dedup + surrogate distinct-id counting.
  //
  // Regression tests for two render-side scaffold defects observed on a live
  // turn: a slow-success start+end pair rendered as two lines, and surrogate
  // ×N counts inflated to 2× the true call count.
  // ---------------------------------------------------------------------------

  it("dedupes start+end pairs by activityId, preferring the end event (slow-success duplicate lines)", () => {
    // A single slow tool call ("managing MCP
    // servers", 2300ms) emits two events sharing the same activityId — a
    // start/running with the running marker baked into defaultLabel by
    // activity-stream (emit-site behavior), and an end/completed
    // with a BARE defaultLabel (no marker). Without dedup, both pass
    // through Step 1's "drop fast successes" filter (the end has
    // durationMs:2300 > 1500ms, so it's kept; the start has no durationMs
    // so the `(e.durationMs ?? 0) < FAST_SUCCESS_MS` clause keeps it too) →
    // two visible events render as "🔧 managing MCP servers\nmanaging MCP
    // servers" — a duplicate line the user sees. Phase-pair dedup
    // collapses to ONE event, preferring the end (terminal state, which also
    // drives the renderer's failure-marker prefix downstream).
    const sharedActivityId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const startEvt = ev({
      activityId: sharedActivityId,
      ts: new Date(1_700_003_000_000).toISOString(),
      phase: "start",
      status: "running",
      toolName: "mcp_manage",
      action: "list_servers",
      defaultLabel: "🔧 managing MCP servers",
      durationMs: undefined,
    });
    const endEvt = ev({
      activityId: sharedActivityId,
      ts: new Date(1_700_003_002_300).toISOString(),
      phase: "end",
      status: "completed",
      toolName: "mcp_manage",
      action: "list_servers",
      defaultLabel: "managing MCP servers",
      durationMs: 2300,
    });
    const { visible } = coalesce([startEvt, endEvt], "normal");
    expect(visible).toHaveLength(1);
    const survivor = visible[0]!;
    expect(survivor.phase).toBe("end");
    expect(survivor.status).toBe("completed");
    expect(survivor.defaultLabel).toBe("managing MCP servers");
    // The activityId of the survivor is the shared id (not a surrogate prefix).
    expect(survivor.activityId).toBe(sharedActivityId);
  });

  it("surrogate count counts distinct activityIds, not raw constituent length (defense-in-depth)", () => {
    // Defense-in-depth: a future change that re-introduces same-activityId
    // events into a coalesced run (e.g. a phase-pair-dedup regression) must
    // not inflate the ×N count. Construction: 4 events with two distinct
    // activityIds, each id appearing twice in the input array. Step 1
    // (fast-success drop)
    // keeps all 4 because they are end/completed with durationMs:3000 > 1500.
    // Step 1.5 (phase-pair dedup) collapses identical activityId duplicates
    // to one each (kept-first behavior for non-end-vs-start duplicates) →
    // there are then 2 events in the grouped run, count is 2. But this
    // test directly exercises the surrogate-count map's distinct-id logic by
    // feeding 4 events with 2 distinct ids — even if a future regression
    // re-introduced same-id events into the grouped run, `new Set(...)`
    // dedup MUST keep the count at 2.
    const base = 1_700_004_000_000;
    const idA = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const idB = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const mk = (
      activityId: string,
      offsetMs: number,
    ): ActivityEvent =>
      ev({
        activityId,
        ts: new Date(base + offsetMs).toISOString(),
        phase: "end",
        status: "completed",
        toolName: "read",
        action: "file",
        durationMs: 3000,
      });
    // Input: [a, a, b, b] — same toolName/action, all <800ms apart, two
    // duplicate pairs. Both copies of idA collapse to one in Step 1.5;
    // both copies of idB collapse to one. Resulting run length is 2,
    // grouped into ONE surrogate with constituents = [idA, idB] (distinct).
    const eventsIn: ActivityEvent[] = [
      mk(idA, 0),
      mk(idA, 100),
      mk(idB, 200),
      mk(idB, 300),
    ];
    const { visible, grouped } = coalesce(eventsIn, "normal");
    expect(visible).toHaveLength(1);
    const surrogateId = visible[0]!.activityId;
    // The surrogate carries the count of DISTINCT activityIds (2), not the
    // raw constituent count from the post-dedup slice (which is also 2
    // after dedup, but the assertion pins the `new Set(...)` invariant).
    expect(grouped[surrogateId]).toHaveLength(2);
    expect(new Set(grouped[surrogateId])).toEqual(new Set([idA, idB]));
  });
});
