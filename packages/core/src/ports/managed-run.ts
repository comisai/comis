// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { ConversationRef } from "../domain/conversation-scope.js";
import type {
  ManagedRunRecord,
  ManagedRunStatus,
  ManagedRunStatusReason,
  ManagedRunTerminalOutcome,
} from "../domain/managed-run.js";
import type {
  ManagedRunActivationDescriptor,
  ManagedRunReportBody,
  ManagedRunReportIndex,
  ManagedRunReportKind,
} from "../domain/managed-run-content.js";

/** Exact human or configured internal-principal authority for owner operations. */
export interface ManagedRunOwnerScope {
  readonly kind: "owner";
  readonly tenantId: string;
  readonly agentId: string;
  readonly principalId: string;
  readonly conversationRef: ConversationRef;
}

/** Authenticated capability-service identity for service-originated operations. */
export interface ManagedRunServiceScope {
  readonly kind: "service";
  readonly serviceInstanceId: string;
}

export type ManagedRunLookupScope = ManagedRunOwnerScope | ManagedRunServiceScope;

/** Exact filesystem-content scope; no content method derives a tenant or agent. */
export interface ManagedRunContentScope {
  readonly tenantId: string;
  readonly agentId: string;
  readonly managedRunId: string;
}

export type ManagedRunCreateOutcome =
  | { readonly kind: "created"; readonly record: ManagedRunRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunRecord }
  | { readonly kind: "replay_conflict" };

export interface ManagedRunTransitionClaimInput {
  readonly operationId: string;
  readonly managedRunId: string;
  readonly expectedStatuses: readonly ManagedRunStatus[];
  readonly nextStatus: ManagedRunStatus;
  readonly nextStatusReason: ManagedRunStatusReason;
  readonly transitionedAtMs: number;
  readonly terminalOutcome?: ManagedRunTerminalOutcome;
}

export type ManagedRunTransitionClaimOutcome =
  | { readonly kind: "claimed"; readonly record: ManagedRunRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "state_mismatch"; readonly status: ManagedRunStatus }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "replay_conflict" };

export interface ManagedRunTerminalBindingInput {
  readonly managedRunId: string;
  readonly terminalSessionId: string;
  readonly terminalTenantId: string;
  readonly terminalAgentId: string;
  readonly boundAtMs: number;
}

export interface ManagedRunWorkspaceBindingInput {
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly leaseTenantId: string;
  readonly leaseAgentId: string;
  readonly boundAtMs: number;
}

export type ManagedRunBindingOutcome =
  | { readonly kind: "bound"; readonly record: ManagedRunRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "ownership_mismatch" };

export interface ManagedRunReportAppendInput {
  readonly managedRunId: string;
  readonly serviceReportId: string;
  readonly kind: ManagedRunReportKind;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly receivedAtMs: number;
  readonly retainedUntilMs: number;
  readonly observedAtMs?: number;
}

export type ManagedRunReportAppendOutcome =
  | { readonly kind: "accepted"; readonly report: ManagedRunReportIndex }
  | { readonly kind: "identical_replay"; readonly report: ManagedRunReportIndex }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "state_mismatch"; readonly status: ManagedRunStatus }
  | { readonly kind: "replay_conflict" };

export interface ManagedRunReportRangeInput {
  readonly managedRunId: string;
  readonly afterSequence: number;
  readonly throughSequence: number;
}

export interface ManagedRunContinuationClaimInput {
  readonly managedRunId: string;
  readonly claimId: string;
  readonly throughReportSequence: number;
  readonly claimedAtMs: number;
  readonly expiresAtMs: number;
}

export type ManagedRunContinuationClaimOutcome =
  | { readonly kind: "claimed"; readonly record: ManagedRunRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "not_pending" }
  | { readonly kind: "cursor_mismatch" }
  | { readonly kind: "replay_conflict" };

export interface ManagedRunReducedStateInput {
  readonly managedRunId: string;
  readonly claimId: string;
  readonly throughReportSequence: number;
  readonly status: ManagedRunStatus;
  readonly statusReason: ManagedRunStatusReason;
  readonly committedAtMs: number;
  readonly terminalOutcome?: ManagedRunTerminalOutcome;
}

export type ManagedRunContinuationOutcomeKind = "completed" | "failed" | "abandoned";

export interface ManagedRunContinuationOutcomeInput {
  readonly managedRunId: string;
  readonly claimId: string;
  readonly outcome: ManagedRunContinuationOutcomeKind;
  readonly recordedAtMs: number;
}

export type ManagedRunMutationOutcome =
  | { readonly kind: "updated"; readonly record: ManagedRunRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "claim_mismatch" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "cursor_regression" };

export interface ManagedRunScopedListInput {
  readonly scope: ManagedRunOwnerScope;
  readonly statuses?: readonly ManagedRunStatus[];
  readonly limit: number;
}

export interface ManagedRunRecoveryScanInput {
  readonly kind: "recovery";
  readonly statuses: readonly ManagedRunStatus[];
  readonly updatedBeforeMs: number;
  readonly limit: number;
}

export interface InvalidManagedRunRecord {
  readonly managedRunId: string;
  readonly serviceInstanceId: string;
  readonly reason: "record_validation_failed";
}

export interface ManagedRunRecoveryScan {
  readonly records: readonly ManagedRunRecord[];
  readonly invalid: readonly InvalidManagedRunRecord[];
}

export interface ManagedRunRevokeInput {
  readonly operationId: string;
  readonly managedRunId: string;
  readonly reason: "owner_cancelled" | "authority_revoked";
  readonly revokedAtMs: number;
}

/** Content-free durable state and report-index boundary. */
export interface ManagedRunStorePort {
  create(record: ManagedRunRecord): Promise<Result<ManagedRunCreateOutcome, Error>>;
  get(scope: ManagedRunLookupScope, managedRunId: string): Promise<Result<ManagedRunRecord | undefined, Error>>;
  claimTransition(scope: ManagedRunLookupScope, input: ManagedRunTransitionClaimInput): Promise<Result<ManagedRunTransitionClaimOutcome, Error>>;
  bindTerminal(scope: ManagedRunOwnerScope, input: ManagedRunTerminalBindingInput): Promise<Result<ManagedRunBindingOutcome, Error>>;
  setWorkspaceLease(scope: ManagedRunOwnerScope, input: ManagedRunWorkspaceBindingInput): Promise<Result<ManagedRunBindingOutcome, Error>>;
  appendReportAndAdvanceAcceptedCursor(scope: ManagedRunServiceScope, input: ManagedRunReportAppendInput): Promise<Result<ManagedRunReportAppendOutcome, Error>>;
  listReportRange(scope: ManagedRunOwnerScope, input: ManagedRunReportRangeInput): Promise<Result<ManagedRunReportIndex[], Error>>;
  claimContinuation(scope: ManagedRunOwnerScope, input: ManagedRunContinuationClaimInput): Promise<Result<ManagedRunContinuationClaimOutcome, Error>>;
  commitReducedState(scope: ManagedRunOwnerScope, input: ManagedRunReducedStateInput): Promise<Result<ManagedRunMutationOutcome, Error>>;
  markContinuationOutcome(scope: ManagedRunOwnerScope, input: ManagedRunContinuationOutcomeInput): Promise<Result<ManagedRunMutationOutcome, Error>>;
  listScoped(input: ManagedRunScopedListInput): Promise<Result<ManagedRunRecord[], Error>>;
  listRecoverable(input: ManagedRunRecoveryScanInput): Promise<Result<ManagedRunRecoveryScan, Error>>;
  revoke(scope: ManagedRunOwnerScope, input: ManagedRunRevokeInput): Promise<Result<ManagedRunTransitionClaimOutcome, Error>>;
}

export interface ManagedRunPrivateContentReceipt {
  readonly contentRef: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly expiresAtMs?: number;
}

export interface ManagedRunRawPrivateContentInput {
  readonly body: Uint8Array;
  readonly expiresAtMs?: number;
}

export interface ManagedRunContentRecoveryInput {
  readonly kind: "recovery";
  readonly expiredBeforeMs: number;
  readonly limit: number;
}

/** Owner-scoped private body boundary; no index method returns body bytes. */
export interface ManagedRunContentPort {
  putActivationDescriptor(scope: ManagedRunContentScope, descriptorRef: string, descriptor: ManagedRunActivationDescriptor): Promise<Result<ManagedRunPrivateContentReceipt, Error>>;
  getActivationDescriptor(scope: ManagedRunContentScope, descriptorRef: string): Promise<Result<ManagedRunActivationDescriptor | undefined, Error>>;
  getActivationDescriptorForRecovery(scope: ManagedRunContentScope, descriptorRef: string, input: { readonly kind: "recovery" }): Promise<Result<ManagedRunActivationDescriptor | undefined, Error>>;
  deleteActivationDescriptor(scope: ManagedRunContentScope, descriptorRef: string): Promise<Result<boolean, Error>>;
  putReportBody(scope: ManagedRunContentScope, body: ManagedRunReportBody, retainedUntilMs: number): Promise<Result<ManagedRunPrivateContentReceipt, Error>>;
  getReportBody(scope: ManagedRunContentScope, contentRef: string): Promise<Result<ManagedRunReportBody | undefined, Error>>;
  deleteReportBody(scope: ManagedRunContentScope, contentRef: string): Promise<Result<boolean, Error>>;
  putEvidence(scope: ManagedRunContentScope, evidenceRef: string, input: ManagedRunRawPrivateContentInput): Promise<Result<ManagedRunPrivateContentReceipt, Error>>;
  getEvidence(scope: ManagedRunContentScope, contentRef: string): Promise<Result<Uint8Array | undefined, Error>>;
  putAttentionBody(scope: ManagedRunContentScope, attentionRef: string, input: ManagedRunRawPrivateContentInput): Promise<Result<ManagedRunPrivateContentReceipt, Error>>;
  getAttentionBody(scope: ManagedRunContentScope, contentRef: string): Promise<Result<Uint8Array | undefined, Error>>;
  purgeExpired(input: ManagedRunContentRecoveryInput): Promise<Result<number, Error>>;
}
