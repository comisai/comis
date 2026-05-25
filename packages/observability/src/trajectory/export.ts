// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bundle export — types, constants, pure helpers, and
 * SDK-based session reader.
 *
 * Provides:
 *   - Hard limits + bundle exporter pipeline helpers.
 *   - Session DAG reader with cycle + missing-parent detection.
 *   - TrajectoryBundleManifest + TrajectoryBundleWarning shape.
 *
 * **Module layout:**
 *   - types, 4 hard-limit constants, `buildTranscriptEvents`,
 *     `sortTrajectoryEvents`.
 *   - `readSessionBranch(filePath)` and `ReadSessionBranchResult` — the
 *     DAG-aware reader.
 *   - `exportTrajectoryBundle(params)` lives in `bundle-exporter.ts`
 *     (co-located in this directory). The file split is required by the
 *     800-line architecture invariant; the logical module boundary is
 *     unchanged. See bundle-exporter.ts.
 *
 * **TYPE MAPPING (session.transcript.entry):**
 * SDK SessionEntry.type values ("message", "compaction", etc.) are NOT in
 * the `TrajectoryEventType` closed union. We add ONE literal to the
 * union: `"session.transcript.entry"`. All synthesized transcript events
 * use this single type. The SDK entry type is carried verbatim inside
 * `data.entryType` so downstream consumers can branch on it without
 * exploding the closed union.
 *
 * **PURE FUNCTIONS — no I/O, no logging, no throws:**
 * `buildTranscriptEvents` and `sortTrajectoryEvents` are total pure
 * functions over typed inputs. Callers in `exportTrajectoryBundle`
 * enforce the hard-limit caps before invoking them.
 *
 * **readSessionBranch is a soft-fail reader** — corrupt input returns
 * structured warnings, never throws. No raw JSONL parser is introduced;
 * the SDK's `SessionManager.open()` is the trust anchor.
 *
 * @module
 */

import { statSync } from "node:fs";
import { dirname } from "node:path";
import {
  SessionManager as SdkSessionManager,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { TrajectoryEvent, TrajectoryEventSource } from "./types.js";

// ---------------------------------------------------------------------------
// Hard-limit constants.
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
// Private warning-construction helper (used by readSessionBranch).
// ---------------------------------------------------------------------------

/**
 * Build a single `TrajectoryBundleWarning` value.
 *
 * Caps `rows` at `MAX_TRAJECTORY_WARNING_ROWS` ONLY at construction time —
 * so callers accumulate the full `count` while building rows[], then pass
 * both to this helper. `count` preserves the true detection total.
 *
 * @internal
 */
function buildWarning(
  source: TrajectoryBundleWarning["source"],
  code: TrajectoryBundleWarning["code"],
  count: number,
  rows: number[],
  message: string,
): TrajectoryBundleWarning {
  return {
    source,
    code,
    count,
    rows: rows.slice(0, MAX_TRAJECTORY_WARNING_ROWS),
    message,
  };
}

// ---------------------------------------------------------------------------
// TrajectoryBundleWarning
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
// TrajectoryBundleManifest
// ---------------------------------------------------------------------------

/**
 * Top-level manifest for a trajectory bundle directory.
 *
 * Written as `manifest.json` inside the bundle directory.
 * `contents` auto-populates the `{path, mediaType, bytes}` entries for
 * all files in the bundle. `warnings` accumulates structured warnings
 * from the export pipeline capped at `MAX_TRAJECTORY_WARNING_ROWS` per code.
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
  /** Redaction policy applied at bundle export time. */
  readonly redaction?: { readonly policy: string };
}

// ---------------------------------------------------------------------------
// Helper input shapes
// ---------------------------------------------------------------------------

/**
 * Envelope base fields passed to `buildTranscriptEvents`.
 * Matches the required session-correlation fields on TrajectoryEvent.
 * Exported so bundle-exporter.ts can use it at the call site.
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
 * Contract:
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
 * Source-order rank for tiebreak sorting.
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

// ---------------------------------------------------------------------------
// ReadSessionBranchResult + readSessionBranch
// ---------------------------------------------------------------------------

/**
 * Output of `readSessionBranch`.
 *
 * - `header`: SDK session header, or `null` when the file does not exist
 *   or the session is empty/header-only.
 * - `leafId`: the leaf entry id at read time (SDK's current pointer),
 *   or `null` when the session is empty.
 * - `branchEntries`: chronologically-ordered branch from root to leaf
 *   (reverse of the leaf-to-root walk). Excludes the header. Empty when
 *   no entries are reachable.
 * - `warnings`: structured warnings emitted during the walk
 *   (cycle / missing-parent / invalid-json). Each warning code's `rows`
 *   field is capped at `MAX_TRAJECTORY_WARNING_ROWS`; `count` preserves
 *   the true detection count.
 */
export interface ReadSessionBranchResult {
  readonly header: SessionHeader | null;
  readonly leafId: string | null;
  readonly branchEntries: ReadonlyArray<SessionEntry>;
  readonly warnings: ReadonlyArray<TrajectoryBundleWarning>;
}

/** Empty-result shorthand for pre-flight failures. */
function emptyResult(warnings: TrajectoryBundleWarning[]): ReadSessionBranchResult {
  return { header: null, leafId: null, branchEntries: [], warnings };
}

/**
 * Read a session JSONL file via the SDK SessionManager and walk
 * leaf-to-root via parentId chain, emitting structured warnings on
 * cycles and missing parents.
 *
 * Algorithm:
 *   1. Pre-flight stat. If file > MAX_TRAJECTORY_SESSION_FILE_BYTES,
 *      return invalid-session-json warning, no throw, no SDK open.
 *   2. SdkSessionManager.open(filePath, dirname(filePath)) inside try/catch.
 *      On throw → invalid-session-json warning, return empty result.
 *   3. sm.getHeader() → header (may be null).
 *   4. sm.getLeafEntry() → leaf (may be undefined → return empty branch).
 *   5. Walk: bounded loop from leaf backward through parentId chain.
 *      - `seen` Set detects cycles (emits cyclic-session-branch).
 *      - `sm.getEntry(parentId)` returning undefined → missing-parent
 *        (emits incomplete-session-branch), stops walk.
 *      - Hard iteration cap at MAX_TRAJECTORY_TOTAL_EVENTS (defense-in-depth).
 *   6. branchEntries = reversedBranch.reverse() (root → leaf, chronological).
 *   7. Build warnings: one entry per code; cap rows at MAX_TRAJECTORY_WARNING_ROWS.
 *
 * Returns a `ReadSessionBranchResult`-shaped plain object.
 * **Never throws.** Corrupt input → warning + reachable suffix.
 *
 * **No raw JSONL parsing:** the SDK's SessionManager.open is the only
 * JSONL parser — no second `JSON.parse` pass on the file contents.
 *
 * @public
 */
export function readSessionBranch(filePath: string): ReadSessionBranchResult {
  // -------------------------------------------------------------------------
  // Step 1a: pre-flight stat — ENOENT or any error returns invalid-session-json.
  // -------------------------------------------------------------------------
  let statResult: { size: number };
  try {
    statResult = statSync(filePath);
  } catch {
    return emptyResult([
      buildWarning("session", "invalid-session-json", 1, [], "Session file not readable"),
    ]);
  }

  // -------------------------------------------------------------------------
  // Step 1b: size cap (50 MiB defense-in-depth; bundle-exporter also stats).
  // -------------------------------------------------------------------------
  if (statResult.size > MAX_TRAJECTORY_SESSION_FILE_BYTES) {
    return emptyResult([
      buildWarning(
        "session",
        "invalid-session-json",
        1,
        [],
        "Session file exceeds MAX_TRAJECTORY_SESSION_FILE_BYTES (50 MB)",
      ),
    ]);
  }

  // -------------------------------------------------------------------------
  // Step 2: open session via SDK — the only JSONL parser.
  // -------------------------------------------------------------------------
  let sm: ReturnType<typeof SdkSessionManager.open>;
  try {
    sm = SdkSessionManager.open(filePath, dirname(filePath));
  } catch {
    // Do NOT include the SDK error message — defense against adversarial
    // error strings carrying attacker-controlled bytes.
    return emptyResult([
      buildWarning("session", "invalid-session-json", 1, [], "SDK SessionManager.open failed"),
    ]);
  }

  // -------------------------------------------------------------------------
  // Step 3: header (may be null for malformed / empty files).
  // -------------------------------------------------------------------------
  const header = sm.getHeader();

  // -------------------------------------------------------------------------
  // Step 4: leaf entry — undefined means header-only or empty session.
  //         Header-only is well-formed; no warning.
  // -------------------------------------------------------------------------
  const leafEntry = sm.getLeafEntry();
  if (leafEntry === undefined) {
    return { header, leafId: null, branchEntries: [], warnings: [] };
  }

  // -------------------------------------------------------------------------
  // Step 5: leaf-to-root walk with cycle + missing-parent detection.
  // -------------------------------------------------------------------------
  const seen = new Set<string>();
  const reversedBranch: SessionEntry[] = [];

  // Accumulators for warning metadata (rows + counts, uncapped during walk).
  const cycleRowIndices: number[] = [];
  let cycleCount = 0;
  const missingParentRowIndices: number[] = [];
  let missingParentCount = 0;

  let current: SessionEntry | undefined = leafEntry;
  let iterCapHit = false;

  for (let iter = 0; iter < MAX_TRAJECTORY_TOTAL_EVENTS && current !== undefined; iter++) {
    // Cycle detection: if we have already visited this entry's id, stop.
    if (seen.has(current.id)) {
      cycleCount += 1;
      cycleRowIndices.push(iter);
      break;
    }

    seen.add(current.id);
    reversedBranch.push(current);

    // Stop at the root (parentId === null means this is the branch root).
    if (current.parentId === null) {
      break;
    }

    // Walk to parent.
    const parent = sm.getEntry(current.parentId);
    if (parent === undefined) {
      missingParentCount += 1;
      missingParentRowIndices.push(iter);
      break;
    }

    current = parent;

    // Safety: if this is the last iteration and the loop exits without
    // terminating cleanly, record as a cycle (defense-in-depth against
    // a session that somehow defeats `seen`). Check at the END of each
    // iteration — the cap fires only if we consumed all iterations.
    if (iter === MAX_TRAJECTORY_TOTAL_EVENTS - 1) {
      iterCapHit = true;
    }
  }

  // If the hard cap was hit, record as a cyclic warning.
  if (iterCapHit && cycleCount === 0 && missingParentCount === 0) {
    cycleCount += 1;
    cycleRowIndices.push(MAX_TRAJECTORY_TOTAL_EVENTS - 1);
  }

  // -------------------------------------------------------------------------
  // Step 6: reverse to chronological order (root → leaf).
  // -------------------------------------------------------------------------
  const branchEntries = reversedBranch.reverse();

  // -------------------------------------------------------------------------
  // Step 7: build warnings array (at most one entry per code).
  // -------------------------------------------------------------------------
  const warnings: TrajectoryBundleWarning[] = [];

  if (cycleCount > 0) {
    warnings.push(
      buildWarning(
        "session",
        "cyclic-session-branch",
        cycleCount,
        cycleRowIndices,
        "Cyclic parentId chain detected in session JSONL",
      ),
    );
  }

  if (missingParentCount > 0) {
    warnings.push(
      buildWarning(
        "session",
        "incomplete-session-branch",
        missingParentCount,
        missingParentRowIndices,
        "Session entry references a parentId that could not be resolved",
      ),
    );
  }

  return {
    header,
    leafId: leafEntry.id,
    branchEntries,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// exportTrajectoryBundle pipeline
//
// Defined in bundle-exporter.ts (co-located in this directory). The file
// split is required by the 800-line architecture invariant — export.ts
// would exceed the cap if the full pipeline were inlined here.
//
// bundle-exporter.ts imports types/helpers from this file. To avoid the
// circular dependency that would result from re-exporting here, the barrel
// (index.ts) exports from bundle-exporter.ts directly. Tests import bundle
// exporter symbols from bundle-exporter.ts.
// ---------------------------------------------------------------------------
