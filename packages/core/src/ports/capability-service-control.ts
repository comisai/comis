// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

export interface CapabilityServiceActivateCommand {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly externalRunRef: string;
  readonly registrationNonce: string;
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
}

export interface CapabilityServiceAbandonAcknowledgement {
  readonly externalRunRef: string;
  readonly state: "abandoned";
}

/** Authenticated instance-scoped control boundary; implementations never select authority. */
export interface CapabilityServiceControlPort {
  activate(
    command: CapabilityServiceActivateCommand,
  ): Promise<Result<CapabilityServiceActivateAcknowledgement, CapabilityServiceControlFailure>>;
  abandon(
    command: CapabilityServiceAbandonCommand,
  ): Promise<Result<CapabilityServiceAbandonAcknowledgement, CapabilityServiceControlFailure>>;
}
