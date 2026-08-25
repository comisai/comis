// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type {
  WorkspaceLeaseDisposition,
  WorkspaceLeaseFilesystemIdentity,
  WorkspaceLeaseRecord,
} from "../domain/workspace-lease.js";

/** Exact tenant, agent, service, and run authority for one workspace lease. */
export interface WorkspaceLeaseScope {
  readonly tenantId: string;
  readonly agentId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
}

export type WorkspaceLeaseCreateOutcome =
  | { readonly kind: "created"; readonly record: WorkspaceLeaseRecord }
  | { readonly kind: "identical_replay"; readonly record: WorkspaceLeaseRecord }
  | { readonly kind: "replay_conflict" };

export interface WorkspaceLeaseReleaseInput {
  readonly operationId: string;
  readonly workspaceLeaseId: string;
  readonly disposition: WorkspaceLeaseDisposition;
  readonly releasedAtMs: number;
}

export interface WorkspaceLeaseReconcileInput {
  readonly operationId: string;
  readonly workspaceLeaseId: string;
  readonly filesystemIdentity: WorkspaceLeaseFilesystemIdentity;
  readonly recoveredAtMs: number;
}

export type WorkspaceLeaseReleaseOutcome =
  | { readonly kind: "released"; readonly record: WorkspaceLeaseRecord }
  | { readonly kind: "identical_replay"; readonly record: WorkspaceLeaseRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "state_mismatch" }
  | { readonly kind: "replay_conflict" };

export type WorkspaceLeaseReconcileOutcome =
  | { readonly kind: "recovered"; readonly record: WorkspaceLeaseRecord }
  | { readonly kind: "identical_replay"; readonly record: WorkspaceLeaseRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "state_mismatch" }
  | { readonly kind: "identity_mismatch" }
  | { readonly kind: "replay_conflict" };

export interface WorkspaceLeaseRecoveryScanInput {
  readonly kind: "recovery";
  readonly limit: number;
}

/** Content-free durable authority for canonical workspace filesystem identities. */
export interface WorkspaceLeasePort {
  create(record: WorkspaceLeaseRecord): Promise<Result<WorkspaceLeaseCreateOutcome, Error>>;
  get(
    scope: WorkspaceLeaseScope,
    workspaceLeaseId: string,
  ): Promise<Result<WorkspaceLeaseRecord | undefined, Error>>;
  release(
    scope: WorkspaceLeaseScope,
    input: WorkspaceLeaseReleaseInput,
  ): Promise<Result<WorkspaceLeaseReleaseOutcome, Error>>;
  reconcile(
    scope: WorkspaceLeaseScope,
    input: WorkspaceLeaseReconcileInput,
  ): Promise<Result<WorkspaceLeaseReconcileOutcome, Error>>;
  listRecoverable(
    input: WorkspaceLeaseRecoveryScanInput,
  ): Promise<Result<WorkspaceLeaseRecord[], Error>>;
}
