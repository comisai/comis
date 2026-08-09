// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ManagedRunRecord,
  WorkspaceLeaseRecord,
  WorkspaceLeaseScope,
} from "@comis/core";
import { createConversationRef } from "@comis/core";
import { createSqliteManagedRunStore } from "./managed-run-store.js";
import { initSchema } from "./schema.js";
import { createSqliteWorkspaceLeaseStore } from "./workspace-lease-store.js";

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
const conversationRef = createConversationRef(conversationScope);
if (!conversationRef.ok) throw conversationRef.error;

const LEASE_SCOPE: WorkspaceLeaseScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  serviceInstanceId: "service-instance_a",
  managedRunId: "managed-run_a",
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
    executionAttachmentIds: [],
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

function makeLease(overrides: Partial<WorkspaceLeaseRecord> = {}): WorkspaceLeaseRecord {
  return {
    schemaVersion: 1,
    workspaceLeaseId: "workspace-lease_a",
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    canonicalPath: "/srv/comis-workspaces/task-a",
    filesystemIdentity: { device: 10, inode: 20 },
    state: "active",
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

describe("SQLite workspace lease persistence", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists active lease identity across a database reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "workspace-lease-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "memory.db");
    const firstDb = new Database(databasePath);
    initSchema(firstDb, 4);
    expect((await createSqliteManagedRunStore(firstDb).create(makeManagedRun())).ok).toBe(true);
    const firstStore = createSqliteWorkspaceLeaseStore(firstDb);

    expect(await firstStore.create(makeLease())).toMatchObject({
      ok: true,
      value: { kind: "created", record: { state: "active" } },
    });
    firstDb.close();

    const reopenedDb = new Database(databasePath);
    initSchema(reopenedDb, 4);
    const reopenedStore = createSqliteWorkspaceLeaseStore(reopenedDb);
    expect(await reopenedStore.get(LEASE_SCOPE, "workspace-lease_a")).toEqual({
      ok: true,
      value: makeLease(),
    });
    expect(await reopenedStore.listRecoverable({ kind: "recovery", limit: 10 })).toEqual({
      ok: true,
      value: [makeLease()],
    });
    reopenedDb.close();
  });

  it("releases a lease with closed cleanup disposition idempotently", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);
    expect((await store.create(makeLease())).ok).toBe(true);
    const release = {
      operationId: "release_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "preserve" as const,
      releasedAtMs: NOW_MS + 10,
    };

    expect(await store.release(LEASE_SCOPE, release)).toMatchObject({
      ok: true,
      value: { kind: "released", record: { state: "released", releaseDisposition: "preserve" } },
    });
    expect(await store.release(LEASE_SCOPE, release)).toMatchObject({
      ok: true,
      value: { kind: "identical_replay" },
    });
    expect(await store.release(LEASE_SCOPE, { ...release, disposition: "reap_safe" })).toEqual({
      ok: true,
      value: { kind: "replay_conflict" },
    });
    expect(await store.listRecoverable({ kind: "recovery", limit: 10 })).toEqual({
      ok: true,
      value: [],
    });
    db.close();
  });

  it("records restart recovery only when filesystem identity still matches", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);
    expect((await store.create(makeLease())).ok).toBe(true);
    const recovered = {
      operationId: "recover_a",
      workspaceLeaseId: "workspace-lease_a",
      filesystemIdentity: { device: 10, inode: 20 },
      recoveredAtMs: NOW_MS + 20,
    };

    expect(await store.reconcile(LEASE_SCOPE, recovered)).toMatchObject({
      ok: true,
      value: { kind: "recovered", record: { lastRecoveredAtMs: NOW_MS + 20 } },
    });
    expect(await store.reconcile(LEASE_SCOPE, recovered)).toMatchObject({
      ok: true,
      value: { kind: "identical_replay" },
    });
    expect(await store.reconcile(LEASE_SCOPE, {
      ...recovered,
      operationId: "recover_changed",
      filesystemIdentity: { device: 10, inode: 21 },
    })).toEqual({ ok: true, value: { kind: "identity_mismatch" } });
    db.close();
  });

  it("rejects invalid creation and conflicting lease replays", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);

    await expect(store.create(makeLease({ canonicalPath: "" }))).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("canonicalPath") },
    });
    await expect(store.create(makeLease())).resolves.toMatchObject({
      ok: true,
      value: { kind: "created" },
    });
    await expect(store.create(makeLease())).resolves.toMatchObject({
      ok: true,
      value: { kind: "identical_replay" },
    });
    await expect(store.create(makeLease({ canonicalPath: "/srv/comis-workspaces/changed" })))
      .resolves.toEqual({ ok: true, value: { kind: "replay_conflict" } });
    await expect(store.create(makeLease({ workspaceLeaseId: "workspace-lease_b" })))
      .resolves.toEqual({ ok: true, value: { kind: "replay_conflict" } });
    db.close();
  });

  it("returns closed outcomes for missing scoped and stale release requests", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);
    expect((await store.create(makeLease())).ok).toBe(true);
    const release = {
      operationId: "release_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "reap_safe" as const,
      releasedAtMs: NOW_MS + 1,
    };

    await expect(store.get({ ...LEASE_SCOPE, tenantId: "tenant_b" }, "workspace-lease_a"))
      .resolves.toEqual({ ok: true, value: undefined });
    await expect(store.release(LEASE_SCOPE, {
      ...release,
      workspaceLeaseId: "workspace-lease_missing",
    })).resolves.toEqual({ ok: true, value: { kind: "not_found" } });
    await expect(store.release({ ...LEASE_SCOPE, agentId: "agent_b" }, release))
      .resolves.toEqual({ ok: true, value: { kind: "scope_mismatch" } });
    await expect(store.release(LEASE_SCOPE, { ...release, releasedAtMs: NOW_MS - 1 }))
      .resolves.toMatchObject({
        ok: false,
        error: { message: "workspace lease release time cannot move backward" },
      });
    await expect(store.release(LEASE_SCOPE, release)).resolves.toMatchObject({
      ok: true,
      value: { kind: "released" },
    });
    await expect(store.release(LEASE_SCOPE, { ...release, operationId: "release_b" }))
      .resolves.toEqual({ ok: true, value: { kind: "state_mismatch" } });
    db.close();
  });

  it("returns closed outcomes for missing scoped replay and stale recovery requests", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);
    expect((await store.create(makeLease())).ok).toBe(true);
    const recovered = {
      operationId: "recover_a",
      workspaceLeaseId: "workspace-lease_a",
      filesystemIdentity: { device: 10, inode: 20 },
      recoveredAtMs: NOW_MS + 1,
    };

    await expect(store.reconcile(LEASE_SCOPE, {
      ...recovered,
      workspaceLeaseId: "workspace-lease_missing",
    })).resolves.toEqual({ ok: true, value: { kind: "not_found" } });
    await expect(store.reconcile({ ...LEASE_SCOPE, serviceInstanceId: "service-instance_b" }, recovered))
      .resolves.toEqual({ ok: true, value: { kind: "scope_mismatch" } });
    await expect(store.reconcile(LEASE_SCOPE, { ...recovered, recoveredAtMs: NOW_MS - 1 }))
      .resolves.toMatchObject({
        ok: false,
        error: { message: "workspace lease recovery time cannot move backward" },
      });
    await expect(store.reconcile(LEASE_SCOPE, recovered)).resolves.toMatchObject({
      ok: true,
      value: { kind: "recovered" },
    });
    await expect(store.reconcile(LEASE_SCOPE, { ...recovered, recoveredAtMs: NOW_MS + 2 }))
      .resolves.toEqual({ ok: true, value: { kind: "replay_conflict" } });
    await expect(store.release(LEASE_SCOPE, {
      operationId: "release_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "preserve",
      releasedAtMs: NOW_MS + 2,
    })).resolves.toMatchObject({ ok: true, value: { kind: "released" } });
    await expect(store.reconcile(LEASE_SCOPE, { ...recovered, operationId: "recover_b" }))
      .resolves.toEqual({ ok: true, value: { kind: "state_mismatch" } });
    db.close();
  });

  it("rejects invalid recovery limits and contains closed database failures", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    const store = createSqliteWorkspaceLeaseStore(db);

    await expect(store.listRecoverable({ kind: "recovery", limit: 0 })).resolves.toMatchObject({
      ok: false,
      error: { message: "workspace lease recovery scan limit is invalid" },
    });
    db.close();
    await expect(store.get(LEASE_SCOPE, "workspace-lease_a")).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("database connection is not open") },
    });
  });

  it("contains malformed durable operation records as result errors", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);
    expect((await store.create(makeLease())).ok).toBe(true);
    const release = {
      operationId: "release_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "preserve" as const,
      releasedAtMs: NOW_MS + 1,
    };
    expect((await store.release(LEASE_SCOPE, release)).ok).toBe(true);
    db.prepare(`
      UPDATE workspace_lease_operations
      SET result_record = '{'
      WHERE workspace_lease_id = ? AND operation_id = ? AND operation_kind = 'release'
    `).run("workspace-lease_a", "release_a");

    await expect(store.release(LEASE_SCOPE, release)).resolves.toMatchObject({
      ok: false,
      error: { name: "SyntaxError" },
    });
    db.close();
  });

  it("contains malformed lease rows across durable authority operations", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);
    expect((await store.create(makeLease())).ok).toBe(true);
    db.prepare("UPDATE workspace_leases SET created_at_ms = 'invalid'").run();

    await expect(store.get(LEASE_SCOPE, "workspace-lease_a")).resolves.toMatchObject({ ok: false });
    await expect(store.release(LEASE_SCOPE, {
      operationId: "release_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "preserve",
      releasedAtMs: NOW_MS + 1,
    })).resolves.toMatchObject({ ok: false });
    await expect(store.reconcile(LEASE_SCOPE, {
      operationId: "recover_a",
      workspaceLeaseId: "workspace-lease_a",
      filesystemIdentity: { device: 10, inode: 20 },
      recoveredAtMs: NOW_MS + 1,
    })).resolves.toMatchObject({ ok: false });
    await expect(store.create(makeLease({ workspaceLeaseId: "workspace-lease_b" })))
      .resolves.toMatchObject({ ok: false });
    await expect(store.listRecoverable({ kind: "recovery", limit: 10 }))
      .resolves.toMatchObject({ ok: false });
    db.close();
  });

  it("contains domain-invalid rows and malformed operation hashes", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);
    expect((await store.create(makeLease())).ok).toBe(true);
    db.prepare("UPDATE workspace_leases SET canonical_path = ''").run();

    await expect(store.get(LEASE_SCOPE, "workspace-lease_a")).resolves.toMatchObject({ ok: false });
    await expect(store.listRecoverable({ kind: "recovery", limit: 10 }))
      .resolves.toMatchObject({ ok: false });

    db.prepare("UPDATE workspace_leases SET canonical_path = ?")
      .run("/srv/comis-workspaces/task-a");
    const recovered = {
      operationId: "recover_a",
      workspaceLeaseId: "workspace-lease_a",
      filesystemIdentity: { device: 10, inode: 20 },
      recoveredAtMs: NOW_MS + 1,
    };
    expect((await store.reconcile(LEASE_SCOPE, recovered)).ok).toBe(true);
    db.prepare(`
      UPDATE workspace_lease_operations
      SET input_hash = X'00'
      WHERE workspace_lease_id = ? AND operation_id = ? AND operation_kind = 'reconcile'
    `).run("workspace-lease_a", "recover_a");
    await expect(store.reconcile(LEASE_SCOPE, recovered)).resolves.toMatchObject({ ok: false });
    db.close();
  });

  it("reports lost atomic lease updates as durable errors", async () => {
    const db = new Database(":memory:");
    initSchema(db, 4);
    expect((await createSqliteManagedRunStore(db).create(makeManagedRun())).ok).toBe(true);
    const store = createSqliteWorkspaceLeaseStore(db);
    expect((await store.create(makeLease())).ok).toBe(true);
    db.exec(`
      CREATE TRIGGER remove_lease_before_update
      BEFORE UPDATE ON workspace_leases
      BEGIN
        DELETE FROM workspace_leases WHERE workspace_lease_id = OLD.workspace_lease_id;
        SELECT RAISE(IGNORE);
      END;
    `);

    await expect(store.release(LEASE_SCOPE, {
      operationId: "release_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "preserve",
      releasedAtMs: NOW_MS + 1,
    })).resolves.toMatchObject({
      ok: false,
      error: { message: "workspace lease update lost its row" },
    });
    db.exec("DROP TRIGGER remove_lease_before_update");
    expect((await store.create(makeLease())).ok).toBe(true);
    db.exec(`
      CREATE TRIGGER remove_lease_before_update
      BEFORE UPDATE ON workspace_leases
      BEGIN
        DELETE FROM workspace_leases WHERE workspace_lease_id = OLD.workspace_lease_id;
        SELECT RAISE(IGNORE);
      END;
    `);
    await expect(store.reconcile(LEASE_SCOPE, {
      operationId: "recover_a",
      workspaceLeaseId: "workspace-lease_a",
      filesystemIdentity: { device: 10, inode: 20 },
      recoveredAtMs: NOW_MS + 1,
    })).resolves.toMatchObject({
      ok: false,
      error: { message: "workspace lease update lost its row" },
    });
    db.close();
  });
});
