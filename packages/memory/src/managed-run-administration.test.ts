// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-scope health counts over the durable managed-run index.
 *
 * The system-health digest needs to say how many managed runs are degraded and
 * why, across every service, without loading a single run body. This pins that
 * the aggregate read stays content-free — closed status/reason enums, counts,
 * and one opaque run identifier — and that it windows on the update time exactly
 * like the durable-run health read it sits beside.
 *
 * @module
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversationRef,
  type ManagedRunRecord,
  type ManagedRunStatus,
  type ManagedRunStatusReason,
  type ManagedRunTerminalOutcome,
} from "@comis/core";
import { ensureManagedRunTables } from "./schema-managed-runs.js";
import { createSqliteManagedRunStore } from "./managed-run-store.js";

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

interface RunShape {
  readonly managedRunId: string;
  readonly serviceInstanceId: string;
  readonly status: ManagedRunStatus;
  readonly statusReason: ManagedRunStatusReason;
  readonly updatedAtMs: number;
  readonly createdAtMs?: number;
}

const TERMINAL_KIND: Partial<Record<ManagedRunStatus, ManagedRunTerminalOutcome["kind"]>> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

function makeRun(shape: RunShape): ManagedRunRecord {
  const createdAtMs = shape.createdAtMs ?? NOW_MS;
  const terminalKind = TERMINAL_KIND[shape.status];
  return {
    schemaVersion: 1,
    managedRunId: shape.managedRunId,
    serviceInstanceId: shape.serviceInstanceId,
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorDigest: "b".repeat(64),
    // Only preparing (and, optionally, uncertain) runs may retain an activation
    // descriptor; every other status must omit it to satisfy the record schema.
    ...(shape.status === "preparing"
      ? { activationDescriptorRef: `activation-descriptor_${shape.managedRunId}` }
      : {}),
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
    capturedToolIds: ["mcp:service.tool"],
    capturedCapabilityViewHash: "d".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: shape.status,
    statusReason: shape.statusReason,
    lastAcceptedReportSequence: 0,
    lastReducedReportSequence: 0,
    pendingContinuation: false,
    openAttentionCount: 0,
    createdAtMs,
    updatedAtMs: shape.updatedAtMs,
    ...(terminalKind === undefined
      ? {}
      : { terminalOutcome: { kind: terminalKind, recordedAtMs: shape.updatedAtMs } }),
  };
}

describe("managed-run administration health counts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureManagedRunTables(db);
  });

  afterEach(() => {
    db.close();
  });

  async function seed(store: ReturnType<typeof createSqliteManagedRunStore>, shapes: readonly RunShape[]) {
    for (const shape of shapes) {
      const created = await store.create(makeRun(shape));
      expect(created.ok && created.value.kind).toBe("created");
    }
  }

  it("aggregates degraded runs by status and closed reason code, windowed on update time", async () => {
    const store = createSqliteManagedRunStore(db);
    await seed(store, [
      { managedRunId: "run_x_failed", serviceInstanceId: "service_x", status: "failed", statusReason: "failure_verified", updatedAtMs: NOW_MS + 10 },
      { managedRunId: "run_x_unknown", serviceInstanceId: "service_x", status: "unknown", statusReason: "service_state_unavailable", updatedAtMs: NOW_MS + 20 },
      { managedRunId: "run_y_unknown", serviceInstanceId: "service_y", status: "unknown", statusReason: "required_evidence_stale", updatedAtMs: NOW_MS + 30 },
      { managedRunId: "run_x_ok", serviceInstanceId: "service_x", status: "succeeded", statusReason: "outcome_verified", updatedAtMs: NOW_MS + 5 },
      { managedRunId: "run_z_active", serviceInstanceId: "service_z", status: "active", statusReason: "activation_acknowledged", updatedAtMs: NOW_MS + 40 },
      // Cancellation is an intended outcome, not degradation.
      { managedRunId: "run_z_cancelled", serviceInstanceId: "service_z", status: "cancelled", statusReason: "owner_cancelled", updatedAtMs: NOW_MS + 15 },
      // Before the window: excluded from every count.
      { managedRunId: "run_old_failed", serviceInstanceId: "service_x", status: "failed", statusReason: "failure_verified", updatedAtMs: NOW_MS - 1_000, createdAtMs: NOW_MS - 2_000 },
    ]);

    const counts = await store.countByStatus({ kind: "administration", updatedSinceMs: NOW_MS });
    expect(counts.ok).toBe(true);
    if (!counts.ok) return;

    expect(counts.value.byStatus).toEqual({
      preparing: 0,
      active: 1,
      waiting: 0,
      paused: 0,
      candidate_complete: 0,
      succeeded: 1,
      failed: 1,
      cancelled: 1,
      unknown: 2,
    });
    // Degraded == failed + unknown; cancelled and succeeded are clean outcomes.
    expect(counts.value.degradedReasonCodes).toEqual({
      failure_verified: 1,
      service_state_unavailable: 1,
      required_evidence_stale: 1,
    });
    expect(counts.value.distinctServiceInstances).toBe(3);
    // service_x (failed+unknown) and service_y (unknown) are degraded; service_z
    // holds only an active and a cancelled run, so it is not.
    expect(counts.value.degradedServiceInstances).toBe(2);
    // The most recently updated degraded run is the drill-in target.
    expect(counts.value.worstManagedRunId).toBe("run_y_unknown");
  });

  it("returns an all-zero window with no worst run when nothing degraded is present", async () => {
    const store = createSqliteManagedRunStore(db);
    await seed(store, [
      { managedRunId: "run_ok", serviceInstanceId: "service_x", status: "succeeded", statusReason: "outcome_verified", updatedAtMs: NOW_MS + 5 },
    ]);

    const counts = await store.countByStatus({ kind: "administration", updatedSinceMs: NOW_MS });
    expect(counts.ok).toBe(true);
    if (!counts.ok) return;
    expect(counts.value.byStatus.succeeded).toBe(1);
    expect(counts.value.byStatus.failed).toBe(0);
    expect(counts.value.degradedReasonCodes).toEqual({});
    expect(counts.value.distinctServiceInstances).toBe(1);
    expect(counts.value.degradedServiceInstances).toBe(0);
    expect(counts.value.worstManagedRunId).toBeUndefined();
  });
});

describe("managed-run active concurrency counts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureManagedRunTables(db);
  });

  afterEach(() => {
    db.close();
  });

  async function seed(store: ReturnType<typeof createSqliteManagedRunStore>, shapes: readonly RunShape[]) {
    for (const shape of shapes) {
      const created = await store.create(makeRun(shape));
      expect(created.ok && created.value.kind).toBe("created");
    }
  }

  it("counts only a service's non-terminal runs, ignoring terminal ones and other services", async () => {
    const store = createSqliteManagedRunStore(db);
    await seed(store, [
      { managedRunId: "run_x_preparing", serviceInstanceId: "service_x", status: "preparing", statusReason: "awaiting_activation", updatedAtMs: NOW_MS + 1 },
      { managedRunId: "run_x_active", serviceInstanceId: "service_x", status: "active", statusReason: "activation_acknowledged", updatedAtMs: NOW_MS + 2 },
      { managedRunId: "run_x_unknown", serviceInstanceId: "service_x", status: "unknown", statusReason: "service_state_unavailable", updatedAtMs: NOW_MS + 3 },
      // Terminal runs never count against the concurrency ceiling.
      { managedRunId: "run_x_succeeded", serviceInstanceId: "service_x", status: "succeeded", statusReason: "outcome_verified", updatedAtMs: NOW_MS + 4 },
      { managedRunId: "run_x_failed", serviceInstanceId: "service_x", status: "failed", statusReason: "failure_verified", updatedAtMs: NOW_MS + 5 },
      { managedRunId: "run_x_cancelled", serviceInstanceId: "service_x", status: "cancelled", statusReason: "owner_cancelled", updatedAtMs: NOW_MS + 6 },
      // A different service is out of scope for service_x's count.
      { managedRunId: "run_y_active", serviceInstanceId: "service_y", status: "active", statusReason: "activation_acknowledged", updatedAtMs: NOW_MS + 7 },
    ]);

    const counted = await store.countActiveByService("service_x");
    expect(counted.ok).toBe(true);
    if (!counted.ok) return;
    expect(counted.value).toBe(3);

    const other = await store.countActiveByService("service_y");
    expect(other.ok && other.value).toBe(1);
    const none = await store.countActiveByService("service_absent");
    expect(none.ok && none.value).toBe(0);
  });
});

describe("managed-run report rate counts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureManagedRunTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it("counts a run's reports received within a rolling window, scoped to its service", async () => {
    const store = createSqliteManagedRunStore(db);
    const created = await store.create(makeRun({
      managedRunId: "run_rate",
      serviceInstanceId: "service_x",
      status: "active",
      statusReason: "activation_acknowledged",
      updatedAtMs: NOW_MS,
    }));
    expect(created.ok && created.value.kind).toBe("created");
    const serviceScope = { kind: "service" as const, serviceInstanceId: "service_x" };

    for (const [index, receivedAtMs] of [NOW_MS, NOW_MS + 10_000, NOW_MS + 20_000].entries()) {
      const appended = await store.appendReportAndAdvanceAcceptedCursor(serviceScope, {
        managedRunId: "run_rate",
        serviceReportId: `service-report_${index}`,
        kind: "progress",
        contentRef: `report-content_${index}`,
        contentHash: `${index}`.repeat(64).slice(0, 64),
        receivedAtMs,
        retainedUntilMs: receivedAtMs + 1_000_000,
      });
      expect(appended.ok && appended.value.kind).toBe("accepted");
    }

    expect((await store.countReportsSince(serviceScope, "run_rate", NOW_MS)).ok).toBe(true);
    expect(await store.countReportsSince(serviceScope, "run_rate", NOW_MS)).toEqual({ ok: true, value: 3 });
    expect(await store.countReportsSince(serviceScope, "run_rate", NOW_MS + 10_000)).toEqual({ ok: true, value: 2 });
    expect(await store.countReportsSince(serviceScope, "run_rate", NOW_MS + 20_001)).toEqual({ ok: true, value: 0 });
    // Another service never sees this run's reports.
    expect(await store.countReportsSince(
      { kind: "service", serviceInstanceId: "service_y" },
      "run_rate",
      NOW_MS,
    )).toEqual({ ok: true, value: 0 });
  });
});

describe("managed-run administration trace linkage", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureManagedRunTables(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeTracedRun(managedRunId: string, traceId: string, serviceInstanceId = "service_x"): ManagedRunRecord {
    return makeRun({
      managedRunId,
      serviceInstanceId,
      status: "active",
      statusReason: "activation_acknowledged",
      updatedAtMs: NOW_MS,
    });
    // makeRun keeps a fixed traceId, so overwrite it below via a spread.
  }

  it("links a session's traces to the managed runs they prepared, content-free", async () => {
    const store = createSqliteManagedRunStore(db);
    const traceA = "10000000-0000-4000-8000-00000000000a";
    const traceB = "10000000-0000-4000-8000-00000000000b";
    const traceOther = "10000000-0000-4000-8000-0000000000ff";
    // Two runs prepared in the session's two turns, plus one from an unrelated trace.
    for (const [id, trace, svc] of [
      ["run_a", traceA, "service_x"],
      ["run_b", traceB, "service_y"],
      ["run_other", traceOther, "service_x"],
    ] as const) {
      const created = await store.create({ ...makeTracedRun(id, trace, svc), traceId: trace });
      expect(created.ok && created.value.kind).toBe("created");
    }

    const linked = await store.listByTraceIds({
      kind: "administration",
      traceIds: [traceA, traceB],
      limit: 32,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    const ids = linked.value.map((row) => row.managedRunId).sort();
    expect(ids).toEqual(["run_a", "run_b"]);
    // Content-free rows: ids + closed enums + the linking trace only.
    const rowA = linked.value.find((row) => row.managedRunId === "run_a");
    expect(rowA).toMatchObject({
      serviceInstanceId: "service_x",
      status: "active",
      statusReason: "activation_acknowledged",
      traceId: traceA,
    });
    expect(Object.keys(rowA ?? {}).sort()).toEqual(
      ["managedRunId", "serviceInstanceId", "status", "statusReason", "traceId"],
    );
  });

  it("returns an empty list for an empty trace set or traces with no runs", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create({
      ...makeTracedRun("run_a", "10000000-0000-4000-8000-00000000000a"),
      traceId: "10000000-0000-4000-8000-00000000000a",
    })).ok).toBe(true);

    const none = await store.listByTraceIds({ kind: "administration", traceIds: [], limit: 32 });
    expect(none.ok && none.value).toEqual([]);
    const miss = await store.listByTraceIds({
      kind: "administration",
      traceIds: ["10000000-0000-4000-8000-000000000099"],
      limit: 32,
    });
    expect(miss.ok && miss.value).toEqual([]);
  });

  it("bounds the result to the limit", async () => {
    const store = createSqliteManagedRunStore(db);
    const trace = "10000000-0000-4000-8000-00000000000a";
    for (let index = 0; index < 5; index += 1) {
      expect((await store.create({
        ...makeTracedRun(`run_${index}`, trace),
        traceId: trace,
      })).ok).toBe(true);
    }
    const linked = await store.listByTraceIds({ kind: "administration", traceIds: [trace], limit: 3 });
    expect(linked.ok && linked.value.length).toBe(3);
  });
});
