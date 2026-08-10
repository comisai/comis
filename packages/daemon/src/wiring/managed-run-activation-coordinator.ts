// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  ManagedRunPreparedStartSchema,
  ManagedRunRecordSchema,
  emitObservationalEventSafely,
  type CapabilityServiceAbandonCommand,
  type CapabilityServiceControlFailure,
  type CapabilityServiceControlPort,
  type ComisLogger,
  type ExecutionAttachmentPort,
  type ManagedRunContentPort,
  type ManagedRunActivationDescriptor,
  type ManagedRunInitiationSource,
  type InvalidManagedRunRecord,
  type ManagedRunOwnerScope,
  type ManagedRunPreparedStart,
  type ManagedRunRecord,
  type ManagedRunStorePort,
  type TypedEventBus,
  type WorkspaceLeasePort,
  type WorkspaceLeaseScope,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { CapabilityServiceRuntime } from "./capability-service-runtime.js";
import type { ValidatedWorkspaceLeasePath } from "./workspace-lease-path-validator.js";
import { createManagedRunResourceRevoker } from "./managed-run-resource-revoker.js";

export interface ManagedRunActivationAuthority {
  readonly tenantId: string;
  readonly agentId: string;
  readonly principalId: string;
  readonly conversationRef: ManagedRunRecord["conversationRef"];
  readonly turnScope: ManagedRunRecord["turnScope"];
  readonly deliveryOrigin: ManagedRunRecord["deliveryOrigin"];
  readonly traceId: string;
  readonly trustLevel: ManagedRunRecord["trustLevel"];
  readonly responseLocalePolicy: ManagedRunRecord["responseLocalePolicy"];
  readonly workspacePolicyHash: string;
  readonly rootRunId: string;
  readonly initiationSource: ManagedRunInitiationSource;
  readonly capturedAgentCapabilities: ManagedRunRecord["capturedAgentCapabilities"];
  readonly capturedToolIds: readonly string[];
  readonly capturedCapabilityViewHash: string;
}

export interface ManagedRunActivationInput {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly prepared: ManagedRunPreparedStart;
  readonly authority: ManagedRunActivationAuthority;
}

export interface ManagedRunActivationIds {
  readonly managedRunId: string;
  readonly activationDescriptorRef: string;
  readonly workspaceLeaseId: string;
  readonly activationOperationId: string;
  readonly abandonOperationId: string;
  readonly leaseReleaseOperationId: string;
  readonly leaseRecoveryOperationId: string;
  readonly rejectionOperationId: string;
  readonly joinMissingOperationId: string;
  readonly outcomeUnknownOperationId: string;
  readonly unavailableOperationId: string;
}

export interface ManagedRunActivationControlIds {
  readonly workspaceLeaseId: string;
  readonly activationOperationId: string;
  readonly abandonOperationId: string;
  readonly leaseReleaseOperationId: string;
  readonly leaseRecoveryOperationId: string;
  readonly rejectionOperationId: string;
  readonly joinMissingOperationId: string;
  readonly outcomeUnknownOperationId: string;
  readonly unavailableOperationId: string;
}

export type ManagedRunActivationRejectionReason =
  | "activation_rejected"
  | "agent_not_allowed"
  | "invalid_preparation"
  | "preparation_expired"
  | "replay_conflict"
  | "service_unavailable"
  | "workspace_not_allowed";

export type ManagedRunActivationOutcome =
  | { readonly kind: "activated"; readonly record: ManagedRunRecord }
  | { readonly kind: "identical_replay"; readonly record: ManagedRunRecord }
  | { readonly kind: "activation_unknown"; readonly record: ManagedRunRecord }
  | {
    readonly kind: "rejected";
    readonly reasonCode: ManagedRunActivationRejectionReason;
    readonly record?: ManagedRunRecord;
  };

export interface ManagedRunActivationCoordinator {
  activatePrepared(
    input: ManagedRunActivationInput,
  ): Promise<Result<ManagedRunActivationOutcome, Error>>;
  recoverPreparations(
    input: ManagedRunActivationRecoveryInput,
  ): Promise<Result<ManagedRunActivationRecoverySummary, Error>>;
}

export interface ManagedRunActivationRecoveryInput {
  readonly updatedBeforeMs: number;
  readonly limit: number;
}

export interface ManagedRunActivationRecoveryFailure {
  readonly managedRunId: string;
  readonly serviceInstanceId: string;
  readonly reasonCode: "reconciliation_failed";
}

export interface ManagedRunActivationRecoverySummary {
  readonly activated: readonly string[];
  readonly cancelled: readonly string[];
  readonly unknown: readonly string[];
  readonly invalid: readonly InvalidManagedRunRecord[];
  readonly failed: readonly ManagedRunActivationRecoveryFailure[];
}

export interface ManagedRunActivationCoordinatorDeps {
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly workspaceLeases: WorkspaceLeasePort;
  readonly attachments: ExecutionAttachmentPort;
  readonly revokeManagedTerminals: (record: ManagedRunRecord) => Promise<Result<void, Error>>;
  readonly control: CapabilityServiceControlPort;
  readonly activeView: Pick<CapabilityServiceRuntime, "getActiveView">;
  readonly validateWorkspacePath: (
    requestedPath: string,
    allowedWorkspaceRoots: readonly string[],
  ) => Result<ValidatedWorkspaceLeasePath, Error>;
  readonly ids: {
    forOperation(operationId: string): Pick<ManagedRunActivationIds, "managedRunId" | "activationDescriptorRef">;
    forManagedRun(managedRunId: string): ManagedRunActivationControlIds;
  };
  readonly nowMs: () => number;
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ownerScope(input: ManagedRunActivationInput): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: input.authority.tenantId,
    agentId: input.authority.agentId,
    principalId: input.authority.principalId,
    conversationRef: input.authority.conversationRef,
  };
}

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

async function invokeStore<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

async function invokeControl<T>(
  operation: () => Promise<Result<T, CapabilityServiceControlFailure>>,
): Promise<Result<T, CapabilityServiceControlFailure>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err({ kind: "uncertain", reasonCode: "control_invocation_failed" });
  const settled = await fromPromise(invoked.value);
  return settled.ok
    ? settled.value
    : err({ kind: "uncertain", reasonCode: "control_transport_failed" });
}

function matchesExisting(
  record: ManagedRunRecord,
  input: ManagedRunActivationInput,
  externalRunRefDigest: string,
  activationDescriptorDigest: string,
): boolean {
  return record.serviceInstanceId === input.serviceInstanceId
    && record.externalRunRefDigest === externalRunRefDigest
    && record.activationDescriptorDigest === activationDescriptorDigest
    && record.tenantId === input.authority.tenantId
    && record.agentId === input.authority.agentId
    && record.principalId === input.authority.principalId
    && record.conversationRef === input.authority.conversationRef;
}

/** Bind a private service preparation to exact host authority before allowing work to start. */
export function createManagedRunActivationCoordinator(
  deps: ManagedRunActivationCoordinatorDeps,
): ManagedRunActivationCoordinator {
  const revokeBoundResources = createManagedRunResourceRevoker({ store: deps.store, attachments: deps.attachments, revokeManagedTerminals: deps.revokeManagedTerminals, nowMs: deps.nowMs, logger: deps.logger });

  async function abandonPrepared(
    input: ManagedRunActivationInput,
    ids: ManagedRunActivationIds,
    reason: CapabilityServiceAbandonCommand["reason"],
    disposition: CapabilityServiceAbandonCommand["disposition"],
    record?: ManagedRunRecord,
  ): Promise<void> {
    let effectiveDisposition = disposition;
    if (record?.workspaceLeaseId !== undefined) {
      const resourcesRevoked = await revokeBoundResources(record, ids.leaseReleaseOperationId);
      const released = resourcesRevoked
        ? await invokeStore(() => deps.workspaceLeases.release(
            workspaceScope(record),
            {
              operationId: ids.leaseReleaseOperationId,
              workspaceLeaseId: record.workspaceLeaseId as string,
              disposition,
              releasedAtMs: deps.nowMs(),
            },
          ))
        : err(new Error("managed-run resources remain active"));
      if (
        !released.ok
        || (released.value.kind !== "released" && released.value.kind !== "identical_replay")
      ) {
        effectiveDisposition = "preserve";
        deps.logger.warn({
          managedRunId: record.managedRunId,
          serviceInstanceId: record.serviceInstanceId,
          errorKind: "resource" as const,
          hint: "Inspect the durable workspace lease before reaping the external preparation",
        }, "Workspace lease release was not durably acknowledged");
      }
    }
    const abandoned = await invokeControl(() => deps.control.abandon({
      operationId: ids.abandonOperationId,
      serviceInstanceId: input.serviceInstanceId,
      externalRunRef: input.prepared.externalRunRef,
      registrationNonce: input.prepared.registrationNonce,
      reason,
      disposition: effectiveDisposition,
    }));
    if (!abandoned.ok) {
      deps.logger.warn({
        serviceInstanceId: input.serviceInstanceId,
        reasonCode: abandoned.error.kind,
        errorKind: "dependency" as const,
        hint: "Inspect the configured service and reap the named unbound preparation before its expiry",
      }, "Capability-service preparation abandon was not acknowledged");
    }
  }

  function emitRejected(
    input: ManagedRunActivationInput,
    reasonCode: ManagedRunActivationRejectionReason,
    managedRunId?: string,
  ): void {
    deps.logger.audit({
      decision: "deny",
      serviceInstanceId: input.serviceInstanceId,
      agentId: input.authority.agentId,
      reasonCode,
      ...(managedRunId === undefined ? {} : { managedRunId }),
    }, "Managed-run activation rejected");
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:activation_rejected",
      {
        ...(managedRunId === undefined ? {} : { managedRunId }),
        serviceInstanceId: input.serviceInstanceId,
        agentId: input.authority.agentId,
        reasonCode,
        timestamp: deps.nowMs(),
      },
    );
  }

  async function markUnknown(
    identity: { readonly serviceInstanceId: string; readonly agentId: string },
    ids: ManagedRunActivationIds,
    reason: "activation_outcome_unknown" | "recovery_join_missing" | "service_state_unavailable",
  ): Promise<Result<ManagedRunRecord, Error>> {
    const operationId = reason === "activation_outcome_unknown"
      ? ids.outcomeUnknownOperationId
      : reason === "recovery_join_missing"
        ? ids.joinMissingOperationId
        : ids.unavailableOperationId;
    const transitioned = await invokeStore(() => deps.store.claimTransition(
      { kind: "service", serviceInstanceId: identity.serviceInstanceId },
      {
        operationId,
        managedRunId: ids.managedRunId,
        expectedStatuses: ["preparing", "unknown"],
        nextStatus: "unknown",
        nextStatusReason: reason,
        transitionedAtMs: deps.nowMs(),
      },
    ));
    if (!transitioned.ok) return transitioned;
    if (transitioned.value.kind !== "claimed" && transitioned.value.kind !== "identical_replay") {
      return err(new Error(`managed-run uncertainty transition failed: ${transitioned.value.kind}`));
    }
    const record = transitioned.value.record;
    deps.logger.warn({
      managedRunId: record.managedRunId,
      serviceInstanceId: record.serviceInstanceId,
      reasonCode: reason,
      errorKind: "dependency" as const,
      hint: "Run managed-run recovery after service connectivity is restored; the private activation join was retained",
    }, "Managed-run activation outcome is unknown");
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:activation_unknown",
      {
        managedRunId: record.managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        agentId: identity.agentId,
        reasonCode: reason,
        timestamp: deps.nowMs(),
      },
    );
    return ok(record);
  }

  async function removeDescriptor(record: ManagedRunRecord, descriptorRef: string): Promise<void> {
    const removed = await invokeStore(() => deps.contentStore.deleteActivationDescriptor({
      tenantId: record.tenantId,
      agentId: record.agentId,
      managedRunId: record.managedRunId,
    }, descriptorRef));
    if (!removed.ok) {
      deps.logger.warn({
        managedRunId: record.managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        errorKind: "resource" as const,
        hint: "Run the managed-run content retention sweep to remove the expired private activation body",
      }, "Managed-run activation descriptor cleanup failed");
    }
  }

  function validateRequestedWorkspace(
    input: ManagedRunActivationInput,
  ): Result<ValidatedWorkspaceLeasePath | undefined, Error> {
    const requested = input.prepared.requestedWorkspace;
    if (requested === undefined) return ok(undefined);
    const instance = deps.activeView.getActiveView().instances.find(
      (candidate) => candidate.serviceInstanceId === input.serviceInstanceId
        && candidate.state === "active",
    );
    if (instance === undefined || !instance.allowedAgents.includes(input.authority.agentId)) {
      return err(new Error("workspace lease service instance is not active for the captured agent"));
    }
    return deps.validateWorkspacePath(requested.rootHint, instance.allowedWorkspaceRoots);
  }

  async function ensureWorkspaceLease(
    input: ManagedRunActivationInput,
    ids: ManagedRunActivationIds,
    record: ManagedRunRecord,
    prevalidated?: ValidatedWorkspaceLeasePath,
  ): Promise<Result<ManagedRunRecord, Error>> {
    if (input.prepared.requestedWorkspace === undefined) {
      return record.workspaceLeaseId === undefined
        ? ok(record)
        : err(new Error("workspace-less preparation retained a workspace lease"));
    }
    const validated = prevalidated === undefined
      ? validateRequestedWorkspace(input)
      : ok(prevalidated);
    if (!validated.ok || validated.value === undefined) {
      return validated.ok
        ? err(new Error("workspace-requesting preparation lacks validated authority"))
        : validated;
    }
    const authority = validated.value;
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
        || existing.value.filesystemIdentity.device
          !== authority.filesystemIdentity.device
        || existing.value.filesystemIdentity.inode
          !== authority.filesystemIdentity.inode
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
      return err(new Error("workspace lease mint replay conflicted"));
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

  async function activateDurable(
    input: ManagedRunActivationInput,
    ids: ManagedRunActivationIds,
    preparedRecord: ManagedRunRecord,
    replayed: boolean,
    startedAtMs: number,
    prevalidatedWorkspace?: ValidatedWorkspaceLeasePath,
  ): Promise<Result<ManagedRunActivationOutcome, Error>> {
    const descriptorRef = preparedRecord.activationDescriptorRef;
    if (descriptorRef === undefined) {
      const unknown = await markUnknown({
        serviceInstanceId: input.serviceInstanceId,
        agentId: input.authority.agentId,
      }, ids, "recovery_join_missing");
      return unknown.ok ? ok({ kind: "activation_unknown", record: unknown.value }) : unknown;
    }
    const descriptor = await invokeStore(() => deps.contentStore.getActivationDescriptor({
      tenantId: preparedRecord.tenantId,
      agentId: preparedRecord.agentId,
      managedRunId: preparedRecord.managedRunId,
    }, descriptorRef));
    if (!descriptor.ok) return descriptor;
    if (
      descriptor.value === undefined
      || descriptor.value.externalRunRef !== input.prepared.externalRunRef
      || descriptor.value.registrationNonce !== input.prepared.registrationNonce
      || descriptor.value.expiresAtMs !== input.prepared.expiresAtMs
      || JSON.stringify(descriptor.value.requestedWorkspace)
        !== JSON.stringify(input.prepared.requestedWorkspace)
    ) {
      const unknown = await markUnknown({
        serviceInstanceId: input.serviceInstanceId,
        agentId: input.authority.agentId,
      }, ids, "recovery_join_missing");
      return unknown.ok ? ok({ kind: "activation_unknown", record: unknown.value }) : unknown;
    }
    const workspaceBound = await ensureWorkspaceLease(
      input,
      ids,
      preparedRecord,
      prevalidatedWorkspace,
    );
    if (!workspaceBound.ok) return workspaceBound;
    const durableRecord = workspaceBound.value;
    deps.logger.debug({
      step: "managed-run-service-activate",
      managedRunId: ids.managedRunId,
      serviceInstanceId: input.serviceInstanceId,
    }, "Activating durably bound managed run");
    const activation = await invokeControl(() => deps.control.activate({
      operationId: ids.activationOperationId,
      serviceInstanceId: input.serviceInstanceId,
      managedRunId: ids.managedRunId,
      externalRunRef: input.prepared.externalRunRef,
      registrationNonce: input.prepared.registrationNonce,
      ...(durableRecord.workspaceLeaseId === undefined
        ? {}
        : { workspaceLeaseId: durableRecord.workspaceLeaseId }),
    }));
    if (!activation.ok) {
      if (activation.error.kind === "rejected") {
        await abandonPrepared(input, ids, "activation_rejected", "reap_safe", durableRecord);
        const rejected = await invokeStore(() => deps.store.claimTransition(
          { kind: "service", serviceInstanceId: input.serviceInstanceId },
          {
            operationId: ids.rejectionOperationId,
            managedRunId: ids.managedRunId,
            expectedStatuses: ["preparing", "unknown"],
            nextStatus: "cancelled",
            nextStatusReason: "activation_rejected",
            transitionedAtMs: deps.nowMs(),
            terminalOutcome: { kind: "cancelled", recordedAtMs: deps.nowMs() },
          },
        ));
        if (!rejected.ok) return rejected;
        if (rejected.value.kind !== "claimed" && rejected.value.kind !== "identical_replay") {
          return err(new Error(`managed-run rejection transition failed: ${rejected.value.kind}`));
        }
        await removeDescriptor(rejected.value.record, descriptorRef);
        emitRejected(input, "activation_rejected", ids.managedRunId);
        return ok({
          kind: "rejected",
          reasonCode: "activation_rejected",
          record: rejected.value.record,
        });
      }
      const reason = activation.error.kind === "unavailable"
        ? "service_state_unavailable"
        : "activation_outcome_unknown";
      const unknown = await markUnknown({
        serviceInstanceId: input.serviceInstanceId,
        agentId: input.authority.agentId,
      }, ids, reason);
      return unknown.ok ? ok({ kind: "activation_unknown", record: unknown.value }) : unknown;
    }

    const acknowledgementMatches = activation.value.state === "active"
      && activation.value.managedRunId === ids.managedRunId
      && activation.value.externalRunRef === input.prepared.externalRunRef;
    if (!acknowledgementMatches) {
      deps.logger.warn({
        managedRunId: ids.managedRunId,
        serviceInstanceId: input.serviceInstanceId,
        errorKind: "dependency" as const,
        hint: "Inspect the service activation response and reconcile the retained private join before retrying",
      }, "Capability-service activation acknowledgement did not match its durable binding");
      const unknown = await markUnknown({
        serviceInstanceId: input.serviceInstanceId,
        agentId: input.authority.agentId,
      }, ids, "activation_outcome_unknown");
      return unknown.ok ? ok({ kind: "activation_unknown", record: unknown.value }) : unknown;
    }

    const transitioned = await invokeStore(() => deps.store.claimTransition(
      { kind: "service", serviceInstanceId: input.serviceInstanceId },
      {
        operationId: ids.activationOperationId,
        managedRunId: ids.managedRunId,
        expectedStatuses: ["preparing", "unknown"],
        nextStatus: "active",
        nextStatusReason: "activation_acknowledged",
        transitionedAtMs: Math.max(deps.nowMs(), activation.value.activatedAtMs),
      },
    ));
    if (!transitioned.ok) return transitioned;
    if (transitioned.value.kind !== "claimed" && transitioned.value.kind !== "identical_replay") {
      return err(new Error(`managed-run activation transition failed: ${transitioned.value.kind}`));
    }
    await removeDescriptor(transitioned.value.record, ids.activationDescriptorRef);
    const durationMs = Math.max(0, deps.nowMs() - startedAtMs);
    deps.logger.info({
      managedRunId: ids.managedRunId,
      serviceInstanceId: input.serviceInstanceId,
      durationMs,
    }, "Managed run activated");
    deps.logger.audit({
      decision: "allow",
      managedRunId: ids.managedRunId,
      serviceInstanceId: input.serviceInstanceId,
      agentId: input.authority.agentId,
    }, "Managed-run activation acknowledged");
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:activated",
      {
        managedRunId: ids.managedRunId,
        serviceInstanceId: input.serviceInstanceId,
        agentId: input.authority.agentId,
        durationMs,
        timestamp: deps.nowMs(),
      },
    );
    return ok({
      kind: replayed || transitioned.value.kind === "identical_replay"
        ? "identical_replay"
        : "activated",
      record: transitioned.value.record,
    });
  }

  async function activatePrepared(
    input: ManagedRunActivationInput,
  ): Promise<Result<ManagedRunActivationOutcome, Error>> {
    const startedAtMs = deps.nowMs();
    const mintedIds = deps.ids.forOperation(input.operationId);
    const ids: ManagedRunActivationIds = {
      ...mintedIds,
      ...deps.ids.forManagedRun(mintedIds.managedRunId),
    };
    const prepared = ManagedRunPreparedStartSchema.safeParse(input.prepared);
    if (!prepared.success) {
      emitRejected(input, "invalid_preparation");
      return ok({ kind: "rejected", reasonCode: "invalid_preparation" });
    }
    const externalRunRefDigest = digest(prepared.data.externalRunRef);
    const activationDescriptorDigest = digest(JSON.stringify(prepared.data));
    const existing = await invokeStore(() => deps.store.get(ownerScope(input), ids.managedRunId));
    if (!existing.ok) return existing;
    if (existing.value !== undefined) {
      if (!matchesExisting(
        existing.value,
        input,
        externalRunRefDigest,
        activationDescriptorDigest,
      )) {
        emitRejected(input, "replay_conflict", ids.managedRunId);
        return ok({ kind: "rejected", reasonCode: "replay_conflict" });
      }
      if (existing.value.status === "active") {
        return ok({ kind: "identical_replay", record: existing.value });
      }
      if (existing.value.status === "preparing" || existing.value.status === "unknown") {
        return activateDurable(input, ids, existing.value, true, startedAtMs);
      }
      return ok({ kind: "identical_replay", record: existing.value });
    }

    if (prepared.data.expiresAtMs <= deps.nowMs()) {
      await abandonPrepared(input, ids, "registration_expired", "reap_safe");
      emitRejected(input, "preparation_expired");
      return ok({ kind: "rejected", reasonCode: "preparation_expired" });
    }
    const activeView = deps.activeView.getActiveView();
    const activeInstance = activeView.instances.find(
      (instance) => instance.serviceInstanceId === input.serviceInstanceId && instance.state === "active",
    );
    if (activeInstance === undefined) {
      await abandonPrepared(input, ids, "service_unavailable", "reap_safe");
      emitRejected(input, "service_unavailable");
      return ok({ kind: "rejected", reasonCode: "service_unavailable" });
    }
    if (!activeInstance.allowedAgents.includes(input.authority.agentId)) {
      await abandonPrepared(input, ids, "activation_rejected", "reap_safe");
      emitRejected(input, "agent_not_allowed");
      return ok({ kind: "rejected", reasonCode: "agent_not_allowed" });
    }
    const validatedWorkspace = validateRequestedWorkspace(input);
    if (!validatedWorkspace.ok) {
      await abandonPrepared(input, ids, "activation_rejected", "reap_safe");
      emitRejected(input, "workspace_not_allowed");
      return ok({ kind: "rejected", reasonCode: "workspace_not_allowed" });
    }

    const recordCandidate = ManagedRunRecordSchema.safeParse({
      schemaVersion: 1,
      managedRunId: ids.managedRunId,
      serviceInstanceId: input.serviceInstanceId,
      externalRunRefDigest,
      activationDescriptorDigest,
      activationDescriptorRef: ids.activationDescriptorRef,
      ...(prepared.data.displayLabel === undefined ? {} : { displayLabel: prepared.data.displayLabel }),
      ...input.authority,
      capturedAgentCapabilities: [...input.authority.capturedAgentCapabilities],
      capturedToolIds: [...input.authority.capturedToolIds],
      capturedCapabilityViewHash: input.authority.capturedCapabilityViewHash,
      executionAttachmentIds: [],
      terminalSessionIds: [],
      status: "preparing",
      statusReason: "awaiting_activation",
      lastAcceptedReportSequence: 0,
      lastReducedReportSequence: 0,
      pendingContinuation: false,
      openAttentionCount: 0,
      createdAtMs: deps.nowMs(),
      updatedAtMs: deps.nowMs(),
    });
    if (!recordCandidate.success) {
      await abandonPrepared(input, ids, "activation_rejected", "reap_safe");
      emitRejected(input, "invalid_preparation");
      return ok({ kind: "rejected", reasonCode: "invalid_preparation" });
    }
    const record = recordCandidate.data;
    const contentScope = {
      tenantId: record.tenantId,
      agentId: record.agentId,
      managedRunId: record.managedRunId,
    };
    deps.logger.debug({
      step: "managed-run-durable-bind",
      managedRunId: record.managedRunId,
      serviceInstanceId: record.serviceInstanceId,
    }, "Persisting managed-run authority before service activation");
    const body = await invokeStore(() => deps.contentStore.putActivationDescriptor(
      contentScope,
      ids.activationDescriptorRef,
      {
        schemaVersion: 1,
        externalRunRef: prepared.data.externalRunRef,
        registrationNonce: prepared.data.registrationNonce,
        expiresAtMs: prepared.data.expiresAtMs,
        ...(prepared.data.requestedWorkspace === undefined
          ? {}
          : { requestedWorkspace: prepared.data.requestedWorkspace }),
      },
    ));
    if (!body.ok) {
      await abandonPrepared(input, ids, "activation_rejected", "reap_safe");
      return body;
    }
    const created = await invokeStore(() => deps.store.create(record));
    if (!created.ok) {
      await removeDescriptor(record, ids.activationDescriptorRef);
      await abandonPrepared(input, ids, "activation_rejected", "reap_safe");
      return created;
    }
    if (created.value.kind === "replay_conflict") {
      await removeDescriptor(record, ids.activationDescriptorRef);
      await abandonPrepared(input, ids, "activation_rejected", "reap_safe");
      emitRejected(input, "replay_conflict", ids.managedRunId);
      return ok({ kind: "rejected", reasonCode: "replay_conflict" });
    }
    const durableRecord = created.value.record;
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:prepared",
      {
        managedRunId: durableRecord.managedRunId,
        serviceInstanceId: durableRecord.serviceInstanceId,
        agentId: durableRecord.agentId,
        timestamp: deps.nowMs(),
      },
    );
    return activateDurable(
      input,
      ids,
      durableRecord,
      created.value.kind === "identical_replay",
      startedAtMs,
      validatedWorkspace.value,
    );
  }

  function recoveryIds(record: ManagedRunRecord): ManagedRunActivationIds {
    return {
      managedRunId: record.managedRunId,
      activationDescriptorRef: record.activationDescriptorRef
        ?? `missing-${digest(record.managedRunId)}`,
      ...deps.ids.forManagedRun(record.managedRunId),
    };
  }

  function recoveryActivationInput(
    record: ManagedRunRecord,
    descriptor: ManagedRunActivationDescriptor,
  ): Result<ManagedRunActivationInput, Error> {
    const prepared = ManagedRunPreparedStartSchema.safeParse({
      state: "prepared",
      externalRunRef: descriptor.externalRunRef,
      registrationNonce: descriptor.registrationNonce,
      expiresAtMs: descriptor.expiresAtMs,
      ...(record.displayLabel === undefined ? {} : { displayLabel: record.displayLabel }),
      ...(descriptor.requestedWorkspace === undefined
        ? {}
        : { requestedWorkspace: descriptor.requestedWorkspace }),
    });
    if (!prepared.success) return err(new Error("managed-run recovery descriptor is invalid"));
    if (
      digest(prepared.data.externalRunRef) !== record.externalRunRefDigest
      || digest(JSON.stringify(prepared.data)) !== record.activationDescriptorDigest
    ) {
      return err(new Error("managed-run recovery descriptor does not match its durable digest"));
    }
    return ok({
      operationId: `recovery-${record.managedRunId}`,
      serviceInstanceId: record.serviceInstanceId,
      prepared: prepared.data,
      authority: {
        tenantId: record.tenantId,
        agentId: record.agentId,
        principalId: record.principalId,
        conversationRef: record.conversationRef,
        turnScope: record.turnScope,
        deliveryOrigin: record.deliveryOrigin,
        traceId: record.traceId,
        trustLevel: record.trustLevel,
        responseLocalePolicy: record.responseLocalePolicy,
        workspacePolicyHash: record.workspacePolicyHash,
        rootRunId: record.rootRunId,
        initiationSource: record.initiationSource,
        capturedAgentCapabilities: record.capturedAgentCapabilities,
        capturedToolIds: record.capturedToolIds,
        capturedCapabilityViewHash: record.capturedCapabilityViewHash,
      },
    });
  }

  async function cancelExpiredRecovery(
    input: ManagedRunActivationInput,
    ids: ManagedRunActivationIds,
    record: ManagedRunRecord,
  ): Promise<Result<ManagedRunRecord, Error>> {
    await abandonPrepared(input, ids, "registration_expired", "reap_safe", record);
    const transitioned = await invokeStore(() => deps.store.claimTransition(
      { kind: "service", serviceInstanceId: record.serviceInstanceId },
      {
        operationId: ids.rejectionOperationId,
        managedRunId: record.managedRunId,
        expectedStatuses: ["preparing", "unknown"],
        nextStatus: "cancelled",
        nextStatusReason: "activation_rejected",
        transitionedAtMs: deps.nowMs(),
        terminalOutcome: { kind: "cancelled", recordedAtMs: deps.nowMs() },
      },
    ));
    if (!transitioned.ok) return transitioned;
    if (transitioned.value.kind !== "claimed" && transitioned.value.kind !== "identical_replay") {
      return err(new Error(`managed-run expired recovery transition failed: ${transitioned.value.kind}`));
    }
    await removeDescriptor(transitioned.value.record, ids.activationDescriptorRef);
    emitRejected(input, "preparation_expired", record.managedRunId);
    return ok(transitioned.value.record);
  }

  async function reconcileRecoveryRecord(
    record: ManagedRunRecord,
  ): Promise<Result<"activated" | "cancelled" | "unknown", Error>> {
    const ids = recoveryIds(record);
    const descriptorRef = record.activationDescriptorRef;
    if (descriptorRef === undefined) {
      const unknown = await markUnknown(record, ids, "recovery_join_missing");
      return unknown.ok ? ok("unknown") : unknown;
    }
    const descriptor = await invokeStore(() => deps.contentStore.getActivationDescriptorForRecovery({
      tenantId: record.tenantId,
      agentId: record.agentId,
      managedRunId: record.managedRunId,
    }, descriptorRef, { kind: "recovery" }));
    if (!descriptor.ok) return descriptor;
    if (descriptor.value === undefined) {
      const unknown = await markUnknown(record, ids, "recovery_join_missing");
      return unknown.ok ? ok("unknown") : unknown;
    }
    const input = recoveryActivationInput(record, descriptor.value);
    if (!input.ok) {
      const unknown = await markUnknown(record, ids, "recovery_join_missing");
      return unknown.ok ? ok("unknown") : unknown;
    }
    if (input.value.prepared.expiresAtMs <= deps.nowMs()) {
      const cancelled = await cancelExpiredRecovery(input.value, ids, record);
      return cancelled.ok ? ok("cancelled") : cancelled;
    }
    const activeInstance = deps.activeView.getActiveView().instances.find(
      (instance) => instance.serviceInstanceId === record.serviceInstanceId
        && instance.state === "active",
    );
    if (activeInstance === undefined || !activeInstance.allowedAgents.includes(record.agentId)) {
      const unknown = await markUnknown(record, ids, "service_state_unavailable");
      return unknown.ok ? ok("unknown") : unknown;
    }
    const activated = await activateDurable(input.value, ids, record, true, deps.nowMs());
    if (!activated.ok) return activated;
    if (activated.value.kind === "activation_unknown") return ok("unknown");
    if (activated.value.kind === "rejected") return ok("cancelled");
    return ok("activated");
  }

  async function recoverPreparations(
    input: ManagedRunActivationRecoveryInput,
  ): Promise<Result<ManagedRunActivationRecoverySummary, Error>> {
    const startedAtMs = deps.nowMs();
    const scanned = await invokeStore(() => deps.store.listRecoverable({
      kind: "recovery",
      statuses: ["preparing", "unknown"],
      updatedBeforeMs: input.updatedBeforeMs,
      limit: input.limit,
    }));
    if (!scanned.ok) return scanned;
    const summary: {
      activated: string[];
      cancelled: string[];
      unknown: string[];
      invalid: InvalidManagedRunRecord[];
      failed: ManagedRunActivationRecoveryFailure[];
    } = {
      activated: [],
      cancelled: [],
      unknown: [],
      invalid: [...scanned.value.invalid],
      failed: [],
    };
    for (const invalid of scanned.value.invalid) {
      deps.logger.error({
        managedRunId: invalid.managedRunId,
        serviceInstanceId: invalid.serviceInstanceId,
        errorKind: "internal" as const,
        hint: "Inspect the content-free managed-run row and restore or remove it before the next recovery scan",
      }, "Corrupt managed-run recovery row was quarantined");
      emitObservationalEventSafely(
        { eventBus: deps.eventBus, logger: deps.logger },
        "managed_run:recovery_quarantined",
        { ...invalid, timestamp: deps.nowMs() },
      );
    }
    for (const record of scanned.value.records) {
      deps.logger.debug({
        managedRunId: record.managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        step: "managed-run-activation-recovery",
      }, "Reconciling durable managed-run preparation");
      const reconciled = await reconcileRecoveryRecord(record);
      if (reconciled.ok) {
        summary[reconciled.value].push(record.managedRunId);
        continue;
      }
      summary.failed.push({
        managedRunId: record.managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        reasonCode: "reconciliation_failed",
      });
      deps.logger.error({
        managedRunId: record.managedRunId,
        serviceInstanceId: record.serviceInstanceId,
        errorKind: "internal" as const,
        hint: "Inspect the durable run, private activation join, and service control health before retrying recovery",
      }, "Managed-run activation recovery failed");
      emitObservationalEventSafely(
        { eventBus: deps.eventBus, logger: deps.logger },
        "managed_run:recovery_failed",
        {
          managedRunId: record.managedRunId,
          serviceInstanceId: record.serviceInstanceId,
          reasonCode: "reconciliation_failed",
          timestamp: deps.nowMs(),
        },
      );
    }
    const durationMs = Math.max(0, deps.nowMs() - startedAtMs);
    deps.logger.info({
      recoveredCount: summary.activated.length,
      cancelledCount: summary.cancelled.length,
      unknownCount: summary.unknown.length,
      invalidCount: summary.invalid.length,
      failedCount: summary.failed.length,
      durationMs,
    }, "Managed-run activation recovery completed");
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "managed_run:recovery_completed",
      {
        activatedCount: summary.activated.length,
        cancelledCount: summary.cancelled.length,
        unknownCount: summary.unknown.length,
        invalidCount: summary.invalid.length,
        failedCount: summary.failed.length,
        durationMs,
        timestamp: deps.nowMs(),
      },
    );
    return ok(summary);
  }

  return Object.freeze({ activatePrepared, recoverPreparations });
}
