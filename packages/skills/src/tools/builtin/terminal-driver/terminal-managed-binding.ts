// SPDX-License-Identifier: Apache-2.0

import type { Result } from "@comis/shared";
import type { SessionOwner } from "./terminal-session-owner.js";

export const MANAGED_TERMINAL_ATTACHMENT_DIRECTORY = "/run/comis/attachments";
export const MANAGED_TERMINAL_ATTACHMENT_PATH_ENVIRONMENT = "COMIS_EXECUTION_ATTACHMENT";
export const MANAGED_TERMINAL_ATTACHMENT_TARGET_ENVIRONMENT = "COMIS_EXECUTION_ATTACHMENT_TARGET_NAME";
export const MANAGED_TERMINAL_ATTACHMENT_IDENTITY_ENVIRONMENT = "COMIS_EXECUTION_ATTACHMENT_IDENTITY";

export function managedTerminalAttachmentTargetPath(targetName: string): string {
  return `${MANAGED_TERMINAL_ATTACHMENT_DIRECTORY}/${targetName}`;
}

/** Opaque host identity that distinguishes a PID from a later PID reuse. */
export interface TerminalRootProcessIdentity {
  readonly pid: number;
  readonly startIdentity: string;
}

/** Server-resolved authority stamped onto a managed terminal. */
export interface ManagedTerminalBinding {
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly serviceInstanceId: string;
  readonly canonicalRoot: string;
}

/** Host-resolved socket mount. Source paths never enter model-facing parameters or output. */
export interface ManagedTerminalExecutionAttachment {
  readonly executionAttachmentId: string;
  readonly sourcePath: string;
  readonly targetName: string;
  readonly relayIdentity: string;
}

export type ManagedTerminalResolveOutcome =
  | { readonly kind: "resolved"; readonly binding: ManagedTerminalBinding; readonly executionAttachments: readonly ManagedTerminalExecutionAttachment[] }
  | { readonly kind: "rejected" | "unavailable"; readonly reason: string };

export type ManagedTerminalBindOutcome =
  | { readonly kind: "bound" }
  | { readonly kind: "rejected" | "unavailable"; readonly reason: string };

export type ManagedTerminalReleaseOutcome =
  | { readonly kind: "released" }
  | { readonly kind: "rejected" | "unavailable"; readonly reason: string };

/** Daemon authority seam; the model supplies opaque handles, never paths or service IDs. */
export interface ManagedTerminalBindingResolver {
  resolve(input: {
    readonly managedRunId: string;
    readonly workspaceLeaseId: string;
    readonly owner: SessionOwner;
  }): Promise<ManagedTerminalResolveOutcome>;
  reserve(input: {
    readonly managedRunId: string;
    readonly workspaceLeaseId: string;
    readonly serviceInstanceId: string;
    readonly terminalSessionId: string;
    readonly owner: SessionOwner;
  }): Promise<ManagedTerminalBindOutcome>;
  bind(input: {
    readonly managedRunId: string;
    readonly workspaceLeaseId: string;
    readonly serviceInstanceId: string;
    readonly terminalSessionId: string;
    readonly rootProcessIdentity: TerminalRootProcessIdentity;
    readonly owner: SessionOwner;
  }): Promise<ManagedTerminalBindOutcome>;
  release(input: {
    readonly managedRunId: string;
    readonly workspaceLeaseId: string;
    readonly serviceInstanceId: string;
    readonly terminalSessionId: string;
    readonly owner: SessionOwner;
  }): Promise<ManagedTerminalReleaseOutcome>;
}

export type ManagedTerminalTransition =
  | "created"
  | "running"
  | "input_needed"
  | "stuck"
  | "exited"
  | "lost"
  | "recovered"
  | "released";

/** Content-free transition bridge; publishing failure never grants cleanup authority. */
export interface ManagedTerminalEventSink {
  publish(input: ManagedTerminalTransitionInput): Promise<Result<void, Error>>;
  /** Durable end-of-life barrier. Local retirement remains authoritative when notification fails. */
  retire?(input: ManagedTerminalRetirementInput): Promise<Result<void, Error>>;
}

export interface ManagedTerminalTransitionInput {
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly serviceInstanceId: string;
  readonly terminalSessionId: string;
  readonly transition: ManagedTerminalTransition;
}

export type ManagedTerminalRetirementInput = Omit<ManagedTerminalTransitionInput, "transition"> & {
  readonly transition: "exited" | "released";
};
