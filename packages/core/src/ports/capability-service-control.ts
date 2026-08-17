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
