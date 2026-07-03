// SPDX-License-Identifier: Apache-2.0
import type { ErrorKind } from "@comis/core";

/**
 * Session-health rollup: the five health fields persisted onto
 * `SessionMetadata.sessionEnd` and emitted on `session:summary`.
 *
 * - `degraded`        — the run finished in a non-clean state (tool errors,
 *                       budget/breaker/provider trips, or a hard error). Derived
 *                       from the mapped `endReason` (≠ "success"), the SAME source
 *                       of truth as the co-persisted `sessionEnd.endReason`.
 * - `costUsd`         — cumulative USD cost for the session.
 * - `toolStats`       — per-tool {ok, failed} counts; bounded by the distinct
 *                       tool count of one execution (small).
 * - `breakerTripCount`— how many times a tool circuit breaker opened.
 * - `topErrorKinds`   — the top ErrorKinds by failure count, hard-capped at 3.
 *                       Keys are members of the closed `ErrorKind` union ONLY
 *                       (sourced from the per-tool `errorKind`), never free text.
 */
export interface SessionHealthRollup {
  degraded: boolean;
  costUsd: number;
  toolStats: Record<string, { ok: number; failed: number }>;
  breakerTripCount: number;
  /** Keys ⊂ ErrorKind union; bounded to the top 3 by count. */
  topErrorKinds: Record<string, number>;
}

/**
 * The narrow structural slice of `bridgeResult` this reduce consumes — NOT the
 * whole `ExecutionResult`. `toolExecResults[i]` carries the optional
 * `errorKind`, and `breakerTripCount` is accumulated on the bridge.
 */
interface RollupInput {
  sessionCostUsd?: number;
  breakerTripCount?: number;
  toolExecResults?: ReadonlyArray<{
    toolName: string;
    success: boolean;
    errorKind?: ErrorKind;
  }>;
}

/**
 * The ONLY clean (non-degraded) `endReason`. Single source of truth: a run is
 * degraded iff its persisted `SessionMetadata.sessionEnd.endReason` is not
 * `"success"`. The chokepoint maps the finish reason through `END_REASON_MAP`
 * (executor-post-execution.ts — the one authoritative table) and passes that
 * SAME mapped value here, so `degraded` and `endReason` can never disagree.
 *
 * Do NOT reintroduce a separate hand-maintained set of degraded finish
 * reasons: any set kept apart from `END_REASON_MAP` silently diverges (e.g.
 * `loop_detected` and `session_reset` map to `endReason:"error"` via the
 * map's fallthrough, so a set that omits them would record a runaway-loop /
 * session-reset abort as `degraded:false`). Deriving from the mapped
 * `endReason` removes the second domain entirely, so a newly added finish
 * reason cannot open a divergence.
 */
const CLEAN_END_REASONS: ReadonlySet<string> = new Set<string>(["success"]);

/** How many distinct ErrorKinds the rollup keeps — hard cap, DoS-bounded. */
const TOP_ERROR_KINDS_CAP = 3;

/**
 * Pure reduce over accumulated bridge state → the five health fields.
 *
 * Same inputs always produce the same output: no reads, no writes, no time
 * source, no event emission. The fire-and-forget persist/emit guards live at the
 * post-execution call site.
 *
 * @param bridgeResult - the narrow bridge slice (cost, breaker trips, per-tool results).
 * @param endReason - the ALREADY-MAPPED `SessionMetadata.sessionEnd.endReason`
 *   (the SAME value persisted onto sessionEnd, derived once at the chokepoint via
 *   `END_REASON_MAP`). `degraded := endReason !== "success"` — see CLEAN_END_REASONS.
 */
export function buildSessionHealthRollup(
  bridgeResult: RollupInput,
  endReason: string,
): SessionHealthRollup {
  // Map-keyed accumulation (no plain-object dynamic-key sink); the typed Record
  // outputs are built once at the end via Object.fromEntries.
  const toolStatsMap = new Map<string, { ok: number; failed: number }>();
  // ErrorKind-keyed so every key is a union member by construction.
  const rawErrorKinds = new Map<ErrorKind, number>();

  for (const r of bridgeResult.toolExecResults ?? []) {
    let stat = toolStatsMap.get(r.toolName);
    if (stat === undefined) {
      stat = { ok: 0, failed: 0 };
      toolStatsMap.set(r.toolName, stat);
    }
    if (r.success) {
      stat.ok += 1;
    } else {
      stat.failed += 1;
      if (r.errorKind !== undefined) {
        rawErrorKinds.set(r.errorKind, (rawErrorKinds.get(r.errorKind) ?? 0) + 1);
      }
    }
  }

  // Top-N by count (descending). The cap bounds the map so it cannot grow with
  // failure volume.
  const topErrorKinds: Record<string, number> = Object.fromEntries(
    [...rawErrorKinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_ERROR_KINDS_CAP),
  );

  // Single source of truth: degraded iff the mapped endReason is not "success".
  // The chokepoint derives endReason once via END_REASON_MAP and passes it here,
  // so this can never contradict the co-persisted sessionEnd.endReason.
  const degraded = !CLEAN_END_REASONS.has(endReason);

  return {
    degraded,
    costUsd: bridgeResult.sessionCostUsd ?? 0,
    toolStats: Object.fromEntries(toolStatsMap),
    breakerTripCount: bridgeResult.breakerTripCount ?? 0,
    topErrorKinds,
  };
}
