// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type {
  ComisLogger,
  ExecutionAttachmentPort,
  ExecutionAttachmentScope,
  ManagedRunOwnerScope,
  ManagedRunRecord,
  ManagedRunStorePort,
} from "@comis/core";
import { err, fromPromise, tryCatch, type Result } from "@comis/shared";
import type { ManagedTerminalRevoker } from "./managed-terminal-revoker.js";

export interface ManagedRunResourceRevokerDeps {
  readonly store: ManagedRunStorePort;
  readonly attachments: ExecutionAttachmentPort;
  readonly revokeManagedTerminals: ManagedTerminalRevoker;
  readonly nowMs: () => number;
  readonly logger: ComisLogger;
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

function ownerScope(record: ManagedRunRecord): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: record.tenantId,
    agentId: record.agentId,
    principalId: record.principalId,
    conversationRef: record.conversationRef,
  };
}

function attachmentScope(record: ManagedRunRecord, workspaceLeaseId: string): ExecutionAttachmentScope {
  return {
    tenantId: record.tenantId,
    agentId: record.agentId,
    serviceInstanceId: record.serviceInstanceId,
    managedRunId: record.managedRunId,
    workspaceLeaseId,
  };
}

function attachmentOperationId(leaseReleaseOperationId: string, executionAttachmentId: string): string {
  const suffix = createHash("sha256").update(executionAttachmentId, "utf8").digest("hex").slice(0, 32);
  return `${leaseReleaseOperationId}-attachment-${suffix}`;
}

/** Revoke every run-bound execution capability before its workspace lease can move. */
export function createManagedRunResourceRevoker(deps: ManagedRunResourceRevokerDeps) {
  return async (record: ManagedRunRecord, leaseReleaseOperationId: string): Promise<boolean> => {
    const refreshed = await invoke(() => deps.store.get(ownerScope(record), record.managedRunId));
    if (!refreshed.ok || refreshed.value === undefined) {
      deps.logger.warn({
        managedRunId: record.managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        errorKind: "resource" as const,
        hint: "Inspect the durable managed run before releasing its workspace lease",
      }, "Managed-run release authority could not be refreshed");
      return false;
    }
    const current = refreshed.value;
    if (current.terminalSessionIds.length > 0) {
      const revokedTerminals = await invoke(() => deps.revokeManagedTerminals(current));
      if (!revokedTerminals.ok) {
        deps.logger.warn({
          managedRunId: current.managedRunId,
          serviceInstanceId: current.serviceInstanceId,
          errorKind: "resource" as const,
          hint: "Terminate the bound managed terminals before releasing the workspace lease",
        }, "Managed terminals were not durably terminated before release");
        return false;
      }
    }
    const workspaceLeaseId = current.workspaceLeaseId;
    if (workspaceLeaseId === undefined) return true;
    const scope = attachmentScope(current, workspaceLeaseId);
    const active = await invoke(() => deps.attachments.listActiveForRun(scope));
    if (!active.ok) {
      deps.logger.warn({
        managedRunId: current.managedRunId,
        serviceInstanceId: current.serviceInstanceId,
        errorKind: "resource" as const,
        hint: "Inspect and revoke the run's execution attachments before releasing its workspace lease",
      }, "Execution attachments could not be listed before release");
      return false;
    }
    const activeIds = new Set(active.value.map((attachment) => attachment.executionAttachmentId));
    for (const executionAttachmentId of current.executionAttachmentIds) {
      if (activeIds.has(executionAttachmentId)) continue;
      const stored = await invoke(() => deps.attachments.get(scope, executionAttachmentId));
      if (!stored.ok || stored.value === undefined) {
        deps.logger.warn({
          managedRunId: current.managedRunId,
          executionAttachmentId,
          errorKind: "resource" as const,
          hint: "Repair the durable attachment join before releasing the workspace lease",
        }, "Execution attachment binding could not be reconciled before release");
        return false;
      }
    }
    for (const attachment of active.value) {
      const revoked = await invoke(() => deps.attachments.revoke(scope, {
        operationId: attachmentOperationId(leaseReleaseOperationId, attachment.executionAttachmentId),
        executionAttachmentId: attachment.executionAttachmentId,
        reason: "lease_release",
        revokedAtMs: deps.nowMs(),
      }));
      if (!revoked.ok || (revoked.value.kind !== "revoked" && revoked.value.kind !== "identical_replay")) {
        deps.logger.warn({
          managedRunId: current.managedRunId,
          executionAttachmentId: attachment.executionAttachmentId,
          errorKind: "resource" as const,
          hint: "Revoke the execution attachment before releasing the workspace lease",
        }, "Execution attachment revocation was not durably acknowledged");
        return false;
      }
    }
    return true;
  };
}
