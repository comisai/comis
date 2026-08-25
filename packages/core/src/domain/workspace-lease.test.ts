// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  WorkspaceLeaseRecordSchema,
  parseWorkspaceLeaseRecord,
  type WorkspaceLeaseRecord,
} from "./workspace-lease.js";

const NOW_MS = 1_800_000_000_000;

function makeRecord(overrides: Partial<WorkspaceLeaseRecord> = {}): WorkspaceLeaseRecord {
  return {
    schemaVersion: 1,
    workspaceLeaseId: "workspace-lease_a",
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    canonicalPath: "/srv/comis-workspaces/task-a",
    filesystemIdentity: { device: 10, inode: 20, birthtimeNs: "100" },
    state: "active",
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

describe("workspace lease authority record", () => {
  it("accepts a canonical active lease with exact filesystem identity", () => {
    expect(parseWorkspaceLeaseRecord(makeRecord())).toEqual({
      ok: true,
      value: makeRecord(),
    });
  });

  it("requires release disposition and timestamp only for released leases", () => {
    expect(parseWorkspaceLeaseRecord(makeRecord({
      state: "released",
      releaseDisposition: "preserve",
      releasedAtMs: NOW_MS + 10,
      updatedAtMs: NOW_MS + 10,
    })).ok).toBe(true);
    expect(parseWorkspaceLeaseRecord(makeRecord({
      state: "released",
      updatedAtMs: NOW_MS + 10,
    })).ok).toBe(false);
    expect(parseWorkspaceLeaseRecord(makeRecord({
      releaseDisposition: "reap_safe",
      releasedAtMs: NOW_MS,
    })).ok).toBe(false);
  });

  it("rejects identity, identifier, and timestamp corruption", () => {
    expect(WorkspaceLeaseRecordSchema.safeParse(makeRecord({
      filesystemIdentity: { device: -1, inode: 20, birthtimeNs: "100" },
    })).success).toBe(false);
    expect(WorkspaceLeaseRecordSchema.safeParse(makeRecord({
      filesystemIdentity: { device: 10, inode: 20, birthtimeNs: "0" },
    })).success).toBe(false);
    expect(parseWorkspaceLeaseRecord(makeRecord({ workspaceLeaseId: "contains spaces" })).ok)
      .toBe(false);
    expect(parseWorkspaceLeaseRecord(makeRecord({ updatedAtMs: NOW_MS - 1 })).ok).toBe(false);
    expect(parseWorkspaceLeaseRecord(makeRecord({
      lastRecoveredAtMs: NOW_MS + 1,
    })).ok).toBe(false);
  });
});
