// SPDX-License-Identifier: Apache-2.0
import {
  createConversationRef,
  tryGetContext,
  type ManagedRunOwnerScope,
  type ManagedRunStorePort,
  type WorkspaceLeasePort,
} from "@comis/core";
import type { ManagedTerminalBindingResolver, SessionOwner } from "@comis/skills/tools";
import { fromPromise, type Result } from "@comis/shared";

export interface ManagedTerminalBindingDeps {
  readonly store: ManagedRunStorePort;
  readonly workspaceLeases: WorkspaceLeasePort;
  readonly nowMs: () => number;
  readonly resolveOwnerScope?: (owner: SessionOwner) => ManagedRunOwnerScope | undefined;
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const called = await fromPromise(operation());
  return called.ok ? called.value : called;
}

/** Resolve the complete ALS authority and cross-check it against the registry owner key. */
export function resolveManagedTerminalOwnerScope(owner: SessionOwner): ManagedRunOwnerScope | undefined {
  const context = tryGetContext();
  if (
    context?.agentId !== owner.agentId
    || context.sessionKey !== owner.sessionKey
    || context.turnScope === undefined
    || context.turnScope.conversation.tenantId !== context.tenantId
    || context.turnScope.conversation.agentId !== context.agentId
  ) return undefined;
  const conversationRef = createConversationRef(context.turnScope.conversation);
  if (!conversationRef.ok) return undefined;
  return {
    kind: "owner",
    tenantId: context.tenantId,
    agentId: context.agentId,
    principalId: context.turnScope.principal.principalId,
    conversationRef: conversationRef.value,
  };
}

/** Create the exact run→lease→terminal join used by the managed create path. */
export function createManagedTerminalBindingResolver(
  deps: ManagedTerminalBindingDeps,
): ManagedTerminalBindingResolver {
  const resolveScope = deps.resolveOwnerScope ?? resolveManagedTerminalOwnerScope;
  const resolve: ManagedTerminalBindingResolver["resolve"] = async (input) => {
    const scope = resolveScope(input.owner);
    if (scope === undefined) return { kind: "rejected", reason: "owner_scope_unresolved" };
    const loaded = await invoke(() => deps.store.get(scope, input.managedRunId));
    if (!loaded.ok) return { kind: "unavailable", reason: "managed_run_store_unavailable" };
    const record = loaded.value;
    if (record === undefined) return { kind: "rejected", reason: "managed_run_not_found" };
    if (record.tenantId !== scope.tenantId || record.agentId !== scope.agentId) {
      return { kind: "rejected", reason: "managed_run_scope_mismatch" };
    }
    if (record.workspaceLeaseId !== input.workspaceLeaseId) {
      return { kind: "rejected", reason: "workspace_lease_mismatch" };
    }
    const lease = await invoke(() => deps.workspaceLeases.get({
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      serviceInstanceId: record.serviceInstanceId,
      managedRunId: record.managedRunId,
    }, input.workspaceLeaseId));
    if (!lease.ok) return { kind: "unavailable", reason: "workspace_lease_store_unavailable" };
    if (lease.value === undefined) return { kind: "rejected", reason: "workspace_lease_not_found" };
    if (lease.value.state !== "active") return { kind: "rejected", reason: "workspace_lease_inactive" };
    return {
      kind: "resolved",
      binding: {
        managedRunId: record.managedRunId,
        workspaceLeaseId: lease.value.workspaceLeaseId,
        serviceInstanceId: record.serviceInstanceId,
        canonicalRoot: lease.value.canonicalPath,
      },
    };
  };

  return {
    resolve,
    bind: async (input) => {
      const current = await resolve(input);
      if (current.kind !== "resolved") return current;
      if (current.binding.serviceInstanceId !== input.serviceInstanceId) {
        return { kind: "rejected", reason: "service_instance_mismatch" };
      }
      const scope = resolveScope(input.owner);
      if (scope === undefined) return { kind: "rejected", reason: "owner_scope_unresolved" };
      const bound = await invoke(() => deps.store.bindTerminal(scope, {
        managedRunId: input.managedRunId,
        terminalSessionId: input.terminalSessionId,
        terminalTenantId: scope.tenantId,
        terminalAgentId: scope.agentId,
        boundAtMs: deps.nowMs(),
      }));
      if (!bound.ok) return { kind: "unavailable", reason: "managed_run_store_unavailable" };
      return bound.value.kind === "bound" || bound.value.kind === "identical_replay"
        ? { kind: "bound" }
        : { kind: "rejected", reason: bound.value.kind };
    },
  };
}
