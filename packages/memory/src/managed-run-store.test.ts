// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversationRef,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
  type ManagedRunReportAppendInput,
  type ManagedRunServiceScope,
} from "@comis/core";
import { ensureManagedRunTables } from "./schema-managed-runs.js";
import { createSqliteManagedRunStore } from "./managed-run-store.js";

const CONVERSATION_SCOPE = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: {
    kind: "endpoint-conversation-principal" as const,
    endpoint: {
      channelType: "telegram",
      channelInstanceId: "channel-instance_a",
      conversationId: "conversation_a",
      threadId: "thread_a",
      conversationKind: "direct" as const,
    },
    principalId: "principal_a",
  },
};
const conversationReference = createConversationRef(CONVERSATION_SCOPE);
if (!conversationReference.ok) throw conversationReference.error;

const OWNER_SCOPE: ManagedRunOwnerScope = {
  kind: "owner",
  tenantId: "tenant_a",
  agentId: "agent_a",
  principalId: "principal_a",
  conversationRef: conversationReference.value,
};
const OTHER_OWNER_SCOPE: ManagedRunOwnerScope = {
  ...OWNER_SCOPE,
  principalId: "principal_b",
};
const SERVICE_SCOPE: ManagedRunServiceScope = {
  kind: "service",
  serviceInstanceId: "service-instance_a",
};
const OTHER_SERVICE_SCOPE: ManagedRunServiceScope = {
  kind: "service",
  serviceInstanceId: "service-instance_b",
};

function makeRecord(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    schemaVersion: 1,
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorRef: "activation-descriptor_a",
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: conversationReference.value,
    turnScope: {
      conversation: CONVERSATION_SCOPE,
      principal: { principalId: "principal_a" },
      endpoint: CONVERSATION_SCOPE.partition.endpoint,
    },
    deliveryOrigin: {
      channelType: "telegram",
      channelId: "conversation_a",
      userId: "principal_a",
      threadId: "thread_a",
      tenantId: "tenant_a",
    },
    trustLevel: "user",
    responseLocalePolicy: { locale: "en", source: "request", enforceLocale: true },
    workspacePolicyHash: "b".repeat(64),
    rootRunId: "root-run_a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:read", "orch:web"],
    capturedToolIds: ["mcp:service_a.inspect", "web_search"],
    capturedCapabilityViewHash: "c".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "preparing",
    statusReason: "awaiting_activation",
    lastAcceptedReportSequence: 0,
    lastReducedReportSequence: 0,
    pendingContinuation: false,
    openAttentionCount: 0,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

function reportInput(overrides: Partial<ManagedRunReportAppendInput> = {}): ManagedRunReportAppendInput {
  return {
    managedRunId: "managed-run_a",
    serviceReportId: "service-report_a",
    kind: "progress",
    contentRef: "report-content_a",
    contentHash: "d".repeat(64),
    receivedAtMs: 1_800_000_000_100,
    retainedUntilMs: 1_802_592_000_100,
    observedAtMs: 1_800_000_000_050,
    ...overrides,
  };
}

async function activate(store: ReturnType<typeof createSqliteManagedRunStore>): Promise<void> {
  const activated = await store.claimTransition(SERVICE_SCOPE, {
    operationId: "operation_activate",
    managedRunId: "managed-run_a",
    expectedStatuses: ["preparing"],
    nextStatus: "active",
    nextStatusReason: "activation_acknowledged",
    transitionedAtMs: 1_800_000_000_050,
  });
  expect(activated.ok && activated.value.kind).toBe("claimed");
}

describe("createSqliteManagedRunStore durable state machine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureManagedRunTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates reads and lists records only through exact explicit scopes", async () => {
    const store = createSqliteManagedRunStore(db);
    const record = makeRecord();

    expect((await store.create(record)).value).toEqual({ kind: "created", record });
    expect(await store.get(OWNER_SCOPE, record.managedRunId)).toEqual({ ok: true, value: record });
    expect(await store.get(SERVICE_SCOPE, record.managedRunId)).toEqual({ ok: true, value: record });
    expect(await store.get(OTHER_OWNER_SCOPE, record.managedRunId)).toEqual({ ok: true, value: undefined });
    expect(await store.get(OTHER_SERVICE_SCOPE, record.managedRunId)).toEqual({ ok: true, value: undefined });
    expect(await store.listScoped({ scope: OWNER_SCOPE, limit: 10 })).toEqual({ ok: true, value: [record] });
    expect(await store.listScoped({ scope: OTHER_OWNER_SCOPE, limit: 10 })).toEqual({ ok: true, value: [] });
  });

  it("returns original create results and rejects altered identity reuse", async () => {
    const store = createSqliteManagedRunStore(db);
    const record = makeRecord();

    expect((await store.create(record)).value?.kind).toBe("created");
    expect(await store.create(record)).toEqual({
      ok: true,
      value: { kind: "identical_replay", record },
    });
    expect(await store.create({ ...record, capturedToolIds: ["different_tool"] })).toEqual({
      ok: true,
      value: { kind: "replay_conflict" },
    });
  });

  it("claims transitions atomically and persists the original replay result", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    const activation = {
      operationId: "operation_activate",
      managedRunId: "managed-run_a",
      expectedStatuses: ["preparing" as const],
      nextStatus: "active" as const,
      nextStatusReason: "activation_acknowledged" as const,
      transitionedAtMs: 1_800_000_000_100,
    };

    const claimed = await store.claimTransition(SERVICE_SCOPE, activation);
    expect(claimed.ok && claimed.value.kind).toBe("claimed");
    expect(claimed.ok && "record" in claimed.value && claimed.value.record).toMatchObject({
      status: "active",
      statusReason: "activation_acknowledged",
      activationDescriptorRef: undefined,
    });
    expect((await store.claimTransition(SERVICE_SCOPE, activation)).value?.kind).toBe("identical_replay");
    expect((await store.claimTransition(OTHER_SERVICE_SCOPE, activation)).value?.kind).toBe("scope_mismatch");
    expect((await store.claimTransition(SERVICE_SCOPE, {
      ...activation,
      nextStatus: "unknown",
      nextStatusReason: "activation_outcome_unknown",
    })).value?.kind).toBe("replay_conflict");
    expect((await store.claimTransition(SERVICE_SCOPE, {
      ...activation,
      operationId: "operation_illegal",
      expectedStatuses: ["active"],
      nextStatus: "preparing",
      nextStatusReason: "awaiting_activation",
    })).value?.kind).toBe("invalid_transition");
  });

  it("accepts reports transactionally with monotonic sequence and durable replay", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).value?.kind).toBe("state_mismatch");
    await activate(store);
    const firstInput = reportInput();

    const first = await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, firstInput);
    expect(first.ok && first.value).toMatchObject({
      kind: "accepted",
      report: { sequence: 1, serviceReportId: "service-report_a" },
    });
    expect(await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, firstInput)).toEqual({
      ok: true,
      value: first.ok && "report" in first.value
        ? { kind: "identical_replay", report: first.value.report }
        : undefined,
    });

    const second = await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_b",
      contentRef: "report-content_b",
      contentHash: "e".repeat(64),
      receivedAtMs: 1_800_000_000_200,
      retainedUntilMs: 1_802_592_000_200,
    }));
    expect(second.ok && "report" in second.value && second.value.report.sequence).toBe(2);
    expect(await store.get(OWNER_SCOPE, "managed-run_a")).toMatchObject({
      ok: true,
      value: { lastAcceptedReportSequence: 2, pendingContinuation: true },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM managed_run_reports").get()).toEqual({ count: 2 });
  });

  it("rejects altered report replay and service ownership mismatches without advancing", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).value?.kind).toBe("accepted");
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      contentHash: "f".repeat(64),
    }))).value?.kind).toBe("replay_conflict");
    expect((await store.appendReportAndAdvanceAcceptedCursor(OTHER_SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_other",
    }))).value?.kind).toBe("scope_mismatch");
    expect(await store.get(OWNER_SCOPE, "managed-run_a")).toMatchObject({
      ok: true,
      value: { lastAcceptedReportSequence: 1 },
    });
  });

  it("claims reduces and settles one pending continuation without cursor regression", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(true);
    const claim = {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_a",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_200,
      expiresAtMs: 1_800_000_060_200,
    };

    expect((await store.claimContinuation(OWNER_SCOPE, claim)).value?.kind).toBe("claimed");
    expect((await store.claimContinuation(OWNER_SCOPE, claim)).value?.kind).toBe("identical_replay");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_a",
      throughReportSequence: 1,
      status: "active",
      statusReason: "report_activity",
      committedAtMs: 1_800_000_000_300,
    })).value?.kind).toBe("updated");
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_a",
      outcome: "completed",
      recordedAtMs: 1_800_000_000_400,
    })).value?.kind).toBe("updated");
    expect(await store.get(OWNER_SCOPE, "managed-run_a")).toMatchObject({
      ok: true,
      value: {
        lastAcceptedReportSequence: 1,
        lastReducedReportSequence: 1,
        pendingContinuation: false,
        status: "active",
      },
    });

    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_b",
      contentRef: "report-content_b",
      contentHash: "e".repeat(64),
      receivedAtMs: 1_800_000_000_500,
      retainedUntilMs: 1_802_592_000_500,
    }))).ok).toBe(true);
    expect((await store.claimContinuation(OWNER_SCOPE, {
      ...claim,
      claimId: "continuation-claim_stale",
    })).value?.kind).toBe("cursor_mismatch");
  });

  it("validates terminal and workspace binding ownership before durable mutation", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);

    expect((await store.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal_a",
      terminalTenantId: "tenant_b",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_100,
    })).value?.kind).toBe("ownership_mismatch");
    expect((await store.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal_a",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_100,
    })).value?.kind).toBe("bound");
    expect((await store.setWorkspaceLease(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      leaseTenantId: "tenant_a",
      leaseAgentId: "agent_a",
      boundAtMs: 1_800_000_000_200,
    })).value?.kind).toBe("bound");
  });

  it("stores no private report body or service credential columns", () => {
    const runColumns = new Set(
      (db.prepare("PRAGMA table_info(managed_runs)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const reportColumns = new Set(
      (db.prepare("PRAGMA table_info(managed_run_reports)").all() as Array<{ name: string }>).map((row) => row.name),
    );

    for (const forbidden of ["summary", "details", "body", "bearer", "credential", "registration_nonce", "external_run_ref"]) {
      expect(runColumns.has(forbidden), forbidden).toBe(false);
      expect(reportColumns.has(forbidden), forbidden).toBe(false);
    }
  });
});

describe("managed-run restart recovery scans", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("survives close and reopen while quarantining one corrupt recoverable row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-run-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "managed-runs.db");
    const firstDb = new Database(databasePath);
    ensureManagedRunTables(firstDb);
    const firstStore = createSqliteManagedRunStore(firstDb);
    expect((await firstStore.create(makeRecord({ managedRunId: "managed-run_valid" }))).ok).toBe(true);
    expect((await firstStore.create(makeRecord({
      managedRunId: "managed-run_corrupt",
      activationDescriptorRef: "activation-descriptor_corrupt",
    }))).ok).toBe(true);
    firstDb.prepare("UPDATE managed_runs SET turn_scope = ? WHERE managed_run_id = ?")
      .run("{not-json", "managed-run_corrupt");
    firstDb.close();

    const reopenedDb = new Database(databasePath);
    ensureManagedRunTables(reopenedDb);
    const reopenedStore = createSqliteManagedRunStore(reopenedDb);
    const scan = await reopenedStore.listRecoverable({
      kind: "recovery",
      statuses: ["preparing", "unknown"],
      updatedBeforeMs: 1_800_000_000_001,
      limit: 10,
    });

    expect(scan).toEqual({
      ok: true,
      value: {
        records: [expect.objectContaining({ managedRunId: "managed-run_valid" })],
        invalid: [{
          managedRunId: "managed-run_corrupt",
          serviceInstanceId: "service-instance_a",
          reason: "record_validation_failed",
        }],
      },
    });
    reopenedDb.close();
  });
});
