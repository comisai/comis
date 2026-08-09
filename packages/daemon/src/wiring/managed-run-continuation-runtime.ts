// SPDX-License-Identifier: Apache-2.0
import type {
  ComisLogger,
  ManagedRunOwnerScope,
  ManagedRunRecord,
  ManagedRunStorePort,
  TypedEventBus,
} from "@comis/core";
import { sanitizeLogString } from "@comis/core";
import { err, ok, suppressError, type Result } from "@comis/shared";
import {
  createManagedRunContinuationCoalescer,
  type ManagedRunContinuationCoordinator,
} from "./managed-run-continuation-coordinator.js";

const RECOVERABLE_STATUSES = [
  "active",
  "waiting",
  "paused",
  "candidate_complete",
  "unknown",
] as const;

export interface ManagedRunContinuationRuntime {
  recover(): Promise<Result<{ readonly scheduledCount: number; readonly invalidCount: number }, Error>>;
  waitUntilIdle(): Promise<void>;
  shutdown(): Promise<void>;
}

function ownerScope(record: ManagedRunRecord): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: record.tenantId,
    agentId: record.agentId,
    principalId: record.principalId,
    conversationRef: record.conversationRef,
  };
}

/** Subscribe durable accepted reports to exact-owner continuation processing. */
export function createManagedRunContinuationRuntime(deps: {
  readonly eventBus: TypedEventBus;
  readonly store: ManagedRunStorePort;
  readonly coordinator: ManagedRunContinuationCoordinator;
  readonly nowMs: () => number;
  readonly recoveryBatchSize: number;
  readonly logger: ComisLogger;
}): ManagedRunContinuationRuntime {
  const log = deps.logger.child({ submodule: "managed-run-continuation-runtime" });
  const serviceByRun = new Map<string, string>();
  const recoveredRecordByRun = new Map<string, ManagedRunRecord>();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  const coalescer = createManagedRunContinuationCoalescer({
    process: async (managedRunId) => {
      const serviceInstanceId = serviceByRun.get(managedRunId);
      if (serviceInstanceId === undefined) return false;
      const recoveredRecord = recoveredRecordByRun.get(managedRunId);
      recoveredRecordByRun.delete(managedRunId);
      const loaded = recoveredRecord === undefined
        ? await deps.store.get({ kind: "service", serviceInstanceId }, managedRunId)
        : ok<ManagedRunRecord | undefined>(recoveredRecord);
      if (!loaded.ok) {
        log.error({
          managedRunId,
          serviceInstanceId,
          errorKind: "resource" as const,
          hint: "Repair the managed-run store and restart so pending continuations are recovered",
        }, "Managed-run continuation owner resolution failed");
        return Promise.reject(loaded.error);
      }
      if (loaded.value === undefined) {
        log.debug({ managedRunId, serviceInstanceId, step: "owner-resolution" }, "Managed-run continuation event no longer has a scoped record");
        return false;
      }
      const processed = await deps.coordinator.process(ownerScope(loaded.value), managedRunId);
      if (!processed.ok) {
        log.error({
          managedRunId,
          serviceInstanceId,
          errorKind: "internal" as const,
          hint: "Inspect the managed-run claim, evidence, policy snapshot, and delivery dependencies before retrying",
        }, "Managed-run continuation processing failed");
        return Promise.reject(processed.error);
      }
      return processed.value.kind === "processed" && processed.value.pendingAfterCurrent;
    },
  });

  function schedule(managedRunId: string, serviceInstanceId: string): void {
    if (stopped) return;
    serviceByRun.set(managedRunId, serviceInstanceId);
    const drain = coalescer.request(managedRunId);
    inFlight.add(drain);
    void drain.then(
      () => { inFlight.delete(drain); },
      () => { inFlight.delete(drain); },
    );
    suppressError(drain, "managed-run continuation event handler", (message) => {
      log.debug({ step: "event-handler", err: sanitizeLogString(message) }, "Managed-run continuation rejection was contained");
    });
  }

  const onReportAccepted = (event: {
    readonly managedRunId: string;
    readonly serviceInstanceId: string;
  }): void => {
    schedule(event.managedRunId, event.serviceInstanceId);
  };
  deps.eventBus.on("managed_run:report_accepted", onReportAccepted);

  async function waitUntilIdle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight].map(async (pending) => {
        const settled = await pending.then(
          () => ok(undefined),
          (cause: unknown) => err(cause instanceof Error ? cause : new Error(String(cause))),
        );
        if (!settled.ok) return;
      }));
    }
  }

  return Object.freeze({
    recover: async () => {
      const recovered = await deps.store.listRecoverable({
        kind: "recovery",
        statuses: RECOVERABLE_STATUSES,
        updatedBeforeMs: deps.nowMs(),
        limit: deps.recoveryBatchSize,
      });
      if (!recovered.ok) return recovered;
      for (const record of recovered.value.records) {
        if (record.pendingContinuation) {
          recoveredRecordByRun.set(record.managedRunId, record);
          schedule(record.managedRunId, record.serviceInstanceId);
        }
      }
      if (recovered.value.invalid.length > 0) {
        log.warn({
          invalidCount: recovered.value.invalid.length,
          errorKind: "validation" as const,
          hint: "Inspect quarantined managed-run rows and restore valid content-free authority records",
        }, "Managed-run continuation recovery quarantined invalid rows");
      }
      return ok({
        scheduledCount: recovered.value.records.filter((record) => record.pendingContinuation).length,
        invalidCount: recovered.value.invalid.length,
      });
    },
    waitUntilIdle,
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      deps.eventBus.off("managed_run:report_accepted", onReportAccepted);
      await waitUntilIdle();
    },
  });
}
