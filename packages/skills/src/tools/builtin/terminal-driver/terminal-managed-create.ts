// SPDX-License-Identifier: Apache-2.0

import type { TerminalScope } from "./allowlist-matcher.js";

export type ManagedHandleSelection =
  | { readonly kind: "ordinary" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "managed";
      readonly managedRunId: string;
      readonly workspaceLeaseId: string;
    };

/** Read the paired opaque handles without ever accepting a caller-supplied path. */
export function selectManagedHandles(params: Readonly<Record<string, unknown>>): ManagedHandleSelection {
  const managedRunId = typeof params.managedRunId === "string" ? params.managedRunId : undefined;
  const workspaceLeaseId = typeof params.workspaceLeaseId === "string" ? params.workspaceLeaseId : undefined;
  if (managedRunId === undefined && workspaceLeaseId === undefined) return { kind: "ordinary" };
  if (!managedRunId || !workspaceLeaseId) return { kind: "invalid" };
  return { kind: "managed", managedRunId, workspaceLeaseId };
}

/** A managed run inherits network/uid policy but can see only its leased filesystem root. */
export function narrowManagedTerminalScope(scope: TerminalScope): TerminalScope {
  return {
    filesystem: "workspace",
    network: scope.network,
    credentialPaths: [],
    uid: scope.uid,
    ...(scope.hosts === undefined ? {} : { hosts: scope.hosts }),
  };
}
