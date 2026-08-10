// SPDX-License-Identifier: Apache-2.0

import type { SessionOwner } from "./terminal-session-owner.js";

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

export type ManagedTerminalResolveOutcome =
  | { readonly kind: "resolved"; readonly binding: ManagedTerminalBinding }
  | { readonly kind: "rejected" | "unavailable"; readonly reason: string };

export type ManagedTerminalBindOutcome =
  | { readonly kind: "bound" }
  | { readonly kind: "rejected" | "unavailable"; readonly reason: string };

/** Daemon authority seam; the model supplies opaque handles, never paths or service IDs. */
export interface ManagedTerminalBindingResolver {
  resolve(input: {
    readonly managedRunId: string;
    readonly workspaceLeaseId: string;
    readonly owner: SessionOwner;
  }): Promise<ManagedTerminalResolveOutcome>;
  bind(input: {
    readonly managedRunId: string;
    readonly workspaceLeaseId: string;
    readonly serviceInstanceId: string;
    readonly terminalSessionId: string;
    readonly rootProcessIdentity: TerminalRootProcessIdentity;
    readonly owner: SessionOwner;
  }): Promise<ManagedTerminalBindOutcome>;
}
