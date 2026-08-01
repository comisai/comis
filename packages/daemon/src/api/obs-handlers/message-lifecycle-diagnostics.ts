// SPDX-License-Identifier: Apache-2.0
/**
 * Defensive, content-free projection and system-window merge for durable
 * `diagnostic:message_processed` rows. Both `obs.explain` and
 * `obs.system.health` consume this single parser so trace/session authority and
 * closed lifecycle classifications cannot drift between the two lenses.
 */
import {
  ERROR_KINDS,
  type ErrorKind,
  type EventMap,
} from "@comis/core";
import type { DiagnosticRow, ObservabilityStore } from "@comis/memory";

type MessageLifecycleStatus = EventMap["diagnostic:message_processed"]["status"];
type MessageLifecycleFailureStage =
  NonNullable<EventMap["diagnostic:message_processed"]["failureStage"]>;
type SessionRollup =
  ReturnType<ObservabilityStore["aggregateSessionsInWindow"]>[number];

const MESSAGE_LIFECYCLE_STATUSES: ReadonlySet<MessageLifecycleStatus> = new Set([
  "success",
  "error",
  "timeout",
  "filtered",
  "aborted",
]);

const MESSAGE_LIFECYCLE_FAILURE_STAGES: ReadonlySet<MessageLifecycleFailureStage> = new Set([
  "execution",
  "delivery",
]);

const ERROR_KIND_SET: ReadonlySet<string> = new Set(ERROR_KINDS);

/** Content-free projection of one durable per-message lifecycle row. */
export interface MessageLifecycleDiagnosticEvidence {
  readonly timestamp: number;
  readonly sessionKey: string;
  readonly traceId: string;
  readonly agentId: string;
  readonly channelType: string;
  readonly channelId: string;
  readonly status: MessageLifecycleStatus;
  readonly failureStage?: MessageLifecycleFailureStage;
  readonly errorKind?: ErrorKind;
  readonly totalDurationMs: number;
  readonly tokensUsed: number;
  readonly cost: number;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse one exact lifecycle row. Conflicting indexed/payload identity fails
 * closed; free-form fields are never copied into the result.
 */
export function parseMessageLifecycleDiagnostic(
  row: DiagnosticRow,
  expectedTraceId?: string,
): MessageLifecycleDiagnosticEvidence | null {
  const indexedTraceId = nonEmptyString(row.traceId);
  if (
    row.message !== "diagnostic:message_processed"
    || indexedTraceId === undefined
    || (expectedTraceId !== undefined && indexedTraceId !== expectedTraceId)
    || row.sessionKey === undefined
    || row.sessionKey.length === 0
  ) {
    return null;
  }
  let details: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.details ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    details = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const detailTraceId = nonEmptyString(details.traceId);
  const detailSessionKey = nonEmptyString(details.sessionKey);
  const detailAgentId = nonEmptyString(details.agentId);
  const agentId = detailAgentId ?? row.agentId;
  const channelType = nonEmptyString(details.channelType);
  const channelId = nonEmptyString(details.channelId);
  const status = details.status;
  const failureStage = details.failureStage;
  const errorKind = details.errorKind;
  const totalDurationMs = finiteNonNegativeNumber(details.totalDurationMs);
  const tokensUsed = finiteNonNegativeNumber(details.tokensUsed);
  const cost = finiteNonNegativeNumber(details.cost);

  if (
    detailTraceId !== indexedTraceId
    || detailSessionKey !== row.sessionKey
    || agentId === undefined
    || (row.agentId !== undefined && detailAgentId !== undefined && row.agentId !== detailAgentId)
    || channelType === undefined
    || channelId === undefined
    || typeof status !== "string"
    || !MESSAGE_LIFECYCLE_STATUSES.has(status as MessageLifecycleStatus)
    || (
      failureStage !== undefined
      && (
        typeof failureStage !== "string"
        || !MESSAGE_LIFECYCLE_FAILURE_STAGES.has(
          failureStage as MessageLifecycleFailureStage,
        )
      )
    )
    || (
      errorKind !== undefined
      && (typeof errorKind !== "string" || !ERROR_KIND_SET.has(errorKind))
    )
    || totalDurationMs === undefined
    || tokensUsed === undefined
    || cost === undefined
  ) {
    return null;
  }

  return {
    timestamp: row.timestamp,
    sessionKey: row.sessionKey,
    traceId: indexedTraceId,
    agentId,
    channelType,
    channelId,
    status: status as MessageLifecycleStatus,
    ...(failureStage === undefined
      ? {}
      : { failureStage: failureStage as MessageLifecycleFailureStage }),
    ...(errorKind === undefined ? {} : { errorKind: errorKind as ErrorKind }),
    totalDurationMs,
    tokensUsed,
    cost,
  };
}

export interface PreSessionFailureMerge {
  readonly rows: SessionRollup[];
  readonly failures: MessageLifecycleDiagnosticEvidence[];
}

/**
 * Fold exact-trace lifecycle failures with no matching session-summary row into
 * the per-session system population. A trace already represented by a summary
 * is skipped, and repeated diagnostic rows for one trace count once.
 */
export function mergePreSessionMessageFailures(
  rows: readonly SessionRollup[],
  messageRows: readonly DiagnosticRow[],
  summaryRows: readonly DiagnosticRow[],
): PreSessionFailureMerge {
  const summarizedTraceIds = new Set(
    summaryRows
      .map((row) => nonEmptyString(row.traceId))
      .filter((traceId): traceId is string => traceId !== undefined),
  );
  const failureByTrace = new Map<string, MessageLifecycleDiagnosticEvidence>();
  for (const row of messageRows) {
    const evidence = parseMessageLifecycleDiagnostic(row);
    if (
      evidence === null
      || summarizedTraceIds.has(evidence.traceId)
      || evidence.status === "success"
      || evidence.status === "filtered"
    ) {
      continue;
    }
    const current = failureByTrace.get(evidence.traceId);
    if (current === undefined || evidence.timestamp > current.timestamp) {
      failureByTrace.set(evidence.traceId, evidence);
    }
  }

  const failures = [...failureByTrace.values()].sort(
    (left, right) =>
      left.timestamp - right.timestamp || left.traceId.localeCompare(right.traceId),
  );
  const bySession = new Map<string, SessionRollup>();
  for (const row of rows) {
    bySession.set(row.sessionKey, {
      ...row,
      toolStats: { ...row.toolStats },
      topErrorKinds: { ...row.topErrorKinds },
    });
  }
  for (const failure of failures) {
    const current = bySession.get(failure.sessionKey);
    const endReason = failure.status === "timeout" ? "timeout" : "error";
    if (current === undefined) {
      bySession.set(failure.sessionKey, {
        sessionKey: failure.sessionKey,
        lastTs: failure.timestamp,
        degraded: true,
        costUsd: failure.cost,
        toolStats: {},
        breakerTripCount: 0,
        turnCount: 1,
        topErrorKinds: failure.errorKind === undefined
          ? {}
          : { [failure.errorKind]: 1 },
        source: "runtime",
        endReason,
      });
      continue;
    }
    current.degraded = true;
    current.costUsd += failure.cost;
    current.turnCount += 1;
    if (failure.errorKind !== undefined) {
      current.topErrorKinds[failure.errorKind] =
        (current.topErrorKinds[failure.errorKind] ?? 0) + 1;
    }
    const currentCauseIsHard =
      current.endReason !== "success"
      && current.endReason !== "unknown"
      && current.endReason !== "background_pending"
      && current.endReason !== "completed_with_tool_errors";
    if (!currentCauseIsHard || failure.timestamp >= current.lastTs) {
      current.endReason = endReason;
    }
    current.lastTs = Math.max(current.lastTs, failure.timestamp);
  }
  return { rows: [...bySession.values()], failures };
}
