// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type {
  ManagedRunRecord,
  ManagedRunStorePort,
  WorkspaceLeasePort,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createManagedRunReleaseCoordinator } from "./managed-run-release-coordinator.js";

const RELEASED_AT_MS = 1_800_000_000_000;

function record(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    workspaceLeaseId: "workspace-lease_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    ...overrides,
  } as unknown as ManagedRunRecord;
}

function makeCoordinator(overrides: {
  readonly record?: ManagedRunRecord;
  readonly revoke?: ReturnType<typeof vi.fn>;
  readonly release?: ReturnType<typeof vi.fn>;
} = {}) {
  const durable = overrides.record ?? record();
  const get = vi.fn(async () => ok(durable));
  const revoke = overrides.revoke ?? vi.fn(async () => true);
  const release = overrides.release ?? vi.fn(async () => ok({
    kind: "released" as const,
    record: {
      workspaceLeaseId: "workspace-lease_a",
      managedRunId: "managed-run_a",
      state: "released" as const,
      releaseDisposition: "reap_safe" as const,
      releasedAtMs: RELEASED_AT_MS,
    },
  }));
  return {
    coordinator: createManagedRunReleaseCoordinator({
      store: { get } as unknown as ManagedRunStorePort,
      workspaceLeases: { release } as unknown as WorkspaceLeasePort,
      revokeBoundResources: revoke,
    }),
    get,
    revoke,
    release,
  };
}

const input = {
  operationId: "operation_release",
  serviceInstanceId: "service-instance_a",
  managedRunId: "managed-run_a",
  workspaceLeaseId: "workspace-lease_a",
  disposition: "reap_safe" as const,
  releasedAtMs: RELEASED_AT_MS,
};

describe("managed run release coordinator", () => {
  it("revokes exact bound resources before releasing the lease", async () => {
    const harness = makeCoordinator();
    const result = await harness.coordinator.release(input);

    expect(result).toEqual({
      kind: "released",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "reap_safe",
      releasedAtMs: RELEASED_AT_MS,
    });
    expect(harness.get).toHaveBeenCalledWith(
      { kind: "service", serviceInstanceId: "service-instance_a" },
      "managed-run_a",
    );
    expect(harness.revoke).toHaveBeenCalledWith(record(), "operation_release");
    expect(harness.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      harness.release.mock.invocationCallOrder[0] ?? 0,
    );
    expect(harness.release).toHaveBeenCalledWith({
      tenantId: "tenant_a",
      agentId: "agent_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
    }, {
      operationId: "operation_release",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "reap_safe",
      releasedAtMs: RELEASED_AT_MS,
    });
  });

  it("refuses mismatched authority and incomplete resource revocation", async () => {
    const mismatch = makeCoordinator({ record: record({ workspaceLeaseId: "workspace-lease_b" }) });
    await expect(mismatch.coordinator.release(input)).resolves.toEqual({
      kind: "rejected",
      reasonCode: "authority_mismatch",
    });
    expect(mismatch.revoke).not.toHaveBeenCalled();
    expect(mismatch.release).not.toHaveBeenCalled();

    const revoke = vi.fn(async () => false);
    const held = makeCoordinator({ revoke });
    await expect(held.coordinator.release(input)).resolves.toEqual({
      kind: "rejected",
      reasonCode: "resources_active",
    });
    expect(held.release).not.toHaveBeenCalled();
  });
});
