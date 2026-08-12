// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ManagedRunReportInputSchema,
  emitObservationalEventSafely,
  type ComisLogger,
  type ManagedRunContentPort,
  type ManagedRunContentScope,
  type ManagedRunReportBody,
  type ManagedRunReportIndex,
  type ManagedRunReportInput,
  type ManagedRunStorePort,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/;
const REPORTABLE_STATUSES = new Set(["active", "waiting", "paused", "candidate_complete", "unknown"]);

const ManagedRunReportIngressSchema = z.strictObject({
  serviceInstanceId: z.string().regex(OPAQUE_ID_PATTERN),
  managedRunId: z.string().regex(OPAQUE_ID_PATTERN),
  report: ManagedRunReportInputSchema,
});

export interface ManagedRunReportIngressInput {
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly report: ManagedRunReportInput;
}

export type ManagedRunReportRejectionReason =
  | "invalid_report"
  | "managed_run_not_found"
  | "observed_time_out_of_bounds"
  | "replay_conflict"
  | "state_mismatch";

export type ManagedRunReportIngressOutcome =
  | { readonly kind: "accepted"; readonly report: ManagedRunReportIndex }
  | { readonly kind: "identical_replay"; readonly report: ManagedRunReportIndex }
  | { readonly kind: "rejected"; readonly reasonCode: ManagedRunReportRejectionReason };

export interface ManagedRunReportBridge {
  ingestReport(
    input: ManagedRunReportIngressInput,
  ): Promise<Result<ManagedRunReportIngressOutcome, Error>>;
}

export interface ManagedRunReportBridgeDeps {
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly nowMs: () => number;
  readonly retentionMs: number;
  readonly maxObservedClockSkewMs: number;
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

function sameBody(left: ManagedRunReportBody, right: ManagedRunReportBody): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function attentionId(identity: {
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
}, body: ManagedRunReportBody): string {
  const key = body.externalKey ?? body.serviceReportId;
  const digest = createHash("sha256")
    .update(`${identity.serviceInstanceId}\0${identity.managedRunId}\0${key}`, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `attention-${digest}`;
}

function contentScope(
  record: { readonly tenantId: string; readonly agentId: string; readonly managedRunId: string },
): ManagedRunContentScope {
  return {
    tenantId: record.tenantId,
    agentId: record.agentId,
    managedRunId: record.managedRunId,
  };
}

/** Accept authenticated service reports without granting authority from their bodies. */
export function createManagedRunReportBridge(deps: ManagedRunReportBridgeDeps): ManagedRunReportBridge {
  function rejectReport(
    reasonCode: ManagedRunReportRejectionReason,
    identity?: { readonly serviceInstanceId: string; readonly managedRunId: string },
  ): Result<ManagedRunReportIngressOutcome, Error> {
    deps.logger.audit({
      decision: "deny",
      reasonCode,
      ...(identity === undefined ? {} : identity),
    }, "Managed-run report rejected");
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:report_rejected",
      {
        reasonCode,
        ...(identity === undefined ? {} : identity),
        timestamp: deps.nowMs(),
      },
    );
    return ok({ kind: "rejected", reasonCode });
  }

  function logTransactionFailure(
    identity: { readonly serviceInstanceId: string; readonly managedRunId: string },
    step: string,
  ): void {
    deps.logger.error({
      ...identity,
      step,
      errorKind: "internal" as const,
      hint: "Inspect the managed-run private content root and SQLite store, then retry the same service report ID",
    }, "Managed-run report transaction failed");
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:report_rejected",
      { ...identity, reasonCode: "storage_failure", timestamp: deps.nowMs() },
    );
  }

  async function removeUnindexedBody(
    scope: ManagedRunContentScope,
    contentRef: string,
    identity: { readonly serviceInstanceId: string; readonly managedRunId: string },
  ): Promise<void> {
    const removed = await invoke(() => deps.contentStore.deleteReportBody(scope, contentRef));
    if (removed.ok) return;
    deps.logger.error({
      ...identity,
      step: "report-body-compensation",
      errorKind: "internal" as const,
      hint: "Run managed-run private-content recovery and inspect the owner-only content root for an unindexed report body",
    }, "Managed-run report body compensation failed");
  }

  return Object.freeze({
    ingestReport: async (input: ManagedRunReportIngressInput) => {
      const startedAtMs = deps.nowMs();
      const parsed = ManagedRunReportIngressSchema.safeParse(input);
      if (!parsed.success) return rejectReport("invalid_report");
      const identity = {
        serviceInstanceId: parsed.data.serviceInstanceId,
        managedRunId: parsed.data.managedRunId,
      };
      const receivedAtMs = deps.nowMs();
      const retainedUntilMs = receivedAtMs + deps.retentionMs;
      if (!Number.isSafeInteger(retainedUntilMs) || retainedUntilMs < receivedAtMs) {
        logTransactionFailure(identity, "report-retention");
        return err(new Error("managed-run report retention configuration is invalid"));
      }

      deps.logger.debug({ ...identity, step: "report-authority" }, "Resolving managed-run report authority");
      const recordResult = await invoke(() => deps.store.get(
        { kind: "service", serviceInstanceId: identity.serviceInstanceId },
        identity.managedRunId,
      ));
      if (!recordResult.ok) {
        logTransactionFailure(identity, "report-authority");
        return recordResult;
      }
      if (recordResult.value === undefined) return rejectReport("managed_run_not_found", identity);
      if (
        parsed.data.report.observedAtMs !== undefined
        && (
          parsed.data.report.observedAtMs < recordResult.value.createdAtMs - deps.maxObservedClockSkewMs
          || parsed.data.report.observedAtMs > receivedAtMs + deps.maxObservedClockSkewMs
        )
      ) {
        return rejectReport("observed_time_out_of_bounds", identity);
      }
      if (!REPORTABLE_STATUSES.has(recordResult.value.status)) {
        return rejectReport("state_mismatch", identity);
      }

      const scope = contentScope(recordResult.value);
      const body: ManagedRunReportBody = { schemaVersion: 1, ...parsed.data.report };
      deps.logger.debug({ ...identity, step: "report-private-body" }, "Publishing managed-run private report body");
      const existing = await invoke(() => deps.contentStore.getReportBody(
        scope,
        body.serviceReportId,
      ));
      if (!existing.ok) {
        logTransactionFailure(identity, "report-private-body-read");
        return existing;
      }
      if (existing.value !== undefined && !sameBody(existing.value, body)) {
        return rejectReport("replay_conflict", identity);
      }
      const published = await invoke(() => deps.contentStore.putReportBody(
        scope,
        body,
        retainedUntilMs,
      ));
      if (!published.ok) {
        const raced = await invoke(() => deps.contentStore.getReportBody(scope, body.serviceReportId));
        if (raced.ok && raced.value !== undefined && !sameBody(raced.value, body)) {
          return rejectReport("replay_conflict", identity);
        }
        logTransactionFailure(identity, "report-private-body-write");
        return published;
      }

      deps.logger.debug({ ...identity, step: "report-index" }, "Appending managed-run report index");
      const appended = await invoke(() => deps.store.appendReportAndAdvanceAcceptedCursor(
        { kind: "service", serviceInstanceId: identity.serviceInstanceId },
        {
          managedRunId: identity.managedRunId,
          serviceReportId: body.serviceReportId,
          kind: body.kind,
          contentRef: published.value.contentRef,
          contentHash: published.value.contentHash,
          receivedAtMs,
          retainedUntilMs,
          ...(body.observedAtMs === undefined ? {} : { observedAtMs: body.observedAtMs }),
          ...(body.kind === "attention" || body.kind === "blocked"
            ? {
              attention: {
                attentionId: attentionId(identity, body),
                attentionRef: published.value.contentRef,
                ...(body.externalKey === undefined ? {} : { externalKey: body.externalKey }),
              },
            }
            : {}),
          ...(body.kind === "resolution" && body.externalKey !== undefined
            ? { resolutionExternalKey: body.externalKey }
            : {}),
        },
      ));
      if (!appended.ok) {
        if (existing.value === undefined) {
          await removeUnindexedBody(scope, body.serviceReportId, identity);
        }
        logTransactionFailure(identity, "report-index");
        return appended;
      }
      if (appended.value.kind !== "accepted" && appended.value.kind !== "identical_replay") {
        if (existing.value === undefined) {
          await removeUnindexedBody(scope, body.serviceReportId, identity);
        }
        if (appended.value.kind === "replay_conflict") {
          return rejectReport("replay_conflict", identity);
        }
        if (appended.value.kind === "state_mismatch") {
          return rejectReport("state_mismatch", identity);
        }
        return rejectReport("managed_run_not_found", identity);
      }

      const durationMs = Math.max(0, deps.nowMs() - startedAtMs);
      if (appended.value.kind === "identical_replay") {
        deps.logger.info({
          ...identity,
          sequence: appended.value.report.sequence,
          durationMs,
        }, "Managed-run report replay accepted");
        return ok(appended.value);
      }
      deps.logger.info({
        ...identity,
        sequence: appended.value.report.sequence,
        kind: appended.value.report.kind,
        durationMs,
      }, "Managed-run report accepted");
      emitObservationalEventSafely(
        { eventBus: deps.eventBus, logger: deps.logger },
        "managed_run:report_accepted",
        {
          ...identity,
          sequence: appended.value.report.sequence,
          kind: appended.value.report.kind,
          durationMs,
          timestamp: deps.nowMs(),
        },
      );
      return ok(appended.value);
    },
  });
}
