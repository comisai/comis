// SPDX-License-Identifier: Apache-2.0
import type { ErrorKind } from "@comis/core";

/**
 * F1 session-health rollup: the five health fields persisted onto
 * `SessionMetadata.sessionEnd` and emitted on `session:summary`.
 *
 * - `degraded`        — the run finished in a non-clean state (tool errors,
 *                       budget/breaker/provider trips, or a hard error).
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
 * whole `ExecutionResult`. After Phase 152-01, `toolExecResults[i]` carries the
 * optional `errorKind`, and `breakerTripCount` is accumulated on the bridge.
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
 * The closed degraded-reason set (design §5 D5). A run whose
 * `effectiveFinishReason` is one of these is degraded. Mirrors the non-success
 * values of `END_REASON_MAP` in executor-post-execution.ts.
 */
export const DEGRADED_REASONS: ReadonlySet<string> = new Set<string>([
  "completed_with_tool_errors",
  "budget_exceeded",
  "budget_exhausted",
  "circuit_open",
  "provider_degraded",
]);

/**
 * The END_REASON_MAP "error" class — reasons that map to endReason "error".
 * A hard error is also degraded.
 */
const ERROR_CLASS_REASONS: ReadonlySet<string> = new Set<string>([
  "error",
  "max_steps",
  "context_loop",
  "context_exhausted",
]);

/** How many distinct ErrorKinds the rollup keeps — hard cap, DoS-bounded. */
const TOP_ERROR_KINDS_CAP = 3;

/**
 * Pure reduce over accumulated bridge state → the five F1 health fields.
 *
 * Same inputs always produce the same output: no reads, no writes, no time
 * source, no event emission. The fire-and-forget persist/emit guards live at the
 * post-execution call site (Plan 04).
 */
export function buildSessionHealthRollup(
  bridgeResult: RollupInput,
  effectiveFinishReason: string,
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

  const degraded =
    DEGRADED_REASONS.has(effectiveFinishReason) ||
    ERROR_CLASS_REASONS.has(effectiveFinishReason);

  return {
    degraded,
    costUsd: bridgeResult.sessionCostUsd ?? 0,
    toolStats: Object.fromEntries(toolStatsMap),
    breakerTripCount: bridgeResult.breakerTripCount ?? 0,
    topErrorKinds,
  };
}
