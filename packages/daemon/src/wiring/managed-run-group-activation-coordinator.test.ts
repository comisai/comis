// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type CapabilityServiceControlPort,
  type ComisLogger,
  type ManagedRunOwnerScope,
} from "@comis/core";
import {
  createSqliteExecutionAttachmentStore,
  createSqliteManagedRunContentStore,
  createSqliteManagedRunGroupStore,
  createSqliteManagedRunStore,
  createSqliteWorkspaceLeaseStore,
  initSchema,
} from "@comis/memory";
import { err, ok } from "@comis/shared";
import {
  createManagedRunGroupActivationCoordinator,
  type ManagedRunGroupActivationInput,
} from "./managed-run-group-activation-coordinator.js";

const NOW_MS = 1_800_000_000_000;
const conversation = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: { kind: "agent" as const },
};
const conversationRef = createConversationRef(conversation);
if (!conversationRef.ok) throw conversationRef.error;

const OWNER_SCOPE: ManagedRunOwnerScope = {
  kind: "owner",
  tenantId: "tenant_a",
  agentId: "agent_a",
  principalId: "principal_a",
  conversationRef: conversationRef.value,
};

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

function makeInput(): ManagedRunGroupActivationInput {
  return {
    operationId: "operation_group_prepare_a",
    serviceInstanceId: "service-instance_a",
    prepared: {
      state: "prepared",
      registrationNonce: "group-registration-nonce_a",
      expiresAtMs: NOW_MS + 60_000,
      members: [
        {
          state: "prepared",
          externalRunRef: "external-run_member-a",
          registrationNonce: "member-registration-nonce_a",
          expiresAtMs: NOW_MS + 60_000,
          displayLabel: "Member A",
        },
        {
          state: "prepared",
          externalRunRef: "external-run_member-b",
          registrationNonce: "member-registration-nonce_b",
          expiresAtMs: NOW_MS + 60_000,
          displayLabel: "Member B",
        },
      ],
    },
    authority: {
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationRef.value,
      turnScope: {
        conversation,
        principal: { principalId: "principal_a" },
        endpoint: {
          channelType: "telegram",
          channelInstanceId: "channel-instance_a",
          conversationId: "conversation_a",
          conversationKind: "direct",
        },
      },
      deliveryOrigin: {
        channelType: "telegram",
        channelId: "conversation_a",
        userId: "principal_a",
        tenantId: "tenant_a",
      },
      traceId: "10000000-0000-4000-8000-000000000001",
      trustLevel: "user",
      responseLocalePolicy: { locale: "en", source: "request", enforceLocale: true },
      workspacePolicyHash: "b".repeat(64),
      rootRunId: "root-run_a",
      initiationSource: "user_request",
      capturedAgentCapabilities: ["orch:read"],
      capturedToolIds: ["mcp:fixture-service/prepare_initiative"],
      capturedCapabilityViewHash: "c".repeat(64),
    },
  };
}

describe("managed-run grouped two-phase activation", () => {
  let db: Database.Database;
  let directory: string;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4);
    directory = realpathSync(mkdtempSync(join(tmpdir(), "managed-run-group-activation-")));
    chmodSync(directory, 0o700);
    mkdirSync(join(directory, "private"), { mode: 0o700 });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function makeCoordinator(
    activateGroup: ReturnType<typeof vi.fn>,
  ) {
    const store = createSqliteManagedRunStore(db);
    const groupStore = createSqliteManagedRunGroupStore(db);
    const content = createSqliteManagedRunContentStore(db, {
      directoryPath: join(directory, "private"),
      nowMs: () => NOW_MS,
    });
    if (!content.ok) throw content.error;
    const control = {
      activateGroup,
      abandonGroup: vi.fn(async (command) => ok({
        managedRunGroupId: command.managedRunGroupId,
        members: [],
        state: "abandoned" as const,
        disposition: command.disposition,
      })),
    } as unknown as CapabilityServiceControlPort;
    return {
      store,
      groupStore,
      contentStore: content.value,
      coordinator: createManagedRunGroupActivationCoordinator({
        store,
        groupStore,
        contentStore: content.value,
        workspaceLeases: createSqliteWorkspaceLeaseStore(db),
        attachments: createSqliteExecutionAttachmentStore(db),
        attachmentAuthority: {
          create: vi.fn(async () => err(new Error("attachment creation was not expected"))),
        },
        revokeManagedTerminals: async () => ok(undefined),
        control,
        activeView: {
          getActiveView: () => ({
            schemaVersion: 1,
            revision: 1,
            publishedAtMs: NOW_MS,
            viewHash: "c".repeat(64),
            definitions: [],
            instances: [{
              contributionId: "fixture-service",
              serviceDefinitionId: "fixture-service-definition",
              serviceInstanceId: "service-instance_a",
              mcpServerName: "fixture-service",
              allowedAgents: ["agent_a"],
              allowedWorkspaceRoots: [],
              allowedRuntimeRoots: [],
              activeScopes: ["managed_run_group"],
              state: "active",
            }],
          }),
        },
        validateWorkspacePath: () => err(new Error("workspace validation was not expected")),
        ids: {
          groupForOperation: (operationId) => ({
            managedRunGroupId: `managed-run-group-${operationId}`,
            activationDescriptorRef: `descriptor-group-${operationId}`,
            activationOperationId: `activate-group-${operationId}`,
            abandonOperationId: `abandon-group-${operationId}`,
          }),
          forManagedRunGroup: (managedRunGroupId) => ({
            managedRunGroupId,
            activationDescriptorRef: "descriptor-group-operation_group_prepare_a",
            activationOperationId: "activate-group-operation_group_prepare_a",
            abandonOperationId: "abandon-group-operation_group_prepare_a",
          }),
          memberForOperation: (operationId, index) => ({
            managedRunId: `managed-run-${operationId}-${String(index)}`,
            activationDescriptorRef: `descriptor-${operationId}-${String(index)}`,
          }),
          forManagedRun: (managedRunId) => ({
            workspaceLeaseId: `workspace-${managedRunId}`,
            attachmentOperationId: `attachment-${managedRunId}`,
            activationOperationId: `activate-${managedRunId}`,
            abandonOperationId: `abandon-${managedRunId}`,
            leaseReleaseOperationId: `release-${managedRunId}`,
            leaseRecoveryOperationId: `recover-${managedRunId}`,
            rejectionOperationId: `reject-${managedRunId}`,
            joinMissingOperationId: `join-missing-${managedRunId}`,
            outcomeUnknownOperationId: `unknown-${managedRunId}`,
            unavailableOperationId: `unavailable-${managedRunId}`,
          }),
        },
        nowMs: () => NOW_MS,
        eventBus: new TypedEventBus(),
        logger: makeLogger(),
      }),
    };
  }

  it("persists every member before one group activation frame", async () => {
    let store = createSqliteManagedRunStore(db);
    const activateGroup = vi.fn(async (command) => {
      const records = await Promise.all(command.members.map((member) =>
        store.get({ kind: "service", serviceInstanceId: command.serviceInstanceId }, member.managedRunId)));
      expect(records.every((record) => record.ok && record.value?.status === "preparing")).toBe(true);
      return ok({
        managedRunGroupId: command.managedRunGroupId,
        members: command.members.map((member) => ({
          managedRunId: member.managedRunId,
          outcome: "completed" as const,
        })),
        activatedAtMs: NOW_MS + 10,
      });
    });
    const harness = makeCoordinator(activateGroup);
    store = harness.store;

    const activated = await harness.coordinator.activatePreparedGroup(makeInput());

    expect(activated.ok && activated.value.kind).toBe("activated");
    expect(activateGroup).toHaveBeenCalledOnce();
    expect(activateGroup).toHaveBeenCalledWith(expect.objectContaining({
      managedRunGroupId: "managed-run-group-operation_group_prepare_a",
      registrationNonce: "group-registration-nonce_a",
      members: [
        expect.objectContaining({ externalRunRef: "external-run_member-a" }),
        expect.objectContaining({ externalRunRef: "external-run_member-b" }),
      ],
    }));
    const group = await harness.groupStore.getGroup(
      OWNER_SCOPE,
      "managed-run-group-operation_group_prepare_a",
    );
    expect(group.ok && group.value?.stateCounts).toEqual({ active: 2 });
  });

  it("records a partial acknowledgement per member without claiming group success", async () => {
    const activateGroup = vi.fn(async (command) => ok({
      managedRunGroupId: command.managedRunGroupId,
      members: [
        { managedRunId: command.members[0]!.managedRunId, outcome: "completed" as const },
        { managedRunId: command.members[1]!.managedRunId, outcome: "unknown" as const },
      ],
      activatedAtMs: NOW_MS + 10,
    }));
    const harness = makeCoordinator(activateGroup);

    const activated = await harness.coordinator.activatePreparedGroup(makeInput());

    expect(activated.ok && activated.value.kind).toBe("activation_unknown");
    const group = await harness.groupStore.getGroup(
      OWNER_SCOPE,
      "managed-run-group-operation_group_prepare_a",
    );
    expect(group.ok && group.value?.stateCounts).toEqual({ active: 1, unknown: 1 });
    const retainedDescriptor = await harness.contentStore.getActivationDescriptor({
      tenantId: "tenant_a",
      agentId: "agent_a",
      managedRunId: "managed-run-operation_group_prepare_a-1",
    }, "descriptor-operation_group_prepare_a-1");
    expect(retainedDescriptor.ok && retainedDescriptor.value).toMatchObject({
      managedRunGroup: {
        managedRunGroupId: "managed-run-group-operation_group_prepare_a",
        registrationNonce: "group-registration-nonce_a",
      },
    });
  });

  it("replays a retained partial group as one operation after restart", async () => {
    const activateGroup = vi.fn(async (command) => ok({
      managedRunGroupId: command.managedRunGroupId,
      members: [
        { managedRunId: command.members[0]!.managedRunId, outcome: "completed" as const },
        { managedRunId: command.members[1]!.managedRunId, outcome: "unknown" as const },
      ],
      activatedAtMs: NOW_MS + 10,
    }));
    const first = makeCoordinator(activateGroup);
    expect((await first.coordinator.activatePreparedGroup(makeInput())).ok).toBe(true);
    activateGroup.mockImplementation(async (command) => ok({
      managedRunGroupId: command.managedRunGroupId,
      members: command.members.map((member) => ({
        managedRunId: member.managedRunId,
        outcome: "completed" as const,
      })),
      activatedAtMs: NOW_MS + 20,
    }));

    const recovered = await first.coordinator.recoverPreparations({
      updatedBeforeMs: NOW_MS + 10,
      limit: 10,
    });

    expect(recovered).toMatchObject({
      ok: true,
      value: {
        activated: ["managed-run-group-operation_group_prepare_a"],
        unknown: [],
        failed: [],
      },
    });
    expect(activateGroup).toHaveBeenCalledTimes(2);
    const group = await first.groupStore.getGroup(
      OWNER_SCOPE,
      "managed-run-group-operation_group_prepare_a",
    );
    expect(group.ok && group.value?.stateCounts).toEqual({ active: 2 });
  });
});
