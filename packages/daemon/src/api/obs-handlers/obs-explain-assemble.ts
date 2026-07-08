// SPDX-License-Identifier: Apache-2.0
/**
 * `assembleIncidentReport` — the pure incident-report assembler.
 *
 * Merges three already-normalized, already-bounded inputs into one
 * {@link IncidentReport}:
 *
 *   1. `signals` — the {@link IncidentSignals} from `toIncidentSignals`:
 *      per-tool stats, normalized failures (newest-first), the breaker timeline,
 *      and large-result offloads. Its `errorPreview` is already ≤200 chars and
 *      redacted, its offload pointers already relativized — this assembler only
 *      re-shapes them onto the wire type and introduces NO raw body.
 *   2. `metadata` — the F1 `_session-metadata.json` rollup (PRIMARY):
 *      the nested `sessionEnd` rollup (endReason / durationMs / totalTokens /
 *      degraded / costUsd / toolStats / …) plus top-level identity fields.
 *   3. `rollup` — the F2 `obs_diagnostics` session_summary row (FALLBACK): read
 *      ONLY when the F1 metadata field is absent. The rich payload may sit at the
 *      row top level OR inside a JSON-encoded `details` string.
 *
 * PURITY: no `fs`, no `crypto` beyond what the signals already carry, no
 * `eventBus`, no LLM. A deterministic merge/reduce — drive it with synthetic
 * signals/metadata in a unit test (the clean TDD seam; the handler wires
 * reader→normalize→assemble→heuristics→bound linearly).
 *
 * Two fields are deliberately left for downstream passes:
 *   - `likelyRootCause` stays `null` — the deterministic heuristic registry
 *     populates it.
 *   - `truncations` starts `[]` and `suggestedNextSteps` starts `[]` — the
 *     bounding pass records its lossiness ledger and the heuristics pass adds
 *     the report-level guidance.
 *
 * @module
 */

import type { IncidentReport, IncidentSignals } from "@comis/core";

// ---------------------------------------------------------------------------
// Closed endReason classification sets.
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
  // The dollars kill-switch abort is a hard failure (never
  // "ok") — so `comis explain` marks severity:"failed" and `comis fleet`
  // degradedByCause buckets the spend-killed session on the named "spend_exceeded"
  // cause instead of leaving it in the generic "error" bucket.
  "spend_exceeded",
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
// toolStats reconciliation (obs.explain ↔ obs.fleet.health).
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

/** The reconciliation block attached to `coverage.toolStats`. */
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
 * Assemble an {@link IncidentReport} from the normalized signals + the F1
 * metadata rollup (primary) + the F2 diagnostics rollup (fallback). Pure —
 * no I/O, no LLM. `likelyRootCause` stays `null` (the heuristics pass fills
 * it) and `truncations` stays `[]` (the bounding pass fills it).
 *
 * `recordCount` is the number of trajectory records the reader READ (the length
 * of `readSessionRecords`' result, threaded from the handler). It drives
 * `coverage.trajectory` — READ-coverage meta-observability, NOT cost. A
 * silent read-nothing bug surfaces as `coverage.trajectory.records: 0`
 * on a report that otherwise looks like a clean zero-activity session.
 */
export function assembleIncidentReport(
  signals: IncidentSignals,
  metadata: Record<string, unknown> | null,
  rollup: Record<string, unknown> | null,
  sessionKey: string,
  recordCount: number,
  /**
   * The closest REAL session keys, populated by the async caller ONLY on a
   * 0-record miss (a lossy/partial key). Surfaced on `coverage.candidateSessionKeys`
   * so a silent empty report becomes a "did you mean …?". Defaults to `[]` (the
   * common resolved-record path adds no field). Stays PURE — the caller does the I/O.
   */
  candidateSessionKeys: readonly string[] = [],
): IncidentReport {
  const sessionEnd = sessionEndOf(metadata);
  const rollupPayload = rollupPayloadOf(rollup);

  // --- outcome -------------------------------------------------------------
  // The FROZEN 678 fixture's session-metadata.json carries the rollup fields at
  // the metadata TOP LEVEL with no nested `sessionEnd` (endReason / durationMs /
  // totalTokens / executionCostUsd / degraded). Live sessions nest them under
  // `sessionEnd`. Read `sessionEnd.<field>` first, then the metadata top-level
  // field of the same name — so BOTH on-disk shapes resolve.
  const endReason =
    (sessionEnd !== undefined ? asString(sessionEnd.endReason) : undefined) ??
    (metadata !== null ? asString(metadata.endReason) : undefined) ??
    // A HARD abort (per-root budget / loop) skips the clean
    // sessionEnd rollup, so the metadata endReason is absent — fall back to the
    // terminal `execution.aborted` reason captured from the trajectory. Without
    // this a per-root spend abort surfaced endReason:"unknown" → the spend-verdict
    // (gated on "spend_exceeded") never fired + perRootBudget stayed off the verdict.
    signals.abortReason ??
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
  // Prefer the TRAJECTORY-derived ledger sums (signals.summaryCostUsd = Σ of
  // the per-execution session.summary costs; signals.modelTokens = Σ of the
  // per-call model.completed token fields). The sessionEnd rollup is
  // overwritten by every execution, so its costUsd holds only the FINAL
  // execution's cost — a multi-execution session under-reported ~16× live —
  // and no rollup writer ever populates a cacheReadRatio. The rollup chain
  // stays the fallback for log-only sessions with no trajectory records.
  const costUsd =
    signals.summaryCostUsd ??
    // The topAlias is the FROZEN 678 fixture's flat metadata field name
    // (`sessionCostUsd`) — a data key on an immutable on-disk artifact, NOT the
    // renamed bridge field. It must stay `sessionCostUsd` to read the fixture.
    readRollupNumber(sessionEnd, metadata, rollupPayload, "costUsd", "sessionCostUsd", 0);
  const mt = signals.modelTokens;
  const totalTokens =
    mt !== undefined
      ? mt.input + mt.output + mt.cacheRead + mt.cacheCreation
      : readRollupNumber(sessionEnd, metadata, rollupPayload, "totalTokens", "totalTokens", 0);
  // Read cacheReadRatio from the metadata top level too (the field name
  // is identical at the top level), matching durationMs/totalTokens — the frozen
  // 678 fixture is flat (no nested sessionEnd), so a top-level-only value would
  // be silently dropped when topAlias is undefined and mis-reported as 0.
  const cacheReadRatio =
    mt !== undefined && mt.input + mt.cacheRead > 0
      ? mt.cacheRead / (mt.input + mt.cacheRead)
      : readRollupNumber(sessionEnd, metadata, rollupPayload, "cacheReadRatio", "cacheReadRatio", 0);

  // --- timing --------------------------------------------------------------
  // durationMs also lives at the metadata top level in the frozen-678 shape.
  const durationMs = readRollupNumber(sessionEnd, metadata, rollupPayload, "durationMs", "durationMs", 0);
  // turnCount: prefer the SUMMED per-execution ledger (Σ session.summary
  // turnCount — the rollup's turnCount is last-write-wins, so a multi-execution
  // session under-reported it: the incident's 11-turn session showed 1). Then
  // the explicit rollup turn count (log-only sessions), then the per-tool
  // invocation total (a deterministic lower bound, never 0 when any tool ran).
  const explicitTurns = readRollupNumber(sessionEnd, metadata, rollupPayload, "turnCount", "turnCount", 0);
  let toolInvocations = 0;
  for (const stat of Object.values(signals.toolStats)) {
    toolInvocations += stat.ok + stat.failed;
  }
  const turnCount =
    signals.summaryTurnCount !== undefined && signals.summaryTurnCount > 0
      ? signals.summaryTurnCount
      : explicitTurns > 0
        ? explicitTurns
        : toolInvocations;

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
  // Fall back to the signals-derived identity (trajectory envelopes +
  // session.started) — the live metadata rollup carries neither field, so a
  // real session's report would otherwise print empty strings.
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
  // Reconcile the headline (whole-session trajectory) toolStats against the
  // persisted per-session rollup that obs.fleet.health reads (latest-execution).
  // Makes the structural divergence TRANSPARENT (rollup ⊆ trajectory) so the two
  // commands can never silently contradict for the same session.
  const toolStatsReconciliation = reconcileToolStats(signals.toolStats, rollupToolStats);
  const coverage = {
    trajectory: { found: recordCount > 0, records: recordCount },
    rollup: { present: sessionEnd !== undefined },
    offloads: { pointersResolved: offloadsResolved, pointersTotal: offloads.length },
    toolStats: toolStatsReconciliation,
    // "did you mean …?" — only when the request resolved nothing AND the caller
    // found closer real keys (a lossy/partial key). Omitted otherwise.
    ...(candidateSessionKeys.length > 0 ? { candidateSessionKeys: [...candidateSessionKeys] } : {}),
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
    // Per-node token-budget breaches reconstructed from the
    // session's subagent.budget_exceeded records — capSource names WHICH knob bound
    // each node. Absent when the session had no breach (additive; schemaVersion 1).
    ...((signals.nodeBudgetBreaches ?? []).length > 0 ? { nodeBudgetBreaches: signals.nodeBudgetBreaches } : {}),
    // The root→children spawn tree reconstructed from the
    // session's capability.audited records (one node per leaseId; each carries its
    // attenuated caps, tool NAMES, and any CapabilityDeniedError cap in denials).
    // Absent when the session emitted no per-cap audit records (additive;
    // schemaVersion 1) — the offline path assembles it for free (same assembler).
    ...((signals.spawnTree ?? []).length > 0 ? { spawnTree: signals.spawnTree } : {}),
    // The per-run orchestrate section reconstructed from the session's
    // orchestrate.run_summary records (one entry per run; each carries its
    // failureClass, the per-run toolCalls/denials attributed by the child leaseId,
    // and the labeled savings estimate). Absent when the session ran no orchestrate
    // script (additive; schemaVersion 1) — the spawnTree presence-conditional mold.
    ...((signals.orchestrate ?? []).length > 0 ? { orchestrate: signals.orchestrate } : {}),
    // The terminal per-call budget equation (absent when the trajectory carries
    // no context.budget record).
    ...(signals.contextBudget !== undefined ? { contextBudget: signals.contextBudget } : {}),
    // The per-turn budget cascade toward that terminal (present only when ≥2 distinct states).
    ...(signals.contextBudgetHistory !== undefined ? { contextBudgetHistory: signals.contextBudgetHistory } : {}),
    // The woke-fire wake-gate fact (absent when the trajectory has no
    // scheduler.wake_gate record — a skip opens no session, so its report never exists).
    ...(signals.cronWakeGate !== undefined ? { cronWakeGate: signals.cronWakeGate } : {}),
    // The memory-recall outcome (absent when the trajectory has no recall records).
    ...(signals.recall !== undefined ? { recall: signals.recall } : {}),
    // The per-reason cache breaks (absent when the session
    // had none). Bounded to CACHE_BREAKS_CAP highest-count-first; the bound pass
    // (obs-explain-bound.ts) records a truncations[] breadcrumb when it sheds the
    // tail. Content-free (counts + closed reason label + a number).
    ...(signals.cacheBreaks !== undefined && signals.cacheBreaks.length > 0
      ? { cacheBreaks: signals.cacheBreaks }
      : {}),
    // The spend kill-switch breach (scope + the two dollar
    // numbers) reconstructed from the terminal spend.exceeded record. Absent when the
    // session was not spend-killed (additive; schemaVersion 1). The verdict stays
    // amount-free; this section carries the numbers the Incident view renders.
    ...(signals.spend !== undefined ? { spend: signals.spend } : {}),
    // The per-ROOT autonomy.budget limb +
    // numbers from the terminal execution.aborted record (absent unless a per-root
    // meter tripped). Lets the Incident view + the spend verdict name the exact knob.
    ...(signals.perRootBudget !== undefined ? { perRootBudget: signals.perRootBudget } : {}),
    // The terminal user-surface state (which pill label / delete the renderer
    // painted, and whether a failed event reclassified the outcome) + the
    // blocks an aborted delivery left unsent — together they answer "what did
    // the user's chat actually show this turn" from the trajectory alone.
    ...(signals.turnFinalized !== undefined ? { activityFinalize: signals.turnFinalized } : {}),
    ...(signals.deliveryAborts !== undefined
      ? { deliverySkipped: { events: signals.deliveryAborts.events, chunksNotSent: signals.deliveryAborts.chunksNotSent } }
      : {}),
    // The silent-failure recovery re-drives (model re-entry) — previously
    // log-only, so explain could not show a session re-entered the model.
    ...(signals.recoveries !== undefined ? { recoveries: signals.recoveries } : {}),
    // The turn span (>1 only) — flags the
    // whole-session toolStats as cumulative across N turns (append-only trajectory).
    ...(signals.turnCount !== undefined ? { turnCount: signals.turnCount } : {}),
    // The image-generation turn reconstructed from the
    // trajectory's image.* records (absent when the session generated no image).
    // The cost rides here so `comis explain` shows it (NOT in cost.costUsd,
    // which reads the executor sessionEnd — a different path).
    ...(signals.image !== undefined ? { image: signals.image } : {}),
    // The vision turn reconstructed from the trajectory's
    // media.vision.* records (absent when the session ran no vision). The vision
    // cost rides here too — the image/vision folds are independent.
    ...(signals.vision !== undefined ? { vision: signals.vision } : {}),
    // The VIDEO turn reconstructed from the trajectory's video.*
    // records (absent when the session generated no video). Reconstructs a
    // background-completed job too — the in-turn video.submitted ties the later
    // off-turn video.generated via jobId/traceId on one sessionKey. Cost rides
    // here. The offline assembler is the binding oracle for this section.
    ...(signals.videoGenerated !== undefined ? { videoGenerated: signals.videoGenerated } : {}),
    // The VOICE turn reconstructed from the trajectory's
    // media.stt.* / media.tts.* records (absent when the session ran no voice).
    // Wholly in-turn (the daemon voice RPC handlers direct-emit). Cost rides
    // here: keyless `costUsd:0` is VISIBLE, keyed cost is omitted.
    // The offline assembler is the binding oracle for this section.
    ...(signals.voice !== undefined ? { voice: signals.voice } : {}),
    // The Verified-Learning outcome signal reconstructed from the
    // trajectory's learning.outcome_observed records (absent when the session
    // recorded no outcome). Counts/ids/closed-enums only; drives outcome_unresolved.
    ...(signals.learning !== undefined ? { learning: signals.learning } : {}),
    summary,
    // The heuristics pass fills likelyRootCause and the report-level
    // suggestedNextSteps; the bounding pass fills truncations.
    likelyRootCause: null,
    suggestedNextSteps: [],
    truncations: [],
    coverage,
  };
}
