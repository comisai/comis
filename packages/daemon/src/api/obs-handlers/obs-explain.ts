// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `obs.explain` RPC handler — the IncidentReport assembler.
 *
 * Wires the full pipeline in five linear steps:
 *
 *   1. admin check (defense-in-depth; gateway-router is the primary gate)
 *   2. `stripInternalFields` THEN `ObsExplainContract.request.parse`
 *      (so `_trustLevel` can never be smuggled into the parsed params)
 *   3. resolve — a `traceId` is canonicalized to its `sessionKey` FIRST
 *      ({@link resolveTraceToSession}), so by-trace and by-session share ONE
 *      assembler path (structural identity)
 *   4. read → normalize → assemble → heuristics → bound:
 *        - {@link IncidentSourceReader} reads the four bounded sources
 *        - {@link toIncidentSignals} collapses log + event shapes
 *        - {@link assembleIncidentReport} merges signals + rollup → the report
 *        - {@link rootCause} stamps the deterministic `likelyRootCause`
 *        - {@link boundIncidentReport} enforces the depth budget
 *   5. dev-mode `response.parse` (catches field regressions in dev only)
 *
 * The `incidentReader` dep is an OPTIONAL test seam: production builds
 * {@link makeRealReader} over the real (safePath-guarded) data dir; tests inject
 * a fixture reader. It does NOT enable arbitrary-file reads in production
 * — the dataDir override convention only, like obs-trace.
 *
 * @module
 */

import { AuthorizationError } from "../errors.js";
import * as os from "node:os";
import {
  ObsExplainContract,
  stripInternalFields,
  safePath,
  type IncidentGraphRun,
  type IncidentReport,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type ObsHandlerDeps } from "./obs-helpers.js";
import {
  resolveTraceToSession,
  resolveRootRunToSession,
  traceIdFromCronRootRun,
} from "./obs-explain-resolve.js";
import {
  makeRealReader,
  resolveSessionFilePath,
  type IncidentSourceReader,
  type TaskCheckLifecycleEvidence,
} from "./obs-explain-readers.js";
import { toIncidentSignals } from "./obs-explain-signals.js";
import { assembleIncidentReport } from "./obs-explain-assemble.js";
import { rootCause } from "./obs-explain-heuristics.js";
import { boundIncidentReport } from "./obs-explain-bound.js";

const DELEGATION_EVIDENCE_GUARD_ACTION =
  "response.delegation_evidence_guard";
const PERSISTENT_ACTION_EVIDENCE_GUARD_ACTION =
  "response.persistent_action_evidence_guard";
const DESTRUCTIVE_ACTION_EVIDENCE_GUARD_ACTION =
  "response.destructive_action_evidence_guard";
const VISION_FALLBACK_GROUNDED_ACTION =
  "response.vision_fallback_grounded";

/** Default data directory (lazy). Mirrors obs-trace.ts / obs-explain-readers.ts. */
function defaultDataDir(): string {
  return safePath(os.homedir(), ".comis");
}

/**
 * Already-validated `obs.explain` params (post `request.parse`). The shared
 * assembler takes this shape DIRECTLY — it performs NO contract parse and NO
 * admin check, so it can be reached under daemon authority by a caller that has
 * its own authorization boundary (the admin RPC handler keeps its admin gate;
 * the operator-allowlisted `obs_explain` MCP tool relies on the per-client
 * allowlist + the digest-only/bounded report instead).
 */
export interface AssembleIncidentReportParams {
  readonly sessionKey?: string;
  readonly traceId?: string;
  /** A durable execution-graph id resolved through terminal run metadata. */
  readonly graphId?: string;
  /**
   * A governed run's rootRunId (the 3rd ref). Canonicalized to the
   * run's sessionKey FIRST via {@link resolveRootRunToSession} — the synthetic
   * in-process root by a pure prefix-strip, a real socket/spawned root by the
   * session-index scan. An unresolvable rootRunId soft-fails to "" → the
   * not-found marker (it never masquerades as a clean session). Lets the
   * system→explain drill-down paste the worst run's rootRunId straight in.
   */
  readonly rootRunId?: string;
  readonly depth?: "summary" | "full";
  /**
   * Admin opt-in: when `true`, a `traceId` that resolves only through a
   * synthetic (test/harness) session-index row is still canonicalized. Default
   * (absent/`false`) excludes synthetic rows from the by-traceId resolution.
   */
  readonly includeSynthetic?: boolean;
}

function recordHasTraceId(record: Record<string, unknown>, traceId: string): boolean {
  return record.traceId === traceId;
}

/** Select one prompt-anchored execution, including same-trace preparation
 * before the prompt and settlement rows whose ended request context carries
 * the session fallback trace. */
function recordsForExecution(
  records: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): Array<Record<string, unknown>> {
  const start = records.findIndex(
    (record) => record.type === "prompt.submitted" && recordHasTraceId(record, traceId),
  );
  if (start < 0) return records.filter((record) => recordHasTraceId(record, traceId));
  const relativeEnd = records.slice(start + 1).findIndex(
    (record) => record.type === "prompt.submitted",
  );
  const end = relativeEnd < 0 ? records.length : start + 1 + relativeEnd;
  const preparationRecords = records
    .slice(0, start)
    .filter((record) => recordHasTraceId(record, traceId));
  return [...preparationRecords, ...records.slice(start, end)];
}

function latestPromptTraceId(
  records: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  const latestPrompt = [...records].reverse().find(
    (record) =>
      record.type === "prompt.submitted"
      && typeof record.traceId === "string"
      && record.traceId.length > 0,
  );
  return typeof latestPrompt?.traceId === "string"
    ? latestPrompt.traceId
    : undefined;
}

function recordData(record: Record<string, unknown> | undefined): Record<string, unknown> {
  return typeof record?.data === "object" && record.data !== null
    ? record.data as Record<string, unknown>
    : {};
}

function lastRecordOfType(
  records: ReadonlyArray<Record<string, unknown>>,
  type: string,
): Record<string, unknown> | undefined {
  return [...records].reverse().find((record) => record.type === type);
}

function executionDurationMs(records: ReadonlyArray<Record<string, unknown>>): number | undefined {
  const timestamps = records
    .map((record) => typeof record.ts === "string" ? Date.parse(record.ts) : undefined)
    .filter((timestamp): timestamp is number => timestamp !== undefined && Number.isFinite(timestamp));
  if (timestamps.length > 1) {
    const first = Math.min(...timestamps);
    const last = Math.max(...timestamps);
    if (last > first) return last - first;
  }

  let modelDurationMs = 0;
  let modelCompletions = 0;
  for (const record of records) {
    if (record.type !== "model.completed") continue;
    const durationMs = recordData(record).durationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) continue;
    modelDurationMs += durationMs;
    modelCompletions += 1;
  }
  return modelCompletions > 0 ? modelDurationMs : undefined;
}

function successfulExecutionEndReason(
  records: ReadonlyArray<Record<string, unknown>>,
  summary: Record<string, unknown>,
): "success" | undefined {
  if (summary.degraded !== false) return undefined;
  const finalModel = recordData(lastRecordOfType(records, "model.completed"));
  if (finalModel.stopReason !== "stop") return undefined;
  const delivered = records.some((record) =>
    record.type === "delivery.dispatched" && recordData(record).status === "success"
  );
  return delivered ? "success" : undefined;
}

/**
 * Build the last-write rollup for one scheduler execution from that execution's
 * trajectory. Durable scheduler sessions reuse one metadata file, so metadata
 * for an earlier trace is no longer authoritative after the next cron turn.
 */
function metadataForExecution(
  metadata: Record<string, unknown> | null,
  records: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): Record<string, unknown> | null {
  const matchingMetadata = metadata?.traceId === traceId ? metadata : undefined;
  if (matchingMetadata === undefined && records.length === 0) return null;
  const matchingSessionEnd =
    typeof matchingMetadata?.sessionEnd === "object" && matchingMetadata.sessionEnd !== null
      ? matchingMetadata.sessionEnd as Record<string, unknown>
      : {};
  const hasMatchingSessionEnd = Object.keys(matchingSessionEnd).length > 0;
  const summaryRecord = lastRecordOfType(records, "session.summary");
  if (matchingMetadata === undefined && summaryRecord === undefined) {
    return { traceId };
  }
  const summary = recordData(summaryRecord);
  const durationMs = matchingMetadata === undefined ? executionDurationMs(records) : undefined;
  const summaryEndReason =
    typeof summary.endReason === "string" && summary.endReason.length > 0
      ? summary.endReason
      : undefined;
  const endReason = hasMatchingSessionEnd
    ? undefined
    : summaryEndReason ?? successfulExecutionEndReason(records, summary);

  return {
    ...(matchingMetadata ?? {}),
    traceId,
    sessionEnd: {
      ...matchingSessionEnd,
      ...summary,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(endReason !== undefined ? { endReason } : {}),
    },
  };
}

/**
 * Build identity metadata for an ephemeral task-check execution. The origin
 * session metadata supplies only stable channel identity; its last-write-wins
 * outcome/cost/timing belong to a different execution and must not leak into
 * this root report. The scheduler correlation is the task model trace.
 */
function metadataForTaskCheckExecution(
  originMetadata: Record<string, unknown> | null,
  evidence: TaskCheckLifecycleEvidence,
): Record<string, unknown> {
  const originAgentId = typeof originMetadata?.agentId === "string"
    ? originMetadata.agentId
    : undefined;
  const channel = typeof originMetadata?.channel === "object" && originMetadata.channel !== null
    ? originMetadata.channel
    : undefined;
  // A persisted delivered terminal is the task attempt's authoritative local
  // outcome. Other terminal dispositions need their own reviewed severity
  // classification, so they remain unresolved instead of being guessed here.
  const sessionEnd = evidence.lifecycle === "terminal" && evidence.outcome === "delivered"
    ? { endReason: "success", degraded: false }
    : undefined;
  return {
    traceId: evidence.correlationId,
    ...(evidence.agentId !== undefined
      ? { agentId: evidence.agentId }
      : originAgentId === undefined ? {} : { agentId: originAgentId }),
    ...(channel === undefined ? {} : { channel }),
    ...(sessionEnd === undefined ? {} : { sessionEnd }),
  };
}

function taskCheckReportSection(
  evidence: TaskCheckLifecycleEvidence,
): NonNullable<IncidentReport["taskCheck"]> {
  return {
    rootRunId: evidence.rootRunId,
    attemptId: evidence.attemptId,
    correlationId: evidence.correlationId,
    lifecycle: evidence.lifecycle,
    ...(evidence.outcome === undefined ? {} : { outcome: evidence.outcome }),
    ...(evidence.recovery === undefined ? {} : { recovery: evidence.recovery }),
    ...(evidence.deliveredChunks === undefined
      ? {}
      : { deliveredChunks: evidence.deliveredChunks }),
    ...(evidence.failedChunks === undefined ? {} : { failedChunks: evidence.failedChunks }),
    ...(evidence.ambiguousChunks === undefined
      ? {}
      : { ambiguousChunks: evidence.ambiguousChunks }),
  };
}

/**
 * The FROZEN `obs.explain` assembler pipeline, extracted from the RPC handler
 * so it can be shared by BOTH the admin RPC path (which keeps Step 1's admin
 * gate + Step 2's contract parse, then delegates here) AND the
 * operator-allowlisted `obs_explain` MCP tool (which has NO admin gate — its
 * authorization is the per-client `mcpClient.allowlist`, NOT admin trust).
 *
 * This function contains NEITHER an admin check NOR a `request.parse`: it takes
 * ALREADY-VALIDATED params and runs the deterministic pipeline:
 *
 *   3.      canonicalize a `traceId` to its `sessionKey` FIRST, so by-trace and
 *           by-session collapse to one assembler path.
 *   4.      read the four bounded sources → `toIncidentSignals` → assemble the
 *           report → stamp `likelyRootCause` (with the
 *           `session_not_found` not-found marker) → bound to the depth budget.
 *   5.      dev-mode `response.parse` (catches field regressions in dev only).
 *
 * The RPC handler delegates here with no added behavior — the
 * obs-explain.test.ts parity case pins that both paths yield identical reports.
 *
 * @param reader - the four-source DI reader (production `makeRealReader` over a
 *   safePath-guarded `dataDir`; tests inject a fixture reader). Read-only.
 * @param dataDir - file-system root for `resolveTraceToSession` (the session
 *   index lookup). Mirrors the reader's root.
 * @param params - already-validated `{ sessionKey?, traceId?, depth? }` (the
 *   contract `.refine` guarantees one of `sessionKey`/`traceId` is present).
 */
export async function assembleIncidentReportFromSources(
  reader: IncidentSourceReader,
  dataDir: string,
  params: AssembleIncidentReportParams,
): Promise<IncidentReport> {
  const graph: IncidentGraphRun | null =
    params.graphId !== undefined && reader.readGraphRun !== undefined
      ? await reader.readGraphRun(params.graphId)
      : null;
  const graphTraceId = graph?.traceId;
  // Step 3: canonicalize a traceId OR a rootRunId to its sessionKey FIRST,
  // so by-trace, by-rootRun, and by-session collapse to one assembler path. The
  // rootRunId arm is checked FIRST; `sessionKey` is present when both
  // traceId and rootRunId are absent (the contract .refine guarantees one of the
  // three). Scheduler task roots first load their durable lifecycle row: it is
  // both the authoritative root→origin mapping and the report's content-free
  // delivery evidence.
  const taskCheck = params.rootRunId !== undefined && reader.readTaskCheckLifecycle !== undefined
    ? await reader.readTaskCheckLifecycle(params.rootRunId)
    : null;
  const indexedSessionKey = params.graphId !== undefined
    ? graphTraceId === undefined
      ? ""
      : await resolveTraceToSession(dataDir, graphTraceId, params.includeSynthetic)
    : params.rootRunId
    ? await resolveRootRunToSession(dataDir, params.rootRunId, taskCheck)
    : params.traceId
      ? await resolveTraceToSession(dataDir, params.traceId, params.includeSynthetic)
      : params.sessionKey!;
  const cronExecutionTraceId = params.rootRunId !== undefined
    ? traceIdFromCronRootRun(params.rootRunId)
    : undefined;
  const fallbackTraceId = params.traceId ?? cronExecutionTraceId ?? graphTraceId;
  const sessionKey =
    indexedSessionKey.length === 0 &&
      fallbackTraceId !== undefined &&
      reader.resolveTraceSessionKey !== undefined
      ? await reader.resolveTraceSessionKey(fallbackTraceId, params.includeSynthetic)
      : indexedSessionKey;

  // A traceId OR a rootRunId that resolves to "" (no row in
  // today/yesterday's session index, and not a synthetic root) is UNRESOLVABLE —
  // distinct from a session that genuinely had zero tool activity. Without a
  // marker both yield the same empty report keyed on "", so an admin can't tell a
  // typo'd/expired ref from a clean session. We stamp the marker (below, after we
  // know the report is genuinely empty) rather than throw: the no-throw posture is
  // preserved (the empty report is safe — no traversal, no leak). An empty
  // RESOLVED session (a real sessionKey with no telemetry) is NOT flagged. Note
  // the resolution missed the index; whether the report is actually empty is
  // decided post-assembly (an injected reader may still surface telemetry for a ""
  // key — then the session WAS effectively found and must keep its real rootCause).
  const refResolutionMissed =
    (params.graphId !== undefined && graph === null)
    || (
      params.graphId === undefined
      && (params.traceId !== undefined || params.rootRunId !== undefined)
      && sessionKey === ""
    );
  // Which ref missed — drives the not-found detail + truncation field below.
  const missedRefField = params.graphId !== undefined
    ? "graphId"
    : params.rootRunId !== undefined ? "rootRunId" : "traceId";

  // Step 4: read the bounded sources (production reads files; tests
  // inject the fixture reader).
  const sessionRecords = await reader.readSessionRecords(sessionKey);
  const sessionCache = await reader.readCacheTraceRecords(sessionKey);
  const sessionMetadata = await reader.readSessionMetadata(sessionKey);
  const sessionRollup = await reader.readDiagnosticsRollup(sessionKey);
  const taskExecutionSessionKey = taskCheck === null
    ? ""
    : await resolveTraceToSession(dataDir, taskCheck.correlationId, params.includeSynthetic)
      || await reader.resolveTraceSessionKey?.(
        taskCheck.correlationId,
        params.includeSynthetic,
      )
      || "";
  const taskSessionRecords = taskCheck === null || taskExecutionSessionKey.length === 0
    ? []
    : await reader.readSessionRecords(taskExecutionSessionKey);
  const taskSessionCache = taskCheck === null || taskExecutionSessionKey.length === 0
    ? []
    : await reader.readCacheTraceRecords(taskExecutionSessionKey);
  const executionTraceId = params.traceId ?? cronExecutionTraceId ?? graphTraceId;
  const latestSessionTraceId =
    taskCheck === null && executionTraceId === undefined
      ? latestPromptTraceId(sessionRecords)
      : undefined;
  const selectedTraceId = executionTraceId ?? latestSessionTraceId;
  const selectedRecords = taskCheck !== null
    ? taskSessionRecords
    : executionTraceId === undefined
      ? sessionRecords
      : recordsForExecution(sessionRecords, executionTraceId);
  const losslessEvidence =
    taskCheck === null &&
      executionTraceId === undefined &&
      selectedRecords.length === 0 &&
      reader.readLosslessToolEvidence !== undefined
      ? await reader.readLosslessToolEvidence(sessionKey)
      : null;
  const records = selectedRecords.length > 0
    ? selectedRecords
    : losslessEvidence?.records ?? [];
  const cache = taskCheck !== null
    ? taskSessionCache
    : executionTraceId === undefined
      ? sessionCache
      : sessionCache.filter((record) => recordHasTraceId(record, executionTraceId));
  const metadataRecords =
    selectedTraceId === undefined
      ? records
      : recordsForExecution(sessionRecords, selectedTraceId);
  const metadata = taskCheck !== null
    ? metadataForTaskCheckExecution(sessionMetadata, taskCheck)
    : selectedTraceId === undefined
      ? sessionMetadata
      : metadataForExecution(sessionMetadata, metadataRecords, selectedTraceId);
  // Diagnostics rows are session-scoped and last-write-wins. They cannot
  // safely contribute to a historical cron execution report.
  const rollup =
    taskCheck !== null
    || executionTraceId !== undefined
    || (
      latestSessionTraceId !== undefined
      && sessionMetadata?.traceId !== latestSessionTraceId
    )
      ? null
      : sessionRollup;
  // A durable scheduler session emits session.started only once. Retain that
  // single session-invariant identity envelope for channel attribution, while
  // every execution-varying record remains selected by traceId above.
  const sessionIdentityRecords = taskCheck !== null || executionTraceId === undefined
    ? []
    : sessionRecords.filter((record) => record.type === "session.started");
  // The 5th source — the session's audit events (persisted
  // via SQLite, NOT a trajectory record, so they are read HERE,
  // not folded from the record stream). Tenant-scoped + bounded by the reader;
  // filtered to the resolved traceId + aggregated counts-by-kind below. Optional
  // reader method — a fixture reader that omits it simply produces no audit?.
  const auditSessionKey = taskExecutionSessionKey.length > 0 ? taskExecutionSessionKey : sessionKey;
  const auditRows = reader.readAuditEvents ? await reader.readAuditEvents(auditSessionKey) : [];

  // Normalize both shapes → uniform signals; assemble the report;
  // stamp the deterministic root cause; bound to the depth budget.
  const signals = toIncidentSignals([...sessionIdentityRecords, ...records, ...cache]);
  // ZERO-RECORD MISS → "did you mean …?": a lossy/partial key (e.g.
  // `telegram:<chatId>` instead of the formatted `<agent>:<chatId>:<chatId>:peer:
  // <chatId>`) resolves nothing. Enumerate the closest REAL keys so the operator
  // copies the right one instead of hand-joining the session index (the recurring
  // live friction). Only on a genuine miss (no records AND no rollup) — a resolved
  // session never pays the scan.
  // Seed the scan with the ORIGINAL requested ref, not the resolved `sessionKey`:
  // a chatId / tilde-form / typo'd ref that lacks ':' misroutes to `{traceId}`
  // (the CLI's separator heuristic), `resolveTraceToSession` misses, and
  // `sessionKey` collapses to "". Scanning against "" hands the ranker an empty
  // request → zero suggestions — the "did you mean …?" list silently no-ops for
  // the exact lossy-key case it exists to serve. Fall back to the raw ref so the
  // ranker can match it (the recurring live friction).
  const candidateSeed =
    sessionKey !== ""
      ? sessionKey
      : (params.sessionKey ?? params.traceId ?? params.rootRunId ?? params.graphId ?? "");
  const candidateSessionKeys =
    records.length === 0 && metadata === null && reader.listCandidateSessionKeys
      ? await reader.listCandidateSessionKeys(candidateSeed)
      : [];
  // A NON-EMPTY `sessionKey` that resolved nothing is ALSO unresolved — and it
  // never reached the traceId/rootRunId arms above, so `refResolutionMissed`
  // stayed false and the empty report masqueraded as a healthy zero-activity
  // session. Live friction (comis-moshe 2026-07-26): `explain
  // "telegram:<user>~peer~<peer>"` CONTAINS a ':' so the CLI routes it as a
  // sessionKey; the report came back all-zero with likelyRootCause:null while
  // coverage.candidateSessionKeys already held the correct full key.
  //
  // The DISCRIMINATOR is the ranker: a session that genuinely exists but has no
  // telemetry ranks ITSELF; a key that does not exist ranks only OTHER keys. So
  // "ranker returned candidates, none of which is the requested key" is positive
  // evidence the ref missed — while an empty candidate list (or one containing
  // the request) keeps the honest clean-empty report.
  const sessionKeyRefMissed =
    params.sessionKey !== undefined &&
    records.length === 0 &&
    metadata === null &&
    candidateSessionKeys.length > 0 &&
    !candidateSessionKeys.includes(params.sessionKey);
  const anyRefMissed = refResolutionMissed || sessionKeyRefMissed;
  const missedField = sessionKeyRefMissed ? "sessionKey" : missedRefField;
  // Pass the trajectory READ count (selectedRecords.length) so coverage.trajectory
  // reflects what the reader actually READ — the meta-observability point: a
  // "reader read nothing" bug surfaces as coverage.trajectory.records:0
  // on a report that otherwise looks like a clean zero-activity session.
  // The resolved raw session `.jsonl` path → coverage.sources, so a numeric/value
  // reconciliation knows the VALUES live in the session file (not the provenance-only
  // trajectory). Only for a resolved key with real on-disk artifacts (undefined ⇒ omitted;
  // a fixture-reader test over a non-real dataDir simply gets no sources field).
  // NON-FATAL: this coverage-pointer resolution is enrichment — it must NEVER fail the
  // report. `resolveSessionFilePath` does real fs work and throws a PathTraversalError on a
  // relative/odd dataDir (e.g. the "." offline/CLI base); swallow to undefined so the pointer
  // is simply omitted rather than crashing the assembly (degrade, never error).
  let sessionSourcePath: string | undefined;
  if (sessionKey !== "" && taskCheck === null) {
    try {
      sessionSourcePath = reader.resolveSessionFilePath?.(sessionKey)
        ?? resolveSessionFilePath(dataDir, sessionKey);
    } catch {
      sessionSourcePath = undefined;
    }
  }
  const report = assembleIncidentReport(
    signals,
    metadata,
    rollup,
    sessionKey,
    selectedRecords.length,
    candidateSessionKeys,
    sessionSourcePath,
    losslessEvidence === null
      ? undefined
      : {
          found: losslessEvidence.messageCount > 0,
          messages: losslessEvidence.messageCount,
          toolResults: losslessEvidence.toolResultCount,
          toolResultsReturned: losslessEvidence.records.length,
          truncated: losslessEvidence.truncated,
        },
  );
  if (taskCheck !== null) report.taskCheck = taskCheckReportSection(taskCheck);
  if (graph !== null) report.graph = graph;
  // The report is genuinely empty only when NO source surfaced any activity.
  const reportIsEmpty =
    report.failures.length === 0 &&
    report.breakerTimeline.length === 0 &&
    report.offloads.length === 0 &&
    Object.keys(report.toolStats).length === 0 &&
    report.graph === undefined;
  if (anyRefMissed && reportIsEmpty) {
    // An honest not-found verdict + ledger note so the empty report
    // does not masquerade as a healthy zero-activity session. The bound pass
    // preserves both (it seeds truncations[] from the report and never
    // overwrites likelyRootCause). The detail/field name the ref that missed
    // (traceId or rootRunId), so a typo'd autonomy-run id
    // surfaces an honest not-found verdict instead of a clean-looking report.
    // When the ranker surfaced closest-key candidates, the ref was almost
    // certainly a lossy/partial sessionKey (a chatId / tilde-form) that misrouted
    // to a traceId lookup — NOT a typo'd/expired traceId. Name that + point at the
    // candidates instead of the misdirecting "typo/expired" hint.
    report.likelyRootCause =
      missedField === "graphId"
        ? {
            code: "graph_not_found",
            detail:
              "graphId did not resolve to a valid terminal graph record under "
              + "graph-runs/<graphId>/_run-metadata.json",
            suggestedNextSteps: [
              "verify the graphId with graph.runs or graph.runDetail",
              "if the graph is still running, use graph.status until terminal metadata is written",
            ],
          }
        : candidateSessionKeys.length > 0
        ? {
            code: "session_not_found",
            detail: `${missedField} did not resolve — it looks like a lossy/partial sessionKey (e.g. a bare chatId or the "<user>~peer~<peer>" trajectory-filename form), which matches no session on disk. See coverage.candidateSessionKeys for the closest real keys.`,
            suggestedNextSteps: [
              `re-run with one of the candidate session keys (coverage.candidateSessionKeys), e.g. "${candidateSessionKeys[0]}"`,
              "or pass the traceId from the trajectory's model.completed record",
            ],
          }
        : {
            code: "session_not_found",
            detail: `${missedField} did not resolve to any session in the index (today/yesterday). Either the reference is wrong or older than the 2-day resolution horizon, OR the turn aborted BEFORE it recorded a session — a pre-execution fail-closed (e.g. unresolved conversation authority, a rejected identity, or tool assembly) never reaches the index, so a real failure can look like a missing reference`,
            suggestedNextSteps: [
              `verify the ${missedField}, or query by sessionKey directly`,
              "confirm the session ended within the last two days (the session-index lookup window)",
              `if the trigger is known to have fired, treat this as a possible pre-execution abort: grep the daemon log for this ${missedRefField} — a turn that failed before recording emits an ERROR carrying its step and errorKind but no session`,
            ],
          };
    report.truncations.push({
      field: missedField,
      reason: missedField === "graphId"
        ? "graphId terminal metadata was missing or invalid — empty report is unresolved"
        : `${missedField} not found in session index (today/yesterday) — empty report is unresolved, not a clean session`,
    });
  } else {
    // Thread the mapped terminal endReason (the NAMED degradation cause)
    // onto the signals so the two lowest-priority heuristics (context_exhausted /
    // output_starved) can fire. endReason is metadata-derived — toIncidentSignals
    // reads the trajectory record stream and never sees it — so the assembler's
    // resolved `report.outcome.endReason` is the single source threaded here. A
    // tool-failure cause still out-ranks it (the named-cause rules sit LAST).
    // Also thread the authoritative `degraded` flag so `recall_miss`
    // gates on genuine degradation (a zero-hit recall on a healthy turn is benign).
    report.likelyRootCause = rootCause({
      ...signals,
      endReason: report.outcome.endReason,
      degraded: report.outcome.degraded,
    });
  }
  const visionFallbackVerdict = visionFallbackGroundedVerdict(
    auditRows,
    report.traceId,
  );
  if (visionFallbackVerdict !== null) {
    // A proven same-source fallback explains the user-visible outcome more
    // accurately than chronic breaker noise from the failed primary tool.
    report.likelyRootCause = visionFallbackVerdict;
  }
  const delegationEvidenceVerdict = delegationEvidenceGuardVerdict(
    auditRows,
    report.traceId,
    report.failures,
  );
  if (delegationEvidenceVerdict !== null) {
    // A deterministic response correction is the acute terminal event. Rank it
    // above chronic tool noise so one explain call names the honesty failure
    // that changed the user-visible outcome.
    report.likelyRootCause = delegationEvidenceVerdict;
  }
  const persistentActionEvidenceVerdict =
    persistentActionEvidenceGuardVerdict(auditRows, report.traceId);
  const hasStructuredMcpFailure = report.failures.some(
    (failure) =>
      failure.classifiedFailureBy === "mcp_classifier"
      && failure.failureCode !== undefined,
  );
  if (persistentActionEvidenceVerdict !== null && !hasStructuredMcpFailure) {
    report.likelyRootCause = persistentActionEvidenceVerdict;
  }
  const destructiveActionEvidenceVerdict = destructiveActionEvidenceGuardVerdict(
    auditRows,
    report.traceId,
  );
  if (destructiveActionEvidenceVerdict !== null) {
    report.likelyRootCause = destructiveActionEvidenceVerdict;
  }
  const bounded = boundIncidentReport(report, params.depth ?? "summary");

  // Attach the audit? section AFTER the bound pass (it is
  // already bounded — counts-by-kind, capped by the distinct AuditKind set). The
  // rows arrive tenant-scoped; narrow to THIS session's resolved traceId, then
  // aggregate counts-by-kind (content-free — no actor names beyond ids, no value,
  // no refs blob). Present only when the session produced ≥1 audit event.
  const audit = aggregateAuditByKind(auditRows, bounded.traceId);
  if (audit !== undefined) bounded.audit = audit;

  // Step 5: dev-mode response validation (catches field type regressions).
  if (IS_DEV) ObsExplainContract.response.parse(bounded);
  return bounded;
}

function visionFallbackGroundedVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === VISION_FALLBACK_GROUNDED_ACTION
        && row.outcome === "success",
    )
  ) {
    return null;
  }

  return {
    code: "vision_fallback_grounded",
    detail:
      "configured image analysis was unavailable, but a later tool used the same image "
      + "and produced evidence that grounded the delivered response",
    suggestedNextSteps: [
      "no user retry is required; the fallback recovered this turn",
      "configure a vision-capable model or vision provider to avoid the fallback path",
    ],
  };
}

function delegationEvidenceGuardVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
  failures: IncidentReport["failures"],
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    // The guard corrected the response because this concrete spawn failed.
    // Preserve that causal refusal; the response correction is downstream.
    || failures.some((failure) => failure.toolName === "sessions_spawn")
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === DELEGATION_EVIDENCE_GUARD_ACTION
        && row.outcome === "denied",
    )
  ) {
    return null;
  }

  return {
    code: "delegation_evidence_missing",
    detail:
      "the response honesty guard replaced an unsupported delegation claim "
      + "because this execution had no successful current-turn sessions_spawn receipt",
    suggestedNextSteps: [
      "inspect sessions_spawn admission and the tool inventory for this turn",
      "if a spawn was refused, inspect the bound-naming tool failure in this report",
      "retry the request after correcting the spawn precondition",
    ],
  };
}

function destructiveActionEvidenceGuardVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === DESTRUCTIVE_ACTION_EVIDENCE_GUARD_ACTION
        && row.outcome === "denied",
    )
  ) {
    return null;
  }
  return {
    code: "destructive_action_no_effect",
    detail:
      "the response honesty guard replaced a completion claim because the destructive "
      + "exec command reported no observable filesystem effect",
    suggestedNextSteps: [
      "inspect the failed exec record and its bound approval request",
      "confirm the intended target exists inside the configured workspace or write fence",
      "retry only after correcting the target; do not treat an exit-zero no-op as success",
    ],
  };
}

function persistentActionEvidenceGuardVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === PERSISTENT_ACTION_EVIDENCE_GUARD_ACTION
        && row.outcome === "denied",
    )
  ) {
    return null;
  }
  return {
    code: "persistent_action_evidence_missing",
    detail:
      "the response honesty guard replaced a terminal result because the request "
      + "required repeated current-turn action but this execution had no successful tool receipt",
    suggestedNextSteps: [
      "inspect the current tool inventory and action admission for this turn",
      "retry after the required capability can produce current-turn evidence",
    ],
  };
}

/**
 * Aggregate the tenant-scoped `obs_audit_events` rows for ONE
 * session into the content-free `audit?` section — `{ total, byKind }`, counts by
 * the closed AuditKind discriminator ONLY. The rows arrive scoped by tenant (the
 * reader; `AuditQueryParams` has no traceId predicate), so this narrows to the
 * session's resolved `traceId`. Rows whose `traceId` is null/blank (system-scoped
 * tenant-less events) are EXCLUDED — they belong to no single session. A non-empty
 * `traceId` with no matching rows ⇒ undefined (the section is omitted, never `{}`).
 *
 * Bounded by construction: `byKind` is keyed by the closed AuditKind set, so it is
 * capped regardless of row volume (no per-row growth) — the report-size bound
 * holds without an explicit truncation pass.
 */
function aggregateAuditByKind(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): { total: number; byKind: Record<string, number> } | undefined {
  if (traceId.length === 0) return undefined;
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    if (row.traceId !== traceId) continue; // narrow tenant-window → THIS session
    const kind = typeof row.kind === "string" && row.kind.length > 0 ? row.kind : "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    total += 1;
  }
  return total > 0 ? { total, byKind } : undefined;
}

/**
 * Bind the `obs.explain` handler — the wired resolver → readers → normalize →
 * assemble → heuristics → bound pipeline.
 *
 * @param deps - the shared obs-handler deps, plus an optional `incidentReader`
 *   test seam. When absent, the production {@link makeRealReader} is built over
 *   `deps.dataDir` (defaulting to `~/.comis`) backed by `deps.obsStore`.
 */
export function bindObsExplainHandlers(
  deps: ObsHandlerDeps & {
    incidentReader?: IncidentSourceReader;
    workspaceDirs?: ReadonlyMap<string, string>;
  },
): Record<string, RpcHandler> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const reader = deps.incidentReader ??
    makeRealReader(dataDir, deps.obsStore, deps.workspaceDirs, deps.contextBrowse);

  return {
    [ObsExplainContract.method]: async (rawParams) => {
      // Step 1: admin check (defense-in-depth; gateway-router is the primary gate).
      // FROZEN — this gate stays on the RPC path for non-MCP callers. The
      // operator-allowlisted obs_explain MCP tool does NOT come through here;
      // it calls assembleIncidentReportFromSources directly (its boundary is
      // the per-client allowlist, not admin trust).
      const trustLevel = (rawParams as Record<string, unknown>)._trustLevel as
        | string
        | undefined;
      // Name the operator route in the message. obs.explain is
      // admin-trust-only BY DESIGN (defense-in-depth; the gateway-router is the primary gate). An
      // operator full-access TOKEN is not admin-TRUST, so name the offline route rather than leaving the
      // caller to guess (the CLI `comis explain` assembles the same report offline from the data dir).
      if (trustLevel !== "admin")
        throw new AuthorizationError("Admin access required for obs.explain (admin-trust only; operators use `comis explain`, which assembles the report offline from the data dir)");

      // Step 2: stripInternalFields BEFORE contract parse — `_trustLevel`
      // cannot be smuggled into the parsed params.
      const params = ObsExplainContract.request.parse(stripInternalFields(rawParams));

      // Steps 3-5: delegate to the shared assembler (resolve → read → signals →
      // assemble → rootCause/not-found marker → bound → dev-mode parse). The body is
      // identical to the former inline pipeline; the obs_explain MCP path runs
      // the SAME function under daemon authority.
      return assembleIncidentReportFromSources(reader, dataDir, params);
    },
  };
}
