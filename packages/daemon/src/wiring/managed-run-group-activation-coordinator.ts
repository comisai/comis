// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  ManagedRunPreparedGroupStartSchema,
  ManagedRunRecordSchema,
  emitObservationalEventSafely,
  type CapabilityServiceControlFailure,
  type CapabilityServiceControlPort,
  type ComisLogger,
  type ExecutionAttachmentPort,
  type ManagedRunContentPort,
  type ManagedRunGroupOperationResult,
  type ManagedRunGroupRecord,
  type ManagedRunGroupStorePort,
  type ManagedRunOwnerScope,
  type ManagedRunPreparedGroupStart,
  type ManagedRunRecord,
  type ManagedRunStorePort,
  type TypedEventBus,
  type WorkspaceLeasePort,
  type WorkspaceLeaseScope,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { CapabilityServiceRuntime } from "./capability-service-runtime.js";
import type { ExecutionAttachmentAuthority } from "./execution-attachment-authority.js";
import {
  ensurePreparedExecutionAttachment,
  ensurePreparedWorkspaceLease,
  validatePreparedBindingRequests,
  type ManagedRunActivationBindingDeps,
  type PreparedBindingValidation,
} from "./managed-run-activation-bindings.js";
import type {
  ManagedRunActivationAuthority,
  ManagedRunActivationControlIds,
} from "./managed-run-activation-coordinator.js";
import { createManagedRunResourceRevoker } from "./managed-run-resource-revoker.js";
import type { ManagedTerminalRevoker } from "./managed-terminal-revoker.js";
import type { ValidatedWorkspaceLeasePath } from "./workspace-lease-path-validator.js";

export interface ManagedRunGroupActivationInput {
  readonly operationId: string;
  readonly serviceInstanceId: string;
  readonly prepared: ManagedRunPreparedGroupStart;
  readonly authority: ManagedRunActivationAuthority;
}

export interface ManagedRunGroupActivationIds {
  readonly managedRunGroupId: string;
  readonly activationDescriptorRef: string;
  readonly activationOperationId: string;
  readonly abandonOperationId: string;
}

export type ManagedRunGroupActivationRejectionReason =
  | "agent_not_allowed"
  | "binding_not_allowed"
  | "capacity_exceeded"
  | "invalid_preparation"
  | "preparation_expired"
  | "replay_conflict"
  | "service_unavailable";

export type ManagedRunGroupActivationOutcome =
  | {
    readonly kind: "activated" | "identical_replay" | "activation_unknown";
    readonly record: ManagedRunGroupRecord;
    readonly result: ManagedRunGroupOperationResult;
  }
  | {
    readonly kind: "rejected";
    readonly reasonCode: ManagedRunGroupActivationRejectionReason;
    readonly record?: ManagedRunGroupRecord;
  };

export interface ManagedRunGroupActivationCoordinator {
  activatePreparedGroup(
    input: ManagedRunGroupActivationInput,
  ): Promise<Result<ManagedRunGroupActivationOutcome, Error>>;
  recoverPreparations(
    input: ManagedRunGroupActivationRecoveryInput,
  ): Promise<Result<ManagedRunGroupActivationRecoverySummary, Error>>;
}

export interface ManagedRunGroupActivationRecoveryInput {
  readonly updatedBeforeMs: number;
  readonly limit: number;
}

export interface ManagedRunGroupActivationRecoverySummary {
  readonly activated: readonly string[];
  readonly unknown: readonly string[];
  readonly failed: readonly string[];
}

export interface ManagedRunGroupActivationCoordinatorDeps {
  readonly store: ManagedRunStorePort;
  readonly groupStore: ManagedRunGroupStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly workspaceLeases: WorkspaceLeasePort;
  readonly attachments: ExecutionAttachmentPort;
  readonly attachmentAuthority: Pick<ExecutionAttachmentAuthority, "create">;
  readonly revokeManagedTerminals: ManagedTerminalRevoker;
  readonly control: Pick<CapabilityServiceControlPort, "activateGroup" | "abandonGroup">;
  readonly activeView: Pick<CapabilityServiceRuntime, "getActiveView">;
  readonly validateWorkspacePath: (
    requestedPath: string,
    allowedWorkspaceRoots: readonly string[],
  ) => Result<ValidatedWorkspaceLeasePath, Error>;
  readonly resolveMaxConcurrentRuns?: (serviceInstanceId: string) => number | undefined;
  readonly ids: {
    groupForOperation(operationId: string): ManagedRunGroupActivationIds;
    forManagedRunGroup(managedRunGroupId: string): ManagedRunGroupActivationIds;
    memberForOperation(operationId: string, index: number): {
      readonly managedRunId: string;
      readonly activationDescriptorRef: string;
    };
    forManagedRun(managedRunId: string): ManagedRunActivationControlIds;
  };
  readonly nowMs: () => number;
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
}

interface PreparedMember {
  readonly input: ManagedRunGroupActivationInput;
  readonly prepared: ManagedRunPreparedGroupStart["members"][number];
  readonly record: ManagedRunRecord;
  readonly ids: ManagedRunActivationControlIds;
  readonly validation?: PreparedBindingValidation;
}

interface BoundMember extends PreparedMember {
  readonly record: ManagedRunRecord;
  readonly attachment?: {
    readonly executionAttachmentId: string;
    readonly targetName: string;
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function ownerScope(input: ManagedRunGroupActivationInput): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: input.authority.tenantId,
    agentId: input.authority.agentId,
    principalId: input.authority.principalId,
    conversationRef: input.authority.conversationRef,
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

function descriptorFor(member: PreparedMember, groupIds: ManagedRunGroupActivationIds) {
  return {
    schemaVersion: 1 as const,
    externalRunRef: member.prepared.externalRunRef,
    registrationNonce: member.prepared.registrationNonce,
    expiresAtMs: member.prepared.expiresAtMs,
    ...(member.prepared.requestedWorkspace === undefined
      ? {}
      : { requestedWorkspace: member.prepared.requestedWorkspace }),
    ...(member.prepared.requestedAttachment === undefined
      ? {}
      : { requestedAttachment: member.prepared.requestedAttachment }),
    managedRunGroup: {
      managedRunGroupId: groupIds.managedRunGroupId,
      registrationNonce: member.input.prepared.registrationNonce,
    },
  };
}

function bindingInput(member: PreparedMember) {
  return {
    serviceInstanceId: member.input.serviceInstanceId,
    prepared: member.prepared,
    authority: member.input.authority,
  };
}

/** Bind and activate one prepared group without importing its domain graph. */
export function createManagedRunGroupActivationCoordinator(
  deps: ManagedRunGroupActivationCoordinatorDeps,
): ManagedRunGroupActivationCoordinator {
  const bindingDeps: ManagedRunActivationBindingDeps = {
    store: deps.store,
    workspaceLeases: deps.workspaceLeases,
    attachmentAuthority: deps.attachmentAuthority,
    activeView: deps.activeView,
    validateWorkspacePath: deps.validateWorkspacePath,
    nowMs: deps.nowMs,
  };
  const revokeBoundResources = createManagedRunResourceRevoker({
    store: deps.store,
    attachments: deps.attachments,
    revokeManagedTerminals: deps.revokeManagedTerminals,
    nowMs: deps.nowMs,
    logger: deps.logger,
  });

  function emitRejected(
    input: ManagedRunGroupActivationInput,
    reasonCode: ManagedRunGroupActivationRejectionReason,
    managedRunGroupId?: string,
  ): void {
    deps.logger.audit({
      decision: "deny",
      serviceInstanceId: input.serviceInstanceId,
      agentId: input.authority.agentId,
      reasonCode,
      ...(managedRunGroupId === undefined ? {} : { managedRunGroupId }),
    }, "Managed-run group activation rejected");
  }

  async function abandonGroup(
    input: ManagedRunGroupActivationInput,
    groupIds: ManagedRunGroupActivationIds,
    reason: "activation_rejected" | "registration_expired" | "service_unavailable",
  ): Promise<boolean> {
    const abandoned = await invokeControl(() => deps.control.abandonGroup({
      operationId: groupIds.abandonOperationId,
      serviceInstanceId: input.serviceInstanceId,
      managedRunGroupId: groupIds.managedRunGroupId,
      registrationNonce: input.prepared.registrationNonce,
      members: input.prepared.members.map((member, index) => ({
        managedRunId: deps.ids.memberForOperation(input.operationId, index).managedRunId,
        externalRunRef: member.externalRunRef,
        registrationNonce: member.registrationNonce,
      })),
      reason,
      disposition: "reap_safe",
    }));
    if (abandoned.ok) return true;
    deps.logger.warn({
      serviceInstanceId: input.serviceInstanceId,
      managedRunGroupId: groupIds.managedRunGroupId,
      reasonCode: abandoned.error.reasonCode,
      errorKind: "dependency" as const,
      hint: "Inspect the capability service and reap the named prepared group before its expiry",
    }, "Capability-service group abandon was not acknowledged");
    return false;
  }

  async function removeDescriptor(member: PreparedMember): Promise<void> {
    const removed = await invokeStore(() => deps.contentStore.deleteActivationDescriptor({
      tenantId: member.record.tenantId,
      agentId: member.record.agentId,
      managedRunId: member.record.managedRunId,
    }, member.record.activationDescriptorRef ?? "missing-activation-descriptor"));
    if (!removed.ok) {
      deps.logger.warn({
        managedRunId: member.record.managedRunId,
        serviceInstanceId: member.record.serviceInstanceId,
        errorKind: "resource" as const,
        hint: "Run the managed-run content retention sweep to remove the private grouped activation body",
      }, "Managed-run group descriptor cleanup failed");
    }
  }

  function memberCandidate(
    input: ManagedRunGroupActivationInput,
    groupIds: ManagedRunGroupActivationIds,
    index: number,
  ): Result<PreparedMember, Error> {
    const prepared = input.prepared.members[index];
    if (prepared === undefined) return err(new Error("managed-run group member is missing"));
    const minted = deps.ids.memberForOperation(input.operationId, index);
    const ids = deps.ids.forManagedRun(minted.managedRunId);
    const descriptor = {
      schemaVersion: 1 as const,
      externalRunRef: prepared.externalRunRef,
      registrationNonce: prepared.registrationNonce,
      expiresAtMs: prepared.expiresAtMs,
      ...(prepared.requestedWorkspace === undefined ? {} : { requestedWorkspace: prepared.requestedWorkspace }),
      ...(prepared.requestedAttachment === undefined ? {} : { requestedAttachment: prepared.requestedAttachment }),
      managedRunGroup: {
        managedRunGroupId: groupIds.managedRunGroupId,
        registrationNonce: input.prepared.registrationNonce,
      },
    };
    const nowMs = deps.nowMs();
    const record = ManagedRunRecordSchema.safeParse({
      schemaVersion: 1,
      managedRunId: minted.managedRunId,
      managedRunGroupId: groupIds.managedRunGroupId,
      serviceInstanceId: input.serviceInstanceId,
      externalRunRefDigest: digest(prepared.externalRunRef),
      activationDescriptorDigest: digest(descriptor),
      activationDescriptorRef: minted.activationDescriptorRef,
      ...(prepared.displayLabel === undefined ? {} : { displayLabel: prepared.displayLabel }),
      ...input.authority,
      capturedAgentCapabilities: [...input.authority.capturedAgentCapabilities],
      capturedToolIds: [...input.authority.capturedToolIds],
      executionAttachmentIds: [],
      terminalSessionIds: [],
      status: "preparing",
      statusReason: "awaiting_activation",
      lastAcceptedReportSequence: 0,
      lastReducedReportSequence: 0,
      pendingContinuation: false,
      openAttentionCount: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return record.success
      ? ok({ input, prepared, record: record.data, ids })
      : err(new Error("managed-run group member authority failed strict validation"));
  }

  async function loadExistingMembers(
    input: ManagedRunGroupActivationInput,
    group: ManagedRunGroupRecord,
    candidates: readonly PreparedMember[],
  ): Promise<Result<PreparedMember[], Error>> {
    if (
      group.serviceInstanceId !== input.serviceInstanceId
      || group.rootRunId !== input.authority.rootRunId
      || group.memberManagedRunIds.length !== candidates.length
    ) return err(new Error("managed-run group replay authority does not match"));
    const loaded: PreparedMember[] = [];
    for (const candidate of candidates) {
      const record = await invokeStore(() => deps.store.get(ownerScope(input), candidate.record.managedRunId));
      if (!record.ok) return record;
      if (
        record.value === undefined
        || record.value.managedRunGroupId !== group.managedRunGroupId
        || record.value.externalRunRefDigest !== candidate.record.externalRunRefDigest
        || record.value.activationDescriptorDigest !== candidate.record.activationDescriptorDigest
      ) return err(new Error("managed-run group replay member does not match"));
      loaded.push({ ...candidate, record: record.value });
    }
    return ok(loaded);
  }

  async function persistNewMembers(
    input: ManagedRunGroupActivationInput,
    groupIds: ManagedRunGroupActivationIds,
    members: readonly PreparedMember[],
  ): Promise<Result<readonly PreparedMember[], Error>> {
    const groupScope = {
      tenantId: input.authority.tenantId,
      agentId: input.authority.agentId,
      managedRunId: groupIds.managedRunGroupId,
    };
    const groupBody = await invokeStore(() => deps.contentStore.putGroupActivationDescriptor(
      groupScope,
      groupIds.activationDescriptorRef,
      { schemaVersion: 1, ...input.prepared },
    ));
    if (!groupBody.ok) return groupBody;
    const written: PreparedMember[] = [];
    for (const member of members) {
      const body = await invokeStore(() => deps.contentStore.putActivationDescriptor({
        tenantId: member.record.tenantId,
        agentId: member.record.agentId,
        managedRunId: member.record.managedRunId,
      }, member.record.activationDescriptorRef as string, descriptorFor(member, groupIds)));
      if (!body.ok) {
        for (const prior of written) await removeDescriptor(prior);
        await invokeStore(() => deps.contentStore.deleteGroupActivationDescriptor(
          groupScope,
          groupIds.activationDescriptorRef,
        ));
        return body;
      }
      written.push(member);
    }
    const prepared = await invokeStore(() => deps.groupStore.prepareGroup({
      operationId: input.operationId,
      managedRunGroupId: groupIds.managedRunGroupId,
      serviceInstanceId: input.serviceInstanceId,
      rootRunId: input.authority.rootRunId,
      createdAtMs: members[0]?.record.createdAtMs ?? deps.nowMs(),
      members: members.map((member) => member.record),
    }));
    if (!prepared.ok || (prepared.value.kind !== "created" && prepared.value.kind !== "identical_replay")) {
      for (const member of written) await removeDescriptor(member);
      await invokeStore(() => deps.contentStore.deleteGroupActivationDescriptor(
        groupScope,
        groupIds.activationDescriptorRef,
      ));
      return prepared.ok
        ? err(new Error(`managed-run group durable preparation failed: ${prepared.value.kind}`))
        : prepared;
    }
    for (const member of members) {
      emitObservationalEventSafely(
        { eventBus: deps.eventBus, logger: deps.logger },
        "managed_run:prepared",
        {
          managedRunId: member.record.managedRunId,
          serviceInstanceId: member.record.serviceInstanceId,
          agentId: member.record.agentId,
          timestamp: deps.nowMs(),
        },
      );
    }
    return ok(members);
  }

  async function bindMembers(
    members: readonly PreparedMember[],
  ): Promise<Result<BoundMember[], Error>> {
    const bound: BoundMember[] = [];
    for (const member of members) {
      const workspace = await ensurePreparedWorkspaceLease(
        bindingDeps,
        bindingInput(member),
        member.ids,
        member.record,
        member.validation?.workspace,
      );
      if (!workspace.ok) return workspace;
      const attachment = await ensurePreparedExecutionAttachment(
        bindingDeps,
        bindingInput(member),
        member.ids,
        workspace.value,
      );
      if (!attachment.ok) return attachment;
      if (attachment.value.kind === "rejected") {
        return err(new Error("managed-run group member attachment was rejected"));
      }
      bound.push({
        ...member,
        record: attachment.value.record,
        ...(attachment.value.attachment === undefined
          ? {}
          : { attachment: attachment.value.attachment }),
      });
    }
    return ok(bound);
  }

  async function markUnknown(member: PreparedMember): Promise<Result<ManagedRunRecord, Error>> {
    if (member.record.status === "unknown") return ok(member.record);
    const transitioned = await invokeStore(() => deps.store.claimTransition(
      { kind: "service", serviceInstanceId: member.record.serviceInstanceId },
      {
        operationId: member.ids.outcomeUnknownOperationId,
        managedRunId: member.record.managedRunId,
        expectedStatuses: ["preparing", "unknown"],
        nextStatus: "unknown",
        nextStatusReason: "activation_outcome_unknown",
        transitionedAtMs: deps.nowMs(),
      },
    ));
    if (!transitioned.ok) return transitioned;
    return transitioned.value.kind === "claimed" || transitioned.value.kind === "identical_replay"
      ? ok(transitioned.value.record)
      : err(new Error(`managed-run group uncertainty transition failed: ${transitioned.value.kind}`));
  }

  async function cancelRejected(member: PreparedMember): Promise<Result<ManagedRunRecord, Error>> {
    if (member.record.status === "cancelled") return ok(member.record);
    if (member.record.workspaceLeaseId !== undefined) {
      const revoked = await revokeBoundResources(member.record, member.ids.leaseReleaseOperationId);
      if (!revoked) return markUnknown(member);
      const released = await invokeStore(() => deps.workspaceLeases.release(
        workspaceScope(member.record),
        {
          operationId: member.ids.leaseReleaseOperationId,
          workspaceLeaseId: member.record.workspaceLeaseId as string,
          disposition: "reap_safe",
          releasedAtMs: deps.nowMs(),
        },
      ));
      if (!released.ok) return markUnknown(member);
    }
    const transitionedAtMs = deps.nowMs();
    const transitioned = await invokeStore(() => deps.store.claimTransition(
      { kind: "service", serviceInstanceId: member.record.serviceInstanceId },
      {
        operationId: member.ids.rejectionOperationId,
        managedRunId: member.record.managedRunId,
        expectedStatuses: ["preparing", "unknown"],
        nextStatus: "cancelled",
        nextStatusReason: "activation_rejected",
        transitionedAtMs,
        terminalOutcome: { kind: "cancelled", recordedAtMs: transitionedAtMs },
      },
    ));
    if (!transitioned.ok) return transitioned;
    if (transitioned.value.kind !== "claimed" && transitioned.value.kind !== "identical_replay") {
      return err(new Error(`managed-run group rejection transition failed: ${transitioned.value.kind}`));
    }
    return ok(transitioned.value.record);
  }

  async function activateMember(member: PreparedMember, activatedAtMs: number): Promise<Result<ManagedRunRecord, Error>> {
    if (member.record.status === "active") return ok(member.record);
    const transitioned = await invokeStore(() => deps.store.claimTransition(
      { kind: "service", serviceInstanceId: member.record.serviceInstanceId },
      {
        operationId: member.ids.activationOperationId,
        managedRunId: member.record.managedRunId,
        expectedStatuses: ["preparing", "unknown"],
        nextStatus: "active",
        nextStatusReason: "activation_acknowledged",
        transitionedAtMs: Math.max(deps.nowMs(), activatedAtMs),
      },
    ));
    if (!transitioned.ok) return transitioned;
    if (transitioned.value.kind !== "claimed" && transitioned.value.kind !== "identical_replay") {
      return err(new Error(`managed-run group activation transition failed: ${transitioned.value.kind}`));
    }
    return ok(transitioned.value.record);
  }

  async function transitionOutcomes(
    members: readonly BoundMember[],
    outcomes: readonly { readonly managedRunId: string; readonly outcome: "completed" | "rejected" | "unknown" | "not_attempted" }[],
    activatedAtMs: number,
  ): Promise<Result<ManagedRunGroupOperationResult["members"], Error>> {
    const result: Array<ManagedRunGroupOperationResult["members"][number]> = [];
    for (const member of members) {
      const acknowledgement = outcomes.find((candidate) => candidate.managedRunId === member.record.managedRunId);
      if (acknowledgement === undefined) return err(new Error("group acknowledgement omitted a member"));
      const transitioned = acknowledgement.outcome === "completed"
        ? await activateMember(member, activatedAtMs)
        : acknowledgement.outcome === "rejected"
          ? await cancelRejected(member)
          : await markUnknown(member);
      if (!transitioned.ok) return transitioned;
      result.push({ managedRunId: member.record.managedRunId, outcome: acknowledgement.outcome });
    }
    return ok(result.sort((left, right) => left.managedRunId.localeCompare(right.managedRunId)));
  }

  async function currentGroup(
    input: ManagedRunGroupActivationInput,
    managedRunGroupId: string,
  ): Promise<Result<ManagedRunGroupRecord, Error>> {
    const group = await invokeStore(() => deps.groupStore.getGroup(ownerScope(input), managedRunGroupId));
    if (!group.ok) return group;
    return group.value === undefined
      ? err(new Error("durable managed-run group disappeared during activation"))
      : ok(group.value);
  }

  async function markAllUnknown(
    input: ManagedRunGroupActivationInput,
    groupIds: ManagedRunGroupActivationIds,
    members: readonly PreparedMember[],
  ): Promise<Result<ManagedRunGroupActivationOutcome, Error>> {
    const outcomes: Array<ManagedRunGroupOperationResult["members"][number]> = [];
    for (const member of members) {
      const unknown = await markUnknown(member);
      if (!unknown.ok) return unknown;
      outcomes.push({ managedRunId: member.record.managedRunId, outcome: "unknown" });
    }
    const group = await currentGroup(input, groupIds.managedRunGroupId);
    if (!group.ok) return group;
    return ok({
      kind: "activation_unknown",
      record: group.value,
      result: {
        operationId: groupIds.activationOperationId,
        managedRunGroupId: groupIds.managedRunGroupId,
        members: outcomes.sort((left, right) => left.managedRunId.localeCompare(right.managedRunId)),
      },
    });
  }

  async function activateDurableGroup(
    input: ManagedRunGroupActivationInput,
    groupIds: ManagedRunGroupActivationIds,
    members: readonly PreparedMember[],
    replayed: boolean,
    startedAtMs: number,
  ): Promise<Result<ManagedRunGroupActivationOutcome, Error>> {
    const bound = await bindMembers(members);
    if (!bound.ok) {
      deps.logger.warn({
        serviceInstanceId: input.serviceInstanceId,
        managedRunGroupId: groupIds.managedRunGroupId,
        errorKind: "resource" as const,
        hint: "Inspect each retained group member binding before retrying the replayable activation operation",
      }, "Managed-run group binding outcome is unknown");
      return markAllUnknown(input, groupIds, members);
    }
    const commandMembers = bound.value.map((member) => ({
      managedRunId: member.record.managedRunId,
      externalRunRef: member.prepared.externalRunRef,
      registrationNonce: member.prepared.registrationNonce,
      ...(member.record.workspaceLeaseId === undefined ? {} : { workspaceLeaseId: member.record.workspaceLeaseId }),
      ...(member.attachment === undefined
        ? {}
        : {
            executionAttachmentId: member.attachment.executionAttachmentId,
            attachmentTargetName: member.attachment.targetName,
          }),
    }));
    const activation = await invokeControl(() => deps.control.activateGroup({
      operationId: groupIds.activationOperationId,
      serviceInstanceId: input.serviceInstanceId,
      managedRunGroupId: groupIds.managedRunGroupId,
      registrationNonce: input.prepared.registrationNonce,
      members: commandMembers,
    }));
    if (!activation.ok) return markAllUnknown(input, groupIds, bound.value);
    const acknowledgementIds = new Set(activation.value.members.map((member) => member.managedRunId));
    if (
      activation.value.managedRunGroupId !== groupIds.managedRunGroupId
      || acknowledgementIds.size !== bound.value.length
      || bound.value.some((member) => !acknowledgementIds.has(member.record.managedRunId))
    ) return markAllUnknown(input, groupIds, bound.value);

    const outcomes = await transitionOutcomes(
      bound.value,
      activation.value.members,
      activation.value.activatedAtMs,
    );
    if (!outcomes.ok) return outcomes;
    const group = await currentGroup(input, groupIds.managedRunGroupId);
    if (!group.ok) return group;
    const allCompleted = outcomes.value.every((member) => member.outcome === "completed");
    if (allCompleted) {
      for (const member of bound.value) await removeDescriptor(member);
      await invokeStore(() => deps.contentStore.deleteGroupActivationDescriptor({
        tenantId: input.authority.tenantId,
        agentId: input.authority.agentId,
        managedRunId: groupIds.managedRunGroupId,
      }, groupIds.activationDescriptorRef));
    }
    const durationMs = Math.max(0, deps.nowMs() - startedAtMs);
    deps.logger.info({
      serviceInstanceId: input.serviceInstanceId,
      managedRunGroupId: groupIds.managedRunGroupId,
      memberCount: outcomes.value.length,
      completedCount: outcomes.value.filter((member) => member.outcome === "completed").length,
      durationMs,
    }, "Managed-run group activation completed");
    return ok({
      kind: allCompleted ? (replayed ? "identical_replay" : "activated") : "activation_unknown",
      record: group.value,
      result: {
        operationId: groupIds.activationOperationId,
        managedRunGroupId: groupIds.managedRunGroupId,
        members: outcomes.value,
      },
    });
  }

  async function activatePreparedGroup(
    input: ManagedRunGroupActivationInput,
  ): Promise<Result<ManagedRunGroupActivationOutcome, Error>> {
    const startedAtMs = deps.nowMs();
    const parsed = ManagedRunPreparedGroupStartSchema.safeParse(input.prepared);
    const groupIds = deps.ids.groupForOperation(input.operationId);
    if (!parsed.success) {
      emitRejected(input, "invalid_preparation");
      return ok({ kind: "rejected", reasonCode: "invalid_preparation" });
    }
    const candidates: PreparedMember[] = [];
    for (let index = 0; index < parsed.data.members.length; index += 1) {
      const candidate = memberCandidate({ ...input, prepared: parsed.data }, groupIds, index);
      if (!candidate.ok) {
        emitRejected(input, "invalid_preparation", groupIds.managedRunGroupId);
        return ok({ kind: "rejected", reasonCode: "invalid_preparation" });
      }
      candidates.push(candidate.value);
    }

    const existingGroup = await invokeStore(() => deps.groupStore.getGroup(
      ownerScope(input),
      groupIds.managedRunGroupId,
    ));
    if (!existingGroup.ok) return existingGroup;
    let members: PreparedMember[];
    let replayed = false;
    if (existingGroup.value !== undefined) {
      const loaded = await loadExistingMembers(input, existingGroup.value, candidates);
      if (!loaded.ok) {
        emitRejected(input, "replay_conflict", groupIds.managedRunGroupId);
        return ok({ kind: "rejected", reasonCode: "replay_conflict", record: existingGroup.value });
      }
      members = loaded.value;
      replayed = true;
      if (members.every((member) => member.record.status === "active")) {
        return ok({
          kind: "identical_replay",
          record: existingGroup.value,
          result: {
            operationId: groupIds.activationOperationId,
            managedRunGroupId: groupIds.managedRunGroupId,
            members: members.map((member) => ({
              managedRunId: member.record.managedRunId,
              outcome: "completed" as const,
            })).sort((left, right) => left.managedRunId.localeCompare(right.managedRunId)),
          },
        });
      }
    } else {
      if (parsed.data.expiresAtMs <= deps.nowMs()) {
        await abandonGroup(input, groupIds, "registration_expired");
        emitRejected(input, "preparation_expired");
        return ok({ kind: "rejected", reasonCode: "preparation_expired" });
      }
      const instance = deps.activeView.getActiveView().instances.find(
        (candidate) => candidate.serviceInstanceId === input.serviceInstanceId
          && candidate.state === "active",
      );
      if (instance === undefined || !instance.activeScopes.includes("managed_run_group")) {
        await abandonGroup(input, groupIds, "service_unavailable");
        emitRejected(input, "service_unavailable");
        return ok({ kind: "rejected", reasonCode: "service_unavailable" });
      }
      if (!instance.allowedAgents.includes(input.authority.agentId)) {
        await abandonGroup(input, groupIds, "activation_rejected");
        emitRejected(input, "agent_not_allowed");
        return ok({ kind: "rejected", reasonCode: "agent_not_allowed" });
      }
      const maxConcurrentRuns = deps.resolveMaxConcurrentRuns?.(input.serviceInstanceId);
      if (maxConcurrentRuns !== undefined) {
        const activeCount = await invokeStore(() => deps.store.countActiveByService(input.serviceInstanceId));
        if (!activeCount.ok) return activeCount;
        if (activeCount.value + candidates.length > maxConcurrentRuns) {
          await abandonGroup(input, groupIds, "service_unavailable");
          emitRejected(input, "capacity_exceeded");
          return ok({ kind: "rejected", reasonCode: "capacity_exceeded" });
        }
      }
      const validated: PreparedMember[] = [];
      for (const member of candidates) {
        const validation = validatePreparedBindingRequests(bindingDeps, bindingInput(member));
        if (!validation.ok) {
          await abandonGroup(input, groupIds, "activation_rejected");
          emitRejected(input, "binding_not_allowed");
          return ok({ kind: "rejected", reasonCode: "binding_not_allowed" });
        }
        validated.push({ ...member, validation: validation.value });
      }
      const persisted = await persistNewMembers(input, groupIds, validated);
      if (!persisted.ok) {
        await abandonGroup(input, groupIds, "activation_rejected");
        return persisted;
      }
      members = [...persisted.value];
    }

    return activateDurableGroup(input, groupIds, members, replayed, startedAtMs);
  }

  async function recoverGroup(
    seed: ManagedRunRecord,
  ): Promise<Result<"activated" | "unknown", Error>> {
    const managedRunGroupId = seed.managedRunGroupId;
    if (managedRunGroupId === undefined) {
      return err(new Error("managed-run group recovery seed has no group id"));
    }
    const group = await invokeStore(() => deps.groupStore.getGroup(
      { kind: "service", serviceInstanceId: seed.serviceInstanceId },
      managedRunGroupId,
    ));
    if (!group.ok) return group;
    if (group.value === undefined) return err(new Error("managed-run group recovery roll-up is missing"));
    const records: ManagedRunRecord[] = [];
    for (const managedRunId of group.value.memberManagedRunIds) {
      const record = await invokeStore(() => deps.store.get(
        { kind: "service", serviceInstanceId: seed.serviceInstanceId },
        managedRunId,
      ));
      if (!record.ok) return record;
      if (record.value === undefined) {
        return err(new Error("managed-run group recovery member is missing"));
      }
      records.push(record.value);
    }
    if (records.every((record) => record.status === "active")) return ok("activated");

    const groupIds = deps.ids.forManagedRunGroup(managedRunGroupId);
    const groupDescriptor = await invokeStore(() => deps.contentStore.getGroupActivationDescriptorForRecovery({
      tenantId: seed.tenantId,
      agentId: seed.agentId,
      managedRunId: managedRunGroupId,
    }, groupIds.activationDescriptorRef, { kind: "recovery" }));
    if (!groupDescriptor.ok) return groupDescriptor;
    if (groupDescriptor.value === undefined) {
      return err(new Error("managed-run group recovery private join is missing"));
    }
    const prepared = ManagedRunPreparedGroupStartSchema.safeParse({
      state: groupDescriptor.value.state,
      registrationNonce: groupDescriptor.value.registrationNonce,
      expiresAtMs: groupDescriptor.value.expiresAtMs,
      ...(groupDescriptor.value.displayLabel === undefined
        ? {}
        : { displayLabel: groupDescriptor.value.displayLabel }),
      members: groupDescriptor.value.members,
    });
    if (!prepared.success) return err(new Error("managed-run group recovery input is invalid"));
    const [anchor] = records;
    if (anchor === undefined) return err(new Error("group recovery has no anchor member"));
    const input: ManagedRunGroupActivationInput = {
      operationId: `recovery-${managedRunGroupId}`,
      serviceInstanceId: anchor.serviceInstanceId,
      prepared: prepared.data,
      authority: {
        tenantId: anchor.tenantId,
        agentId: anchor.agentId,
        principalId: anchor.principalId,
        conversationRef: anchor.conversationRef,
        turnScope: anchor.turnScope,
        deliveryOrigin: anchor.deliveryOrigin,
        traceId: anchor.traceId,
        trustLevel: anchor.trustLevel,
        responseLocalePolicy: anchor.responseLocalePolicy,
        workspacePolicyHash: anchor.workspacePolicyHash,
        rootRunId: anchor.rootRunId,
        initiationSource: anchor.initiationSource,
        capturedAgentCapabilities: anchor.capturedAgentCapabilities,
        capturedToolIds: anchor.capturedToolIds,
        capturedCapabilityViewHash: anchor.capturedCapabilityViewHash,
      },
    };
    const claimedRecords = new Set<string>();
    const preparedMembers: PreparedMember[] = [];
    for (const preparedMember of prepared.data.members) {
      const expectedDescriptor = {
        schemaVersion: 1 as const,
        externalRunRef: preparedMember.externalRunRef,
        registrationNonce: preparedMember.registrationNonce,
        expiresAtMs: preparedMember.expiresAtMs,
        ...(preparedMember.requestedWorkspace === undefined
          ? {}
          : { requestedWorkspace: preparedMember.requestedWorkspace }),
        ...(preparedMember.requestedAttachment === undefined
          ? {}
          : { requestedAttachment: preparedMember.requestedAttachment }),
        managedRunGroup: { managedRunGroupId, registrationNonce: prepared.data.registrationNonce },
      };
      const record = records.find((candidate) =>
        !claimedRecords.has(candidate.managedRunId)
        && candidate.externalRunRefDigest === digest(preparedMember.externalRunRef)
        && candidate.activationDescriptorDigest === digest(expectedDescriptor));
      if (record === undefined) return err(new Error("group recovery member digest does not match its private join"));
      claimedRecords.add(record.managedRunId);
      preparedMembers.push({
        input,
        prepared: preparedMember,
        record,
        ids: deps.ids.forManagedRun(record.managedRunId),
      });
    }
    if (claimedRecords.size !== records.length) {
      return err(new Error("group recovery private join does not account for every member"));
    }
    const activated = await activateDurableGroup(
      input,
      groupIds,
      preparedMembers,
      true,
      deps.nowMs(),
    );
    if (!activated.ok) return activated;
    return ok(activated.value.kind === "activation_unknown" || activated.value.kind === "rejected"
      ? "unknown"
      : "activated");
  }

  async function recoverPreparations(
    input: ManagedRunGroupActivationRecoveryInput,
  ): Promise<Result<ManagedRunGroupActivationRecoverySummary, Error>> {
    const startedAtMs = deps.nowMs();
    const seen = new Set<string>();
    const summary = { activated: [] as string[], unknown: [] as string[], failed: [] as string[] };
    let afterManagedRunId: string | undefined;
    do {
      const scanned = await invokeStore(() => deps.store.listRecoverable({
        kind: "recovery",
        statuses: ["preparing", "unknown"],
        updatedBeforeMs: input.updatedBeforeMs,
        ...(afterManagedRunId === undefined ? {} : { afterManagedRunId }),
        limit: input.limit,
      }));
      if (!scanned.ok) return scanned;
      for (const record of scanned.value.records) {
        const managedRunGroupId = record.managedRunGroupId;
        if (managedRunGroupId === undefined || seen.has(managedRunGroupId)) continue;
        seen.add(managedRunGroupId);
        deps.logger.debug({
          managedRunGroupId,
          serviceInstanceId: record.serviceInstanceId,
          step: "managed-run-group-activation-recovery",
        }, "Reconciling durable managed-run group preparation");
        const recovered = await recoverGroup(record);
        if (!recovered.ok) {
          summary.failed.push(managedRunGroupId);
          deps.logger.error({
            managedRunGroupId,
            serviceInstanceId: record.serviceInstanceId,
            errorKind: "internal" as const,
            hint: "Inspect the durable group members, private activation joins, and service control health before retrying recovery",
          }, "Managed-run group activation recovery failed");
        } else {
          summary[recovered.value].push(managedRunGroupId);
        }
      }
      afterManagedRunId = scanned.value.nextAfterManagedRunId;
    } while (afterManagedRunId !== undefined);
    deps.logger.info({
      recoveredGroupCount: summary.activated.length,
      unknownGroupCount: summary.unknown.length,
      failedGroupCount: summary.failed.length,
      durationMs: Math.max(0, deps.nowMs() - startedAtMs),
    }, "Managed-run group activation recovery completed");
    return ok(summary);
  }

  return Object.freeze({ activatePreparedGroup, recoverPreparations });
}
