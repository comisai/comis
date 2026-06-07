// SPDX-License-Identifier: Apache-2.0
/**
 * `assembleIncidentReport` — the pure Wave-3 assembler.
 *
 * Merges three already-normalized, already-bounded inputs into one §6.3
 * {@link IncidentReport}:
 *
 *   1. `signals` — the {@link IncidentSignals} from `toIncidentSignals` (Plan 02):
 *      per-tool stats, normalized failures (newest-first), the breaker timeline,
 *      and large-result offloads. Its `errorPreview` is already ≤200 chars and
 *      redacted, its offload pointers already relativized — this assembler only
 *      re-shapes them onto the wire type and introduces NO raw body (T-153-08).
 *   2. `metadata` — the F1 `_session-metadata.json` rollup (PRIMARY, per OQ3):
 *      the `sessionEnd` Phase-152 rollup (endReason / durationMs / totalTokens /
 *      degraded / costUsd / toolStats / …) plus top-level identity fields.
 *   3. `rollup` — the F2 `obs_diagnostics` session_summary row (FALLBACK): read
 *      ONLY when the F1 metadata field is absent. The rich payload may sit at the
 *      row top level OR inside a JSON-encoded `details` string.
 *
 * PURITY: no `fs`, no `crypto` beyond what the signals already carry, no
 * `eventBus`, no LLM. A deterministic merge/reduce — drive it with synthetic
 * signals/metadata in a unit test (the clean TDD seam; Plan 05 wires the handler
 * reader→normalize→assemble→heuristics→bound linearly).
 *
 * Two fields are deliberately left for downstream plans:
 *   - `likelyRootCause` stays `null` — the deterministic heuristic registry
 *     (Plan 05) populates it.
 *   - `truncations` starts `[]` and `suggestedNextSteps` starts `[]` — the
 *     Plan-04 bounding pass records its lossiness ledger and (with Plan 05) the
 *     report-level guidance.
 *
 * @module
 */

import type { IncidentReport, IncidentSignals } from "@comis/core";

// ---------------------------------------------------------------------------
// Closed endReason classification sets (design D5).
// ---------------------------------------------------------------------------

/**
 * Hard-failure endReasons → `severity: "failed"`. These are also degraded by
 * construction (a hard failure is never "ok"). String-literal closed set.
 */
const HARD_FAILURE_END_REASONS: ReadonlySet<string> = new Set([
  "error",
  "timeout",
  "circuit_open",
  "budget_exceeded",
  "budget_exhausted",
]);

/**
 * Degraded-but-not-failed endReasons → `degraded: true`, `severity: "degraded"`
 * (when not already a hard failure). Union with the hard-failure set gives the
 * full "this session did not end cleanly" classifier used for the derived
 * `degraded` flag when no explicit flag is present.
 */
const DEGRADED_END_REASONS: ReadonlySet<string> = new Set([
  "completed_with_tool_errors",
  "provider_degraded",
]);

// ---------------------------------------------------------------------------
// Defensive field reads (every external object is `Record<string, unknown>`).
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** The `sessionEnd` sub-object of the F1 metadata (or `undefined`). */
function sessionEndOf(metadata: Record<string, unknown> | null): Record<string, unknown> | undefined {
  return metadata === null ? undefined : asRecord(metadata.sessionEnd);
}

/**
 * The F2 rollup payload. The `obs_diagnostics` row carries the rich rollup at
 * the row top level OR inside a JSON-encoded `details` string — return a merged
 * view (top-level wins) so a field read works against either shape.
 */
function rollupPayloadOf(rollup: Record<string, unknown> | null): Record<string, unknown> {
  if (rollup === null) return {};
  let fromDetails: Record<string, unknown> = {};
  const details = asString(rollup.details);
  if (details !== undefined) {
    try {
      const parsed = JSON.parse(details) as unknown;
      fromDetails = asRecord(parsed) ?? {};
    } catch {
      // Non-JSON details — ignore; the top-level fields (if any) still apply.
    }
  }
  return { ...fromDetails, ...rollup };
}

/**
 * Read a rollup numeric field with the F1-primary fallback chain:
 *   `sessionEnd.<field>` → metadata top-level `<topAlias>` → F2 `rollup.<field>`
 *   → the literal `fallback`.
 */
function readRollupNumber(
  sessionEnd: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | null,
  rollupPayload: Record<string, unknown>,
  field: string,
  topAlias: string | undefined,
  fallback: number,
): number {
  const fromSessionEnd = sessionEnd === undefined ? undefined : asNumber(sessionEnd[field]);
  if (fromSessionEnd !== undefined) return fromSessionEnd;
  if (topAlias !== undefined && metadata !== null) {
    const fromTop = asNumber(metadata[topAlias]);
    if (fromTop !== undefined) return fromTop;
  }
  const fromRollup = asNumber(rollupPayload[field]);
  if (fromRollup !== undefined) return fromRollup;
  return fallback;
}

// ---------------------------------------------------------------------------
// Public assembler.
// ---------------------------------------------------------------------------

/**
 * Assemble a §6.3 {@link IncidentReport} from the normalized signals + the F1
 * metadata rollup (primary) + the F2 diagnostics rollup (fallback). Pure —
 * no I/O, no LLM. `likelyRootCause` stays `null` (Plan 05) and `truncations`
 * stays `[]` (Plan 04).
 */
export function assembleIncidentReport(
  signals: IncidentSignals,
  metadata: Record<string, unknown> | null,
  rollup: Record<string, unknown> | null,
  sessionKey: string,
): IncidentReport {
  const sessionEnd = sessionEndOf(metadata);
  const rollupPayload = rollupPayloadOf(rollup);

  // --- outcome -------------------------------------------------------------
  const endReason =
    (sessionEnd !== undefined ? asString(sessionEnd.endReason) : undefined) ?? "unknown";
  const isHardFailure = HARD_FAILURE_END_REASONS.has(endReason);
  const explicitDegraded =
    (sessionEnd !== undefined ? asBoolean(sessionEnd.degraded) : undefined) ??
    asBoolean(rollupPayload.degraded);
  const derivedDegraded = isHardFailure || DEGRADED_END_REASONS.has(endReason);
  const degraded = explicitDegraded ?? derivedDegraded;
  const severity: "ok" | "degraded" | "failed" = isHardFailure
    ? "failed"
    : degraded
      ? "degraded"
      : "ok";

  // --- cost ----------------------------------------------------------------
  const costUsd = readRollupNumber(sessionEnd, metadata, rollupPayload, "costUsd", "sessionCostUsd", 0);
  const totalTokens = readRollupNumber(sessionEnd, metadata, rollupPayload, "totalTokens", "totalTokens", 0);
  const cacheReadRatio = readRollupNumber(sessionEnd, metadata, rollupPayload, "cacheReadRatio", undefined, 0);

  // --- timing --------------------------------------------------------------
  const durationMs = readRollupNumber(sessionEnd, metadata, rollupPayload, "durationMs", undefined, 0);
  // turnCount: prefer an explicit rollup turn count; else derive from the
  // per-tool invocation totals (a deterministic lower bound, never 0 when any
  // tool ran), else 0.
  const explicitTurns = readRollupNumber(sessionEnd, metadata, rollupPayload, "turnCount", "turnCount", 0);
  let toolInvocations = 0;
  for (const stat of Object.values(signals.toolStats)) {
    toolInvocations += stat.ok + stat.failed;
  }
  const turnCount = explicitTurns > 0 ? explicitTurns : toolInvocations;

  // --- toolStats merge (signal counts win on overlap; rollup-only surfaced) -
  const toolStats: IncidentReport["toolStats"] = {};
  const rollupToolStats = asRecord(sessionEnd?.toolStats) ?? asRecord(rollupPayload.toolStats);
  if (rollupToolStats !== undefined) {
    for (const [tool, raw] of Object.entries(rollupToolStats)) {
      const entry = asRecord(raw);
      if (entry === undefined) continue;
      toolStats[tool] = {
        ok: asNumber(entry.ok) ?? 0,
        failed: asNumber(entry.failed) ?? 0,
      };
    }
  }
  for (const [tool, stat] of Object.entries(signals.toolStats)) {
    // Signal stats are authoritative (the normalizer counted the actual lines).
    toolStats[tool] = {
      ok: stat.ok,
      failed: stat.failed,
      ...(stat.topErrorKind !== undefined ? { topErrorKind: stat.topErrorKind } : {}),
    };
  }

  // --- failures (newest-first), breaker timeline, offloads -----------------
  // Copy then sort defensively (descending seq) so "newest-first" is well-
  // defined regardless of upstream ordering. The entries are already bounded.
  const failures = [...signals.failures].sort((a, b) => b.seq - a.seq);
  const breakerTimeline = [...signals.breakerEvents];
  const offloads = [...signals.offloads];

  // --- identity ------------------------------------------------------------
  const traceId =
    (metadata !== null ? asString(metadata.traceId) : undefined) ??
    (metadata !== null ? asString(metadata.secondTurnTraceId) : undefined) ??
    "";
  const agentId = (metadata !== null ? asString(metadata.agentId) : undefined) ?? "";
  const channelRecord = metadata !== null ? asRecord(metadata.channel) : undefined;
  const channel = {
    type: (channelRecord !== undefined ? asString(channelRecord.type) : undefined) ?? "",
    id: (channelRecord !== undefined ? asString(channelRecord.id) : undefined) ?? "",
  };

  // --- deterministic summary one-liner (NO LLM) ----------------------------
  const summary = `${failures.length} tool failures across ${turnCount} turns; endReason=${endReason}`;

  return {
    schemaVersion: 1,
    sessionKey,
    traceId,
    agentId,
    channel,
    outcome: { endReason, degraded, severity },
    cost: { costUsd, totalTokens, cacheReadRatio },
    timing: { durationMs, turnCount },
    toolStats,
    failures,
    breakerTimeline,
    offloads,
    summary,
    // Plan 05 fills likelyRootCause; Plan 04 fills truncations; Plan 05 fills
    // the report-level suggestedNextSteps.
    likelyRootCause: null,
    suggestedNextSteps: [],
    truncations: [],
  };
}
