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
});
