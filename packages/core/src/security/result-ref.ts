// SPDX-License-Identifier: Apache-2.0
/**
 * `ResultRef` — the minimal structured result-handle + its pure threshold/GC
 * math, for the autonomous `orchestrate` tool surface.
 *
 * ResultRef is DISTINCT from `microcompaction-guard.ts` — do NOT conflate the
 * two mechanisms:
 *   - proactive: a handle BY DEFAULT above a per-tool threshold (the guard is
 *     reactive — it offloads AFTER a result is already too big).
 *   - workspace-relative `results/<id>.<kind>` (the guard writes
 *     `<sessionDir>/tool-results/<id>.json`).
 *   - a structured handle `{ref, kind, bytes, rows?, schema?, preview,
 *     expiresAt}` (the guard returns a head+tail text-preview string).
 *   - per-run GC lifecycle, cleaned on orchestrate-run end (the guard is
 *     session-lifetime).
 *   - extraction is in-jail (`jq`/`grep`/`read --offset/--limit`) the SAME turn,
 *     so only the slice re-enters context (the guard re-enters via a next-turn
 *     read HINT). Materialize-then-extract is the contract: the full result
 *     lands on disk, and only queried slices ever enter the model context.
 *
 * This module is the TYPE + the PURE math only — every function takes an
 * injected `nowMs`/byte-count and reads no ambient clock and no fs (AGENTS.md
 * §2.8 globals rule), so it is fully macOS-unit-testable. The actual disk I/O
 * (write/read/GC-sweep) lives in `result-ref-store.ts` (@comis/skills), which
 * consumes these pure deciders. Pure @comis/core data: NO imports from
 * @comis/skills / @comis/agent / @comis/daemon (keeps the package cycle-free).
 *
 * @module
 */
import { err, ok, type Result } from "@comis/shared";
import { systemDateFrom } from "../runtime/system-time.js";

/**
 * A structured handle to a materialized tool result on the jailed workspace.
 * Only the handle re-enters context; the bytes stay on disk until an in-jail
 * `jq`/`grep`/`read` slices them.
 */
export interface ResultRef {
  /** WORKSPACE-relative path, e.g. `"results/ws-7af3.jsonl"` (NOT sessionDir). */
  ref: string;
  /** The materialized content kind (closed union — AGENTS.md §2.8). */
  kind: "jsonl" | "json" | "csv" | "html" | "text" | "binary";
  /** Total materialized size in bytes. */
  bytes: number;
  /** Row count for tabular kinds (jsonl/csv), when known. */
  rows?: number;
  /** Column/field names for tabular kinds, when known. */
  schema?: string[];
  /** A tiny bounded head of the content (re-enters context with the handle). */
  preview: string;
  /** ISO-8601 expiry — the TTL after which the run-GC evicts the file. */
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Per-tool inline → handle thresholds.
// ---------------------------------------------------------------------------

/**
 * The high default threshold for a tool NOT in {@link RESULT_REF_THRESHOLDS}.
 *
 * `POSITIVE_INFINITY` means "never materialize by default" — the 95% case
 * (small/non-high-volume returns like `memory_get`/`session_status`) stays
 * inline with zero friction. Only the explicitly-listed high-volume
 * tools get a finite, exceedable threshold.
 */
export const DEFAULT_INLINE_THRESHOLD_BYTES = Number.POSITIVE_INFINITY;

/**
 * Per-tool inline→handle byte threshold. A return strictly LARGER than the
 * tool's threshold is materialized to `results/` and replaced by a ResultRef;
 * at or below it stays inline.
 *
 * The 15_000-byte default mirrors the microcompaction high-value-read inline cap
 * (`MAX_INLINE_FILE_READ_RESULT_CHARS` / `MAX_INLINE_MCP_TOOL_RESULT_CHARS`,
 * `context-engine/constants.ts`) as a sane reference point — it is a fresh
 * constant, not a reuse. Only the high-volume tools (web fetch/search, document
 * extraction, recursive grep, file read, MCP tool returns) are listed; every
 * other tool falls through to {@link DEFAULT_INLINE_THRESHOLD_BYTES} (Infinity →
 * stays inline).
 * The values are initial defaults, deliberately left tunable.
 */
export const RESULT_REF_THRESHOLDS: Record<string, number> = {
  web_fetch: 15_000,
  web_search: 15_000,
  extract_document: 15_000,
  grep: 15_000,
  read: 15_000,
  mcp: 15_000,
};

/** Per-tool threshold lookup with the high default fallback. */
export function getResultRefThreshold(toolName: string): number {
  return RESULT_REF_THRESHOLDS[toolName] ?? DEFAULT_INLINE_THRESHOLD_BYTES;
}

/**
 * Whether a `byteCount`-sized return for `toolName` should be materialized to a
 * ResultRef. Strict `>` (a return exactly at the threshold stays inline).
 */
export function shouldMaterialize(toolName: string, byteCount: number): boolean {
  return byteCount > getResultRefThreshold(toolName);
}

// ---------------------------------------------------------------------------
// GC / cap math — all pure, all injected-now, no fs.
// ---------------------------------------------------------------------------

/**
 * Per-file cap: a single materialized result larger than this is REFUSED by the
 * store (the runner surfaces a `result_ref_too_large` honest-degrade, never a
 * silent truncate). ~8 MiB is a sane default — far above the 15 KB handle
 * threshold so legitimate large returns materialize, but bounded so one tool
 * call can't fill the workspace (tunable later).
 */
export const PER_FILE_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Per-run aggregate cap: the total `results/` budget for one orchestrate run.
 * When the sum exceeds this, the run-GC evicts oldest-first via
 * {@link selectEvictions}. ~64 MiB (8× the per-file cap) is a sane default.
 */
export const PER_RUN_AGGREGATE_CAP_BYTES = 64 * 1024 * 1024;

/**
 * Whether `expiresAtIso` is strictly in the past relative to the injected
 * `nowMs` (the TTL eviction predicate). Exactly-at-expiry is NOT yet expired.
 */
export function isExpired(expiresAtIso: string, nowMs: number): boolean {
  return Date.parse(expiresAtIso) < nowMs;
}

/**
 * Compute an ISO-8601 expiry `ttlMs` after the injected `nowMs` (pure; reads no
 * ambient clock — `systemDateFrom` is a value→Date converter, not a clock read,
 * so the deterministic input→output property holds). Used to stamp
 * `ResultRef.expiresAt` at materialize time.
 */
export function computeExpiresAt(nowMs: number, ttlMs: number): string {
  return systemDateFrom(nowMs + ttlMs).toISOString();
}

/**
 * Select the oldest result files to evict until the total size is at or below
 * `aggregateCapBytes` (pure; deterministic). The kept set is chosen newest-first
 * (the freshest results survive); everything that does NOT fit under the cap is
 * evicted. The returned paths are ordered OLDEST-first (ascending `createdAtMs`)
 * — the natural deletion order. Returns `[]` when the input already fits.
 */
export function selectEvictions(
  entries: ReadonlyArray<{ path: string; bytes: number; createdAtMs: number }>,
  aggregateCapBytes: number,
): string[] {
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= aggregateCapBytes) return [];

  // Keep newest-first; whatever no longer fits under the cap is evicted.
  const newestFirst = [...entries].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const evicted: { path: string; createdAtMs: number }[] = [];
  let kept = 0;
  for (const e of newestFirst) {
    if (kept + e.bytes <= aggregateCapBytes) {
      kept += e.bytes; // this (newer) entry survives
    } else {
      evicted.push({ path: e.path, createdAtMs: e.createdAtMs }); // among the oldest → evict
    }
  }
  // Return the evicted paths oldest-first (the deletion order callers expect).
  return evicted
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((e) => e.path);
}

/**
 * Reject a materialize that exceeds the per-file cap. Returns `ok` when
 * `bytes <= capBytes`, else an `err` carrying the overflow so the store can
 * surface an honest `result_ref_too_large` instead of writing/clamping.
 */
export function checkPerFileCap(
  bytes: number,
  capBytes: number,
): Result<void, { kind: "result_ref_too_large"; bytes: number; cap: number }> {
  if (bytes <= capBytes) return ok(undefined);
  return err({ kind: "result_ref_too_large", bytes, cap: capBytes });
}
