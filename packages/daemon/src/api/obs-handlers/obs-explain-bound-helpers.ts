// SPDX-License-Identifier: Apache-2.0
/**
 * Pure leaf helpers for the report-level bounding pass {@link
 * import("./obs-explain-bound.js").boundIncidentReport}. Extracted from
 * `obs-explain-bound.ts` to keep that module under the obs-handlers
 * per-subdirectory file-size cap (the spawnTree cap pushed it over) — the
 * file-size-cap-driven extraction precedent (obs-explain-bound-caps.ts,
 * obs-orchestration-rows.ts, obs-audit-sink.ts). No behavior change.
 *
 * Pure module — no I/O, no logging, no globals.
 *
 * @module
 */

import { fingerprint } from "@comis/core";
import { MAX_INLINE_STRING } from "./obs-explain-bound-caps.js";

/**
 * A single honest-lossiness ledger entry: the report-level sentinel. Distinct
 * from `limitPayloadValue`'s structural `{__bounded__:…}` sentinel.
 */
export interface TruncationEntry {
  field: string;
  reason: string;
  pointer?: string;
}

/**
 * Cap a `{seq:number}`-keyed array to its `max` NEWEST entries (highest seq
 * first), pushing an honest `truncations[]` entry naming the dropped tail when
 * it fires. Used by the breaker/offload caps (failures has bespoke
 * messaging inline). Re-sorts defensively so "newest" is well-defined
 * regardless of upstream ordering; a no-op (returns the input array) when the
 * length is already within budget so a clean report records no spurious entry.
 */
export function capNewestFirst<T extends { seq: number }>(
  arr: readonly T[],
  max: number,
  field: string,
  truncations: TruncationEntry[],
): T[] {
  if (arr.length <= max) return [...arr];
  const sorted = [...arr].sort((a, b) => b.seq - a.seq);
  truncations.push({
    field,
    reason: `capped at ${max} newest entries (had ${arr.length})`,
    pointer: "obs.explain depth=full",
  });
  return sorted.slice(0, max);
}

/**
 * Collapse a free-text scalar string to a `[digest:…]` fingerprint when it
 * exceeds `MAX_INLINE_STRING`, pushing an honest `truncations[]` entry under
 * `field`. Returns the input unchanged (and records nothing) when within the
 * cap. The STRING→string shape is preserved so the structural backstop never
 * coerces the field into a `{__bounded__}` sentinel and the schema's `string`
 * type still holds. Used by the report-level free-text sweep
 * (channel.id/type, agentId, traceId, endReason) — these come from session
 * metadata (channel.id is channel/peer-derived, attacker-influenced) and are
 * otherwise bounded only by `limitPayloadValue`'s 32 KB floor.
 */
export function digestIfOversized(
  value: string,
  field: string,
  truncations: TruncationEntry[],
): string {
  if (value.length <= MAX_INLINE_STRING) return value;
  truncations.push({
    field,
    reason: `oversized (${value.length} chars) — replaced with digest`,
  });
  return `[digest:${fingerprint(value)}]`;
}
