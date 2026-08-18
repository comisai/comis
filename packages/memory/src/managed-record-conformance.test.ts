// SPDX-License-Identifier: Apache-2.0
/**
 * Record-only conformance for the capability-service platform.
 *
 * The managed-executor fixture proves the shape that holds workspace, terminal,
 * and attachment authority. This is its deliberate complement: a service that
 * holds managed-run authority with none of those scopes at all. It prepares a
 * run, emits progress, asks the owner one question, publishes an evidence-backed
 * candidate, and reaches a verified outcome — all without ever leasing a
 * workspace or binding a terminal, and all surviving a service-plus-daemon
 * restart.
 *
 * Two claims separate this shape from an executor and are the reason it exists:
 *   1. a record-only run completes when the host holds verified evidence and
 *      delivery is not part of its contract — it must never be forced to wait
 *      for delivery evidence it will never produce; and
 *   2. the executor scopes it never requested cannot make it look degraded.
 *      Absent workspace, terminal, and attachment authority is proven absent,
 *      not merely unmentioned.
 *
 * The fixture is deliberately neutral. It carries no consumer's domain nouns, so
 * passing it cannot quietly make one vertical the definition of the runtime.
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
  ManagedRunReductionInput,
  ManagedRunServiceScope,
} from "@comis/core";
import { createConversationRef, reduceManagedRunState } from "@comis/core";
import { createSqliteManagedRunStore } from "./managed-run-store.js";
import { initSchema } from "./schema.js";

const NOW_MS = 1_800_000_000_000;
const SERVICE_INSTANCE_ID = "service-instance_record";

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
  serviceInstanceId: SERVICE_INSTANCE_ID,
};

function makeRun(managedRunId: string, overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    schemaVersion: 1,
    managedRunId,
    serviceInstanceId: SERVICE_INSTANCE_ID,
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
    capturedToolIds: ["mcp:service_record.prepare"],
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

/** The record-only completion inputs: the host holds verified evidence and no
 * delivery is owed, because a record service produces a durable candidate rather
 * than an artifact routed to a destination. */
function recordReduction(
  overrides: Partial<ManagedRunReductionInput> = {},
): ManagedRunReductionInput {
  return {
    currentStatus: "active",
    currentStatusReason: "report_activity",
    openAttentionCount: 0,
    reports: [{
      schemaVersion: 1,
      managedRunId: "managed-run_a",
      serviceInstanceId: SERVICE_INSTANCE_ID,
      sequence: 1,
      kind: "candidate_complete",
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
    evidenceHealth: "available",
    verifiedOutcome: "succeeded",
    deliveryState: "not_required",
    nowMs: NOW_MS + 1_000,
    ...overrides,
  };
}

describe("managed-record fixture conformance", () => {
  const directories: string[] = [];
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) if (db.open) db.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function openStore(directory: string) {
    const db = new Database(join(directory, "memory.db"));
    databases.push(db);
    initSchema(db, 4);
    return createSqliteManagedRunStore(db);
  }

  function freshDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "managed-record-conformance-"));
    directories.push(directory);
    return directory;
  }

  it("drives a run to a verified candidate holding no workspace, terminal, or attachment", async () => {
    // Progress, then one question, then a candidate — the full record-only arc,
    // and at no point does it lease a workspace or bind a terminal. The executor
    // relationships stay empty because the shape never requested their scopes.
    const store = openStore(freshDirectory());
    expect((await store.create(makeRun("managed-run_a"))).ok).toBe(true);
    const activated = await store.claimTransition(SERVICE_SCOPE, {
      operationId: "operation_activate_a",
      managedRunId: "managed-run_a",
      expectedStatuses: ["preparing"],
      nextStatus: "active",
      nextStatusReason: "activation_acknowledged",
      transitionedAtMs: NOW_MS + 1_000,
    });
    expect(activated.ok && activated.value.kind).toBe("claimed");

    const progress = await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, {
      managedRunId: "managed-run_a",
      serviceReportId: "service-report_progress",
      kind: "progress",
      contentRef: "report-content_progress",
      contentHash: "3".repeat(64),
      receivedAtMs: NOW_MS + 2_000,
      retainedUntilMs: NOW_MS + 2_592_000_000,
      observedAtMs: NOW_MS + 1_500,
    });
    expect(progress.ok && progress.value.kind).toBe("accepted");

    const question = await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, {
      managedRunId: "managed-run_a",
      serviceReportId: "service-report_attention",
      kind: "attention",
      contentRef: "report-content_attention",
      contentHash: "4".repeat(64),
      receivedAtMs: NOW_MS + 3_000,
      retainedUntilMs: NOW_MS + 2_592_000_000,
      attention: {
        attentionId: "attention-a",
        attentionRef: "report-content_attention",
        externalKey: "answer-a",
      },
    });
    expect(question.ok && question.value.kind).toBe("accepted");

    const open = await store.listOpenAttention(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      limit: 10,
    });
    expect(open.ok && open.value[0]?.status).toBe("open");

    const answered = await store.claimAttentionResponse(OWNER_SCOPE, {
      operationId: "attention-response-a",
      attentionId: "attention-a",
      responseRef: "attention-response-content-a",
      respondedAtMs: NOW_MS + 3_500,
    });
    expect(answered.ok && answered.value.kind).toBe("updated");

    const resolution = await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, {
      managedRunId: "managed-run_a",
      serviceReportId: "service-report_resolution",
      kind: "resolution",
      contentRef: "report-content_resolution",
      contentHash: "5".repeat(64),
      receivedAtMs: NOW_MS + 4_000,
      retainedUntilMs: NOW_MS + 2_592_000_000,
      resolutionExternalKey: "answer-a",
    });
    expect(resolution.ok && resolution.value.kind).toBe("accepted");

    const candidate = await store.appendEvidence(SERVICE_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRef: "evidence_candidate_a",
      kind: "candidate_bundle",
      subjectDigest: "6".repeat(64),
      observedAtMs: NOW_MS + 5_000,
      contentRef: "candidate_a",
      contentHash: "7".repeat(64),
      privateContentHash: "8".repeat(64),
      verificationLevel: "host_verified",
      deliveryKind: "reference",
      receivedAtMs: NOW_MS + 5_000,
    });
    expect(candidate.ok && candidate.value.kind).toBe("accepted");

    const record = await store.get(SERVICE_SCOPE, "managed-run_a");
    expect(record.ok).toBe(true);
    if (!record.ok || record.value === undefined) throw new Error("record must be durable");
    // The whole point of the shape: the executor relationships were never bound.
    expect(record.value.workspaceLeaseId).toBeUndefined();
    expect(record.value.terminalSessionIds).toEqual([]);
    expect(record.value.executionAttachmentIds).toEqual([]);
  });

  it("completes on verified evidence when delivery is not part of the contract", () => {
    // The executor is blocked until the host confirms delivery; the record-only
    // service must not inherit that gate. Delivery `not_required` is exactly the
    // fact that distinguishes producing a durable candidate from routing an
    // artifact to a destination.
    const succeeded = reduceManagedRunState(recordReduction());
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.terminalOutcomeKind).toBe("succeeded");

    // And it must not silently succeed on the executor gate it never opted into:
    // an outcome that claimed delivery it never owed would be a different bug.
    for (const deliveryState of ["missing", "unavailable"] as const) {
      const stuck = reduceManagedRunState(recordReduction({ deliveryState }));
      expect(stuck.status).not.toBe("succeeded");
      expect(stuck.terminalOutcomeKind).toBeUndefined();
    }
  });

  it("does not degrade to unknown from the executor scopes it never requested", () => {
    // A record-only run holds no workspace, terminal, or attachment. Reduction
    // reads only host-owned record facts — reports, heartbeat freshness,
    // evidence health, verified outcome — so the absent executor scopes can
    // never turn a healthy record run degraded. Liveness is not even required of
    // a shape that declares no health obligation.
    const running = reduceManagedRunState(recordReduction({
      reports: [{
        schemaVersion: 1,
        managedRunId: "managed-run_a",
        serviceInstanceId: SERVICE_INSTANCE_ID,
        sequence: 1,
        kind: "progress",
        contentRef: "managed-runs/private/managed-run_a/report_1",
        contentHash: "1".repeat(64),
        privateContentHash: "2".repeat(64),
        observedAtMs: NOW_MS,
        receivedAtMs: NOW_MS,
      }],
      verifiedOutcome: "none",
      lastHeartbeatAtMs: undefined,
    }));
    expect(running.status).toBe("active");
    expect(running.statusReason).toBe("report_activity");
  });

  it("survives a service and daemon restart with its durable record intact", async () => {
    // Kill the service, restart the daemon: the run is durable state, not
    // in-memory session state, so a fresh store over the same data directory
    // must resolve the exact run and its advanced cursor.
    const directory = freshDirectory();
    const store = openStore(directory);
    expect((await store.create(makeRun("managed-run_a"))).ok).toBe(true);
    const activated = await store.claimTransition(SERVICE_SCOPE, {
      operationId: "operation_activate_a",
      managedRunId: "managed-run_a",
      expectedStatuses: ["preparing"],
      nextStatus: "active",
      nextStatusReason: "activation_acknowledged",
      transitionedAtMs: NOW_MS + 1_000,
    });
    expect(activated.ok && activated.value.kind).toBe("claimed");
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, {
      managedRunId: "managed-run_a",
      serviceReportId: "service-report_progress",
      kind: "progress",
      contentRef: "report-content_progress",
      contentHash: "3".repeat(64),
      receivedAtMs: NOW_MS + 2_000,
      retainedUntilMs: NOW_MS + 2_592_000_000,
    })).ok).toBe(true);
    for (const db of databases.splice(0)) db.close();

    const restarted = openStore(directory);
    const recovered = await restarted.get(SERVICE_SCOPE, "managed-run_a");
    expect(recovered.ok).toBe(true);
    if (!recovered.ok || recovered.value === undefined) throw new Error("run must survive restart");
    expect(recovered.value.status).toBe("active");
    expect(recovered.value.lastAcceptedReportSequence).toBe(1);
    expect(recovered.value.workspaceLeaseId).toBeUndefined();
    expect(recovered.value.terminalSessionIds).toEqual([]);
  });
});
