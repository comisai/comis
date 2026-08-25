// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ManagedRunRecord, ManagedRunStorePort, WorkspaceLeasePort } from "@comis/core";
import { ok } from "@comis/shared";
import { ensurePreparedWorkspaceLease } from "./managed-run-activation-bindings.js";

describe("managed-run activation authority bindings", () => {
  it("rejoins an identical active lease left durable before its run binding", async () => {
    const record = {
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: `cv_${"a".repeat(43)}`,
      updatedAtMs: 1_800_000_000_000,
    } as unknown as ManagedRunRecord;
    const filesystemIdentity = { device: 10, inode: 20, birthtimeNs: "100" };
    const existing = {
      schemaVersion: 1 as const,
      workspaceLeaseId: "workspace-lease_a",
      managedRunId: record.managedRunId,
      serviceInstanceId: record.serviceInstanceId,
      tenantId: record.tenantId,
      agentId: record.agentId,
      canonicalPath: "/srv/workspaces/task-a",
      filesystemIdentity,
      state: "active" as const,
      createdAtMs: 1_799_999_999_000,
      updatedAtMs: 1_799_999_999_000,
    };
    const setWorkspaceLease = vi.fn(async (_scope, input) => ok({
      kind: "bound" as const,
      record: { ...record, workspaceLeaseId: input.workspaceLeaseId },
    }));
    const workspaceLeases = {
      create: vi.fn(async () => ok({ kind: "replay_conflict" as const })),
      get: vi.fn(async () => ok(existing)),
    } as unknown as WorkspaceLeasePort;

    const result = await ensurePreparedWorkspaceLease({
      store: { setWorkspaceLease } as unknown as ManagedRunStorePort,
      workspaceLeases,
      attachmentAuthority: {} as never,
      activeView: {} as never,
      validateWorkspacePath: vi.fn() as never,
      nowMs: () => 1_800_000_001_000,
    }, {
      serviceInstanceId: record.serviceInstanceId,
      prepared: {
        state: "prepared",
        externalRunRef: "external-run_a",
        registrationNonce: "registration-nonce_a",
        expiresAtMs: 1_800_000_060_000,
        requestedWorkspace: { rootHint: existing.canonicalPath },
      },
      authority: {
        tenantId: record.tenantId,
        agentId: record.agentId,
        principalId: record.principalId,
        conversationRef: record.conversationRef,
      },
    }, {
      workspaceLeaseId: existing.workspaceLeaseId,
      attachmentOperationId: "attachment-operation_a",
      leaseReleaseOperationId: "lease-release-operation_a",
      leaseRecoveryOperationId: "lease-recovery-operation_a",
    }, record, {
      canonicalPath: existing.canonicalPath,
      filesystemIdentity,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { workspaceLeaseId: existing.workspaceLeaseId },
    });
    expect(setWorkspaceLease).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      workspaceLeaseId: existing.workspaceLeaseId,
    }));
  });
});
