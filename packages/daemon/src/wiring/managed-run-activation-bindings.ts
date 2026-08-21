// SPDX-License-Identifier: Apache-2.0
import {
  type ExecutionAttachmentRecord,
  type ManagedRunOwnerScope,
  type ManagedRunPreparedStart,
  type ManagedRunRecord,
  type ManagedRunStorePort,
  type WorkspaceLeasePort,
  type WorkspaceLeaseRecord,
  type WorkspaceLeaseScope,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type {
  ActiveCapabilityServiceInstance,
  CapabilityServiceRuntime,
} from "./capability-service-runtime.js";
import type { ExecutionAttachmentAuthority } from "./execution-attachment-authority.js";
import type { ValidatedWorkspaceLeasePath } from "./workspace-lease-path-validator.js";

interface PreparedBindingInput {
  readonly serviceInstanceId: string;
  readonly prepared: ManagedRunPreparedStart;
  readonly authority: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly principalId: string;
    readonly conversationRef: ManagedRunRecord["conversationRef"];
  };
}

interface PreparedBindingIds {
  readonly workspaceLeaseId: string;
  readonly attachmentOperationId: string;
  readonly leaseReleaseOperationId: string;
  readonly leaseRecoveryOperationId: string;
}

export interface ManagedRunActivationBindingDeps {
  readonly store: ManagedRunStorePort;
  readonly workspaceLeases: WorkspaceLeasePort;
  readonly attachmentAuthority: Pick<ExecutionAttachmentAuthority, "create">;
  readonly activeView: Pick<CapabilityServiceRuntime, "getActiveView">;
  readonly validateWorkspacePath: (
    requestedPath: string,
    allowedWorkspaceRoots: readonly string[],
  ) => Result<ValidatedWorkspaceLeasePath, Error>;
  readonly nowMs: () => number;
}

export interface PreparedBindingValidation {
  readonly workspace?: ValidatedWorkspaceLeasePath;
}

export interface PreparedBindingValidationFailure {
  readonly reasonCode: "attachment_not_allowed" | "workspace_not_allowed";
  readonly error: Error;
}

export type PreparedAttachmentBindingOutcome =
  | {
    readonly kind: "bound";
    readonly record: ManagedRunRecord;
    readonly attachment?: ExecutionAttachmentRecord;
  }
  | { readonly kind: "rejected" };

function recordOwnerScope(record: ManagedRunRecord): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: record.tenantId,
    agentId: record.agentId,
    principalId: record.principalId,
    conversationRef: record.conversationRef,
  };
}

function workspaceScope(record: ManagedRunRecord): WorkspaceLeaseScope {
  return {
    tenantId: record.tenantId,
    agentId: record.agentId,
    serviceInstanceId: record.serviceInstanceId,
    managedRunId: record.managedRunId,
  };
}

function matchesWorkspaceLeaseAuthority(
  record: WorkspaceLeaseRecord,
  expected: {
    readonly workspaceLeaseId: string;
    readonly managedRunId: string;
    readonly serviceInstanceId: string;
    readonly tenantId: string;
    readonly agentId: string;
    readonly canonicalPath: string;
    readonly filesystemIdentity: ValidatedWorkspaceLeasePath["filesystemIdentity"];
  },
): boolean {
  return record.workspaceLeaseId === expected.workspaceLeaseId
    && record.managedRunId === expected.managedRunId
    && record.serviceInstanceId === expected.serviceInstanceId
    && record.tenantId === expected.tenantId
    && record.agentId === expected.agentId
    && record.state === "active"
    && record.canonicalPath === expected.canonicalPath
    && record.filesystemIdentity.device === expected.filesystemIdentity.device
    && record.filesystemIdentity.inode === expected.filesystemIdentity.inode
    && record.filesystemIdentity.birthtimeNs === expected.filesystemIdentity.birthtimeNs;
}

async function invokeStore<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

function activeInstance(
  deps: ManagedRunActivationBindingDeps,
  input: PreparedBindingInput,
): ActiveCapabilityServiceInstance | undefined {
  return deps.activeView.getActiveView().instances.find(
    (candidate) => candidate.serviceInstanceId === input.serviceInstanceId
      && candidate.state === "active"
      && candidate.allowedAgents.includes(input.authority.agentId),
  );
}

/** Validate requested host authority before persisting a managed-run binding. */
export function validatePreparedBindingRequests(
  deps: ManagedRunActivationBindingDeps,
  input: PreparedBindingInput,
): Result<PreparedBindingValidation, PreparedBindingValidationFailure> {
  const instance = activeInstance(deps, input);
  if (input.prepared.requestedAttachment !== undefined) {
    if (
      instance === undefined
      || !instance.activeScopes.includes("execution_attachment")
      || input.prepared.requestedWorkspace === undefined
      || input.prepared.requestedAttachment.kind !== "unix_socket"
    ) {
      return err({
        reasonCode: "attachment_not_allowed",
        error: new Error("execution attachment authority is unavailable for this preparation"),
      });
    }
  }
  const requestedWorkspace = input.prepared.requestedWorkspace;
  if (requestedWorkspace === undefined) return ok({});
  if (instance === undefined || !instance.activeScopes.includes("workspace_lease")) {
    return err({
      reasonCode: "workspace_not_allowed",
      error: new Error("workspace lease authority is unavailable for this preparation"),
    });
  }
  const validated = deps.validateWorkspacePath(
    requestedWorkspace.rootHint,
    instance.allowedWorkspaceRoots,
  );
  return validated.ok
    ? ok({ workspace: validated.value })
    : err({ reasonCode: "workspace_not_allowed", error: validated.error });
}

/** Mint or reconcile the exclusive workspace authority required by a prepared run. */
export async function ensurePreparedWorkspaceLease(
  deps: ManagedRunActivationBindingDeps,
  input: PreparedBindingInput,
  ids: PreparedBindingIds,
  record: ManagedRunRecord,
  prevalidated?: ValidatedWorkspaceLeasePath,
): Promise<Result<ManagedRunRecord, Error>> {
  if (input.prepared.requestedWorkspace === undefined) {
    return record.workspaceLeaseId === undefined
      ? ok(record)
      : err(new Error("workspace-less preparation retained a workspace lease"));
  }
  const validation = prevalidated === undefined
    ? validatePreparedBindingRequests(deps, input)
    : ok({ workspace: prevalidated });
  if (!validation.ok || validation.value.workspace === undefined) {
    return validation.ok
      ? err(new Error("workspace-requesting preparation lacks validated authority"))
      : err(validation.error.error);
  }
  const authority = validation.value.workspace;
  const scope = workspaceScope(record);
  if (record.workspaceLeaseId !== undefined) {
    const existing = await invokeStore(() => deps.workspaceLeases.get(
      scope,
      record.workspaceLeaseId as string,
    ));
    if (!existing.ok) return existing;
    if (
      existing.value === undefined
      || existing.value.state !== "active"
      || existing.value.canonicalPath !== authority.canonicalPath
      || existing.value.filesystemIdentity.device !== authority.filesystemIdentity.device
      || existing.value.filesystemIdentity.inode !== authority.filesystemIdentity.inode
      || existing.value.filesystemIdentity.birthtimeNs !== authority.filesystemIdentity.birthtimeNs
    ) {
      return err(new Error("durable workspace lease no longer matches filesystem authority"));
    }
    const recoveredAtMs = deps.nowMs();
    const reconciled = await invokeStore(() => deps.workspaceLeases.reconcile(scope, {
      operationId: `${ids.leaseRecoveryOperationId}-${recoveredAtMs}`,
      workspaceLeaseId: record.workspaceLeaseId as string,
      filesystemIdentity: authority.filesystemIdentity,
      recoveredAtMs,
    }));
    if (!reconciled.ok) return reconciled;
    if (reconciled.value.kind !== "recovered" && reconciled.value.kind !== "identical_replay") {
      return err(new Error(`workspace lease recovery failed: ${reconciled.value.kind}`));
    }
    return ok(record);
  }

  const boundAtMs = Math.max(deps.nowMs(), record.updatedAtMs);
  const created = await invokeStore(() => deps.workspaceLeases.create({
    schemaVersion: 1,
    workspaceLeaseId: ids.workspaceLeaseId,
    managedRunId: record.managedRunId,
    serviceInstanceId: record.serviceInstanceId,
    tenantId: record.tenantId,
    agentId: record.agentId,
    canonicalPath: authority.canonicalPath,
    filesystemIdentity: authority.filesystemIdentity,
    state: "active",
    createdAtMs: boundAtMs,
    updatedAtMs: boundAtMs,
  }));
  if (!created.ok) return created;
  if (created.value.kind === "replay_conflict") {
    const existing = await invokeStore(() => deps.workspaceLeases.get(scope, ids.workspaceLeaseId));
    if (!existing.ok) return existing;
    if (
      existing.value === undefined
      || !matchesWorkspaceLeaseAuthority(existing.value, {
        workspaceLeaseId: ids.workspaceLeaseId,
        managedRunId: record.managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        tenantId: record.tenantId,
        agentId: record.agentId,
        canonicalPath: authority.canonicalPath,
        filesystemIdentity: authority.filesystemIdentity,
      })
    ) {
      return err(new Error("workspace lease mint replay conflicted"));
    }
  }
  const bound = await invokeStore(() => deps.store.setWorkspaceLease(recordOwnerScope(record), {
    managedRunId: record.managedRunId,
    workspaceLeaseId: ids.workspaceLeaseId,
    leaseTenantId: record.tenantId,
    leaseAgentId: record.agentId,
    boundAtMs,
  }));
  if (!bound.ok) return bound;
  if (bound.value.kind !== "bound" && bound.value.kind !== "identical_replay") {
    await invokeStore(() => deps.workspaceLeases.release(scope, {
      operationId: `${ids.leaseReleaseOperationId}-bind-failed`,
      workspaceLeaseId: ids.workspaceLeaseId,
      disposition: "preserve",
      releasedAtMs: boundAtMs,
    }));
    return err(new Error(`managed-run workspace binding failed: ${bound.value.kind}`));
  }
  return ok(bound.value.record);
}

/** Create and durably bind the prepared run's host-owned execution attachment. */
export async function ensurePreparedExecutionAttachment(
  deps: ManagedRunActivationBindingDeps,
  input: PreparedBindingInput,
  ids: PreparedBindingIds,
  record: ManagedRunRecord,
): Promise<Result<PreparedAttachmentBindingOutcome, Error>> {
  const requested = input.prepared.requestedAttachment;
  if (requested === undefined) {
    return record.executionAttachmentIds.length === 0
      ? ok({ kind: "bound", record })
      : err(new Error("attachment-less preparation retained an execution attachment"));
  }
  if (record.workspaceLeaseId === undefined) {
    return err(new Error("attachment-requesting preparation lacks a workspace lease"));
  }
  const created = await deps.attachmentAuthority.create({
    operationId: ids.attachmentOperationId,
    managedRunId: record.managedRunId,
    workspaceLeaseId: record.workspaceLeaseId,
    kind: requested.kind,
    sourcePath: requested.sourcePath,
    relayIdentity: requested.relayIdentity,
    owner: recordOwnerScope(record),
  });
  if (!created.ok) return created;
  if (created.value.kind === "rejected") return ok({ kind: "rejected" });
  const durable = await invokeStore(() => deps.store.get(
    recordOwnerScope(record),
    record.managedRunId,
  ));
  if (!durable.ok) return durable;
  if (
    durable.value === undefined
    || !durable.value.executionAttachmentIds.includes(
      created.value.record.executionAttachmentId,
    )
  ) {
    return err(new Error("execution attachment authority did not produce a durable run binding"));
  }
  return ok({
    kind: "bound",
    record: durable.value,
    attachment: created.value.record,
  });
}
