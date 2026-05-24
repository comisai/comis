// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for export.ts foundations (Phase 4 Plan 01).
 *
 * Tests cover:
 *   - Hard-limit constants with exact values (design §5 D5 lines 318–321)
 *   - buildTranscriptEvents: parentEntryId chaining, sourceSeq assignment,
 *     ts passthrough from SDK entry.timestamp
 *   - sortTrajectoryEvents: primary ts sort, source-order tiebreak,
 *     sourceSeq tiebreak, non-mutation
 *   - TrajectoryBundleManifest + TrajectoryBundleWarning type conformance
 *     (compile-time; TypeScript must accept the literal shapes)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  buildTranscriptEvents,
  sortTrajectoryEvents,
  MAX_TRAJECTORY_RUNTIME_EVENTS,
  MAX_TRAJECTORY_TOTAL_EVENTS,
  MAX_TRAJECTORY_SESSION_FILE_BYTES,
  MAX_TRAJECTORY_WARNING_ROWS,
  type TrajectoryBundleManifest,
  type TrajectoryBundleWarning,
} from "./export.js";
import type { TrajectoryEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Structural session entry fixture — matches TranscriptSourceEntry shape. */
const e1 = { id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", type: "message" } as const;
const e2 = { id: "entry-2", parentId: "entry-1", timestamp: "2026-01-01T00:00:02.000Z", type: "thinking_level_change" } as const;
const e3 = { id: "entry-3", parentId: "entry-2", timestamp: "2026-01-01T00:00:03.000Z", type: "compaction" } as const;

const base = {
  sessionId: "sess-abc",
  traceId: "trace-xyz",
  agentId: "agent-1",
  workspaceDir: "/home/user/.comis/workspace",
} as const;

// ---------------------------------------------------------------------------
// Helpers to build minimal TrajectoryEvent fixtures for sort tests
// ---------------------------------------------------------------------------

function makeEvent(
  ts: string,
  source: TrajectoryEvent["source"],
  sourceSeq: number | undefined,
  entryId: string,
): TrajectoryEvent {
  return {
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    source,
    type: "session.started",
    ts,
    seq: 1,
    agentId: "agent-1",
    sessionId: "sess-abc",
    traceId: "trace-xyz",
    entryId,
    ...(sourceSeq !== undefined ? { sourceSeq } : {}),
  };
}

// ---------------------------------------------------------------------------
// Describe block
// ---------------------------------------------------------------------------

describe("export.ts foundations (Plan 04-01)", () => {
  // -------------------------------------------------------------------------
  // 1. Constants
  // -------------------------------------------------------------------------

  it("MAX_TRAJECTORY_RUNTIME_EVENTS equals 200_000", () => {
    expect(MAX_TRAJECTORY_RUNTIME_EVENTS).toBe(200_000);
  });

  it("MAX_TRAJECTORY_TOTAL_EVENTS equals 250_000", () => {
    expect(MAX_TRAJECTORY_TOTAL_EVENTS).toBe(250_000);
  });

  it("MAX_TRAJECTORY_SESSION_FILE_BYTES equals 50 * 1024 * 1024", () => {
    expect(MAX_TRAJECTORY_SESSION_FILE_BYTES).toBe(50 * 1024 * 1024);
  });

  it("MAX_TRAJECTORY_WARNING_ROWS equals 20", () => {
    expect(MAX_TRAJECTORY_WARNING_ROWS).toBe(20);
  });

  // -------------------------------------------------------------------------
  // 2. buildTranscriptEvents — parentEntryId chaining + sourceSeq
  // -------------------------------------------------------------------------

  it("buildTranscriptEvents produces 1 event per entry with source:transcript", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    expect(out).toHaveLength(3);
    for (const ev of out) {
      expect(ev.source).toBe("transcript");
    }
  });

  it("buildTranscriptEvents chains parentEntryId from synthesized predecessor", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    // e1 has no predecessor → parentEntryId is null (e1.parentId is null)
    expect(out[0]!.parentEntryId).toBeNull();
    // e2 predecessor is out[0] (the synthesized event for e1)
    expect(out[1]!.parentEntryId).toBe(out[0]!.entryId);
    // e3 predecessor is out[1]
    expect(out[2]!.parentEntryId).toBe(out[1]!.entryId);
  });

  it("buildTranscriptEvents assigns 1-indexed sourceSeq in chronological order", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    expect(out.map((e) => e.sourceSeq)).toEqual([1, 2, 3]);
  });

  it("buildTranscriptEvents uses SDK entry.timestamp as ts", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    expect(out[0]!.ts).toBe(e1.timestamp);
    expect(out[1]!.ts).toBe(e2.timestamp);
    expect(out[2]!.ts).toBe(e3.timestamp);
  });

  it("buildTranscriptEvents sets entryId to entry.id (no new UUIDs)", () => {
    const out = buildTranscriptEvents([e1, e2, e3], base);
    expect(out[0]!.entryId).toBe(e1.id);
    expect(out[1]!.entryId).toBe(e2.id);
    expect(out[2]!.entryId).toBe(e3.id);
  });

  // -------------------------------------------------------------------------
  // 3. sortTrajectoryEvents — primary ts, tiebreak source, tiebreak sourceSeq
  // -------------------------------------------------------------------------

  it("sortTrajectoryEvents primary ts sort — ascending chronological order", () => {
    const events = [
      makeEvent("2026-01-01T00:00:02.000Z", "runtime", 1, "a"),
      makeEvent("2026-01-01T00:00:01.000Z", "runtime", 2, "b"),
      makeEvent("2026-01-01T00:00:03.000Z", "runtime", 3, "c"),
    ];
    const sorted = sortTrajectoryEvents(events);
    expect(sorted.map((e) => e.ts)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
    ]);
  });

  it("sortTrajectoryEvents tiebreak source order — runtime before transcript", () => {
    const ts = "2026-01-01T00:00:01.000Z";
    const events = [
      makeEvent(ts, "transcript", 1, "t1"),
      makeEvent(ts, "runtime", 1, "r1"),
    ];
    const sorted = sortTrajectoryEvents(events);
    expect(sorted[0]!.source).toBe("runtime");
    expect(sorted[1]!.source).toBe("transcript");
  });

  it("sortTrajectoryEvents tiebreak sourceSeq — ascending numeric, undefined sorts last", () => {
    const ts = "2026-01-01T00:00:01.000Z";
    const events = [
      makeEvent(ts, "runtime", 5, "r5"),
      makeEvent(ts, "runtime", undefined, "ru"),
      makeEvent(ts, "runtime", 3, "r3"),
    ];
    const sorted = sortTrajectoryEvents(events);
    expect(sorted[0]!.sourceSeq).toBe(3);
    expect(sorted[1]!.sourceSeq).toBe(5);
    // undefined sourceSeq sorts after defined
    expect(sorted[2]!.sourceSeq).toBeUndefined();
  });

  it("sortTrajectoryEvents is non-mutating — input array unchanged after sort", () => {
    const ts = "2026-01-01T00:00:01.000Z";
    const events = [
      makeEvent(ts, "transcript", 2, "t2"),
      makeEvent(ts, "runtime", 1, "r1"),
    ];
    // Snapshot the original order by entryId
    const inputSnapshot = events.map((e) => e.entryId);
    sortTrajectoryEvents(events);
    expect(events.map((e) => e.entryId)).toEqual(inputSnapshot);
  });

  // -------------------------------------------------------------------------
  // 4. TrajectoryBundleManifest + TrajectoryBundleWarning compile-time types
  // -------------------------------------------------------------------------

  it("TrajectoryBundleManifest is structurally assignable to design §6.2 shape", () => {
    const warning: TrajectoryBundleWarning = {
      source: "session",
      code: "invalid-session-json",
      count: 1,
      rows: [2],
      message: "bad JSON on line 2",
    };

    const manifest: TrajectoryBundleManifest = {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      traceId: "trace-xyz",
      sessionId: "sess-abc",
      workspaceDir: "/home/user/.comis/workspace",
      leafId: "entry-42",
      eventCount: 10,
      runtimeEventCount: 7,
      transcriptEventCount: 3,
      sourceFiles: { session: "/path/to/session.jsonl" },
      warnings: [warning],
    };

    expect(manifest.traceSchema).toBe("comis-trajectory");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.eventCount).toBe(10);
    expect(manifest.warnings).toHaveLength(1);
  });

  it("TrajectoryBundleWarning code is a closed union — @ts-expect-error on invalid code", () => {
    // This verifies the closed union: "unknown-code" is not in the valid set.
    // @ts-expect-error — "unknown-code" is not assignable to TrajectoryBundleWarning["code"]
    const _invalid: TrajectoryBundleWarning["code"] = "unknown-code";
    // The @ts-expect-error above suppresses the compile error — test passes at runtime
    expect(typeof _invalid).toBe("string");
  });
});
