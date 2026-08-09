// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  emitObservationalEventSafely,
  reduceManagedRunState,
  wrapExternalContent,
  type ComisLogger,
  type ManagedRunContentPort,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
  type ManagedRunReduction,
  type ManagedRunReportBody,
  type ManagedRunReportIndex,
  type ManagedRunStorePort,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

export interface ManagedRunContinuationExecutionInput {
  readonly record: ManagedRunRecord;
  readonly claimId: string;
  readonly triggeringSequence: number;
  readonly announcement: string;
  readonly reducedState: ManagedRunReduction;
}

export interface ManagedRunContinuationExecutionOutcome {
  readonly deliveryState: "not_required" | "verified" | "missing" | "unavailable";
}

export interface ManagedRunContinuationCoordinatorDeps {
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly execute: (
    input: ManagedRunContinuationExecutionInput,
  ) => Promise<Result<ManagedRunContinuationExecutionOutcome, Error>>;
  readonly nowMs: () => number;
  readonly heartbeatMaxAgeMs: number;
  readonly claimTtlMs: number;
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
}

export type ManagedRunContinuationProcessOutcome =
  | { readonly kind: "idle" }
  | {
    readonly kind: "processed";
    readonly throughReportSequence: number;
    readonly pendingAfterCurrent: boolean;
  };

export interface ManagedRunContinuationCoordinator {
  process(
    scope: ManagedRunOwnerScope,
    managedRunId: string,
  ): Promise<Result<ManagedRunContinuationProcessOutcome, Error>>;
}

function claimId(managedRunId: string, throughReportSequence: number): string {
  const hash = createHash("sha256")
    .update(`${managedRunId}\0${throughReportSequence}`, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `continuation-${hash}`;
}

function contentScope(record: ManagedRunRecord) {
  return {
    tenantId: record.tenantId,
    agentId: record.agentId,
    managedRunId: record.managedRunId,
  };
}

function reportBodyHash(body: ManagedRunReportBody): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

function bodyMatchesIndex(body: ManagedRunReportBody, index: ManagedRunReportIndex): boolean {
  return body.serviceReportId === index.serviceReportId
    && body.kind === index.kind
    && body.observedAtMs === index.observedAtMs
    && reportBodyHash(body) === index.contentHash;
}

function buildAnnouncement(
  record: ManagedRunRecord,
  reports: readonly ManagedRunReportIndex[],
  bodies: readonly ManagedRunReportBody[],
): string {
  const selectedBodies = bodies.slice(-3);
  const firstSelectedIndex = bodies.length - selectedBodies.length;
  const lines = selectedBodies.map((body, index) => {
    const report = reports[firstSelectedIndex + index];
    const bodyText = [
      body.summary,
      ...(body.details === undefined ? [] : [body.details]),
      ...(body.externalKey === undefined ? [] : [`External key: ${body.externalKey}`]),
      ...(body.artifactRefs === undefined ? [] : [`Artifact references: ${body.artifactRefs.join(", ")}`]),
    ].join("\n");
    return [
      `Report ${report?.sequence ?? index + 1} (${body.kind}, ${body.serviceReportId})`,
      wrapExternalContent(bodyText, {
        source: "api",
        sender: record.serviceInstanceId,
        subject: "Managed-run service report",
      }),
    ].join("\n");
  });
  return [
    "A capability service reported an update for the managed run. Reconcile it under the recorded authority ceiling.",
    ...(firstSelectedIndex === 0 ? [] : [`${firstSelectedIndex} earlier report(s) were folded into state and omitted from this bounded announcement.`]),
    ...lines,
  ].join("\n\n");
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

function terminalOutcome(
  reduction: ManagedRunReduction,
  recordedAtMs: number,
): { readonly kind: "succeeded" | "failed" | "cancelled"; readonly recordedAtMs: number } | undefined {
  return reduction.terminalOutcomeKind === undefined
    ? undefined
    : { kind: reduction.terminalOutcomeKind, recordedAtMs };
}

/** Claim, verify, execute, and then durably advance one exact report interval. */
export function createManagedRunContinuationCoordinator(
  deps: ManagedRunContinuationCoordinatorDeps,
): ManagedRunContinuationCoordinator {
  const log = deps.logger.child({ submodule: "managed-run-continuation-coordinator" });

  return Object.freeze({
    process: async (
      scope: ManagedRunOwnerScope,
      managedRunId: string,
    ): Promise<Result<ManagedRunContinuationProcessOutcome, Error>> => {
      const startedAtMs = deps.nowMs();
      const loaded = await invoke(() => deps.store.get(scope, managedRunId));
      if (!loaded.ok) return loaded;
      if (loaded.value === undefined || !loaded.value.pendingContinuation) return ok({ kind: "idle" });
      const record = loaded.value;
      const throughReportSequence = record.lastAcceptedReportSequence;
      const continuationClaimId = claimId(managedRunId, throughReportSequence);
      const claimedAtMs = deps.nowMs();
      const claimed = await invoke(() => deps.store.claimContinuation(scope, {
        managedRunId,
        claimId: continuationClaimId,
        throughReportSequence,
        claimedAtMs,
        expiresAtMs: claimedAtMs + deps.claimTtlMs,
      }));
      if (!claimed.ok) return claimed;
      if (claimed.value.kind === "not_pending") return ok({ kind: "idle" });
      if (claimed.value.kind !== "claimed" && claimed.value.kind !== "identical_replay") {
        return err(new Error(`Managed-run continuation claim failed: ${claimed.value.kind}`));
      }

      const range = await invoke(() => deps.store.listReportRange(scope, {
        managedRunId,
        afterSequence: record.lastReducedReportSequence,
        throughSequence: throughReportSequence,
      }));
      let evidenceHealth: "available" | "malformed" | "stale" | "unavailable" = "available";
      const reports = range.ok ? range.value : [];
      if (!range.ok) evidenceHealth = "unavailable";
      const bodies: ManagedRunReportBody[] = [];
      if (evidenceHealth === "available") {
        for (const report of reports) {
          if (report.retainedUntilMs <= deps.nowMs()) {
            evidenceHealth = "stale";
            break;
          }
          const body = await invoke(() => deps.contentStore.getReportBody(
            contentScope(record),
            report.contentRef,
          ));
          if (!body.ok || body.value === undefined) {
            evidenceHealth = "unavailable";
            break;
          }
          if (!bodyMatchesIndex(body.value, report)) {
            evidenceHealth = "malformed";
            break;
          }
          bodies.push(body.value);
        }
      }

      const verifiedOutcome = reports.some((report) => report.kind === "failed")
        ? "failed" as const
        : "none" as const;
      const preliminary = reduceManagedRunState({
        currentStatus: record.status,
        currentStatusReason: record.statusReason,
        openAttentionCount: record.openAttentionCount,
        reports,
        throughReportSequence,
        lastHeartbeatAtMs: record.lastHeartbeatAtMs,
        heartbeatMaxAgeMs: deps.heartbeatMaxAgeMs,
        heartbeatRequired: true,
        evidenceHealth,
        verifiedOutcome,
        deliveryState: "not_required",
        nowMs: deps.nowMs(),
      });

      let execution: Result<ManagedRunContinuationExecutionOutcome, Error> | undefined;
      if (evidenceHealth === "available" && preliminary.actionable) {
        execution = await invoke(() => deps.execute({
          record,
          claimId: continuationClaimId,
          triggeringSequence: throughReportSequence,
          announcement: buildAnnouncement(record, reports, bodies),
          reducedState: preliminary,
        }));
      }
      const executionFailed = execution !== undefined && !execution.ok;
      const finalReduction = executionFailed
        ? reduceManagedRunState({
          currentStatus: record.status,
          currentStatusReason: record.statusReason,
          openAttentionCount: record.openAttentionCount,
          reports,
          throughReportSequence,
          lastHeartbeatAtMs: record.lastHeartbeatAtMs,
          heartbeatMaxAgeMs: deps.heartbeatMaxAgeMs,
          heartbeatRequired: true,
          evidenceHealth: "unavailable",
          verifiedOutcome: "none",
          deliveryState: "unavailable",
          nowMs: deps.nowMs(),
        })
        : preliminary.status === "candidate_complete" && execution?.ok
          ? reduceManagedRunState({
            currentStatus: record.status,
            currentStatusReason: record.statusReason,
            openAttentionCount: record.openAttentionCount,
            reports,
            throughReportSequence,
            lastHeartbeatAtMs: record.lastHeartbeatAtMs,
            heartbeatMaxAgeMs: deps.heartbeatMaxAgeMs,
            heartbeatRequired: true,
            evidenceHealth,
            verifiedOutcome: "succeeded",
            deliveryState: execution.value.deliveryState,
            nowMs: deps.nowMs(),
          })
          : preliminary;
      const committedAtMs = deps.nowMs();
      const outcome = terminalOutcome(finalReduction, committedAtMs);
      const committed = await invoke(() => deps.store.commitReducedState(scope, {
        managedRunId,
        claimId: continuationClaimId,
        throughReportSequence,
        status: finalReduction.status,
        statusReason: finalReduction.statusReason,
        committedAtMs,
        ...(outcome === undefined ? {} : { terminalOutcome: outcome }),
      }));
      if (!committed.ok) return committed;
      if (committed.value.kind !== "updated" && committed.value.kind !== "identical_replay") {
        return err(new Error(`Managed-run reduction commit failed: ${committed.value.kind}`));
      }
      const settled = await invoke(() => deps.store.markContinuationOutcome(scope, {
        managedRunId,
        claimId: continuationClaimId,
        outcome: executionFailed ? "failed" : "completed",
        recordedAtMs: deps.nowMs(),
      }));
      if (!settled.ok) return settled;
      if (settled.value.kind !== "updated" && settled.value.kind !== "identical_replay") {
        return err(new Error(`Managed-run continuation settlement failed: ${settled.value.kind}`));
      }
      const pendingAfterCurrent = settled.value.record.pendingContinuation;
      log.info({
        managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        throughReportSequence,
        status: finalReduction.status,
        pendingAfterCurrent,
        durationMs: Math.max(0, deps.nowMs() - startedAtMs),
      }, "Managed-run continuation completed");
      emitObservationalEventSafely({ eventBus: deps.eventBus, logger: log }, "managed_run:continuation_completed", {
        managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        throughReportSequence,
        status: finalReduction.status,
        pendingAfterCurrent,
        durationMs: Math.max(0, deps.nowMs() - startedAtMs),
        timestamp: deps.nowMs(),
      });
      if (executionFailed) {
        log.warn({
          managedRunId,
          serviceInstanceId: record.serviceInstanceId,
          hint: "Inspect the managed-run continuation execution and retry after its exact policy, tools, and delivery dependencies are available",
          errorKind: "dependency" as const,
        }, "Managed-run continuation failed closed");
      }
      return ok({ kind: "processed", throughReportSequence, pendingAfterCurrent });
    },
  });
}

export interface ManagedRunContinuationCoalescer {
  request(managedRunId: string): Promise<void>;
}

/** Serialize work per run while folding every in-flight notification into one bit. */
export function createManagedRunContinuationCoalescer(deps: {
  readonly process: (managedRunId: string) => Promise<unknown>;
}): ManagedRunContinuationCoalescer {
  const active = new Map<string, { pendingAfterCurrent: boolean; drain: Promise<void> }>();
  return Object.freeze({
    request: (managedRunId: string): Promise<void> => {
      const existing = active.get(managedRunId);
      if (existing !== undefined) {
        existing.pendingAfterCurrent = true;
        return existing.drain;
      }
      const state = { pendingAfterCurrent: false, drain: Promise.resolve() };
      state.drain = (async () => {
        try {
          do {
            state.pendingAfterCurrent = false;
            await deps.process(managedRunId);
          } while (state.pendingAfterCurrent);
        } finally {
          active.delete(managedRunId);
        }
      })();
      active.set(managedRunId, state);
      return state.drain;
    },
  });
}
