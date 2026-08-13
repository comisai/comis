// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type {
  ExecutionAttachmentPort,
  ManagedRunOwnerScope,
  ManagedRunStorePort,
  WorkspaceLeasePort,
} from "@comis/core";
import { createExecutionAttachmentAuthority } from "./execution-attachment-authority.js";

const OWNER: ManagedRunOwnerScope = {
  kind: "owner",
  tenantId: "tenant_a",
  agentId: "agent_a",
  principalId: "principal_a",
  conversationRef: `cv_${"a".repeat(43)}` as ManagedRunOwnerScope["conversationRef"],
};

const ATTACHMENT = {
  schemaVersion: 1 as const,
  executionAttachmentId: "execution-attachment_a",
  managedRunId: "managed-run_a",
  workspaceLeaseId: "workspace-lease_a",
  serviceInstanceId: "service-instance_a",
  tenantId: "tenant_a",
  agentId: "agent_a",
  kind: "unix_socket" as const,
  sourcePath: "/srv/runtime/service-a/run-a.sock",
  sourceFilesystemType: "socket" as const,
  sourceFilesystemIdentity: { device: 10, inode: 20, birthtimeNs: "100" },
  targetName: `attachment-${"a".repeat(32)}.sock`,
  access: "connect_only" as const,
  state: "active" as const,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const record = {
    managedRunId: "managed-run_a",
    workspaceLeaseId: "workspace-lease_a",
    serviceInstanceId: "service-instance_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    executionAttachmentIds: [],
  };
  const lease = {
    workspaceLeaseId: "workspace-lease_a",
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    state: "active",
  };
  const runs = {
    get: vi.fn(async () => ok(record)),
    bindExecutionAttachment: vi.fn(async () => ok({ kind: "bound", record })),
  } as unknown as ManagedRunStorePort;
  const leases = { get: vi.fn(async () => ok(lease)) } as unknown as WorkspaceLeasePort;
  const attachments = {
    get: vi.fn(async () => ok(undefined)),
    create: vi.fn(async (created) => ok({ kind: "created", record: created })),
    revoke: vi.fn(async () => ok({ kind: "revoked", record: {} })),
  } as unknown as ExecutionAttachmentPort;
  return {
    runs,
    leases,
    attachments,
    instances: [{
      serviceInstanceId: "service-instance_a",
      enabled: true,
      allowedAgents: ["agent_a"],
      allowedRuntimeRoots: ["/srv/runtime/service-a"],
      control: { socketPath: "/srv/comis/control.sock" },
    }],
    dataDir: "/srv/comis",
    nowMs: () => 1_800_000_000_000,
    isServiceActive: vi.fn(() => true),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), audit: vi.fn(), child: vi.fn() },
    validateSource: vi.fn(() => ok({
      canonicalPath: "/srv/runtime/service-a/run-a.sock",
      filesystemType: "socket" as const,
      filesystemIdentity: { device: 10, inode: 20, birthtimeNs: "100" },
    })),
    ...overrides,
  };
}

describe("execution attachment authority coordinator", () => {
  it("rejects an unsupported declared attachment kind before source validation", async () => {
    const deps = makeDeps();
    const authority = createExecutionAttachmentAuthority(deps as never);

    const result = await authority.create({
      operationId: "operation_attachment_descriptor",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      kind: "inherited_descriptor",
      sourcePath: "/srv/runtime/service-a/run-a.sock",
      owner: OWNER,
    } as never);

    expect(result).toEqual({
      ok: true,
      value: { kind: "rejected", reason: "unsupported_kind" },
    });
    expect(deps.validateSource).not.toHaveBeenCalled();
    expect(deps.attachments.create).not.toHaveBeenCalled();
  });

  it("mints host identities after exact run lease and filesystem validation", async () => {
    const deps = makeDeps();
    const authority = createExecutionAttachmentAuthority(deps as never);
    const created = await authority.create({
      operationId: "operation_attachment_a",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      kind: "unix_socket",
      sourcePath: "/srv/runtime/service-a/run-a.sock",
      owner: OWNER,
    });

    expect(created).toMatchObject({ ok: true, value: { kind: "created" } });
    const record = (created as Extract<typeof created, { ok: true }>).value.record;
    expect(record).toMatchObject({
      executionAttachmentId: expect.stringMatching(/^execution-attachment-/u),
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      targetName: expect.stringMatching(/^attachment-[a-f0-9]{32}\.sock$/u),
      access: "connect_only",
    });
    expect(deps.runs.bindExecutionAttachment).toHaveBeenCalledWith(OWNER, expect.objectContaining({
      executionAttachmentId: record.executionAttachmentId,
      workspaceLeaseId: "workspace-lease_a",
    }));
  });

  it("rejects a mismatched lease before touching the source path", async () => {
    const deps = makeDeps();
    const authority = createExecutionAttachmentAuthority(deps as never);
    const result = await authority.create({
      operationId: "operation_attachment_wrong_lease",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_b",
      kind: "unix_socket",
      sourcePath: "/srv/runtime/service-a/run-a.sock",
      owner: OWNER,
    });
    expect(result).toEqual({ ok: true, value: { kind: "rejected", reason: "authority_mismatch" } });
    expect(deps.validateSource).not.toHaveBeenCalled();
    expect(deps.attachments.create).not.toHaveBeenCalled();
  });

  it("revalidates a replayed attachment before returning its durable handles", async () => {
    const deps = makeDeps({
      runs: {
        ...(makeDeps().runs as unknown as object),
        get: vi.fn(async () => ok({
          managedRunId: "managed-run_a",
          workspaceLeaseId: "workspace-lease_a",
          serviceInstanceId: "service-instance_a",
          tenantId: "tenant_a",
          agentId: "agent_a",
          executionAttachmentIds: ["execution-attachment_a"],
        })),
      } as unknown as ManagedRunStorePort,
      attachments: {
        ...(makeDeps().attachments as unknown as object),
        get: vi.fn(async () => ok(ATTACHMENT)),
      } as unknown as ExecutionAttachmentPort,
      validateSource: vi.fn(() => err(new Error("socket identity changed"))),
    });
    const authority = createExecutionAttachmentAuthority(deps as never);

    const replayed = await authority.create({
      operationId: "operation_attachment_a",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      kind: "unix_socket",
      sourcePath: ATTACHMENT.sourcePath,
      owner: OWNER,
    });

    expect(replayed).toEqual({
      ok: true,
      value: { kind: "rejected", reason: "source_rejected" },
    });
  });

  it("rejects a socket replacement that reuses its device and inode", () => {
    const deps = makeDeps({
      validateSource: vi.fn(() => ok({
        canonicalPath: ATTACHMENT.sourcePath,
        filesystemType: "socket" as const,
        filesystemIdentity: { device: 10, inode: 20, birthtimeNs: "101" },
      })),
    });
    const authority = createExecutionAttachmentAuthority(deps as never);

    expect(authority.validateActive(ATTACHMENT)).toMatchObject({
      ok: false,
      error: { message: "execution attachment filesystem identity changed" },
    });
  });

  it("revokes a created attachment if durable run binding is refused", async () => {
    const deps = makeDeps({
      runs: {
        ...(makeDeps().runs as unknown as object),
        get: vi.fn(async () => ok({
          managedRunId: "managed-run_a",
          workspaceLeaseId: "workspace-lease_a",
          serviceInstanceId: "service-instance_a",
          tenantId: "tenant_a",
          agentId: "agent_a",
          executionAttachmentIds: [],
        })),
        bindExecutionAttachment: vi.fn(async () => ok({ kind: "ownership_mismatch" as const })),
      } as unknown as ManagedRunStorePort,
    });
    const authority = createExecutionAttachmentAuthority(deps as never);
    const result = await authority.create({
      operationId: "operation_attachment_bind_refused",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      kind: "unix_socket",
      sourcePath: "/srv/runtime/service-a/run-a.sock",
      owner: OWNER,
    });
    expect(result).toEqual({ ok: true, value: { kind: "rejected", reason: "binding_refused" } });
    expect(deps.attachments.revoke).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      reason: "authority_revoked",
    }));
  });

  it("revokes a created attachment if the durable run binding store fails", async () => {
    const deps = makeDeps({
      runs: {
        ...(makeDeps().runs as unknown as object),
        bindExecutionAttachment: vi.fn(async () => err(new Error("binding store unavailable"))),
      } as unknown as ManagedRunStorePort,
    });
    const authority = createExecutionAttachmentAuthority(deps as never);
    const result = await authority.create({
      operationId: "operation_attachment_bind_failure",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      kind: "unix_socket",
      sourcePath: "/srv/runtime/service-a/run-a.sock",
      owner: OWNER,
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ message: "binding store unavailable" }) });
    expect(deps.attachments.revoke).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      reason: "authority_revoked",
    }));
  });

  it("preserves restart attachments while their service is not active", async () => {
    const deps = makeDeps({
      isServiceActive: vi.fn(() => false),
      attachments: {
        listRecoverable: vi.fn(async () => ok([ATTACHMENT])),
        reconcile: vi.fn(),
      } as unknown as ExecutionAttachmentPort,
    });
    const authority = createExecutionAttachmentAuthority(deps as never);

    await expect(authority.reconcileAll({ limit: 10 })).resolves.toEqual({
      ok: true,
      value: { recovered: [], preserved: ["execution-attachment_a"] },
    });
    expect(deps.attachments.reconcile).not.toHaveBeenCalled();
  });

  it("preserves restart attachments whose exact run authority is missing", async () => {
    const deps = makeDeps({
      isServiceActive: vi.fn(() => true),
      runs: {
        get: vi.fn(async () => ok(undefined)),
      } as unknown as ManagedRunStorePort,
      attachments: {
        listRecoverable: vi.fn(async () => ok([ATTACHMENT])),
        reconcile: vi.fn(),
      } as unknown as ExecutionAttachmentPort,
    });
    const authority = createExecutionAttachmentAuthority(deps as never);

    await expect(authority.reconcileAll({ limit: 10 })).resolves.toEqual({
      ok: true,
      value: { recovered: [], preserved: ["execution-attachment_a"] },
    });
    expect(deps.attachments.reconcile).not.toHaveBeenCalled();
  });

  it("reauthorizes a rematerialized socket for the exact active run and lease", async () => {
    const rematerialized = {
      ...ATTACHMENT,
      sourceFilesystemIdentity: { device: 10, inode: 21, birthtimeNs: "101" },
      updatedAtMs: 1_800_000_000_100,
      lastRecoveredAtMs: 1_800_000_000_100,
    };
    const deps = makeDeps({
      nowMs: () => 1_800_000_000_100,
      runs: {
        get: vi.fn(async () => ok({
          managedRunId: ATTACHMENT.managedRunId,
          workspaceLeaseId: ATTACHMENT.workspaceLeaseId,
          serviceInstanceId: ATTACHMENT.serviceInstanceId,
          tenantId: ATTACHMENT.tenantId,
          agentId: ATTACHMENT.agentId,
          executionAttachmentIds: [ATTACHMENT.executionAttachmentId],
        })),
      } as unknown as ManagedRunStorePort,
      attachments: {
        listRecoverable: vi.fn(async () => ok([ATTACHMENT])),
        reconcile: vi.fn(async () => ok({ kind: "recovered" as const, record: rematerialized })),
      } as unknown as ExecutionAttachmentPort,
      validateSource: vi.fn(() => ok({
        canonicalPath: ATTACHMENT.sourcePath,
        filesystemType: "socket" as const,
        filesystemIdentity: rematerialized.sourceFilesystemIdentity,
      })),
    });
    const authority = createExecutionAttachmentAuthority(deps as never);

    await expect(authority.reconcileAll({ limit: 10 })).resolves.toEqual({
      ok: true,
      value: { recovered: [ATTACHMENT.executionAttachmentId], preserved: [] },
    });
    expect(deps.attachments.reconcile).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      executionAttachmentId: ATTACHMENT.executionAttachmentId,
      sourceFilesystemIdentity: rematerialized.sourceFilesystemIdentity,
    }));
  });
});
