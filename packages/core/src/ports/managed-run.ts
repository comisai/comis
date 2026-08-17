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
  ManagedEvidenceIndex,
  ManagedEvidenceVerificationLevel,
} from "../domain/managed-run-content.js";
import type { ManagedRunAttentionRecord } from "../domain/managed-run-attention.js";
import type { WorkspaceLeaseDisposition } from "../domain/workspace-lease.js";

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

export interface ManagedRunTerminalReleaseInput {
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly terminalSessionId: string;
  readonly releasedAtMs: number;
}

export interface ManagedRunWorkspaceBindingInput {
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly leaseTenantId: string;
  readonly leaseAgentId: string;
  readonly boundAtMs: number;
}

export interface ManagedRunExecutionAttachmentBindingInput {
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly executionAttachmentId: string;
  readonly attachmentServiceInstanceId: string;
  readonly attachmentTenantId: string;
  readonly attachmentAgentId: string;
  readonly boundAtMs: number;
}

export type ManagedRunBindingOutcome =
  | { readonly kind: "bound"; readonly record: ManagedRunRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "ownership_mismatch" }
  | { readonly kind: "release_reserved" };

export interface ManagedRunReleaseReservationInput {
  readonly operationId: string;
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly disposition: WorkspaceLeaseDisposition;
  readonly releasedAtMs: number;
}

export type ManagedRunReleaseReservationOutcome =
  | { readonly kind: "reserved"; readonly record: ManagedRunRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "authority_mismatch" }
  | { readonly kind: "replay_conflict" };

export interface ManagedRunHeartbeatInput {
  readonly managedRunId: string;
  readonly observedAtMs: number;
}

/**
 * Liveness is an observation, not a transition: it carries no operation ID and
 * is never replayed. A rejection says the observation is not admissible, which
 * keeps a stale or foreign beat from making a dead service look current.
 */
export type ManagedRunHeartbeatOutcome =
  | { readonly kind: "committed"; readonly record: ManagedRunRecord }
  | {
    readonly kind: "rejected";
    readonly reasonCode: "not_found" | "ownership_mismatch" | "terminal_run" | "stale_observation";
  };

export type ManagedRunTerminalReleaseOutcome =
  | { readonly kind: "released"; readonly record: ManagedRunRecord }
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
  readonly attention?: {
    readonly attentionId: string;
    readonly attentionRef: string;
    readonly externalKey?: string;
    readonly expiresAtMs?: number;
  };
  readonly resolutionExternalKey?: string;
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

export interface ManagedEvidenceAppendInput {
  readonly managedRunId: string;
  readonly evidenceRef: string;
  readonly kind: string;
  readonly subjectDigest: string;
  readonly observedAtMs: number;
  readonly expiresAtMs?: number;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly privateContentHash: string;
  readonly verificationLevel: ManagedEvidenceVerificationLevel;
  readonly deliveryKind: "none" | "reference" | "attachment";
  readonly receivedAtMs: number;
}

export type ManagedEvidenceAppendOutcome =
  | { readonly kind: "accepted"; readonly evidence: ManagedEvidenceIndex }
  | { readonly kind: "identical_replay"; readonly evidence: ManagedEvidenceIndex }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "state_mismatch"; readonly status: ManagedRunStatus }
  | { readonly kind: "replay_conflict" };

export interface ManagedEvidenceListInput {
  readonly managedRunId: string;
  readonly evidenceRefs: readonly string[];
}

export interface ManagedRunAttentionListInput {
  readonly managedRunId?: string;
  readonly limit: number;
}

export interface ManagedRunAttentionResponseInput {
  readonly operationId: string;
  readonly attentionId: string;
  readonly responseRef: string;
  readonly respondedAtMs: number;
}

export interface ManagedRunAttentionDeliveryInput {
  readonly operationId: string;
  readonly attentionId: string;
  readonly deliveredAtMs: number;
}

export type ManagedRunAttentionMutationOutcome =
  | { readonly kind: "updated"; readonly record: ManagedRunAttentionRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunAttentionRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "scope_mismatch" }
  | { readonly kind: "state_mismatch" }
  | { readonly kind: "replay_conflict" };

export interface ManagedAttentionReplyInput {
  readonly operationId: string;
  readonly attentionId?: string;
  readonly text: string;
  readonly respondedAtMs: number;
}

export type ManagedAttentionReplyBindingOutcome =
  | { readonly kind: "bound"; readonly attention: ManagedRunAttentionRecord }
  | { readonly kind: "not_applicable" }
  | {
    readonly kind: "clarification_required";
    readonly reason: "none_open" | "ambiguous" | "handle_not_found" | "already_answered";
    readonly candidateAttentionIds: readonly string[];
  };

/** Owner-facing port that binds a private reply to one exact durable attention row. */
export interface ManagedAttentionReplyPort {
  bind(
    scope: ManagedRunOwnerScope,
    input: ManagedAttentionReplyInput,
  ): Promise<Result<ManagedAttentionReplyBindingOutcome, Error>>;
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
  | {
    readonly kind: "identical_replay";
    readonly record: ManagedRunRecord;
    readonly reducedRecord?: ManagedRunRecord;
    readonly reducedOutcome?: ManagedRunContinuationOutcomeKind;
  }
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
  readonly continuationOutcome: ManagedRunContinuationOutcomeKind;
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

/**
 * A cross-scope operator read. The explicit discriminator is the safety
 * property: the scoped list can never degrade into this one by having its scope
 * omitted, so a caller reaches another principal's work only by naming that it
 * is administering the host rather than serving a conversation.
 */
export interface ManagedRunAdministrationListInput {
  readonly kind: "administration";
  readonly serviceInstanceId?: string;
  readonly agentId?: string;
  readonly statuses?: readonly ManagedRunStatus[];
  readonly limit: number;
}

export interface ManagedRunAdministrationGetInput {
  readonly kind: "administration";
  readonly managedRunId: string;
}

export interface ManagedRunAttentionAdministrationListInput {
  readonly kind: "administration";
  readonly managedRunId?: string;
  readonly limit: number;
}

export interface ManagedRunRecoveryScanInput {
  readonly kind: "recovery";
  readonly statuses: readonly ManagedRunStatus[];
  readonly updatedBeforeMs: number;
  readonly afterManagedRunId?: string;
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
  readonly nextAfterManagedRunId?: string;
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
  getByExternalRunRef(
    scope: ManagedRunOwnerScope,
    serviceInstanceId: string,
    externalRunRef: string,
  ): Promise<Result<ManagedRunRecord | undefined, Error>>;
  claimTransition(scope: ManagedRunLookupScope, input: ManagedRunTransitionClaimInput): Promise<Result<ManagedRunTransitionClaimOutcome, Error>>;
  bindTerminal(scope: ManagedRunOwnerScope, input: ManagedRunTerminalBindingInput): Promise<Result<ManagedRunBindingOutcome, Error>>;
  releaseTerminal(scope: ManagedRunServiceScope, input: ManagedRunTerminalReleaseInput): Promise<Result<ManagedRunTerminalReleaseOutcome, Error>>;
  setWorkspaceLease(scope: ManagedRunOwnerScope, input: ManagedRunWorkspaceBindingInput): Promise<Result<ManagedRunBindingOutcome, Error>>;
  bindExecutionAttachment(scope: ManagedRunOwnerScope, input: ManagedRunExecutionAttachmentBindingInput): Promise<Result<ManagedRunBindingOutcome, Error>>;
  reserveRelease(scope: ManagedRunServiceScope, input: ManagedRunReleaseReservationInput): Promise<Result<ManagedRunReleaseReservationOutcome, Error>>;
  recordHeartbeat(scope: ManagedRunServiceScope, input: ManagedRunHeartbeatInput): Promise<Result<ManagedRunHeartbeatOutcome, Error>>;
  appendReportAndAdvanceAcceptedCursor(scope: ManagedRunServiceScope, input: ManagedRunReportAppendInput): Promise<Result<ManagedRunReportAppendOutcome, Error>>;
  listReportRange(scope: ManagedRunOwnerScope, input: ManagedRunReportRangeInput): Promise<Result<ManagedRunReportIndex[], Error>>;
  appendEvidence(scope: ManagedRunServiceScope, input: ManagedEvidenceAppendInput): Promise<Result<ManagedEvidenceAppendOutcome, Error>>;
  listEvidenceByRefs(scope: ManagedRunOwnerScope, input: ManagedEvidenceListInput): Promise<Result<ManagedEvidenceIndex[], Error>>;
  getAttention(scope: ManagedRunOwnerScope, attentionId: string): Promise<Result<ManagedRunAttentionRecord | undefined, Error>>;
  getAttentionResponseByOperation(
    scope: ManagedRunOwnerScope,
    operationId: string,
  ): Promise<Result<ManagedRunAttentionRecord | undefined, Error>>;
  listOpenAttention(scope: ManagedRunOwnerScope, input: ManagedRunAttentionListInput): Promise<Result<ManagedRunAttentionRecord[], Error>>;
  claimAttentionResponse(scope: ManagedRunOwnerScope, input: ManagedRunAttentionResponseInput): Promise<Result<ManagedRunAttentionMutationOutcome, Error>>;
  markAttentionDelivered(scope: ManagedRunOwnerScope, input: ManagedRunAttentionDeliveryInput): Promise<Result<ManagedRunAttentionMutationOutcome, Error>>;
  claimContinuation(scope: ManagedRunOwnerScope, input: ManagedRunContinuationClaimInput): Promise<Result<ManagedRunContinuationClaimOutcome, Error>>;
  commitReducedState(scope: ManagedRunOwnerScope, input: ManagedRunReducedStateInput): Promise<Result<ManagedRunMutationOutcome, Error>>;
  markContinuationOutcome(scope: ManagedRunOwnerScope, input: ManagedRunContinuationOutcomeInput): Promise<Result<ManagedRunMutationOutcome, Error>>;
  listScoped(input: ManagedRunScopedListInput): Promise<Result<ManagedRunRecord[], Error>>;
  listForAdministration(input: ManagedRunAdministrationListInput): Promise<Result<ManagedRunRecord[], Error>>;
  getForAdministration(input: ManagedRunAdministrationGetInput): Promise<Result<ManagedRunRecord | undefined, Error>>;
  listAttentionForAdministration(input: ManagedRunAttentionAdministrationListInput): Promise<Result<ManagedRunAttentionRecord[], Error>>;
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
  deleteEvidence(scope: ManagedRunContentScope, contentRef: string): Promise<Result<boolean, Error>>;
  putAttentionBody(scope: ManagedRunContentScope, attentionRef: string, input: ManagedRunRawPrivateContentInput): Promise<Result<ManagedRunPrivateContentReceipt, Error>>;
  getAttentionBody(scope: ManagedRunContentScope, contentRef: string): Promise<Result<Uint8Array | undefined, Error>>;
  deleteAttentionBody(scope: ManagedRunContentScope, contentRef: string): Promise<Result<boolean, Error>>;
  purgeExpired(input: ManagedRunContentRecoveryInput): Promise<Result<number, Error>>;
}
