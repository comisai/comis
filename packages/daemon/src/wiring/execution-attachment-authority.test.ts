// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
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
    validateSource: vi.fn(() => ok({
      canonicalPath: "/srv/runtime/service-a/run-a.sock",
      filesystemType: "socket" as const,
      filesystemIdentity: { device: 10, inode: 20 },
    })),
    ...overrides,
  };
}

describe("execution attachment authority coordinator", () => {
  it("mints host identities after exact run lease and filesystem validation", async () => {
    const deps = makeDeps();
    const authority = createExecutionAttachmentAuthority(deps as never);
    const created = await authority.create({
      operationId: "operation_attachment_a",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
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
      sourcePath: "/srv/runtime/service-a/run-a.sock",
      owner: OWNER,
    });
    expect(result).toEqual({ ok: true, value: { kind: "rejected", reason: "authority_mismatch" } });
    expect(deps.validateSource).not.toHaveBeenCalled();
    expect(deps.attachments.create).not.toHaveBeenCalled();
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
      sourcePath: "/srv/runtime/service-a/run-a.sock",
      owner: OWNER,
    });
    expect(result).toEqual({ ok: true, value: { kind: "rejected", reason: "binding_refused" } });
    expect(deps.attachments.revoke).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      reason: "authority_revoked",
    }));
  });
});
