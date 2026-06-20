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
// QT1 — toolStats reconciliation (obs.explain ↔ obs.fleet.health).
// ---------------------------------------------------------------------------

/** A {ok, failed} count pair (defensively coerced from an untrusted source). */
interface CountPair {
  ok: number;
  failed: number;
}

/** One tool whose persisted rollup count differs from the trajectory count. */
interface ToolStatsDivergence {
  tool: string;
  rollup: CountPair;
  trajectory: CountPair;
}

/** The QT1 reconciliation block attached to `coverage.toolStats`. */
interface ToolStatsReconciliation {
  reconciled: boolean;
  rollupSource: "last-execution";
  divergentTools: ToolStatsDivergence[];
}

/** Read a `{ok, failed}` pair from an untrusted record (missing → finite zeros). */
function countPairOf(raw: unknown): CountPair {
  const entry = asRecord(raw);
  if (entry === undefined) return { ok: 0, failed: 0 };
  return { ok: asNumber(entry.ok) ?? 0, failed: asNumber(entry.failed) ?? 0 };
}

/**
 * Reconcile the WHOLE-session trajectory toolStats (`obs.explain`'s headline,
 * complete) against the persisted per-session rollup toolStats (`obs.fleet.health`'s
 * source, latest-execution-wins).
 *
 * The two lenses read structurally-different sources and so CAN differ — but only
 * in ONE direction: the rollup is built per-execution and the `_session-metadata`
 * `sessionEnd` is overwritten each execution, while the trajectory `.jsonl` is
 * APPENDED across every execution. So the rollup is a SUBSET of the trajectory:
 * `rollup.{ok,failed} ≤ trajectory.{ok,failed}` per tool. That is the documented,
 * bounded reason `comis explain` and `comis fleet` can show different per-tool
 * numbers for the same session — they MUST NOT contradict beyond it.
 *
 * - `divergentTools` lists every tool whose persisted rollup count differs from
 *   the trajectory count (in EITHER direction), with both pairs — so an operator
 *   cross-referencing the two commands sees exactly the gap. Deterministically
 *   sorted by tool name (no clock/order dependence).
 * - `reconciled` is the directional invariant: `true` iff every rollup count is
 *   `≤` its trajectory count. A rollup OVERcount — including a tool present in the
 *   rollup but ABSENT from the trajectory (trajectory pair is 0/0) — is the
 *   FORBIDDEN direction (the rollup counted something the trajectory never
 *   recorded, a genuine accounting bug) and flips `reconciled` to `false`, so the
 *   contradiction is surfaced here rather than hidden behind the headline.
 *
 * Pure, bounded (counts + tool names only, capped by the union of the two tool
 * sets — the same bound as `toolStats`).
 */
function reconcileToolStats(
  trajectory: IncidentSignals["toolStats"],
  rollupToolStats: Record<string, unknown> | undefined,
): ToolStatsReconciliation {
  const divergentTools: ToolStatsDivergence[] = [];
  let reconciled = true;

  // Only the rollup's tools can produce a fleet/explain divergence: a
  // trajectory-only tool (not in the rollup) is expected (the rollup is the last
  // execution) and is NOT a contradiction — fleet simply has not persisted it.
  // A rollup tool whose count exceeds the trajectory IS a contradiction.
  for (const tool of Object.keys(rollupToolStats ?? {}).sort()) {
    const rollup = countPairOf((rollupToolStats ?? {})[tool]);
    const trajStat = trajectory[tool];
    const traj: CountPair = trajStat === undefined
      ? { ok: 0, failed: 0 }
      : { ok: trajStat.ok, failed: trajStat.failed };
    if (rollup.ok === traj.ok && rollup.failed === traj.failed) continue;
    divergentTools.push({ tool, rollup, trajectory: traj });
    // The forbidden direction: rollup must never OVERcount the trajectory.
    if (rollup.ok > traj.ok || rollup.failed > traj.failed) reconciled = false;
  }

  return { reconciled, rollupSource: "last-execution", divergentTools };
}

// ---------------------------------------------------------------------------
// Public assembler.
// ---------------------------------------------------------------------------

/**
 * Assemble a §6.3 {@link IncidentReport} from the normalized signals + the F1
 * metadata rollup (primary) + the F2 diagnostics rollup (fallback). Pure —
 * no I/O, no LLM. `likelyRootCause` stays `null` (Plan 05) and `truncations`
 * stays `[]` (Plan 04).
 *
 * `recordCount` is the number of trajectory records the reader READ (the length
 * of `readSessionRecords`' result, threaded from the handler). It drives
 * `coverage.trajectory` — READ-coverage meta-observability, NOT cost. A
 * d510322f-class "read nothing" bug surfaces as `coverage.trajectory.records: 0`
 * on a report that otherwise looks like a clean zero-activity session.
 */
export function assembleIncidentReport(
  signals: IncidentSignals,
  metadata: Record<string, unknown> | null,
  rollup: Record<string, unknown> | null,
  sessionKey: string,
  recordCount: number,
): IncidentReport {
  const sessionEnd = sessionEndOf(metadata);
  const rollupPayload = rollupPayloadOf(rollup);

  // --- outcome -------------------------------------------------------------
  // The FROZEN 678 fixture's session-metadata.json carries the rollup fields at
  // the metadata TOP LEVEL with no nested `sessionEnd` (endReason / durationMs /
  // totalTokens / sessionCostUsd / degraded). Post-152 sessions nest them under
  // `sessionEnd`. Read `sessionEnd.<field>` first, then the metadata top-level
  // field of the same name — so BOTH on-disk shapes resolve.
  const endReason =
    (sessionEnd !== undefined ? asString(sessionEnd.endReason) : undefined) ??
    (metadata !== null ? asString(metadata.endReason) : undefined) ??
    "unknown";
  const isHardFailure = HARD_FAILURE_END_REASONS.has(endReason);
  const explicitDegraded =
    (sessionEnd !== undefined ? asBoolean(sessionEnd.degraded) : undefined) ??
    (metadata !== null ? asBoolean(metadata.degraded) : undefined) ??
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
  // WR-02: read cacheReadRatio from the metadata top level too (the field name
  // is identical at the top level), matching durationMs/totalTokens — the frozen
  // 678 fixture is flat (no nested sessionEnd), so a top-level-only value was
  // silently dropped when topAlias was undefined and mis-reported as 0.
  const cacheReadRatio = readRollupNumber(sessionEnd, metadata, rollupPayload, "cacheReadRatio", "cacheReadRatio", 0);

  // --- timing --------------------------------------------------------------
  // durationMs also lives at the metadata top level in the frozen-678 shape.
  const durationMs = readRollupNumber(sessionEnd, metadata, rollupPayload, "durationMs", "durationMs", 0);
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
  // W8: fall back to the signals-derived identity (trajectory envelopes +
  // session.started) — the live metadata rollup carries neither field, so a
  // real session's report printed empty strings.
  const agentId =
    (metadata !== null ? asString(metadata.agentId) : undefined) ?? signals.agentId ?? "";
  const channelRecord = metadata !== null ? asRecord(metadata.channel) : undefined;
  const channel = {
    type:
      (channelRecord !== undefined ? asString(channelRecord.type) : undefined) ??
      signals.channel?.type ??
      "",
    id:
      (channelRecord !== undefined ? asString(channelRecord.id) : undefined) ??
      signals.channel?.id ??
      "",
  };

  // --- deterministic summary one-liner (NO LLM) ----------------------------
  const summary = `${failures.length} tool failures across ${turnCount} turns; endReason=${endReason}`;

  // --- READ-coverage (meta-observability, NOT cost) ------------------------
  // Did the assembler actually locate + read each source? `recordCount` is the
  // reader's READ count (records.length, threaded from the handler) — distinct
  // from "the trajectory yielded failures". `rollup.present` reflects the F1
  // PRIMARY sessionEnd rollup the report is built from. `pointersResolved`
  // counts offloads whose pointer resolved (signals emit "<offloaded>" when it
  // did not). A silently-empty read is now self-evident here instead of
  // masquerading as a clean session.
  const offloadsResolved = offloads.filter((o) => o.pointer !== "<offloaded>").length;
  // QT1 — reconcile the headline (whole-session trajectory) toolStats against the
  // persisted per-session rollup that obs.fleet.health reads (latest-execution).
  // Makes the structural divergence TRANSPARENT (rollup ⊆ trajectory) so the two
  // commands can never silently contradict for the same session.
  const toolStatsReconciliation = reconcileToolStats(signals.toolStats, rollupToolStats);
  const coverage = {
    trajectory: { found: recordCount > 0, records: recordCount },
    rollup: { present: sessionEnd !== undefined },
    offloads: { pointersResolved: offloadsResolved, pointersTotal: offloads.length },
    toolStats: toolStatsReconciliation,
  };

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
    // ORCH-OBS: per-node token-budget breaches (BUDGET-03) reconstructed from the
    // session's subagent.budget_exceeded records — capSource names WHICH knob bound
    // each node. Absent when the session had no breach (additive; schemaVersion 1).
    ...((signals.nodeBudgetBreaches ?? []).length > 0 ? { nodeBudgetBreaches: signals.nodeBudgetBreaches } : {}),
    // W3: the terminal per-call budget equation (absent for pre-W2 sessions).
    ...(signals.contextBudget !== undefined ? { contextBudget: signals.contextBudget } : {}),
    // RECALL-01: the memory-recall outcome (absent when the trajectory has no recall records).
    ...(signals.recall !== undefined ? { recall: signals.recall } : {}),
    // PERSIST-01 (176-05): the per-reason cache breaks (absent when the session
    // had none). Bounded to CACHE_BREAKS_CAP highest-count-first; the bound pass
    // (obs-explain-bound.ts) records a truncations[] breadcrumb when it sheds the
    // tail (GBIII I2). Content-free (counts + closed reason label + a number).
    ...(signals.cacheBreaks !== undefined && signals.cacheBreaks.length > 0
      ? { cacheBreaks: signals.cacheBreaks }
      : {}),
    // OBS-03/OBS-04 (186): the image-generation turn reconstructed from the
    // trajectory's image.* records (absent when the session generated no image).
    // The cost rides here so `comis explain` shows it (Route a — NOT cost.costUsd,
    // which reads the executor sessionEnd, a different path; Pitfall 2).
    ...(signals.image !== undefined ? { image: signals.image } : {}),
    // VIS-04 (187): the vision turn reconstructed from the trajectory's
    // media.vision.* records (absent when the session ran no vision). The vision
    // cost rides here too (Route a) — the image/vision folds are independent.
    ...(signals.vision !== undefined ? { vision: signals.vision } : {}),
    // OBS-04 (192): the VIDEO turn reconstructed from the trajectory's video.*
    // records (absent when the session generated no video). Reconstructs a
    // background-completed job too — the in-turn video.submitted ties the later
    // off-turn video.generated via jobId/traceId on one sessionKey. Cost rides
    // here (Route a). The offline assembler is the binding OBS-04 oracle.
    ...(signals.videoGenerated !== undefined ? { videoGenerated: signals.videoGenerated } : {}),
    // OBS-02 (196): the VOICE turn reconstructed from the trajectory's
    // media.stt.* / media.tts.* records (absent when the session ran no voice).
    // Wholly in-turn (the daemon voice RPC handlers direct-emit). Cost rides here
    // (Route a): keyless `costUsd:0` is VISIBLE (OBS-05), keyed cost is omitted
    // (FLAG 4). The offline assembler is the binding OBS-02 oracle.
    ...(signals.voice !== undefined ? { voice: signals.voice } : {}),
    // OBS-02 (198): the Verified-Learning outcome signal reconstructed from the
    // trajectory's learning.outcome_observed records (absent when the session
    // recorded no outcome). Counts/ids/closed-enums only; drives outcome_unresolved.
    ...(signals.learning !== undefined ? { learning: signals.learning } : {}),
    summary,
    // Plan 05 fills likelyRootCause; Plan 04 fills truncations; Plan 05 fills
    // the report-level suggestedNextSteps.
    likelyRootCause: null,
    suggestedNextSteps: [],
    truncations: [],
    coverage,
  };
}
