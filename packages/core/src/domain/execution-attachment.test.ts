// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ExecutionAttachmentRecordSchema,
  parseExecutionAttachmentRecord,
  type ExecutionAttachmentRecord,
} from "./execution-attachment.js";

const NOW_MS = 1_800_000_000_000;

function makeRecord(overrides: Partial<ExecutionAttachmentRecord> = {}): ExecutionAttachmentRecord {
  return {
    schemaVersion: 1,
    executionAttachmentId: "execution-attachment_a",
    managedRunId: "managed-run_a",
    workspaceLeaseId: "workspace-lease_a",
    serviceInstanceId: "service-instance_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    kind: "unix_socket",
    sourcePath: "/srv/capability-runtime/service-a/worker.sock",
    sourceFilesystemType: "socket",
    sourceFilesystemIdentity: { device: 10, inode: 20 },
    targetName: `attachment-${"a".repeat(32)}.sock`,
    access: "connect_only",
    state: "active",
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

describe("ExecutionAttachmentRecord authority validation", () => {
  it("accepts one active Unix socket with immutable run and lease scope", () => {
    expect(parseExecutionAttachmentRecord(makeRecord())).toEqual({ ok: true, value: makeRecord() });
  });

  it("rejects noncanonical paths and caller-selected target names", () => {
    expect(parseExecutionAttachmentRecord(makeRecord({ sourcePath: "relative/worker.sock" })).ok).toBe(false);
    expect(parseExecutionAttachmentRecord(makeRecord({ sourcePath: "/srv/runtime/../worker.sock" })).ok).toBe(false);
    expect(parseExecutionAttachmentRecord(makeRecord({ targetName: "control.sock" })).ok).toBe(false);
  });

  it("rejects records that claim broader than connect-only socket access", () => {
    expect(ExecutionAttachmentRecordSchema.safeParse({ ...makeRecord(), sourceFilesystemType: "directory" }).success).toBe(false);
    expect(ExecutionAttachmentRecordSchema.safeParse({ ...makeRecord(), access: "read_write" }).success).toBe(false);
  });

  it("requires complete and monotonic revocation state", () => {
    expect(parseExecutionAttachmentRecord(makeRecord({ state: "revoked" })).ok).toBe(false);
    expect(parseExecutionAttachmentRecord(makeRecord({
      state: "revoked",
      revokedAtMs: NOW_MS + 10,
      revocationReason: "lease_release",
      updatedAtMs: NOW_MS + 10,
    })).ok).toBe(true);
    expect(parseExecutionAttachmentRecord(makeRecord({
      state: "active",
      revokedAtMs: NOW_MS,
      revocationReason: "authority_revoked",
    })).ok).toBe(false);
    expect(parseExecutionAttachmentRecord(makeRecord({ updatedAtMs: NOW_MS - 1 })).ok).toBe(false);
  });
});
