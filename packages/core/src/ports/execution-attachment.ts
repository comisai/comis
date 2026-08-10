// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type {
  ExecutionAttachmentFilesystemIdentity,
  ExecutionAttachmentRecord,
  ExecutionAttachmentRevocationReason,
} from "../domain/execution-attachment.js";

/** Exact tenant, agent, service, run, and lease authority for one attachment. */
export interface ExecutionAttachmentScope {
  readonly tenantId: string;
  readonly agentId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
}

export type ExecutionAttachmentCreateOutcome =
  | { readonly kind: "created"; readonly record: ExecutionAttachmentRecord }
  | { readonly kind: "identical_replay"; readonly record: ExecutionAttachmentRecord }
  | { readonly kind: "authority_mismatch" }
  | { readonly kind: "replay_conflict" };

export interface ExecutionAttachmentRevokeInput {
  readonly operationId: string;
  readonly executionAttachmentId: string;
  readonly reason: ExecutionAttachmentRevocationReason;
  readonly revokedAtMs: number;
}

export interface ExecutionAttachmentReconcileInput {
  readonly operationId: string;
  readonly executionAttachmentId: string;
  readonly sourceFilesystemIdentity: ExecutionAttachmentFilesystemIdentity;
  readonly recoveredAtMs: number;
}

export type ExecutionAttachmentRevokeOutcome =
  | { readonly kind: "revoked"; readonly record: ExecutionAttachmentRecord }
  | { readonly kind: "identical_replay"; readonly record: ExecutionAttachmentRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "state_mismatch" }
  | { readonly kind: "replay_conflict" };

export type ExecutionAttachmentReconcileOutcome =
  | { readonly kind: "recovered"; readonly record: ExecutionAttachmentRecord }
  | { readonly kind: "identical_replay"; readonly record: ExecutionAttachmentRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "state_mismatch" }
  | { readonly kind: "identity_mismatch" }
  | { readonly kind: "replay_conflict" };

export interface ExecutionAttachmentRecoveryScanInput {
  readonly kind: "recovery";
  readonly limit: number;
}

/** Content-free durable authority for run-scoped execution attachments. */
export interface ExecutionAttachmentPort {
  create(record: ExecutionAttachmentRecord): Promise<Result<ExecutionAttachmentCreateOutcome, Error>>;
  get(scope: ExecutionAttachmentScope, executionAttachmentId: string): Promise<Result<ExecutionAttachmentRecord | undefined, Error>>;
  listActiveForRun(scope: ExecutionAttachmentScope): Promise<Result<ExecutionAttachmentRecord[], Error>>;
  revoke(scope: ExecutionAttachmentScope, input: ExecutionAttachmentRevokeInput): Promise<Result<ExecutionAttachmentRevokeOutcome, Error>>;
  reconcile(scope: ExecutionAttachmentScope, input: ExecutionAttachmentReconcileInput): Promise<Result<ExecutionAttachmentReconcileOutcome, Error>>;
  listRecoverable(input: ExecutionAttachmentRecoveryScanInput): Promise<Result<ExecutionAttachmentRecord[], Error>>;
}
