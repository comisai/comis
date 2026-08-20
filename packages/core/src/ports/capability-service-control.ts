// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

export interface CapabilityServiceActivateCommand {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly externalRunRef: string;
  readonly registrationNonce: string;
  readonly workspaceLeaseId?: string;
  readonly executionAttachmentId?: string;
  readonly attachmentTargetName?: string;
}

export interface CapabilityServiceActivateAcknowledgement {
  readonly managedRunId: string;
  readonly externalRunRef: string;
  readonly state: "active";
  readonly activatedAtMs: number;
}

export type CapabilityServiceControlFailure = {
  readonly kind: "rejected" | "uncertain" | "unavailable";
  readonly reasonCode: string;
};

export interface CapabilityServiceAbandonCommand {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly externalRunRef: string;
  readonly registrationNonce: string;
  readonly reason: "activation_rejected" | "owner_cancelled" | "registration_expired" | "service_unavailable";
  readonly disposition: "reap_safe" | "preserve";
}

export interface CapabilityServiceAbandonAcknowledgement {
  readonly externalRunRef: string;
  readonly state: "abandoned";
  readonly disposition: "reap_safe" | "preserve";
  readonly terminalTransition: "unbound_preparation_abandoned";
}

/**
 * One member of a prepared group, as the host hands it to the service. The
 * shape mirrors a single activation because a group is a batch of ordinary
 * preparations, not a new kind of run.
 */
export interface CapabilityServiceGroupMemberActivation {
  readonly managedRunId: string;
  readonly externalRunRef: string;
  readonly registrationNonce: string;
  readonly workspaceLeaseId?: string;
  readonly executionAttachmentId?: string;
  readonly attachmentTargetName?: string;
}

export interface CapabilityServiceGroupActivateCommand {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunGroupId: string;
  readonly members: readonly CapabilityServiceGroupMemberActivation[];
}

/**
 * A group acknowledgement is per member and nothing else. There is deliberately
 * no group-level state field: a single verdict over a partial result would have
 * to round some members' outcomes into a summary that contradicts them.
 */
export interface CapabilityServiceGroupMemberAcknowledgement {
  readonly managedRunId: string;
  readonly outcome: "completed" | "rejected" | "unknown" | "not_attempted";
}

export interface CapabilityServiceGroupActivateAcknowledgement {
  readonly managedRunGroupId: string;
  readonly members: readonly CapabilityServiceGroupMemberAcknowledgement[];
  readonly activatedAtMs: number;
}

export interface CapabilityServiceGroupAbandonCommand {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunGroupId: string;
  readonly reason: "activation_rejected" | "owner_cancelled" | "registration_expired" | "service_unavailable";
  readonly disposition: "reap_safe" | "preserve";
}

export interface CapabilityServiceGroupAbandonAcknowledgement {
  readonly managedRunGroupId: string;
  readonly members: readonly CapabilityServiceGroupMemberAcknowledgement[];
  readonly state: "abandoned";
  readonly disposition: "reap_safe" | "preserve";
}

export interface CapabilityServiceCancelCommand {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly reason: "owner_cancelled" | "authority_revoked" | "budget_exhausted";
}

export interface CapabilityServiceCancelAcknowledgement {
  readonly managedRunId: string;
  readonly state: "cancelling" | "cancelled" | "already_terminal";
  readonly acknowledgedAtMs: number;
}

export type CapabilityServiceTerminalTransition =
  | "created"
  | "running"
  | "input_needed"
  | "stuck"
  | "exited"
  | "lost"
  | "recovered"
  | "released";

export interface CapabilityServiceTerminalEventCommand {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly terminalSessionId: string;
  readonly transition: CapabilityServiceTerminalTransition;
}

export interface CapabilityServiceTerminalEventAcknowledgement {
  readonly managedRunId: string;
  readonly terminalSessionId: string;
  readonly transition: CapabilityServiceTerminalTransition;
}

/** Authenticated instance-scoped control boundary; implementations never select authority. */
export interface CapabilityServiceControlPort {
  activate(
    command: CapabilityServiceActivateCommand,
  ): Promise<Result<CapabilityServiceActivateAcknowledgement, CapabilityServiceControlFailure>>;
  abandon(
    command: CapabilityServiceAbandonCommand,
  ): Promise<Result<CapabilityServiceAbandonAcknowledgement, CapabilityServiceControlFailure>>;
  cancel(
    command: CapabilityServiceCancelCommand,
  ): Promise<Result<CapabilityServiceCancelAcknowledgement, CapabilityServiceControlFailure>>;
  terminalEvent(
    command: CapabilityServiceTerminalEventCommand,
  ): Promise<Result<CapabilityServiceTerminalEventAcknowledgement, CapabilityServiceControlFailure>>;
}
