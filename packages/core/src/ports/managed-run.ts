// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { ConversationRef } from "../domain/conversation-scope.js";
import type { ManagedRunGroupRecord } from "../domain/managed-run-group.js";
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

/**
 * A cross-scope health read over the durable run index. Like the administration
 * list it names the operator intent explicitly so the scoped path can never
 * degrade into it, and it aggregates rows updated within one window. It returns
 * content-free facts only — closed status/reason enums, counts, and opaque
 * host-minted identifiers — never a body, path, or objective.
 */
export interface ManagedRunHealthCountInput {
  readonly kind: "administration";
  readonly updatedSinceMs: number;
}

/**
 * Windowed run-health counts for the system-health digest. `byStatus` carries
 * every managed-run status with an explicit zero for the absent ones;
 * `degradedReasonCodes` tallies the closed status-reason enum across the
 * degraded runs only; the service-instance counts and `worstManagedRunId` let an
 * operator see how many services are affected and which run to drill into,
 * without any contentful field.
 */
export interface ManagedRunHealthCounts {
  readonly byStatus: Readonly<Record<ManagedRunStatus, number>>;
  readonly degradedReasonCodes: Readonly<Record<string, number>>;
  readonly distinctServiceInstances: number;
  readonly degradedServiceInstances: number;
  readonly worstManagedRunId?: string;
}

/**
 * A session→managed-run linkage lookup. Given the trace ids a session's
 * trajectory actually ran, it returns the managed runs those turns prepared, so
 * a per-session incident report can name them without a raw-log join. It names
 * the operator intent explicitly (like the administration reads) so the scoped
 * path can never degrade into it, and returns content-free facts only.
 */
export interface ManagedRunLinkageInput {
  readonly kind: "administration";
  readonly traceIds: readonly string[];
  readonly limit: number;
}

/**
 * One content-free managed-run linkage row: the opaque run and service
 * identifiers, the closed status/reason enums, and the trace it was prepared in.
 * Never a body, path, objective, or credential.
 */
export interface ManagedRunLinkage {
  readonly managedRunId: string;
  readonly serviceInstanceId: string;
  readonly status: ManagedRunStatus;
  readonly statusReason: ManagedRunStatusReason;
  readonly traceId: string;
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
/**
 * One grouped preparation. The host mints the group and its members together;
 * the service never asserts membership after the fact.
 */
export interface ManagedRunGroupPrepareInput {
  readonly operationId: string;
  readonly managedRunGroupId: string;
  readonly serviceInstanceId: string;
  readonly rootRunId: string;
  readonly createdAtMs: number;
  readonly members: readonly ManagedRunRecord[];
}

/**
 * Every refusal names the member that caused it where one did, so a caller can
 * fix the offending run instead of re-sending the whole preparation blind.
 */
export type ManagedRunGroupPrepareOutcome =
  | { readonly kind: "created"; readonly record: ManagedRunGroupRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunGroupRecord }
  | { readonly kind: "replay_conflict" }
  | { readonly kind: "membership_exceeds_ceiling" }
  | { readonly kind: "scope_mismatch"; readonly managedRunId?: string }
  | { readonly kind: "member_conflict"; readonly managedRunId: string };

export interface ManagedRunGroupStorePort {
  /**
   * Persists the group and all of its members, or nothing at all. A partially
   * written preparation would present some members as host-bound and leave the
   * rest invisible, which is indistinguishable from a group that was never
   * prepared — so the transaction is the contract, not an optimization.
   */
  prepareGroup(input: ManagedRunGroupPrepareInput): Promise<Result<ManagedRunGroupPrepareOutcome, Error>>;
  /**
   * Derives the roll-up from member run facts at read time. Membership lives on
   * the member rows alone, so there is exactly one source of truth and a group
   * can never disagree with the runs it contains.
   */
  getGroup(
    scope: ManagedRunLookupScope,
    managedRunGroupId: string,
  ): Promise<Result<ManagedRunGroupRecord | undefined, Error>>;
}

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
  countByStatus(input: ManagedRunHealthCountInput): Promise<Result<ManagedRunHealthCounts, Error>>;
  /**
   * How many of one service's runs are still non-terminal (every status except
   * succeeded/failed/cancelled). A content-free scalar the activation coordinator
   * reads to admit or refuse a new run against a service's concurrency ceiling.
   */
  countActiveByService(serviceInstanceId: string): Promise<Result<number, Error>>;
  /**
   * How many reports one run has received at or after `sinceMs`, scoped to the
   * owning service. A content-free scalar the report bridge reads to enforce a
   * service's per-run rate ceiling over a rolling window.
   */
  countReportsSince(
    scope: ManagedRunServiceScope,
    managedRunId: string,
    sinceMs: number,
  ): Promise<Result<number, Error>>;
  listByTraceIds(input: ManagedRunLinkageInput): Promise<Result<ManagedRunLinkage[], Error>>;
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
