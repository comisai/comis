// SPDX-License-Identifier: Apache-2.0
import type {
  ManagedRunRecord,
  ManagedRunStorePort,
  WorkspaceLeaseReleaseInput,
  WorkspaceLeasePort,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

export interface ManagedRunReleaseInput {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly disposition: WorkspaceLeaseReleaseInput["disposition"];
  readonly releasedAtMs: number;
}

export type ManagedRunReleaseOutcome =
  | {
    readonly kind: "released";
    readonly managedRunId: string;
    readonly workspaceLeaseId: string;
    readonly disposition: WorkspaceLeaseReleaseInput["disposition"];
    readonly releasedAtMs: number;
  }
  | {
    readonly kind: "rejected";
    readonly reasonCode:
      | "authority_mismatch"
      | "release_conflict"
      | "resources_active"
      | "state_mismatch";
  };

export interface ManagedRunReleaseCoordinator {
  release(input: ManagedRunReleaseInput): Promise<Result<ManagedRunReleaseOutcome, Error>>;
}

export interface ManagedRunReleaseCoordinatorDeps {
  readonly store: Pick<ManagedRunStorePort, "reserveRelease">;
  readonly workspaceLeases: Pick<WorkspaceLeasePort, "release">;
  readonly revokeBoundResources: (
    record: ManagedRunRecord,
    releaseOperationId: string,
  ) => Promise<boolean>;
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

/** Revoke exact run capabilities before durably releasing its workspace authority. */
export function createManagedRunReleaseCoordinator(
  deps: ManagedRunReleaseCoordinatorDeps,
): ManagedRunReleaseCoordinator {
  return {
    async release(input) {
      const reserved = await invoke(() => deps.store.reserveRelease(
        { kind: "service", serviceInstanceId: input.serviceInstanceId },
        {
          operationId: input.operationId,
          managedRunId: input.managedRunId,
          workspaceLeaseId: input.workspaceLeaseId,
          disposition: input.disposition,
          releasedAtMs: input.releasedAtMs,
        },
      ));
      if (!reserved.ok) return reserved;
      if (reserved.value.kind === "replay_conflict") {
        return ok({ kind: "rejected", reasonCode: "release_conflict" });
      }
      if (reserved.value.kind !== "reserved" && reserved.value.kind !== "identical_replay") {
        return ok({ kind: "rejected", reasonCode: "authority_mismatch" });
      }
      const record = reserved.value.record;

      const revoked = await fromPromise(
        deps.revokeBoundResources(record, input.operationId),
      );
      if (!revoked.ok) return err(revoked.error);
      if (!revoked.value) return ok({ kind: "rejected", reasonCode: "resources_active" });

      const released = await invoke(() => deps.workspaceLeases.release({
        tenantId: record.tenantId,
        agentId: record.agentId,
        serviceInstanceId: record.serviceInstanceId,
        managedRunId: record.managedRunId,
      }, {
        operationId: input.operationId,
        workspaceLeaseId: input.workspaceLeaseId,
        disposition: input.disposition,
        releasedAtMs: input.releasedAtMs,
      }));
      if (!released.ok) return released;
      if (released.value.kind === "replay_conflict") {
        return ok({ kind: "rejected", reasonCode: "release_conflict" });
      }
      if (released.value.kind !== "released" && released.value.kind !== "identical_replay") {
        return ok({ kind: "rejected", reasonCode: released.value.kind === "state_mismatch"
          ? "state_mismatch"
          : "authority_mismatch" });
      }
      const lease = released.value.record;
      if (
        lease.managedRunId !== input.managedRunId
        || lease.workspaceLeaseId !== input.workspaceLeaseId
        || lease.state !== "released"
        || lease.releaseDisposition !== input.disposition
        || lease.releasedAtMs !== input.releasedAtMs
      ) return err(new Error("managed-run release receipt differs from requested authority"));
      return ok({
        kind: "released",
        managedRunId: input.managedRunId,
        workspaceLeaseId: input.workspaceLeaseId,
        disposition: input.disposition,
        releasedAtMs: input.releasedAtMs,
      });
    },
  };
}
