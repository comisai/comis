// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConversationRef,
  type ExecutionAttachmentRecord,
  type ExecutionAttachmentScope,
  type ManagedRunRecord,
  type ManagedRunServiceScope,
  type WorkspaceLeaseRecord,
} from "@comis/core";
import { createSqliteExecutionAttachmentStore } from "./execution-attachment-store.js";
import { createSqliteManagedRunStore } from "./managed-run-store.js";
import { initSchema } from "./schema.js";
import { createSqliteWorkspaceLeaseStore } from "./workspace-lease-store.js";

const NOW_MS = 1_800_000_000_000;
const RELAY_IDENTITY = "ab".repeat(32);
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
const conversationRef = createConversationRef(conversationScope);
if (!conversationRef.ok) throw conversationRef.error;

const ATTACHMENT_SCOPE: ExecutionAttachmentScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  serviceInstanceId: "service-instance_a",
  managedRunId: "managed-run_a",
  workspaceLeaseId: "workspace-lease_a",
};
const SERVICE_SCOPE: ManagedRunServiceScope = {
  kind: "service",
  serviceInstanceId: "service-instance_a",
};

function makeManagedRun(): ManagedRunRecord {
  return {
    schemaVersion: 1,
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorDigest: "b".repeat(64),
    activationDescriptorRef: "activation-descriptor_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: conversationRef.value,
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
    workspacePolicyHash: "c".repeat(64),
    rootRunId: "root-run_a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:read"],
    capturedToolIds: ["mcp:service_a.inspect"],
    capturedCapabilityViewHash: "d".repeat(64),
    workspaceLeaseId: "workspace-lease_a",
    executionAttachmentIds: ["execution-attachment_a"],
    terminalSessionIds: [],
    status: "preparing",
    statusReason: "awaiting_activation",
    lastAcceptedReportSequence: 0,
    lastReducedReportSequence: 0,
    pendingContinuation: false,
    openAttentionCount: 0,
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  };
}

function makeLease(): WorkspaceLeaseRecord {
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
  };
}

function makeAttachment(overrides: Partial<ExecutionAttachmentRecord> = {}): ExecutionAttachmentRecord {
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
    relayIdentity: RELAY_IDENTITY,
    sourceFilesystemType: "socket",
    sourceFilesystemIdentity: { device: 30, inode: 40, birthtimeNs: "200" },
    targetName: `attachment-${"a".repeat(32)}.sock`,
    access: "connect_only",
    state: "active",
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

async function seed(db: Database.Database): Promise<void> {
  expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
  expect((await createSqliteWorkspaceLeaseStore(db).create(makeLease())).ok).toBe(true);
}

describe("SQLite execution attachment persistence", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists active socket authority across a database reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "execution-attachment-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "memory.db");
    const firstDb = new Database(databasePath);
    initSchema(firstDb, 4);
    await seed(firstDb);
    const firstStore = createSqliteExecutionAttachmentStore(firstDb);
    expect(await firstStore.create(makeAttachment())).toMatchObject({
      ok: true,
      value: { kind: "created", record: { state: "active" } },
    });
    firstDb.close();

    const reopenedDb = new Database(databasePath);
    initSchema(reopenedDb, 4);
    const reopenedStore = createSqliteExecutionAttachmentStore(reopenedDb);
    expect(await reopenedStore.get(ATTACHMENT_SCOPE, "execution-attachment_a")).toEqual({
      ok: true,
      value: makeAttachment(),
    });
    expect(await reopenedStore.listActiveForRun(ATTACHMENT_SCOPE)).toEqual({ ok: true, value: [makeAttachment()] });
    expect(await reopenedStore.listRecoverable({
      kind: "recovery",
      updatedBeforeMs: NOW_MS,
      limit: 10,
    })).toEqual({
      ok: true,
      value: { records: [makeAttachment()] },
    });
    reopenedDb.close();
  });

  it("pages only attachments inside the stable recovery snapshot", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    await seed(db);
    const store = createSqliteExecutionAttachmentStore(db);
    expect((await store.create(makeAttachment())).ok).toBe(true);
    expect((await store.create(makeAttachment({
      executionAttachmentId: "execution-attachment_b",
      sourcePath: "/srv/capability-runtime/service-a/worker-b.sock",
      targetName: `attachment-${"b".repeat(32)}.sock`,
      updatedAtMs: NOW_MS + 1,
    }))).ok).toBe(true);

    const first = await store.listRecoverable({
      kind: "recovery",
      updatedBeforeMs: NOW_MS,
      limit: 1,
    });
    const exhausted = await store.listRecoverable({
      kind: "recovery",
      updatedBeforeMs: NOW_MS,
      afterExecutionAttachmentId: "execution-attachment_a",
      limit: 1,
    });

    expect(first).toMatchObject({
      ok: true,
      value: {
        records: [{ executionAttachmentId: "execution-attachment_a" }],
        nextAfterExecutionAttachmentId: "execution-attachment_a",
      },
    });
    expect(exhausted).toEqual({ ok: true, value: { records: [] } });
    db.close();
  });

  it("hides an attachment from every mismatched run and lease scope", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    await seed(db);
    const store = createSqliteExecutionAttachmentStore(db);
    expect((await store.create(makeAttachment())).ok).toBe(true);
    expect(await store.get(
      { ...ATTACHMENT_SCOPE, managedRunId: "managed-run_b" },
      "execution-attachment_a",
    )).toEqual({ ok: true, value: undefined });
    expect(await store.get(
      { ...ATTACHMENT_SCOPE, workspaceLeaseId: "workspace-lease_b" },
      "execution-attachment_a",
    )).toEqual({ ok: true, value: undefined });
    db.close();
  });

  it("rejects unauthorized creation and conflicting attachment replays", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    await seed(db);
    const store = createSqliteExecutionAttachmentStore(db);

    expect(await store.create(makeAttachment({
      state: "revoked",
      revokedAtMs: NOW_MS,
      revocationReason: "lease_release",
    }))).toMatchObject({ ok: false, error: { message: "execution attachment creation requires active state" } });
    expect(await store.create(makeAttachment({
      executionAttachmentId: "execution-attachment_unauthorized",
      managedRunId: "managed-run_missing",
    }))).toEqual({ ok: true, value: { kind: "authority_mismatch" } });

    const attachment = makeAttachment();
    expect(await store.create(attachment)).toMatchObject({ ok: true, value: { kind: "created" } });
    expect(await store.create(attachment)).toMatchObject({ ok: true, value: { kind: "identical_replay" } });
    expect(await store.create(makeAttachment({ targetName: `attachment-${"b".repeat(32)}.sock` }))).toEqual({
      ok: true,
      value: { kind: "replay_conflict" },
    });
    expect(await store.create(makeAttachment({
      executionAttachmentId: "execution-attachment_b",
      targetName: `attachment-${"c".repeat(32)}.sock`,
    }))).toEqual({ ok: true, value: { kind: "replay_conflict" } });
    db.close();
  });

  it("rejects attachment creation after durable release reservation", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    await seed(db);
    expect(await createSqliteManagedRunStore(db).reserveRelease(SERVICE_SCOPE, {
      operationId: "operation_release_reserved",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "reap_safe",
      releasedAtMs: NOW_MS + 1,
    })).toMatchObject({ ok: true, value: { kind: "reserved" } });

    expect(await createSqliteExecutionAttachmentStore(db).create(makeAttachment())).toEqual({
      ok: true,
      value: { kind: "authority_mismatch" },
    });
    db.close();
  });

  it("reports every scoped revocation conflict without broadening authority", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    await seed(db);
    const store = createSqliteExecutionAttachmentStore(db);

    expect(await store.revoke(ATTACHMENT_SCOPE, {
      operationId: "attachment-revoke_missing",
      executionAttachmentId: "execution-attachment_missing",
      reason: "lease_release",
      revokedAtMs: NOW_MS,
    })).toEqual({ ok: true, value: { kind: "not_found" } });
    expect((await store.create(makeAttachment())).ok).toBe(true);
    expect(await store.revoke({ ...ATTACHMENT_SCOPE, managedRunId: "managed-run_b" }, {
      operationId: "attachment-revoke_scope",
      executionAttachmentId: "execution-attachment_a",
      reason: "lease_release",
      revokedAtMs: NOW_MS,
    })).toEqual({ ok: true, value: { kind: "scope_mismatch" } });
    expect(await store.revoke(ATTACHMENT_SCOPE, {
      operationId: "attachment-revoke_early",
      executionAttachmentId: "execution-attachment_a",
      reason: "lease_release",
      revokedAtMs: NOW_MS - 1,
    })).toMatchObject({ ok: false, error: { message: "execution attachment revocation time cannot move backward" } });

    const revokeInput = {
      operationId: "attachment-revoke_success",
      executionAttachmentId: "execution-attachment_a",
      reason: "lease_release" as const,
      revokedAtMs: NOW_MS + 1,
    };
    expect(await store.revoke(ATTACHMENT_SCOPE, revokeInput)).toMatchObject({ ok: true, value: { kind: "revoked" } });
    expect(await store.revoke(ATTACHMENT_SCOPE, { ...revokeInput, revokedAtMs: NOW_MS + 2 })).toEqual({
      ok: true,
      value: { kind: "replay_conflict" },
    });
    expect(await store.revoke(ATTACHMENT_SCOPE, {
      ...revokeInput,
      operationId: "attachment-revoke_after_terminal_state",
    })).toEqual({ ok: true, value: { kind: "state_mismatch" } });
    db.close();
  });

  it("recovers exact attachment identity idempotently and rejects stale recovery", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    await seed(db);
    const store = createSqliteExecutionAttachmentStore(db);
    const reconcileInput = {
      operationId: "attachment-reconcile_success",
      executionAttachmentId: "execution-attachment_a",
      sourceFilesystemIdentity: { device: 30, inode: 40, birthtimeNs: "200" },
      recoveredAtMs: NOW_MS + 1,
    };

    expect(await store.reconcile(ATTACHMENT_SCOPE, reconcileInput)).toEqual({ ok: true, value: { kind: "not_found" } });
    expect((await store.create(makeAttachment())).ok).toBe(true);
    expect(await store.reconcile({ ...ATTACHMENT_SCOPE, workspaceLeaseId: "workspace-lease_b" }, reconcileInput)).toEqual({
      ok: true,
      value: { kind: "scope_mismatch" },
    });
    expect(await store.reconcile(ATTACHMENT_SCOPE, { ...reconcileInput, recoveredAtMs: NOW_MS - 1 })).toMatchObject({
      ok: false,
      error: { message: "execution attachment recovery time cannot move backward" },
    });
    expect(await store.reconcile(ATTACHMENT_SCOPE, reconcileInput)).toMatchObject({
      ok: true,
      value: { kind: "recovered", record: { lastRecoveredAtMs: NOW_MS + 1 } },
    });
    expect(await store.reconcile(ATTACHMENT_SCOPE, reconcileInput)).toMatchObject({
      ok: true,
      value: { kind: "identical_replay" },
    });
    expect(await store.reconcile(ATTACHMENT_SCOPE, { ...reconcileInput, recoveredAtMs: NOW_MS + 2 })).toEqual({
      ok: true,
      value: { kind: "replay_conflict" },
    });
    expect(await store.revoke(ATTACHMENT_SCOPE, {
      operationId: "attachment-revoke_after_recovery",
      executionAttachmentId: "execution-attachment_a",
      reason: "lease_release",
      revokedAtMs: NOW_MS + 2,
    })).toMatchObject({ ok: true, value: { kind: "revoked" } });
    expect(await store.reconcile(ATTACHMENT_SCOPE, {
      ...reconcileInput,
      operationId: "attachment-reconcile_after_terminal_state",
      recoveredAtMs: NOW_MS + 3,
    })).toEqual({ ok: true, value: { kind: "state_mismatch" } });
    db.close();
  });

  it("rejects invalid recovery scan limits at the persistence boundary", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    const store = createSqliteExecutionAttachmentStore(db);
    expect(await store.listRecoverable({
      kind: "recovery",
      updatedBeforeMs: NOW_MS,
      limit: 0,
    })).toMatchObject({
      ok: false,
      error: { message: "execution attachment recovery scan limit is invalid" },
    });
    db.close();
  });

  it("fails closed for malformed rows and a closed database boundary", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    await seed(db);
    const store = createSqliteExecutionAttachmentStore(db);
    expect((await store.create(makeAttachment())).ok).toBe(true);

    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE execution_attachments SET schema_version = 2").run();
    expect(await store.get(ATTACHMENT_SCOPE, "execution-attachment_a")).toMatchObject({
      ok: false,
      error: { message: "Row validation failed at schema_version" },
    });
    expect(await store.listActiveForRun(ATTACHMENT_SCOPE)).toMatchObject({
      ok: false,
      error: { message: "Row validation failed at row[0].schema_version" },
    });

    db.close();
    expect((await store.get(ATTACHMENT_SCOPE, "execution-attachment_a")).ok).toBe(false);
  });

  it("rotates revalidated filesystem identity and revokes idempotently before release", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    await seed(db);
    const store = createSqliteExecutionAttachmentStore(db);
    expect((await store.create(makeAttachment())).ok).toBe(true);
    expect(await store.reconcile(ATTACHMENT_SCOPE, {
      operationId: "attachment-reconcile_a",
      executionAttachmentId: "execution-attachment_a",
      sourceFilesystemIdentity: { device: 30, inode: 41, birthtimeNs: "201" },
      recoveredAtMs: NOW_MS + 1,
    })).toMatchObject({
      ok: true,
      value: {
        kind: "recovered",
        record: {
          sourceFilesystemIdentity: { device: 30, inode: 41, birthtimeNs: "201" },
          lastRecoveredAtMs: NOW_MS + 1,
        },
      },
    });
    expect(await store.revoke(ATTACHMENT_SCOPE, {
      operationId: "attachment-revoke_a",
      executionAttachmentId: "execution-attachment_a",
      reason: "lease_release",
      revokedAtMs: NOW_MS + 2,
    })).toMatchObject({ ok: true, value: { kind: "revoked" } });
    expect(await store.revoke(ATTACHMENT_SCOPE, {
      operationId: "attachment-revoke_a",
      executionAttachmentId: "execution-attachment_a",
      reason: "lease_release",
      revokedAtMs: NOW_MS + 2,
    })).toMatchObject({ ok: true, value: { kind: "identical_replay" } });
    expect(await store.listActiveForRun(ATTACHMENT_SCOPE)).toEqual({ ok: true, value: [] });
    db.close();
  });
});
