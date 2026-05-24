// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bundle export — types, constants, and pure helpers.
 *
 * This file is the Phase 4 source-of-truth for:
 *
 *   §5 D5 — Hard limits + bundle exporter pipeline helpers.
 *   §6.2  — TrajectoryBundleManifest + TrajectoryBundleWarning shape.
 *
 * **Plan sequence:**
 *   - Plan 04-01 (this plan): types, 4 hard-limit constants,
 *     `buildTranscriptEvents`, `sortTrajectoryEvents`.
 *   - Plan 04-02: adds `readSessionBranch(filePath)` to this file.
 *   - Plan 04-03: adds `exportTrajectoryBundle(opts)` to this file.
 *
 * **TYPE MAPPING (session.transcript.entry):**
 * SDK SessionEntry.type values ("message", "compaction", etc.) are NOT in
 * the `TrajectoryEventType` closed union. Phase 4 adds ONE literal to the
 * union: `"session.transcript.entry"`. All synthesized transcript events
 * use this single type. The SDK entry type is carried verbatim inside
 * `data.entryType` so downstream consumers can branch on it without
 * exploding the closed union.
 *
 * **PURE FUNCTIONS — no I/O, no logging, no throws:**
 * `buildTranscriptEvents` and `sortTrajectoryEvents` are total pure
 * functions over typed inputs. Callers in Plan 04-03 enforce the
 * hard-limit caps before invoking them.
 *
 * @module
 */

import type { TrajectoryEvent, TrajectoryEventSource } from "./types.js";

// ---------------------------------------------------------------------------
// Hard-limit constants (design §5 D5 lines 317–321).
//
// Note: MAX_TRAJECTORY_SESSION_FILE_BYTES (50 MB) is numerically identical
// to runtime.ts:TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES but semantically
// different (session-file-read cap vs. runtime-write cap). Do NOT alias.
// ---------------------------------------------------------------------------

/** Maximum number of runtime events to include in a bundle export. */
export const MAX_TRAJECTORY_RUNTIME_EVENTS = 200_000 as const;

/** Maximum total events (runtime + transcript) in a bundle export. */
export const MAX_TRAJECTORY_TOTAL_EVENTS = 250_000 as const;

/**
 * Maximum session JSONL file size that the bundle exporter will read.
 * Files exceeding this limit are refused with a structured warning.
 * Numerically 50 MiB = 50 * 1024 * 1024 bytes.
 */
// 50 * 1024 * 1024 = 52_428_800 bytes (50 MiB).
export const MAX_TRAJECTORY_SESSION_FILE_BYTES = 52_428_800 as const;

/**
 * Maximum number of row indices recorded per warning code in
 * `TrajectoryBundleWarning.rows`. Additional offending rows increment
 * `count` but are not added to the array.
 */
export const MAX_TRAJECTORY_WARNING_ROWS = 20 as const;

// ---------------------------------------------------------------------------
// TrajectoryBundleWarning (design §6.2)
// ---------------------------------------------------------------------------

/**
 * Structured warning emitted by the bundle exporter when it encounters
 * recoverable parse or consistency failures.
 *
 * `rows` is capped at `MAX_TRAJECTORY_WARNING_ROWS` entries per code.
 * `count` accumulates ALL matching rows, including those not in `rows`.
 */
export interface TrajectoryBundleWarning {
  readonly source: "session" | "runtime";
  readonly code:
    | "invalid-session-json"
    | "invalid-session-row"
    | "incomplete-session-branch"
    | "cyclic-session-branch"
    | "invalid-runtime-json"
    | "invalid-runtime-event";
  readonly count: number;
  /** Row indices of problematic lines (0-indexed), capped at MAX_TRAJECTORY_WARNING_ROWS. */
  readonly rows: number[];
  readonly message: string;
}

// ---------------------------------------------------------------------------
// TrajectoryBundleManifest (design §6.2)
// ---------------------------------------------------------------------------

/**
 * Top-level manifest for a trajectory bundle directory.
 *
 * Written as `manifest.json` inside the bundle directory.
 * `contents` auto-populates the `{path, mediaType, bytes}` entries for
 * all files in the bundle. `warnings` accumulates structured warnings
 * from the export pipeline capped at `MAX_TRAJECTORY_WARNING_ROWS` per code.
 *
 * Field order matches design §6.2 (reproduced verbatim).
 */
export interface TrajectoryBundleManifest {
  readonly traceSchema: "comis-trajectory";
  readonly schemaVersion: 1;
  readonly generatedAt: string;           // ISO 8601
  readonly traceId: string;
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly workspaceDir: string;
  readonly leafId: string | null;
  readonly eventCount: number;            // runtimeEventCount + transcriptEventCount
  readonly runtimeEventCount: number;
  readonly transcriptEventCount: number;
  readonly sourceFiles: { session: string; runtime?: string };
  readonly contents?: Array<{ path: string; mediaType: string; bytes: number }>;
  readonly supplementalFiles?: string[];
  readonly warnings?: TrajectoryBundleWarning[];
}

// ---------------------------------------------------------------------------
// Helper input shapes
// ---------------------------------------------------------------------------

/**
 * Envelope base fields passed to `buildTranscriptEvents`.
 * Matches the required session-correlation fields on TrajectoryEvent.
 * Exported so Plan 04-03 can use it at the call site.
 */
export interface TranscriptEventBase {
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly traceId: string;
  readonly agentId: string;
  readonly tenantId?: string;
  readonly workspaceDir?: string;
}

/**
 * Structural entry shape from the SDK session branch.
 * Matches `SessionEntryBase` from `@earendil-works/pi-coding-agent`.
 * Defined here as a structural type so the test fixtures can use plain
 * object literals without importing the SDK types.
 */
export interface TranscriptSourceEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly type: string;
}

// ---------------------------------------------------------------------------
// buildTranscriptEvents
// ---------------------------------------------------------------------------

/**
 * Synthesizes one `source:"transcript"` TrajectoryEvent per branch entry.
 *
 * Contract (design §5 D5 step 4):
 * - Input `entries` must be in chronological order (caller's responsibility).
 * - Each output event has `entryId = entry.id` (preserves SDK DAG identity).
 * - `parentEntryId` chains through the SYNTHESIZED predecessor:
 *   - `i === 0`: `entry.parentId` (null for the branch root).
 *   - `i > 0`: `entries[i-1].id` — points to the previous synthesized event,
 *     not to the SDK's raw parentId chain, so the trajectory DAG is
 *     self-contained within the bundle's events.jsonl.
 * - `sourceSeq` is 1-indexed chronological position (1, 2, 3…).
 * - `seq` is set to 0 — transcript events are not part of the runtime's
 *   monotonic sequence counter (runtime-seq invariant is runtime-only).
 * - `data.entryType` carries the SDK entry.type verbatim.
 *
 * Pure function — no I/O, no side effects, no throws.
 */
export function buildTranscriptEvents(
  entries: ReadonlyArray<TranscriptSourceEntry>,
  base: TranscriptEventBase,
): TrajectoryEvent[] {
  return entries.map((entry, i) => {
    const parentEntryId: string | null = i === 0 ? entry.parentId : (entries[i - 1]?.id ?? null);

    const event: TrajectoryEvent = {
      traceSchema: "comis-trajectory",
      schemaVersion: 1,
      source: "transcript",
      type: "session.transcript.entry",
      ts: entry.timestamp,
      seq: 0,
      agentId: base.agentId,
      sessionId: base.sessionId,
      traceId: base.traceId,
      entryId: entry.id,
      parentEntryId,
      sourceSeq: i + 1,
      data: { entryType: entry.type },
      // Optional envelope fields — included only when defined.
      ...(base.tenantId !== undefined ? { tenantId: base.tenantId } : {}),
      ...(base.sessionKey !== undefined ? { sessionKey: base.sessionKey } : {}),
      ...(base.workspaceDir !== undefined ? { workspaceDir: base.workspaceDir } : {}),
    };

    return event;
  });
}

// ---------------------------------------------------------------------------
// sortTrajectoryEvents
// ---------------------------------------------------------------------------

/**
 * Source-order rank for tiebreak sorting (design §5 D5 step 5).
 * Lower number = higher priority (sorts first).
 */
const SOURCE_ORDER: Record<TrajectoryEventSource, number> = {
  runtime: 0,
  transcript: 1,
  export: 2,
};

/**
 * Returns a NEW array of events sorted by:
 *
 *   1. Primary: ascending lexicographic `ts` (ISO 8601 strings are
 *      lexicographically orderable).
 *   2. Tiebreak 1: source order (`runtime` < `transcript` < `export`).
 *   3. Tiebreak 2: ascending `sourceSeq`; undefined sourceSeq sorts
 *      AFTER any defined sourceSeq (treated as `+Infinity`).
 *   4. Final fallback: ascending `entryId` lexicographic (deterministic
 *      when (ts, source, sourceSeq) all match).
 *
 * **Non-mutating:** uses `[...events].sort(...)` — input array is
 * unchanged.
 *
 * Pure function — no I/O, no side effects, no throws.
 */
export function sortTrajectoryEvents(events: ReadonlyArray<TrajectoryEvent>): TrajectoryEvent[] {
  return [...events].sort((a, b) => {
    // 1. Primary: ts ascending
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;

    // 2. Tiebreak: source order
    const aOrder = SOURCE_ORDER[a.source];
    const bOrder = SOURCE_ORDER[b.source];
    if (aOrder !== bOrder) return aOrder - bOrder;

    // 3. Tiebreak: sourceSeq ascending (undefined → +Infinity)
    const aSeq = a.sourceSeq ?? Number.POSITIVE_INFINITY;
    const bSeq = b.sourceSeq ?? Number.POSITIVE_INFINITY;
    if (aSeq !== bSeq) return aSeq - bSeq;

    // 4. Final fallback: entryId lexicographic
    if (a.entryId < b.entryId) return -1;
    if (a.entryId > b.entryId) return 1;

    return 0;
  });
}
