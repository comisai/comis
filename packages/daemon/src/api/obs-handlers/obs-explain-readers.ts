// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `IncidentSourceReader` — the four bounded source readers behind one DI seam.
 *
 * `obs.explain` assembles an IncidentReport from four telemetry sources. They
 * sit behind ONE interface so production reads real files while tests inject
 * fixture records (the X3 fixture-injection seam):
 *
 *   1. readSessionRecords    — the per-session trajectory JSONL
 *      (`<dataDir>/sessions/<sessionId>.trajectory.jsonl`). Returns ALL parsed
 *      lines — log shape AND event shape — WITHOUT the production bundle
 *      reader's `traceSchema === "comis-trajectory"` envelope filter, so the
 *      frozen pre-150 log fixtures pass through to `toIncidentSignals`.
 *   2. readCacheTraceRecords — `<dataDir>/logs/cache-trace.jsonl`, filtered to
 *      the resolved session.
 *   3. readSessionMetadata   — the `<sessionId>_session-metadata.json` companion
 *      (the F1 PRIMARY rollup source).
 *   4. readDiagnosticsRollup — `obsStore.queryDiagnostics({category, limit:1000})`
 *      then a SESSION-SCOPED filter by `row.sessionKey` (the F2 fallback).
 *      `DiagnosticQueryParams` has NO sessionKey filter, so `{limit:1}` would
 *      return the most-recent row across ALL sessions — the reader queries a
 *      window and filters AFTER. The window is a recency horizon (WR-01): see
 *      `DIAGNOSTICS_QUERY_LIMIT` for why 1000 and the residual bound.
 *
 * Every path segment (sessionId, filename) goes through `safePath` with an
 * absolute base — a `../…` sessionId cannot escape `<dataDir>/sessions`. All
 * reads soft-fail (missing/corrupt file → `[]` / `null`, never throws).
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { safePath } from "@comis/core";
import type { ObservabilityStore } from "@comis/memory";

/** Per-read line cap (mirrors observability's MAX_TRAJECTORY_RUNTIME_EVENTS
 * intent at a report-appropriate scale — a post-mortem never needs more). */
const MAX_RECORDS = 5_000;

/**
 * Window queried from obs_diagnostics before the session-scoped filter (WR-01).
 *
 * `DiagnosticQueryParams` has NO sessionKey predicate, so the reader queries a
 * window (ordered `timestamp DESC`) and filters by `row.sessionKey` AFTER. The
 * window is therefore a RECENCY HORIZON: a target session whose `session_summary`
 * row sits behind more than this many NEWER session-summary rows falls outside
 * the window and the F2 fallback returns null (the report then loses the
 * cost/tokens/degraded fields only F2 supplies, when F1 metadata is also absent).
 *
 * 50 was too small — on a busy daemon a target ~an hour old could already be
 * behind 50 newer session ends. Widened to 1000 (well under the reader's
 * MAX_RECORDS=5000) so the post-mortem reaches realistically-old sessions while
 * keeping the post-filter cheap. The residual horizon is documented, not hidden:
 * the true fix is a SQL sessionKey predicate on DiagnosticQueryParams (out of
 * scope here — it lives in @comis/memory); until then this is the bound.
 */
const DIAGNOSTICS_QUERY_LIMIT = 1000;

/**
 * The four bounded source readers `obs.explain` consumes. One DI seam: the
 * real implementation reads files; tests inject fixture records.
 */
export interface IncidentSourceReader {
  readSessionRecords(sessionKey: string): Promise<Array<Record<string, unknown>>>;
  readCacheTraceRecords(sessionKey: string): Promise<Array<Record<string, unknown>>>;
  readSessionMetadata(sessionKey: string): Promise<Record<string, unknown> | null>;
  readDiagnosticsRollup(sessionKey: string): Promise<Record<string, unknown> | null>;
}

/** Default data directory (lazy). Mirrors obs-trace.ts. */
function defaultDataDir(): string {
  return safePath(os.homedir(), ".comis");
}

/**
 * Derive the on-disk sessionId from a formatted sessionKey. The session file
 * is keyed by the trailing colon-delimited segment (for
 * `default:678314278:678314278:peer:678314278` → `678314278`). `safePath`
 * collapses any traversal in the segment at the actual read site, so this is a
 * plain extraction.
 */
function sessionIdFromKey(sessionKey: string): string {
  const idx = sessionKey.lastIndexOf(":");
  return idx >= 0 ? sessionKey.slice(idx + 1) : sessionKey;
}

/**
 * Bounded soft-fail JSONL read: every parsed line is returned (NO envelope
 * filtering), malformed lines are skipped, a missing/unreadable file yields
 * `[]`, and at most MAX_RECORDS lines are accepted.
 */
function readJsonlBounded(file: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return []; // Missing/unreadable — soft-fail.
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (out.length >= MAX_RECORDS) break;
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Skip malformed JSONL lines per standard convention.
    }
  }
  return out;
}

/**
 * Build the production reader. `dataDir` is the file-system root (defaults to
 * `~/.comis`); `obsStore` (optional) backs the diagnostics-rollup fallback.
 */
export function makeRealReader(
  dataDir: string,
  obsStore?: ObservabilityStore,
): IncidentSourceReader {
  const base = dataDir.length > 0 ? dataDir : defaultDataDir();
  const sessionsDir = safePath(base, "sessions");
  const logsDir = safePath(base, "logs");

  return {
    async readSessionRecords(sessionKey: string): Promise<Array<Record<string, unknown>>> {
      const sessionId = sessionIdFromKey(sessionKey);
      const file = safePath(sessionsDir, `${sessionId}.trajectory.jsonl`);
      return readJsonlBounded(file);
    },

    async readCacheTraceRecords(sessionKey: string): Promise<Array<Record<string, unknown>>> {
      const file = safePath(logsDir, "cache-trace.jsonl");
      const all = readJsonlBounded(file);
      // Session-scoped: keep only this session's cache-trace lines.
      return all.filter((r) => r.sessionKey === sessionKey);
    },

    async readSessionMetadata(sessionKey: string): Promise<Record<string, unknown> | null> {
      const sessionId = sessionIdFromKey(sessionKey);
      const file = safePath(sessionsDir, `${sessionId}_session-metadata.json`);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf-8");
      } catch {
        return null; // Companion absent — F2 rollup is the fallback.
      }
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null; // Corrupt companion — soft-fail.
      }
    },

    async readDiagnosticsRollup(sessionKey: string): Promise<Record<string, unknown> | null> {
      if (obsStore === undefined) return null; // F1 metadata is the primary source.
      // DiagnosticQueryParams has NO sessionKey filter — query a window and
      // filter by row.sessionKey AFTER (a {limit:1} would return the most-recent
      // row across ALL sessions, not this one). The window (DIAGNOSTICS_QUERY_LIMIT)
      // is a recency horizon — widened to 1000 (WR-01) so older sessions are found.
      const rows = obsStore.queryDiagnostics({
        category: "session_summary",
        limit: DIAGNOSTICS_QUERY_LIMIT,
      });
      const match = rows.find((r) => r.sessionKey === sessionKey);
      return match === undefined ? null : (match as unknown as Record<string, unknown>);
    },
  };
}
