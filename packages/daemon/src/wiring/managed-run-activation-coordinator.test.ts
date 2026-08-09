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
  type ManagedRunContentPort,
  type ManagedRunOwnerScope,
  type ManagedRunPreparedStart,
  type ManagedRunStorePort,
  type WorkspaceLeasePort,
} from "@comis/core";
import {
  createSqliteManagedRunContentStore,
  createSqliteManagedRunStore,
  createSqliteWorkspaceLeaseStore,
  initSchema,
} from "@comis/memory";
import { err, ok } from "@comis/shared";
import {
  createManagedRunActivationCoordinator,
  type ManagedRunActivationCoordinatorDeps,
  type ManagedRunActivationInput,
} from "./managed-run-activation-coordinator.js";
import type { ActiveCapabilityServiceView } from "./capability-service-runtime.js";
import { validateWorkspaceLeasePath } from "./workspace-lease-path-validator.js";

const NOW_MS = 1_800_000_000_000;
const CONVERSATION_SCOPE = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: {
    kind: "endpoint-conversation-principal" as const,
    endpoint: {
      channelType: "telegram",
      channelInstanceId: "channel-instance_a",
      conversationId: "conversation_a",
      threadId: "thread_a",
      conversationKind: "direct" as const,
    },
    principalId: "principal_a",
  },
};
const conversationReference = createConversationRef(CONVERSATION_SCOPE);
if (!conversationReference.ok) throw conversationReference.error;
const OWNER_SCOPE: ManagedRunOwnerScope = {
  kind: "owner",
  tenantId: "tenant_a",
  agentId: "agent_a",
  principalId: "principal_a",
  conversationRef: conversationReference.value,
};

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

function makeActiveView(overrides: Partial<ActiveCapabilityServiceView> = {}): ActiveCapabilityServiceView {
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
      requestedScopes: Object.freeze(["health", "report"] as const),
    })]),
    instances: Object.freeze([Object.freeze({
      contributionId: "example.service",
      serviceDefinitionId: "example.service-definition",
      serviceInstanceId: "service-instance_a",
      mcpServerName: "example-service",
      allowedAgents: Object.freeze(["agent_a"]),
      allowedWorkspaceRoots: Object.freeze([]),
      state: "active" as const,
      activeScopes: Object.freeze(["health", "report"] as const),
    })]),
    ...overrides,
  });
}

function makePrepared(overrides: Partial<ManagedRunPreparedStart> = {}): ManagedRunPreparedStart {
  return {
    state: "prepared",
    externalRunRef: "external-run_a",
    registrationNonce: "registration-nonce_a",
    expiresAtMs: NOW_MS + 60_000,
    displayLabel: "Synthetic managed run",
    ...overrides,
  };
}

function makeInput(overrides: Partial<ManagedRunActivationInput> = {}): ManagedRunActivationInput {
  return {
    operationId: "operation_prepare_a",
    serviceInstanceId: "service-instance_a",
    prepared: makePrepared(),
    authority: {
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationReference.value,
      turnScope: {
        conversation: CONVERSATION_SCOPE,
        principal: { principalId: "principal_a" },
        endpoint: CONVERSATION_SCOPE.partition.endpoint,
      },
      deliveryOrigin: {
        channelType: "telegram",
        channelId: "conversation_a",
        userId: "principal_a",
        threadId: "thread_a",
        tenantId: "tenant_a",
      },
      traceId: "10000000-0000-4000-8000-000000000001",
      trustLevel: "user",
      responseLocalePolicy: { locale: "en", source: "request", enforceLocale: true },
      workspacePolicyHash: "b".repeat(64),
      rootRunId: "root-run_a",
      initiationSource: "user_request",
      capturedAgentCapabilities: ["orch:read", "orch:web"],
      capturedToolIds: ["mcp:service_a.inspect", "web_search"],
      capturedCapabilityViewHash: "c".repeat(64),
    },
    ...overrides,
  };
}

function makeIds(operationId: string) {
  return {
    managedRunId: `managed-${operationId}`,
    activationDescriptorRef: `descriptor-${operationId}`,
    workspaceLeaseId: `workspace-${operationId}`,
    activationOperationId: `activate-${operationId}`,
    abandonOperationId: `abandon-${operationId}`,
    leaseReleaseOperationId: `lease-release-${operationId}`,
    leaseRecoveryOperationId: `lease-recover-${operationId}`,
    rejectionOperationId: `reject-${operationId}`,
    joinMissingOperationId: `join-missing-${operationId}`,
    outcomeUnknownOperationId: `outcome-unknown-${operationId}`,
    unavailableOperationId: `unavailable-${operationId}`,
  };
}

function makeControlIds(managedRunId: string) {
  const operationId = managedRunId.startsWith("managed-")
    ? managedRunId.slice("managed-".length)
    : managedRunId;
  const ids = makeIds(operationId);
  return {
    activationOperationId: ids.activationOperationId,
    abandonOperationId: ids.abandonOperationId,
    workspaceLeaseId: ids.workspaceLeaseId,
    leaseReleaseOperationId: ids.leaseReleaseOperationId,
    leaseRecoveryOperationId: ids.leaseRecoveryOperationId,
    rejectionOperationId: ids.rejectionOperationId,
    joinMissingOperationId: ids.joinMissingOperationId,
    outcomeUnknownOperationId: ids.outcomeUnknownOperationId,
    unavailableOperationId: ids.unavailableOperationId,
  };
}

describe("managed-run two-phase activation", () => {
  const temporaryDirectories: string[] = [];
  let db: Database.Database;
  let store: ManagedRunStorePort;
  let contentStore: ManagedRunContentPort;
  let workspaceLeases: WorkspaceLeasePort;
  let control: CapabilityServiceControlPort;
  let logger: ComisLogger;
  let eventBus: TypedEventBus;
  let activate: ReturnType<typeof vi.fn>;
  let abandon: ReturnType<typeof vi.fn>;
  let dataDirectory: string;
  let workspaceRoot: string;
  let workspaceDirectory: string;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4);
    store = createSqliteManagedRunStore(db);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-run-activation-")));
    temporaryDirectories.push(root);
    chmodSync(root, 0o700);
    dataDirectory = join(root, "data");
    workspaceRoot = join(root, "workspaces");
    workspaceDirectory = join(workspaceRoot, "task-a");
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
    const directory = join(dataDirectory, "private");
    mkdirSync(directory, { mode: 0o700 });
    const content = createSqliteManagedRunContentStore(db, {
      directoryPath: directory,
      nowMs: () => NOW_MS,
    });
    if (!content.ok) throw content.error;
    contentStore = content.value;
    workspaceLeases = createSqliteWorkspaceLeaseStore(db);
    activate = vi.fn(async (command) => ok({
      managedRunId: command.managedRunId,
      externalRunRef: command.externalRunRef,
      state: "active" as const,
      activatedAtMs: NOW_MS + 10,
    }));
    abandon = vi.fn(async (command) => ok({
      externalRunRef: command.externalRunRef,
      state: "abandoned" as const,
      disposition: command.disposition,
      terminalTransition: "unbound_preparation_abandoned" as const,
    }));
    control = { activate, abandon };
    logger = makeLogger();
    eventBus = new TypedEventBus();
  });

  afterEach(() => {
    db.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeCoordinator(overrides: Partial<ManagedRunActivationCoordinatorDeps> = {}) {
    return createManagedRunActivationCoordinator({
      store,
      contentStore,
      workspaceLeases,
      control,
      activeView: {
        getActiveView: () => makeActiveView({
          instances: Object.freeze([Object.freeze({
            ...makeActiveView().instances[0]!,
            allowedWorkspaceRoots: Object.freeze([workspaceRoot]),
          })]),
        }),
      },
      validateWorkspacePath: (requestedPath, allowedWorkspaceRoots) =>
        validateWorkspaceLeasePath({ requestedPath, allowedWorkspaceRoots, dataDir: dataDirectory }),
      ids: { forOperation: makeIds, forManagedRun: makeControlIds },
      nowMs: () => NOW_MS,
      eventBus,
      logger,
      ...overrides,
    });
  }

  it("durably binds exact host authority before activating external work", async () => {
    const activatedEvent = vi.fn();
    eventBus.on("managed_run:activated", activatedEvent);
    activate.mockImplementation(async (command) => {
      const durable = await store.get(
        { kind: "service", serviceInstanceId: "service-instance_a" },
        command.managedRunId,
      );
      expect(durable).toMatchObject({
        ok: true,
        value: {
          status: "preparing",
          capturedCapabilityViewHash: "c".repeat(64),
          activationDescriptorRef: "descriptor-operation_prepare_a",
        },
      });
      const body = await contentStore.getActivationDescriptor({
        tenantId: "tenant_a",
        agentId: "agent_a",
        managedRunId: command.managedRunId,
      }, "descriptor-operation_prepare_a");
      expect(body).toEqual({
        ok: true,
        value: {
          schemaVersion: 1,
          externalRunRef: "external-run_a",
          registrationNonce: "registration-nonce_a",
          expiresAtMs: NOW_MS + 60_000,
        },
      });
      return ok({
        managedRunId: command.managedRunId,
        externalRunRef: command.externalRunRef,
        state: "active" as const,
        activatedAtMs: NOW_MS + 10,
      });
    });

    const result = await makeCoordinator().activatePrepared(makeInput());

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "activated", record: { status: "active" } },
    });
    const durable = await store.get(OWNER_SCOPE, "managed-operation_prepare_a");
    expect(durable).toMatchObject({
      ok: true,
      value: {
        status: "active",
        statusReason: "activation_acknowledged",
        externalRunRefDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(durable.ok && durable.value?.activationDescriptorRef).toBeUndefined();
    expect(await contentStore.getActivationDescriptor({
      tenantId: "tenant_a",
      agentId: "agent_a",
      managedRunId: "managed-operation_prepare_a",
    }, "descriptor-operation_prepare_a")).toEqual({ ok: true, value: undefined });
    expect(activatedEvent).toHaveBeenCalledWith(expect.objectContaining({
      managedRunId: "managed-operation_prepare_a",
      serviceInstanceId: "service-instance_a",
    }));
    const persisted = JSON.stringify(db.prepare("SELECT * FROM managed_runs").all());
    expect(persisted).not.toContain("external-run_a");
    expect(persisted).not.toContain("registration-nonce_a");
  });

  it("mints and binds a requested workspace lease before atomic activation", async () => {
    activate.mockImplementation(async (command) => {
      expect(command.workspaceLeaseId).toBe("workspace-operation_prepare_workspace");
      expect(await store.get(OWNER_SCOPE, command.managedRunId)).toMatchObject({
        ok: true,
        value: { workspaceLeaseId: command.workspaceLeaseId, status: "preparing" },
      });
      expect(await workspaceLeases.get({
        tenantId: "tenant_a",
        agentId: "agent_a",
        serviceInstanceId: "service-instance_a",
        managedRunId: command.managedRunId,
      }, command.workspaceLeaseId)).toMatchObject({
        ok: true,
        value: {
          canonicalPath: workspaceDirectory,
          state: "active",
          filesystemIdentity: { device: expect.any(Number), inode: expect.any(Number) },
        },
      });
      return ok({
        managedRunId: command.managedRunId,
        externalRunRef: command.externalRunRef,
        state: "active" as const,
        activatedAtMs: NOW_MS + 10,
      });
    });

    const result = await makeCoordinator().activatePrepared(makeInput({
      operationId: "operation_prepare_workspace",
      prepared: makePrepared({ requestedWorkspace: { rootHint: workspaceDirectory } }),
    }));

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "activated",
        record: { workspaceLeaseId: "workspace-operation_prepare_workspace" },
      },
    });
  });

  it("rejects a workspace request outside instance authority before activation", async () => {
    const outside = join(dataDirectory, "forbidden-workspace");
    mkdirSync(outside);

    const result = await makeCoordinator().activatePrepared(makeInput({
      operationId: "operation_forbidden_workspace",
      prepared: makePrepared({ requestedWorkspace: { rootHint: outside } }),
    }));

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "rejected", reasonCode: "workspace_not_allowed" },
    });
    expect(activate).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "reap_safe",
    }));
  });

  it("releases a minted lease with the abandonment disposition", async () => {
    activate.mockResolvedValue(err({
      kind: "rejected" as const,
      reasonCode: "precondition_failed",
    }));

    const result = await makeCoordinator().activatePrepared(makeInput({
      operationId: "operation_rejected_workspace",
      prepared: makePrepared({ requestedWorkspace: { rootHint: workspaceDirectory } }),
    }));

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "rejected", reasonCode: "activation_rejected" },
    });
    expect(await workspaceLeases.get({
      tenantId: "tenant_a",
      agentId: "agent_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-operation_rejected_workspace",
    }, "workspace-operation_rejected_workspace")).toMatchObject({
      ok: true,
      value: { state: "released", releaseDisposition: "reap_safe" },
    });
    expect(abandon).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "reap_safe",
    }));
  });

  it("returns the durable original without repeating service activation", async () => {
    const coordinator = makeCoordinator();
    expect((await coordinator.activatePrepared(makeInput())).ok).toBe(true);
    activate.mockClear();

    const replay = await coordinator.activatePrepared(makeInput());

    expect(replay).toMatchObject({
      ok: true,
      value: { kind: "identical_replay", record: { status: "active" } },
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it("rejects an altered preparation replay after the private descriptor is deleted", async () => {
    const coordinator = makeCoordinator();
    expect((await coordinator.activatePrepared(makeInput())).ok).toBe(true);
    activate.mockClear();

    const replay = await coordinator.activatePrepared(makeInput({
      prepared: makePrepared({ registrationNonce: "registration-nonce_altered" }),
    }));

    expect(replay).toMatchObject({
      ok: true,
      value: { kind: "rejected", reasonCode: "replay_conflict" },
    });
    expect(activate).not.toHaveBeenCalled();
    expect(logger.audit).toHaveBeenCalledWith(expect.objectContaining({
      decision: "deny",
      reasonCode: "replay_conflict",
    }), "Managed-run activation rejected");
  });

  it("abandons an expired or unauthorized preparation without creating a run", async () => {
    const expired = await makeCoordinator().activatePrepared(makeInput({
      operationId: "operation_expired",
      prepared: makePrepared({ expiresAtMs: NOW_MS }),
    }));
    const unauthorized = await makeCoordinator({
      activeView: {
        getActiveView: () => makeActiveView({
          instances: Object.freeze([Object.freeze({
            ...makeActiveView().instances[0]!,
            allowedAgents: Object.freeze(["agent_b"]),
          })]),
        }),
      },
    }).activatePrepared(makeInput({ operationId: "operation_unauthorized" }));

    expect(expired).toMatchObject({ ok: true, value: { kind: "rejected", reasonCode: "preparation_expired" } });
    expect(unauthorized).toMatchObject({ ok: true, value: { kind: "rejected", reasonCode: "agent_not_allowed" } });
    expect(abandon).toHaveBeenCalledTimes(2);
    expect(await store.listScoped({ scope: OWNER_SCOPE, limit: 10 })).toEqual({ ok: true, value: [] });
  });

  it("compensates private content and abandons when durable creation fails", async () => {
    const failingStore: ManagedRunStorePort = {
      ...store,
      create: vi.fn(async () => err(new Error("synthetic database unavailable"))),
    };
    const result = await makeCoordinator({ store: failingStore }).activatePrepared(makeInput());

    expect(result).toMatchObject({ ok: false });
    expect(activate).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledWith(expect.objectContaining({
      reason: "activation_rejected",
      disposition: "reap_safe",
    }));
    expect(await contentStore.getActivationDescriptor({
      tenantId: "tenant_a",
      agentId: "agent_a",
      managedRunId: "managed-operation_prepare_a",
    }, "descriptor-operation_prepare_a")).toEqual({ ok: true, value: undefined });
  });

  it("records a definitive activation rejection as cancelled after abandon", async () => {
    activate.mockResolvedValue(err({
      kind: "rejected" as const,
      reasonCode: "precondition_failed",
    }));

    const result = await makeCoordinator().activatePrepared(makeInput());

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "rejected", reasonCode: "activation_rejected", record: { status: "cancelled" } },
    });
    expect(abandon).toHaveBeenCalledOnce();
    expect(await store.get(OWNER_SCOPE, "managed-operation_prepare_a")).toMatchObject({
      ok: true,
      value: { status: "cancelled", statusReason: "activation_rejected" },
    });
  });

  it.each(["uncertain", "unavailable"] as const)(
    "retains the private join and records durable unknown for %s activation",
    async (failureKind) => {
      activate.mockResolvedValue(err({
        kind: failureKind,
        reasonCode: failureKind === "uncertain" ? "deadline_exceeded" : "service_unavailable",
      }));

      const result = await makeCoordinator().activatePrepared(makeInput());

      expect(result).toMatchObject({
        ok: true,
        value: {
          kind: "activation_unknown",
          record: {
            status: "unknown",
            activationDescriptorRef: "descriptor-operation_prepare_a",
          },
        },
      });
      expect(abandon).not.toHaveBeenCalled();
      expect(await contentStore.getActivationDescriptor({
        tenantId: "tenant_a",
        agentId: "agent_a",
        managedRunId: "managed-operation_prepare_a",
      }, "descriptor-operation_prepare_a")).toMatchObject({
        ok: true,
        value: { externalRunRef: "external-run_a" },
      });
    },
  );

  it("records an identity-mismatched activation acknowledgement as unknown", async () => {
    activate.mockResolvedValue(ok({
      managedRunId: "forged-run",
      externalRunRef: "external-run_a",
      state: "active" as const,
      activatedAtMs: NOW_MS + 10,
    }));

    const result = await makeCoordinator().activatePrepared(makeInput());

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "activation_unknown", record: { statusReason: "activation_outcome_unknown" } },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      errorKind: "dependency",
      hint: expect.any(String),
    }), "Capability-service activation acknowledgement did not match its durable binding");
  });

  it("does not activate a replay whose durable private join is missing", async () => {
    activate.mockResolvedValueOnce(err({
      kind: "uncertain" as const,
      reasonCode: "deadline_exceeded",
    }));
    const coordinator = makeCoordinator();
    expect((await coordinator.activatePrepared(makeInput())).ok).toBe(true);
    await contentStore.deleteActivationDescriptor({
      tenantId: "tenant_a",
      agentId: "agent_a",
      managedRunId: "managed-operation_prepare_a",
    }, "descriptor-operation_prepare_a");
    activate.mockClear();

    const replay = await coordinator.activatePrepared(makeInput());

    expect(replay).toMatchObject({
      ok: true,
      value: {
        kind: "activation_unknown",
        record: { statusReason: "recovery_join_missing" },
      },
    });
    expect(activate).not.toHaveBeenCalled();
  });
});
