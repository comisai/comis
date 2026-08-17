// SPDX-License-Identifier: Apache-2.0
import type {
  CapabilityServiceControlPort,
  ManagedRunOwnerScope,
  ManagedRunStatus,
  ManagedRunStorePort,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

const TERMINAL_STATUSES: ReadonlySet<ManagedRunStatus> = new Set([
  "cancelled",
  "failed",
  "succeeded",
]);

export interface ManagedRunCancellationInput {
  readonly operationId: string;
  readonly managedRunId: string;
  readonly reason: "owner_cancelled" | "authority_revoked" | "budget_exhausted";
}

export type ManagedRunCancellationOutcome =
  | {
    readonly kind: "cancelled";
    readonly managedRunId: string;
    readonly serviceAcknowledged: boolean;
    readonly serviceState?: "cancelling" | "cancelled" | "already_terminal";
    readonly serviceReasonCode?: string;
  }
  | { readonly kind: "already_terminal"; readonly status: ManagedRunStatus }
  | { readonly kind: "not_found" };

export interface ManagedRunCancellationCoordinator {
  cancel(
    scope: ManagedRunOwnerScope,
    input: ManagedRunCancellationInput,
  ): Promise<Result<ManagedRunCancellationOutcome, Error>>;
}

export interface ManagedRunCancellationCoordinatorDeps {
  readonly store: Pick<ManagedRunStorePort, "claimTransition" | "get">;
  readonly control: Pick<CapabilityServiceControlPort, "cancel">;
  readonly nowMs: () => number;
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

/**
 * Cancels one managed run on the host's authority.
 *
 * The durable transition commits before the service is told, and it stands even
 * when the service cannot be reached: the run record is the host's, and the
 * reducer already treats a host-recorded cancellation as outranking every later
 * report. Telling the operator the cancel failed because a socket was down
 * would contradict the record they can already read.
 */
export function createManagedRunCancellationCoordinator(
  deps: ManagedRunCancellationCoordinatorDeps,
): ManagedRunCancellationCoordinator {
  return {
    async cancel(scope, input) {
      const existing = await invoke(() => deps.store.get(scope, input.managedRunId));
      if (!existing.ok) return existing;
      const record = existing.value;
      if (record === undefined) return ok({ kind: "not_found" });
      if (TERMINAL_STATUSES.has(record.status)) {
        return ok({ kind: "already_terminal", status: record.status });
      }

      const cancelledAtMs = deps.nowMs();
      const claimed = await invoke(() => deps.store.claimTransition(scope, {
        operationId: input.operationId,
        managedRunId: input.managedRunId,
        expectedStatuses: ["preparing", "active", "waiting", "paused", "candidate_complete", "unknown"],
        nextStatus: "cancelled",
        nextStatusReason: input.reason === "authority_revoked"
          ? "authority_revoked"
          : "owner_cancelled",
        transitionedAtMs: cancelledAtMs,
        terminalOutcome: { kind: "cancelled", recordedAtMs: cancelledAtMs },
      }));
      if (!claimed.ok) return claimed;
      if (claimed.value.kind !== "claimed" && claimed.value.kind !== "identical_replay") {
        // Something settled the run between the read and the claim. Report the
        // authority record as it now stands rather than retrying into a race.
        const settled = await invoke(() => deps.store.get(scope, input.managedRunId));
        if (!settled.ok) return settled;
        return ok(settled.value === undefined
          ? { kind: "not_found" }
          : { kind: "already_terminal", status: settled.value.status });
      }

      const notified = await invoke(async () => ok(await deps.control.cancel({
        operationId: input.operationId,
        serviceInstanceId: record.serviceInstanceId,
        managedRunId: input.managedRunId,
        reason: input.reason,
      })));
      if (!notified.ok) return notified;
      return ok(notified.value.ok
        ? {
          kind: "cancelled",
          managedRunId: input.managedRunId,
          serviceAcknowledged: true,
          serviceState: notified.value.value.state,
        }
        : {
          kind: "cancelled",
          managedRunId: input.managedRunId,
          serviceAcknowledged: false,
          serviceReasonCode: notified.value.error.reasonCode,
        });
    },
  };
}
