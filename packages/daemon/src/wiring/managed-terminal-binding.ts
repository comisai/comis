// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync } from "node:fs";
import {
  createConversationRef,
  tryGetContext,
  type ManagedRunOwnerScope,
  type ManagedRunStorePort,
  type ExecutionAttachmentPort,
  type ExecutionAttachmentRecord,
  type CapabilityServiceControlPort,
  type ComisLogger,
  type WorkspaceLeasePort,
  type WorkspaceLeaseRecord,
} from "@comis/core";
import type { ManagedTerminalBindingResolver, SessionOwner } from "@comis/skills/tools";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { createManagedTerminalEventBridge } from "./capability-service-terminal-event.js";
export { createManagedTerminalRevoker } from "./managed-terminal-revoker.js";
export type { ManagedTerminalRevoker } from "./managed-terminal-revoker.js";

export interface ManagedTerminalBindingDeps {
  readonly store: ManagedRunStorePort;
  readonly workspaceLeases: WorkspaceLeasePort;
  readonly nowMs: () => number;
  readonly logger?: ComisLogger;
  readonly attachments?: ExecutionAttachmentPort;
  readonly validateAttachment?: (record: ExecutionAttachmentRecord) => Result<void, Error>;
  readonly validateLease?: (record: WorkspaceLeaseRecord) => Result<void, Error>;
  readonly resolveOwnerScope?: (owner: SessionOwner) => ManagedRunOwnerScope | undefined;
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const called = await fromPromise(operation());
  return called.ok ? called.value : called;
}

function validateCurrentWorkspaceLease(record: WorkspaceLeaseRecord): Result<void, Error> {
  const inspected = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the stored canonical lease path is re-proven without following its final component before terminal binding
    const stat = lstatSync(record.canonicalPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- equality with the stored canonical lease path rejects any newly symlinked component
    const canonicalPath = realpathSync(record.canonicalPath);
    return { stat, canonicalPath };
  });
  if (!inspected.ok) return err(inspected.error);
  return !inspected.value.stat.isSymbolicLink()
    && inspected.value.stat.isDirectory()
    && inspected.value.canonicalPath === record.canonicalPath
    && inspected.value.stat.dev === record.filesystemIdentity.device
    && inspected.value.stat.ino === record.filesystemIdentity.inode
    ? ok(undefined)
    : err(new Error("workspace lease filesystem identity changed"));
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
  const validateLease = deps.validateLease ?? validateCurrentWorkspaceLease;
  const resolve: ManagedTerminalBindingResolver["resolve"] = async (input) => {
    const scope = resolveScope(input.owner);
    if (scope === undefined) return { kind: "rejected", reason: "owner_scope_unresolved" };
    const loaded = await invoke(() => deps.store.get(scope, input.managedRunId));
    if (!loaded.ok) return { kind: "unavailable", reason: "managed_run_store_unavailable" };
    const record = loaded.value;
    if (record === undefined) {
      deps.logger?.warn({
        managedRunId: input.managedRunId,
        workspaceLeaseId: input.workspaceLeaseId,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        conversationRef: scope.conversationRef,
        hint: "Compare these requested launch handles with the current capability-service launch plan before retrying the terminal create",
        errorKind: "precondition" as const,
      }, "Managed terminal binding could not resolve the requested managed run");
      return { kind: "rejected", reason: "managed_run_not_found" };
    }
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
    if (!validateLease(lease.value).ok) return { kind: "rejected", reason: "workspace_lease_stale" };
    const attachmentScope = {
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      serviceInstanceId: record.serviceInstanceId,
      managedRunId: record.managedRunId,
      workspaceLeaseId: lease.value.workspaceLeaseId,
    };
    const executionAttachments: ExecutionAttachmentRecord[] = [];
    const attachments = deps.attachments;
    const validateAttachment = deps.validateAttachment;
    if (record.executionAttachmentIds.length > 0 && (attachments === undefined || validateAttachment === undefined)) {
      return { kind: "unavailable", reason: "execution_attachment_authority_unavailable" };
    }
    for (const executionAttachmentId of record.executionAttachmentIds) {
      if (attachments === undefined || validateAttachment === undefined) return { kind: "unavailable", reason: "execution_attachment_authority_unavailable" };
      const attachment = await invoke(() => attachments.get(attachmentScope, executionAttachmentId));
      if (!attachment.ok) return { kind: "unavailable", reason: "execution_attachment_store_unavailable" };
      if (attachment.value === undefined) return { kind: "rejected", reason: "execution_attachment_not_found" };
      if (attachment.value.state === "revoked") continue;
      if (!validateAttachment(attachment.value).ok) return { kind: "rejected", reason: "execution_attachment_stale" };
      executionAttachments.push(attachment.value);
    }
    return {
      kind: "resolved",
      binding: {
        managedRunId: record.managedRunId,
        workspaceLeaseId: lease.value.workspaceLeaseId,
        serviceInstanceId: record.serviceInstanceId,
        canonicalRoot: lease.value.canonicalPath,
      },
      executionAttachments: executionAttachments.map((attachment) => ({
        executionAttachmentId: attachment.executionAttachmentId,
        sourcePath: attachment.sourcePath,
        targetName: attachment.targetName,
      })),
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

/** Build the paired authority and lifecycle seams consumed by terminal tool wiring. */
export function createManagedTerminalToolDeps(deps: ManagedTerminalBindingDeps & {
  readonly control: CapabilityServiceControlPort;
  readonly logger: ComisLogger;
}) {
  return {
    managedBinding: createManagedTerminalBindingResolver(deps),
    managedTerminalEvents: createManagedTerminalEventBridge({ control: deps.control, store: deps.store, logger: deps.logger, nowMs: deps.nowMs }),
  };
}
