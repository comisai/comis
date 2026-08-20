// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type CapabilityServiceControlPort,
  type ComisLogger,
  type ManagedRunRecord,
} from "@comis/core";
import {
  createSqliteExecutionAttachmentStore,
  createSqliteManagedRunContentStore,
  createSqliteManagedRunStore,
  createSqliteWorkspaceLeaseStore,
  initSchema,
} from "@comis/memory";
import { ok } from "@comis/shared";
import { createManagedRunActivationCoordinator } from "./managed-run-activation-coordinator.js";
import type { ActiveCapabilityServiceView } from "./capability-service-runtime.js";
import { validateWorkspaceLeasePath } from "./workspace-lease-path-validator.js";

const NOW_MS = 1_800_000_000_000;
const conversationScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: {
    kind: "endpoint-conversation-principal" as const,
    endpoint: {
      channelType: "telegram",
      channelInstanceId: "channel-instance_a",
      conversationId: "conversation_a",
      conversationKind: "direct" as const,
    },
    principalId: "principal_a",
  },
};
const conversationReference = createConversationRef(conversationScope);
if (!conversationReference.ok) throw conversationReference.error;

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

function makeRecord(
  managedRunId: string,
  serviceInstanceId: string,
  descriptorRef: string,
  overrides: Partial<ManagedRunRecord> = {},
  requestedWorkspaceRoot?: string,
): ManagedRunRecord {
  const suffix = managedRunId.replace("managed-run_", "");
  const externalRunRef = `external-run_${suffix}`;
  const expiresAtMs = suffix === "expired" ? NOW_MS - 1 : NOW_MS + 60_000;
  const prepared = {
    externalRunRef,
    registrationNonce: `registration-nonce_${suffix}`,
    expiresAtMs,
    ...(requestedWorkspaceRoot === undefined
      ? {}
      : { requestedWorkspace: { rootHint: requestedWorkspaceRoot } }),
    state: "prepared" as const,
  };
  return {
    schemaVersion: 1,
    managedRunId,
    serviceInstanceId,
    externalRunRefDigest: createHash("sha256").update(externalRunRef).digest("hex"),
    activationDescriptorDigest: createHash("sha256").update(JSON.stringify(prepared)).digest("hex"),
    activationDescriptorRef: descriptorRef,
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: conversationReference.value,
    turnScope: {
      conversation: conversationScope,
      principal: { principalId: "principal_a" },
      endpoint: conversationScope.partition.endpoint,
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
    capturedToolIds: ["mcp:service_a.inspect"],
    capturedCapabilityViewHash: "c".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "preparing",
    statusReason: "awaiting_activation",
    lastAcceptedReportSequence: 0,
    lastReducedReportSequence: 0,
    pendingContinuation: false,
    openAttentionCount: 0,
    createdAtMs: NOW_MS - 10_000,
    updatedAtMs: NOW_MS - 10_000,
    ...overrides,
  };
}

function makeActiveView(allowedWorkspaceRoots: readonly string[] = []): ActiveCapabilityServiceView {
  return Object.freeze({
    schemaVersion: 1,
    revision: 1,
    publishedAtMs: NOW_MS,
    viewHash: "c".repeat(64),
    definitions: Object.freeze([Object.freeze({
      contributionId: "example.service",
      serviceDefinitionId: "example.service-definition",
      mcpServerName: "example-service",
      managedToolBindings: Object.freeze([]),
      requestedScopes: Object.freeze(["health", "workspace_lease"] as const),
      evidencePolicies: Object.freeze([]),
    })]),
    instances: Object.freeze([Object.freeze({
      contributionId: "example.service",
      serviceDefinitionId: "example.service-definition",
      serviceInstanceId: "service-instance_a",
      mcpServerName: "example-service",
      allowedAgents: Object.freeze(["agent_a"]),
      allowedWorkspaceRoots: Object.freeze([...allowedWorkspaceRoots]),
      allowedRuntimeRoots: Object.freeze([]),
      state: "active" as const,
      activeScopes: Object.freeze(["health", "workspace_lease"] as const),
    })]),
  });
}

function controlIds(managedRunId: string) {
  return {
    activationOperationId: `activate-${managedRunId}`,
    abandonOperationId: `abandon-${managedRunId}`,
    workspaceLeaseId: `workspace-${managedRunId}`,
    attachmentOperationId: `attachment-${managedRunId}`,
    leaseReleaseOperationId: `lease-release-${managedRunId}`,
    leaseRecoveryOperationId: `lease-recover-${managedRunId}`,
    rejectionOperationId: `reject-${managedRunId}`,
    joinMissingOperationId: `join-missing-${managedRunId}`,
    outcomeUnknownOperationId: `outcome-unknown-${managedRunId}`,
    unavailableOperationId: `unavailable-${managedRunId}`,
  };
}

describe("managed-run activation restart recovery", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("defers grouped members to the group recovery coordinator", async () => {
    const grouped = makeRecord("managed-run_grouped", "service-instance_a", "descriptor_grouped", {
      managedRunGroupId: "managed-run-group_a",
    });
    const activate = vi.fn();
    const coordinator = createManagedRunActivationCoordinator({
      store: {
        listRecoverable: vi.fn(async () => ok({ records: [grouped], invalid: [] })),
      } as unknown as ReturnType<typeof createSqliteManagedRunStore>,
      contentStore: {} as never,
      workspaceLeases: {} as never,
      attachments: {} as never,
      attachmentAuthority: { create: vi.fn() },
      revokeManagedTerminals: async () => ok(undefined),
      control: { activate } as unknown as CapabilityServiceControlPort,
      activeView: { getActiveView: () => makeActiveView() },
      validateWorkspacePath: () => { throw new Error("workspace validation was not expected"); },
      ids: {
        forOperation: (operationId) => ({
          managedRunId: `managed-${operationId}`,
          activationDescriptorRef: `descriptor-${operationId}`,
        }),
        forManagedRun: controlIds,
      },
      nowMs: () => NOW_MS,
      eventBus: new TypedEventBus(),
      logger: makeLogger(),
    });

    const recovered = await coordinator.recoverPreparations({ updatedBeforeMs: NOW_MS, limit: 10 });

    expect(recovered).toMatchObject({
      ok: true,
      value: {
        activated: [],
        cancelled: [],
        unknown: [],
        deferredGroupIds: ["managed-run-group_a"],
        failed: [],
      },
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it("reconciles independent preparation outcomes after database reopen", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-run-recovery-")));
    temporaryDirectories.push(root);
    chmodSync(root, 0o700);
    const contentDirectory = join(root, "private-content");
    const dataDirectory = join(root, "comis-data");
    const workspaceRoot = join(root, "workspaces");
    const workspaceDirectory = join(workspaceRoot, "task-valid");
    mkdirSync(contentDirectory, { mode: 0o700 });
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
    const databasePath = join(root, "managed-runs.db");

    const firstDb = new Database(databasePath);
    initSchema(firstDb, 4);
    const firstStore = createSqliteManagedRunStore(firstDb);
    const firstContentResult = createSqliteManagedRunContentStore(firstDb, {
      directoryPath: realpathSync(contentDirectory),
      nowMs: () => NOW_MS,
    });
    if (!firstContentResult.ok) throw firstContentResult.error;
    const firstContent = firstContentResult.value;
    const records = [
      makeRecord("managed-run_expired", "service-instance_a", "descriptor_expired"),
      makeRecord("managed-run_missing", "service-instance_a", "descriptor_missing", {
        status: "unknown",
        statusReason: "activation_outcome_unknown",
      }),
      makeRecord("managed-run_unavailable", "service-instance_b", "descriptor_unavailable", {
        status: "unknown",
        statusReason: "service_state_unavailable",
      }),
      makeRecord("managed-run_valid", "service-instance_a", "descriptor_valid", {
        workspaceLeaseId: "workspace-lease_valid",
      }, workspaceDirectory),
      makeRecord("managed-run_corrupt", "service-instance_a", "descriptor_corrupt"),
    ];
    for (const record of records) expect((await firstStore.create(record)).ok).toBe(true);
    const workspaceIdentity = statSync(workspaceDirectory, { bigint: true });
    const firstWorkspaceLeases = createSqliteWorkspaceLeaseStore(firstDb);
    expect((await firstWorkspaceLeases.create({
      schemaVersion: 1,
      workspaceLeaseId: "workspace-lease_valid",
      managedRunId: "managed-run_valid",
      serviceInstanceId: "service-instance_a",
      tenantId: "tenant_a",
      agentId: "agent_a",
      canonicalPath: workspaceDirectory,
      filesystemIdentity: {
        device: Number(workspaceIdentity.dev),
        inode: Number(workspaceIdentity.ino),
        birthtimeNs: workspaceIdentity.birthtimeNs.toString(),
      },
      state: "active",
      createdAtMs: NOW_MS - 10_000,
      updatedAtMs: NOW_MS - 10_000,
    })).ok).toBe(true);
    expect((await firstContent.putActivationDescriptor({
      tenantId: "tenant_a", agentId: "agent_a", managedRunId: "managed-run_expired",
    }, "descriptor_expired", {
      schemaVersion: 1,
      externalRunRef: "external-run_expired",
      registrationNonce: "registration-nonce_expired",
      expiresAtMs: NOW_MS - 1,
    })).ok).toBe(true);
    expect((await firstContent.putActivationDescriptor({
      tenantId: "tenant_a", agentId: "agent_a", managedRunId: "managed-run_unavailable",
    }, "descriptor_unavailable", {
      schemaVersion: 1,
      externalRunRef: "external-run_unavailable",
      registrationNonce: "registration-nonce_unavailable",
      expiresAtMs: NOW_MS + 60_000,
    })).ok).toBe(true);
    expect((await firstContent.putActivationDescriptor({
      tenantId: "tenant_a", agentId: "agent_a", managedRunId: "managed-run_valid",
    }, "descriptor_valid", {
      schemaVersion: 1,
      externalRunRef: "external-run_valid",
      registrationNonce: "registration-nonce_valid",
      expiresAtMs: NOW_MS + 60_000,
      requestedWorkspace: { rootHint: workspaceDirectory },
    })).ok).toBe(true);
    firstDb.prepare("UPDATE managed_runs SET turn_scope = ? WHERE managed_run_id = ?")
      .run("{not-json", "managed-run_corrupt");
    firstDb.close();

    const reopenedDb = new Database(databasePath);
    initSchema(reopenedDb, 4);
    const store = createSqliteManagedRunStore(reopenedDb);
    const workspaceLeases = createSqliteWorkspaceLeaseStore(reopenedDb);
    const contentResult = createSqliteManagedRunContentStore(reopenedDb, {
      directoryPath: realpathSync(contentDirectory),
      nowMs: () => NOW_MS,
    });
    if (!contentResult.ok) throw contentResult.error;
    const contentStore = contentResult.value;
    const activate = vi.fn(async (command) => ok({
      managedRunId: command.managedRunId,
      externalRunRef: command.externalRunRef,
      state: "active" as const,
      activatedAtMs: NOW_MS,
    }));
    const abandon = vi.fn(async (command) => ok({
      externalRunRef: command.externalRunRef,
      state: "abandoned" as const,
      disposition: command.disposition,
      terminalTransition: "unbound_preparation_abandoned" as const,
    }));
    const control: CapabilityServiceControlPort = { activate, abandon };
    const logger = makeLogger();
    const coordinator = createManagedRunActivationCoordinator({
      store,
      contentStore,
      workspaceLeases,
      attachments: createSqliteExecutionAttachmentStore(reopenedDb),
      attachmentAuthority: { create: vi.fn() },
      revokeManagedTerminals: async () => ok(undefined),
      control,
      activeView: { getActiveView: () => makeActiveView([workspaceRoot]) },
      validateWorkspacePath: (requestedPath, allowedWorkspaceRoots) =>
        validateWorkspaceLeasePath({ requestedPath, allowedWorkspaceRoots, dataDir: dataDirectory }),
      ids: {
        forOperation: (operationId) => ({
          managedRunId: `managed-${operationId}`,
          activationDescriptorRef: `descriptor-${operationId}`,
          ...controlIds(`managed-${operationId}`),
        }),
        forManagedRun: controlIds,
      },
      nowMs: () => NOW_MS,
      eventBus: new TypedEventBus(),
      logger,
    });

    const recovered = await coordinator.recoverPreparations({
      updatedBeforeMs: NOW_MS,
      limit: 10,
    });

    expect(recovered).toMatchObject({
      ok: true,
      value: {
        activated: ["managed-run_valid"],
        cancelled: ["managed-run_expired"],
        unknown: ["managed-run_missing", "managed-run_unavailable"],
        invalid: [{
          managedRunId: "managed-run_corrupt",
          serviceInstanceId: "service-instance_a",
          reason: "record_validation_failed",
        }],
        failed: [],
      },
    });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "activate-managed-run_valid",
      managedRunId: "managed-run_valid",
      workspaceLeaseId: "workspace-lease_valid",
    }));
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "abandon-managed-run_expired",
      reason: "registration_expired",
    }));
    const validRecord = await store.get(
      { kind: "service", serviceInstanceId: "service-instance_a" },
      "managed-run_valid",
    );
    expect(validRecord).toMatchObject({ ok: true, value: { status: "active" } });
    expect(await workspaceLeases.get({
      tenantId: "tenant_a",
      agentId: "agent_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_valid",
    }, "workspace-lease_valid")).toMatchObject({
      ok: true,
      value: { state: "active", lastRecoveredAtMs: NOW_MS },
    });
    expect(validRecord.ok && validRecord.value?.activationDescriptorRef).toBeUndefined();
    expect(await store.get({ kind: "service", serviceInstanceId: "service-instance_a" }, "managed-run_expired"))
      .toMatchObject({
        ok: true,
        value: {
          status: "cancelled",
          updatedAtMs: NOW_MS,
          terminalOutcome: { kind: "cancelled", recordedAtMs: NOW_MS },
        },
      });
    expect(await store.get({ kind: "service", serviceInstanceId: "service-instance_a" }, "managed-run_missing"))
      .toMatchObject({ ok: true, value: { status: "unknown", statusReason: "recovery_join_missing" } });
    expect(await contentStore.getActivationDescriptor({
      tenantId: "tenant_a", agentId: "agent_a", managedRunId: "managed-run_valid",
    }, "descriptor_valid")).toEqual({ ok: true, value: undefined });

    const rerun = await coordinator.recoverPreparations({ updatedBeforeMs: NOW_MS, limit: 10 });
    expect(rerun.ok).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      managedRunId: "managed-run_corrupt",
      errorKind: "internal",
      hint: expect.any(String),
    }), "Corrupt managed-run recovery row was quarantined");

    const retryDescriptor = {
      externalRunRef: "external-run_retry",
      registrationNonce: "registration-nonce_retry",
      expiresAtMs: NOW_MS - 1,
    };
    const retryPrepared = { ...retryDescriptor, state: "prepared" as const };
    const retryRecord = makeRecord("managed-run_retry", "service-instance_a", "descriptor_retry", {
      activationDescriptorDigest: createHash("sha256")
        .update(JSON.stringify(retryPrepared))
        .digest("hex"),
    });
    expect((await store.create(retryRecord)).ok).toBe(true);
    expect((await contentStore.putActivationDescriptor({
      tenantId: "tenant_a", agentId: "agent_a", managedRunId: "managed-run_retry",
    }, "descriptor_retry", { schemaVersion: 1, ...retryDescriptor })).ok).toBe(true);
    const failingAbandon = vi.fn(async () => err({
      kind: "uncertain" as const,
      reasonCode: "deadline_exceeded",
    }));
    const retryCoordinator = createManagedRunActivationCoordinator({
      store,
      contentStore,
      workspaceLeases,
      attachments: createSqliteExecutionAttachmentStore(reopenedDb),
      attachmentAuthority: { create: vi.fn() },
      revokeManagedTerminals: async () => ok(undefined),
      control: { activate, abandon: failingAbandon },
      activeView: { getActiveView: () => makeActiveView([workspaceRoot]) },
      validateWorkspacePath: (requestedPath, allowedWorkspaceRoots) =>
        validateWorkspaceLeasePath({ requestedPath, allowedWorkspaceRoots, dataDir: dataDirectory }),
      ids: {
        forOperation: (operationId) => ({
          managedRunId: `managed-${operationId}`,
          activationDescriptorRef: `descriptor-${operationId}`,
          ...controlIds(`managed-${operationId}`),
        }),
        forManagedRun: controlIds,
      },
      nowMs: () => NOW_MS,
      eventBus: new TypedEventBus(),
      logger,
    });
    const retryRecovery = await retryCoordinator.recoverPreparations({ updatedBeforeMs: NOW_MS, limit: 10 });
    expect(retryRecovery).toMatchObject({
      ok: true,
      value: { failed: [{ managedRunId: "managed-run_retry", serviceInstanceId: "service-instance_a" }] },
    });
    expect(await store.get({ kind: "service", serviceInstanceId: "service-instance_a" }, "managed-run_retry"))
      .toMatchObject({ ok: true, value: { status: "preparing", activationDescriptorRef: "descriptor_retry" } });
    expect(await contentStore.getActivationDescriptorForRecovery({
      tenantId: "tenant_a", agentId: "agent_a", managedRunId: "managed-run_retry",
    }, "descriptor_retry", { kind: "recovery" })).toMatchObject({
      ok: true,
      value: { externalRunRef: "external-run_retry" },
    });

    reopenedDb.close();
  });
});
