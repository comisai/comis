// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  type ComisLogger,
  type ExecutionAttachmentPort,
  type ExecutionAttachmentRecord,
  type ExecutionAttachmentScope,
  type ManagedRunOwnerScope,
  type ManagedRunStorePort,
  type WorkspaceLeasePort,
} from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import {
  validateExecutionAttachmentPath,
  type ExecutionAttachmentPathInput,
  type ValidatedExecutionAttachmentPath,
} from "./execution-attachment-path-validator.js";

interface ExecutionAttachmentInstanceAuthority {
  readonly serviceInstanceId: string;
  readonly enabled: boolean;
  readonly allowedAgents: readonly string[];
  readonly allowedRuntimeRoots: readonly string[];
  readonly control: { readonly socketPath: string };
}

export interface ExecutionAttachmentAuthorityDeps {
  readonly runs: ManagedRunStorePort;
  readonly leases: WorkspaceLeasePort;
  readonly attachments: ExecutionAttachmentPort;
  readonly instances: readonly ExecutionAttachmentInstanceAuthority[];
  readonly dataDir: string;
  readonly nowMs: () => number;
  readonly isServiceActive: (serviceInstanceId: string) => boolean;
  readonly logger: ComisLogger;
  readonly validateSource?: (input: ExecutionAttachmentPathInput) => Result<ValidatedExecutionAttachmentPath, Error>;
}

export interface ExecutionAttachmentCreateInput {
  readonly operationId: string;
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
  readonly kind: "unix_socket" | "inherited_descriptor";
  readonly sourcePath: string;
  readonly relayIdentity: string;
  readonly owner: ManagedRunOwnerScope;
}

export type ExecutionAttachmentAuthorityCreateOutcome =
  | { readonly kind: "created" | "identical_replay"; readonly record: ExecutionAttachmentRecord }
  | { readonly kind: "rejected"; readonly reason: "authority_mismatch" | "source_rejected" | "replay_conflict" | "binding_refused" | "unsupported_kind" };

export interface ExecutionAttachmentRecoverySummary {
  readonly recovered: readonly string[];
  readonly preserved: readonly string[];
}

export interface ExecutionAttachmentRecoveryInput {
  readonly updatedBeforeMs: number;
  readonly limit: number;
}

export interface ExecutionAttachmentServiceRecoveryInput extends ExecutionAttachmentRecoveryInput {
  readonly serviceInstanceId: string;
}

export interface ExecutionAttachmentAuthority {
  create(input: ExecutionAttachmentCreateInput): Promise<Result<ExecutionAttachmentAuthorityCreateOutcome, Error>>;
  validateActive(record: ExecutionAttachmentRecord): Result<void, Error>;
  reconcileAll(input: ExecutionAttachmentRecoveryInput): Promise<Result<ExecutionAttachmentRecoverySummary, Error>>;
  reconcileService(input: ExecutionAttachmentServiceRecoveryInput): Promise<Result<ExecutionAttachmentRecoverySummary, Error>>;
}

function digest(kind: string, value: string): string {
  return createHash("sha256").update(`${kind}\0${value}`, "utf8").digest("hex");
}

function attachmentScope(record: {
  readonly tenantId: string;
  readonly agentId: string;
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly workspaceLeaseId: string;
}): ExecutionAttachmentScope {
  return {
    tenantId: record.tenantId,
    agentId: record.agentId,
    serviceInstanceId: record.serviceInstanceId,
    managedRunId: record.managedRunId,
    workspaceLeaseId: record.workspaceLeaseId,
  };
}

async function invoke<T>(operation: Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const settled = await fromPromise(operation);
  return settled.ok ? settled.value : err(settled.error);
}

/** Coordinate host-proven socket authority and its durable managed-run binding. */
export function createExecutionAttachmentAuthority(deps: ExecutionAttachmentAuthorityDeps): ExecutionAttachmentAuthority {
  const validateSource = deps.validateSource ?? validateExecutionAttachmentPath;
  const controlSocketPaths = deps.instances.map((instance) => instance.control.socketPath);

  function validateActive(record: ExecutionAttachmentRecord): Result<void, Error> {
    if (record.state !== "active") return err(new Error("execution attachment is not active"));
    const instance = deps.instances.find((candidate) => candidate.serviceInstanceId === record.serviceInstanceId && candidate.enabled);
    if (
      instance === undefined
      || !deps.isServiceActive(record.serviceInstanceId)
      || !instance.allowedAgents.includes(record.agentId)
    ) return err(new Error("execution attachment instance authority is unavailable"));
    const source = validateSource({
      requestedPath: record.sourcePath,
      allowedRuntimeRoots: instance.allowedRuntimeRoots,
      dataDir: deps.dataDir,
      controlSocketPaths,
    });
    if (!source.ok) return source;
    return source.value.filesystemIdentity.device === record.sourceFilesystemIdentity.device
      && source.value.filesystemIdentity.inode === record.sourceFilesystemIdentity.inode
      && source.value.filesystemIdentity.birthtimeNs === record.sourceFilesystemIdentity.birthtimeNs
      ? ok(undefined)
      : err(new Error("execution attachment filesystem identity changed"));
  }

  async function create(input: ExecutionAttachmentCreateInput): Promise<Result<ExecutionAttachmentAuthorityCreateOutcome, Error>> {
    const startedAtMs = deps.nowMs();
    if (input.kind !== "unix_socket") {
      return ok({ kind: "rejected", reason: "unsupported_kind" });
    }
    const run = await invoke(deps.runs.get(input.owner, input.managedRunId));
    if (!run.ok) return run;
    if (run.value === undefined || run.value.workspaceLeaseId !== input.workspaceLeaseId) {
      return ok({ kind: "rejected", reason: "authority_mismatch" });
    }
    const instance = deps.instances.find((candidate) => candidate.serviceInstanceId === run.value?.serviceInstanceId);
    if (
      instance === undefined
      || !instance.enabled
      || !deps.isServiceActive(run.value.serviceInstanceId)
      || !instance.allowedAgents.includes(run.value.agentId)
    ) {
      return ok({ kind: "rejected", reason: "authority_mismatch" });
    }
    const scope = attachmentScope({ ...run.value, workspaceLeaseId: input.workspaceLeaseId });
    const lease = await invoke(deps.leases.get(scope, input.workspaceLeaseId));
    if (!lease.ok) return lease;
    if (lease.value === undefined || lease.value.state !== "active") {
      return ok({ kind: "rejected", reason: "authority_mismatch" });
    }

    const executionAttachmentId = `execution-attachment-${digest("execution-attachment", `${input.managedRunId}\0${input.operationId}`).slice(0, 48)}`;
    const existing = await invoke(deps.attachments.get(scope, executionAttachmentId));
    if (!existing.ok) return existing;
    if (existing.value !== undefined) {
      if (
        existing.value.sourcePath !== input.sourcePath
        || existing.value.relayIdentity !== input.relayIdentity
      ) {
        return ok({ kind: "rejected", reason: "replay_conflict" });
      }
      const active = validateActive(existing.value);
      if (!active.ok) {
        deps.logger.warn({
          managedRunId: input.managedRunId,
          serviceInstanceId: instance.serviceInstanceId,
          failureCause: active.error.message,
          errorKind: "validation" as const,
          hint: "Restore the original canonical Unix socket under allowedRuntimeRoots or abandon the preparation",
        }, "Replayed execution attachment source was rejected");
        return ok({ kind: "rejected", reason: "source_rejected" });
      }
      if (!run.value.executionAttachmentIds.includes(executionAttachmentId)) {
        const rebound = await invoke(deps.runs.bindExecutionAttachment(input.owner, {
          managedRunId: existing.value.managedRunId,
          workspaceLeaseId: existing.value.workspaceLeaseId,
          executionAttachmentId: existing.value.executionAttachmentId,
          attachmentServiceInstanceId: existing.value.serviceInstanceId,
          attachmentTenantId: existing.value.tenantId,
          attachmentAgentId: existing.value.agentId,
          boundAtMs: Math.max(deps.nowMs(), existing.value.updatedAtMs, run.value.updatedAtMs),
        }));
        if (!rebound.ok) return rebound;
        if (rebound.value.kind !== "bound" && rebound.value.kind !== "identical_replay") {
          return ok({ kind: "rejected", reason: "binding_refused" });
        }
      }
      return ok({ kind: "identical_replay", record: existing.value });
    }

    const source = validateSource({
      requestedPath: input.sourcePath,
      allowedRuntimeRoots: instance.allowedRuntimeRoots,
      dataDir: deps.dataDir,
      controlSocketPaths,
    });
    if (!source.ok) {
      deps.logger.warn({
        managedRunId: input.managedRunId,
        serviceInstanceId: instance.serviceInstanceId,
        failureCause: source.error.message,
        errorKind: "validation" as const,
        hint: "Use a real canonical Unix socket under the instance allowedRuntimeRoots; control and Comis data sockets are forbidden",
      }, "Execution attachment source was rejected");
      return ok({ kind: "rejected", reason: "source_rejected" });
    }
    const createdAtMs = deps.nowMs();
    const record: ExecutionAttachmentRecord = {
      schemaVersion: 1,
      executionAttachmentId,
      managedRunId: run.value.managedRunId,
      workspaceLeaseId: input.workspaceLeaseId,
      serviceInstanceId: run.value.serviceInstanceId,
      tenantId: run.value.tenantId,
      agentId: run.value.agentId,
      kind: "unix_socket",
      sourcePath: source.value.canonicalPath,
      relayIdentity: input.relayIdentity,
      sourceFilesystemType: source.value.filesystemType,
      sourceFilesystemIdentity: source.value.filesystemIdentity,
      targetName: `attachment-${digest("execution-attachment-target", executionAttachmentId).slice(0, 32)}.sock`,
      access: "connect_only",
      state: "active",
      createdAtMs,
      updatedAtMs: createdAtMs,
    };
    const created = await invoke(deps.attachments.create(record));
    if (!created.ok) return created;
    if (created.value.kind !== "created" && created.value.kind !== "identical_replay") {
      return ok({ kind: "rejected", reason: created.value.kind === "replay_conflict" ? "replay_conflict" : "authority_mismatch" });
    }
    const revokeAfterBindingFailure = async (): Promise<Result<void, Error>> => {
      const revoked = await invoke(deps.attachments.revoke(scope, {
        operationId: `${input.operationId}-bind-refused`,
        executionAttachmentId,
        reason: "authority_revoked",
        revokedAtMs: deps.nowMs(),
      }));
      if (revoked.ok && (revoked.value.kind === "revoked" || revoked.value.kind === "identical_replay")) {
        return ok(undefined);
      }
      deps.logger.warn({
        managedRunId: record.managedRunId,
        executionAttachmentId,
        errorKind: "resource" as const,
        hint: "Inspect and revoke the durable execution attachment before releasing its workspace lease",
      }, "Execution attachment rollback was not durably acknowledged");
      return revoked.ok
        ? err(new Error(`execution attachment rollback failed: ${revoked.value.kind}`))
        : revoked;
    };
    const bound = await invoke(deps.runs.bindExecutionAttachment(input.owner, {
      managedRunId: record.managedRunId,
      workspaceLeaseId: record.workspaceLeaseId,
      executionAttachmentId: record.executionAttachmentId,
      attachmentServiceInstanceId: record.serviceInstanceId,
      attachmentTenantId: record.tenantId,
      attachmentAgentId: record.agentId,
      boundAtMs: createdAtMs,
    }));
    if (!bound.ok) {
      const rolledBack = await revokeAfterBindingFailure();
      return rolledBack.ok ? bound : rolledBack;
    }
    if (bound.value.kind !== "bound" && bound.value.kind !== "identical_replay") {
      const rolledBack = await revokeAfterBindingFailure();
      if (!rolledBack.ok) return rolledBack;
      return ok({ kind: "rejected", reason: "binding_refused" });
    }
    deps.logger.info({
      managedRunId: record.managedRunId,
      serviceInstanceId: record.serviceInstanceId,
      executionAttachmentId,
      durationMs: Math.max(0, deps.nowMs() - startedAtMs),
    }, "Execution attachment created");
    return ok({ kind: created.value.kind, record: created.value.record });
  }

  async function reconcile(input: ExecutionAttachmentRecoveryInput & {
    readonly serviceInstanceId?: string;
  }): Promise<Result<ExecutionAttachmentRecoverySummary, Error>> {
    const recovered: string[] = [];
    const preserved: string[] = [];
    let afterExecutionAttachmentId: string | undefined;
    do {
      const scanned = await invoke(deps.attachments.listRecoverable({
        kind: "recovery",
        updatedBeforeMs: input.updatedBeforeMs,
        limit: input.limit,
        ...(afterExecutionAttachmentId === undefined ? {} : { afterExecutionAttachmentId }),
      }));
      if (!scanned.ok) return scanned;
      for (const record of scanned.value.records) {
        if (input.serviceInstanceId !== undefined && record.serviceInstanceId !== input.serviceInstanceId) {
          continue;
        }
        const instance = deps.instances.find(
          (candidate) => candidate.serviceInstanceId === record.serviceInstanceId && candidate.enabled,
        );
        if (
          instance === undefined
          || !deps.isServiceActive(record.serviceInstanceId)
          || !instance.allowedAgents.includes(record.agentId)
        ) {
          preserved.push(record.executionAttachmentId);
          continue;
        }
        const run = await invoke(deps.runs.get(
          { kind: "service", serviceInstanceId: record.serviceInstanceId },
          record.managedRunId,
        ));
        if (!run.ok) return run;
        if (
          run.value === undefined
          || run.value.tenantId !== record.tenantId
          || run.value.agentId !== record.agentId
          || run.value.workspaceLeaseId !== record.workspaceLeaseId
          || !run.value.executionAttachmentIds.includes(record.executionAttachmentId)
        ) {
          preserved.push(record.executionAttachmentId);
          continue;
        }
        const lease = await invoke(deps.leases.get(attachmentScope(record), record.workspaceLeaseId));
        if (!lease.ok) return lease;
        if (lease.value === undefined || lease.value.state !== "active") {
          preserved.push(record.executionAttachmentId);
          continue;
        }
        const source = validateSource({
          requestedPath: record.sourcePath,
          allowedRuntimeRoots: instance.allowedRuntimeRoots,
          dataDir: deps.dataDir,
          controlSocketPaths,
        });
        if (!source.ok) {
          preserved.push(record.executionAttachmentId);
          continue;
        }
        const reconciled = await invoke(deps.attachments.reconcile(attachmentScope(record), {
          operationId: `attachment-recover-${digest("attachment-recover", `${record.executionAttachmentId}\0${source.value.filesystemIdentity.device}\0${source.value.filesystemIdentity.inode}\0${source.value.filesystemIdentity.birthtimeNs}`).slice(0, 48)}`,
          executionAttachmentId: record.executionAttachmentId,
          sourceFilesystemIdentity: source.value.filesystemIdentity,
          recoveredAtMs: deps.nowMs(),
        }));
        if (!reconciled.ok) return reconciled;
        if (reconciled.value.kind === "recovered" || reconciled.value.kind === "identical_replay") {
          recovered.push(record.executionAttachmentId);
        } else {
          preserved.push(record.executionAttachmentId);
        }
      }
      afterExecutionAttachmentId = scanned.value.nextAfterExecutionAttachmentId;
    } while (afterExecutionAttachmentId !== undefined);
    return ok({ recovered, preserved });
  }

  return Object.freeze({
    create,
    validateActive,
    reconcileAll: (input: ExecutionAttachmentRecoveryInput) => reconcile(input),
    reconcileService: (input: ExecutionAttachmentServiceRecoveryInput) => reconcile(input),
  });
}
