// SPDX-License-Identifier: Apache-2.0
/**
 * Managed-executor conformance for the capability-service platform.
 *
 * The record-only fixture proves a service can hold managed-run authority with
 * no workspace, terminal, or attachment scope at all. This is its complement:
 * a neutral fixture that holds all three, leases an isolated workspace, binds a
 * terminal to it by opaque handle, publishes an artifact pointer, and reaches a
 * terminal outcome only once the host itself holds delivery evidence.
 *
 * The fixture is deliberately neutral. It carries no consumer's domain nouns,
 * so passing it cannot quietly make one vertical the definition of the runtime.
 *
 * @module
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ManagedRunOwnerScope,
  ManagedRunRecord,
  ManagedRunServiceScope,
  WorkspaceLeaseRecord,
  WorkspaceLeaseScope,
} from "@comis/core";
import { createConversationRef, reduceManagedRunState } from "@comis/core";
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

const OWNER_SCOPE: ManagedRunOwnerScope = {
  kind: "owner",
  tenantId: "tenant_a",
  agentId: "agent_a",
  principalId: "principal_a",
  conversationRef: conversationRef.value,
};
const SERVICE_SCOPE: ManagedRunServiceScope = {
  kind: "service",
  serviceInstanceId: "service-instance_executor",
};

function leaseScope(managedRunId: string): WorkspaceLeaseScope {
  return {
    tenantId: "tenant_a",
    agentId: "agent_a",
    serviceInstanceId: "service-instance_executor",
    managedRunId,
  };
}

function makeRun(managedRunId: string, overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    schemaVersion: 1,
    managedRunId,
    serviceInstanceId: "service-instance_executor",
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorDigest: "b".repeat(64),
    activationDescriptorRef: `activation-descriptor_${managedRunId}`,
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
    capturedToolIds: ["mcp:service_executor.transform"],
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
    ...overrides,
  };
}

function makeLease(
  workspaceLeaseId: string,
  managedRunId: string,
  overrides: Partial<WorkspaceLeaseRecord> = {},
): WorkspaceLeaseRecord {
  return {
    schemaVersion: 1,
    workspaceLeaseId,
    managedRunId,
    serviceInstanceId: "service-instance_executor",
    tenantId: "tenant_a",
    agentId: "agent_a",
    canonicalPath: `/approved/workspaces/${workspaceLeaseId}`,
    filesystemIdentity: { device: 10, inode: 20, birthtimeNs: "100" },
    state: "active",
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

describe("managed-executor fixture conformance", () => {
  const directories: string[] = [];
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) if (db.open) db.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function openStores() {
    const directory = mkdtempSync(join(tmpdir(), "managed-executor-conformance-"));
    directories.push(directory);
    const db = new Database(join(directory, "memory.db"));
    databases.push(db);
    initSchema(db, 4);
    return {
      runs: createSqliteManagedRunStore(db),
      leases: createSqliteWorkspaceLeaseStore(db),
    };
  }

  it("leases a workspace one run at a time and binds a terminal to that run", async () => {
    // Two concurrent executor runs are the ordinary case, and the isolation
    // claim is only meaningful when a second run exists to be excluded. A lease
    // read under the wrong run's scope must not resolve: the lease identifier is
    // an opaque handle, never a capability that any holder can redeem.
    const { runs, leases } = openStores();
    expect((await runs.create(makeRun("managed-run_a"))).ok).toBe(true);
    expect((await runs.create(makeRun("managed-run_b"))).ok).toBe(true);

    const created = await leases.create(makeLease("workspace-lease_a", "managed-run_a"));
    expect(created.ok && created.value.kind).toBe("created");

    const own = await leases.get(leaseScope("managed-run_a"), "workspace-lease_a");
    expect(own.ok && own.value?.canonicalPath).toBe("/approved/workspaces/workspace-lease_a");

    const sibling = await leases.get(leaseScope("managed-run_b"), "workspace-lease_a");
    expect(sibling.ok).toBe(true);
    expect(sibling.ok && sibling.value).toBeUndefined();

    const bound = await runs.setWorkspaceLease(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      leaseTenantId: "tenant_a",
      leaseAgentId: "agent_a",
      boundAtMs: NOW_MS + 1_000,
    });
    expect(bound.ok && bound.value.kind).toBe("bound");

    const terminal = await runs.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal-session_a",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: NOW_MS + 2_000,
    });
    expect(terminal.ok && terminal.value.kind).toBe("bound");
    expect(terminal.ok && terminal.value.kind === "bound"
      && terminal.value.record.terminalSessionIds).toEqual(["terminal-session_a"]);
  });

  it("refuses a terminal binding whose tenant or agent is not the lease holder's", async () => {
    // A terminal carries the ability to act inside the leased workspace. If a
    // binding could name a different tenant or agent than the run's own, the
    // lease would become a way to reach one principal's workspace from another's
    // session — the exact crossing the lease exists to prevent.
    const { runs, leases } = openStores();
    expect((await runs.create(makeRun("managed-run_a"))).ok).toBe(true);
    expect((await leases.create(makeLease("workspace-lease_a", "managed-run_a"))).ok).toBe(true);

    const foreign = await runs.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal-session_foreign",
      terminalTenantId: "tenant_b",
      terminalAgentId: "agent_a",
      boundAtMs: NOW_MS + 2_000,
    });
    expect(foreign.ok && foreign.value.kind).toBe("ownership_mismatch");

    const foreignAgent = await runs.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal-session_foreign",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_b",
      boundAtMs: NOW_MS + 2_000,
    });
    expect(foreignAgent.ok && foreignAgent.value.kind).toBe("ownership_mismatch");
  });

  it("publishes an artifact as a pointer the host resolves, never as content", async () => {
    // The artifact index is the host's durable record of what the service
    // produced. It holds references and digests only: a service that could write
    // bytes into the index would put unscanned content on every read path that
    // touches a run, including the ones an operator reads during an incident.
    //
    // The reference is an opaque token the host resolves under its own private
    // content root, not a path the service composes. A service that could supply
    // a path would be choosing where the host reads from, and the run's private
    // directory would stop being a boundary.
    const { runs, leases } = openStores();
    // An artifact belongs to a run the host has already activated. The run is
    // transitioned rather than created active: a run that could be born in a
    // working state would have skipped the durable bind that gives the host
    // something to attribute the artifact to.
    expect((await runs.create(makeRun("managed-run_a"))).ok).toBe(true);
    expect((await leases.create(makeLease("workspace-lease_a", "managed-run_a"))).ok).toBe(true);
    const activated = await runs.claimTransition(SERVICE_SCOPE, {
      operationId: "operation_activate_a",
      managedRunId: "managed-run_a",
      expectedStatuses: ["preparing"],
      nextStatus: "active",
      nextStatusReason: "report_activity",
      transitionedAtMs: NOW_MS + 1_000,
    });
    expect(activated.ok && activated.value.kind).toBe("claimed");

    const appended = await runs.appendEvidence(SERVICE_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRef: "evidence_artifact_a",
      kind: "artifact_pointer",
      subjectDigest: "e".repeat(64),
      observedAtMs: NOW_MS + 3_000,
      contentRef: "artifact_a",
      contentHash: "f".repeat(64),
      privateContentHash: "0".repeat(64),
      verificationLevel: "host_verified",
      deliveryKind: "reference",
      receivedAtMs: NOW_MS + 3_000,
    });
    if (!appended.ok) throw appended.error;
    expect(appended.value.kind).toBe("accepted");

    const listed = await runs.listEvidenceByRefs(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRefs: ["evidence_artifact_a"],
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const [artifact] = listed.value;
    expect(artifact?.deliveryKind).toBe("reference");
    expect(artifact?.contentRef).toBe("artifact_a");

    const traversal = await runs.appendEvidence(SERVICE_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRef: "evidence_artifact_b",
      kind: "artifact_pointer",
      subjectDigest: "e".repeat(64),
      observedAtMs: NOW_MS + 4_000,
      contentRef: "../../etc/passwd",
      contentHash: "f".repeat(64),
      privateContentHash: "0".repeat(64),
      verificationLevel: "host_verified",
      deliveryKind: "reference",
      receivedAtMs: NOW_MS + 4_000,
    });
    expect(traversal.ok).toBe(false);
  });

  it("does not complete an executor run until the host holds delivery evidence", async () => {
    // This is the claim that separates an executor from a record-only service.
    // The service publishing an artifact and verifying its own outcome is not
    // completion: the host has not yet confirmed the artifact reached its
    // destination, and a run that reported success there would tell the user
    // their output was delivered when only the service believed it.
    const base = {
      currentStatus: "active" as const,
      currentStatusReason: "report_activity" as const,
      openAttentionCount: 0,
      reports: [{
        schemaVersion: 1 as const,
        managedRunId: "managed-run_a",
        serviceInstanceId: "service-instance_executor",
        sequence: 1,
        kind: "candidate_complete" as const,
        contentRef: "managed-runs/private/managed-run_a/report_1",
        contentHash: "1".repeat(64),
        privateContentHash: "2".repeat(64),
        observedAtMs: NOW_MS,
        receivedAtMs: NOW_MS,
      }],
      throughReportSequence: 1,
      lastHeartbeatAtMs: NOW_MS,
      heartbeatMaxAgeMs: 60_000,
      heartbeatRequired: false,
      evidenceHealth: "available" as const,
      verifiedOutcome: "succeeded" as const,
      nowMs: NOW_MS + 1_000,
    };

    for (const deliveryState of ["missing", "unavailable"] as const) {
      const pending = reduceManagedRunState({ ...base, deliveryState });
      expect(pending.status).not.toBe("succeeded");
      expect(pending.terminalOutcomeKind).toBeUndefined();
    }

    const delivered = reduceManagedRunState({ ...base, deliveryState: "verified" });
    expect(delivered.status).toBe("succeeded");
    expect(delivered.terminalOutcomeKind).toBe("succeeded");
  });
});
