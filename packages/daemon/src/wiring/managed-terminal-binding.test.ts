// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@comis/shared";
import type { ComisLogger, ManagedRunStorePort, WorkspaceLeasePort } from "@comis/core";

import { createManagedTerminalBindingResolver } from "./managed-terminal-binding.js";

const OWNER = { agentId: "agent_a", sessionKey: "session_a" };
const SCOPE = {
  kind: "owner" as const,
  tenantId: "tenant_a",
  agentId: "agent_a",
  principalId: "principal_a",
  conversationRef: "cv_owner" as never,
};

describe("managed terminal binding authority", () => {
  it("records correlatable handle digests when a managed run cannot be resolved", async () => {
    const logger = { warn: vi.fn() } as unknown as ComisLogger;
    const resolver = createManagedTerminalBindingResolver({
      store: { get: vi.fn(async () => ok(undefined)) } as unknown as ManagedRunStorePort,
      workspaceLeases: { get: vi.fn() } as unknown as WorkspaceLeasePort,
      nowMs: () => 1700,
      logger,
      resolveOwnerScope: () => SCOPE,
    });

    await expect(resolver.resolve({
      managedRunId: "managed-run_missing",
      workspaceLeaseId: "workspace-lease_missing",
      owner: OWNER,
    })).resolves.toEqual({ kind: "rejected", reason: "managed_run_not_found" });
    expect(logger.warn).toHaveBeenCalledWith({
      requestedManagedRunDigest: createHash("sha256").update("managed-run_missing", "utf8").digest("hex"),
      requestedWorkspaceLeaseDigest: createHash("sha256").update("workspace-lease_missing", "utf8").digest("hex"),
      tenantId: "tenant_a",
      agentId: "agent_a",
      conversationRef: "cv_owner",
      hint: "Compare these requested launch handles with the current capability-service launch plan before retrying the terminal create",
      errorKind: "precondition",
    }, "Managed terminal binding could not resolve the requested managed run");
  });

  it("resolves the exact run and active lease then binds the terminal in the same owner scope", async () => {
    const record = {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
      tenantId: "tenant_a",
      agentId: "agent_a",
      executionAttachmentIds: [],
    };
    const store = {
      get: vi.fn(async () => ok(record)),
      bindTerminal: vi.fn(async () => ok({ kind: "bound", record })),
    } as unknown as ManagedRunStorePort;
    const workspaceLeases = {
      get: vi.fn(async () => ok({
        workspaceLeaseId: "workspace-lease_a",
        managedRunId: "managed-run_a",
        serviceInstanceId: "service-instance_a",
        tenantId: "tenant_a",
        agentId: "agent_a",
        canonicalPath: "/srv/comis/workspaces/run-a",
        state: "active",
      })),
    } as unknown as WorkspaceLeasePort;
    const resolver = createManagedTerminalBindingResolver({
      store,
      workspaceLeases,
      nowMs: () => 1700,
      validateLease: () => ok(undefined),
      resolveOwnerScope: () => SCOPE,
    });

    await expect(resolver.resolve({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      owner: OWNER,
    })).resolves.toEqual({
      kind: "resolved",
      binding: {
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        serviceInstanceId: "service-instance_a",
        canonicalRoot: "/srv/comis/workspaces/run-a",
      },
      executionAttachments: [],
    });

    await expect(resolver.bind({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
      terminalSessionId: "terminal-session_a",
      rootProcessIdentity: { pid: 6200, startIdentity: "linux:991" },
      owner: OWNER,
    })).resolves.toEqual({ kind: "bound" });
    expect(store.bindTerminal).toHaveBeenCalledWith(SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal-session_a",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1700,
    });
  });

  it("rejects a lease that is not the run's exact active lease", async () => {
    const store = {
      get: vi.fn(async () => ok({
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_other",
        serviceInstanceId: "service-instance_a",
        tenantId: "tenant_a",
        agentId: "agent_a",
      })),
    } as unknown as ManagedRunStorePort;
    const workspaceLeases = { get: vi.fn() } as unknown as WorkspaceLeasePort;
    const resolver = createManagedTerminalBindingResolver({
      store,
      workspaceLeases,
      nowMs: () => 1700,
      resolveOwnerScope: () => SCOPE,
    });

    await expect(resolver.resolve({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      owner: OWNER,
    })).resolves.toEqual({ kind: "rejected", reason: "workspace_lease_mismatch" });
    expect(workspaceLeases.get).not.toHaveBeenCalled();
  });

  it("rejects a stored lease root replaced by either a directory or a symlink before terminal binding", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "managed-terminal-lease-")));
    const workspace = join(scratch, "workspace");
    const sibling = join(scratch, "sibling");
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(sibling, { mode: 0o700 });
    const original = lstatSync(workspace);
    const record = {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
      tenantId: "tenant_a",
      agentId: "agent_a",
      executionAttachmentIds: [],
    };
    const store = { get: vi.fn(async () => ok(record)) } as unknown as ManagedRunStorePort;

    try {
      for (const replacement of ["directory", "symlink"] as const) {
        rmSync(workspace, { recursive: true });
        if (replacement === "directory") mkdirSync(workspace, { mode: 0o700 });
        else symlinkSync(sibling, workspace);
        const workspaceLeases = {
          get: vi.fn(async () => ok({
            schemaVersion: 1,
            workspaceLeaseId: "workspace-lease_a",
            managedRunId: "managed-run_a",
            serviceInstanceId: "service-instance_a",
            tenantId: "tenant_a",
            agentId: "agent_a",
            canonicalPath: workspace,
            filesystemIdentity: { device: original.dev, inode: original.ino },
            state: "active",
            createdAtMs: 1,
            updatedAtMs: 1,
          })),
        } as unknown as WorkspaceLeasePort;
        const resolver = createManagedTerminalBindingResolver({
          store,
          workspaceLeases,
          nowMs: () => 1700,
          resolveOwnerScope: () => SCOPE,
        });

        await expect(resolver.resolve({
          managedRunId: "managed-run_a",
          workspaceLeaseId: "workspace-lease_a",
          owner: OWNER,
        }), replacement).resolves.toEqual({ kind: "rejected", reason: "workspace_lease_stale" });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
