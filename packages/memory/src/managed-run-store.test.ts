// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversationRef,
  type ManagedEvidenceAppendInput,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
  type ManagedRunReportAppendInput,
  type ManagedRunServiceScope,
} from "@comis/core";
import { ensureManagedRunTables } from "./schema-managed-runs.js";
import { createManagedRunAttentionStoreStatements } from "./managed-run-attention-store.js";
import { createSqliteManagedRunStore } from "./managed-run-store.js";
import {
  parseStoredManagedRunRecord,
  rowToManagedRunRecord,
} from "./managed-run-store-record.js";

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
    activationDescriptorDigest: "d".repeat(64),
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
    traceId: "10000000-0000-4000-8000-000000000001",
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

function evidenceInput(overrides: Partial<ManagedEvidenceAppendInput> = {}): ManagedEvidenceAppendInput {
  return {
    managedRunId: "managed-run_a",
    evidenceRef: "evidence_a",
    kind: "candidate_bundle",
    subjectDigest: "a".repeat(64),
    observedAtMs: 1_800_000_000_100,
    expiresAtMs: 1_800_000_060_100,
    contentRef: "evidence-content_a",
    contentHash: "b".repeat(64),
    privateContentHash: "c".repeat(64),
    verificationLevel: "adapter_verified",
    deliveryKind: "none",
    receivedAtMs: 1_800_000_000_200,
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

  it("rejects authority tables that omit required identity and outcome columns", () => {
    for (const fixture of [
      {
        table: "workspace_leases",
        missing: "filesystem_birthtime_ns",
      },
      {
        table: "execution_attachments",
        missing: "source_filesystem_birthtime_ns",
      },
      {
        table: "managed_run_continuation_claims",
        missing: "reduction_outcome",
      },
      {
        table: "managed_run_attention_operations",
        missing: "tenant_id",
      },
    ] as const) {
      const incompatibleDb = new Database(":memory:");
      incompatibleDb.exec(`CREATE TABLE ${fixture.table} (record_id TEXT)`);
      expect(() => ensureManagedRunTables(incompatibleDb)).toThrow(
        `${fixture.table} database schema is incompatible: missing ${fixture.missing}`,
      );
      incompatibleDb.close();
    }
  });

  it("appends immutable evidence and resolves only exact owner-scoped references", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    const input = evidenceInput();

    const accepted = await store.appendEvidence(SERVICE_SCOPE, input);
    expect(accepted).toMatchObject({
      ok: true,
      value: { kind: "accepted", evidence: { ...input, schemaVersion: 1 } },
    });
    expect(await store.appendEvidence(SERVICE_SCOPE, input)).toEqual({
      ok: true,
      value: {
        kind: "identical_replay",
        evidence: { ...input, schemaVersion: 1, serviceInstanceId: "service-instance_a" },
      },
    });
    expect(await store.appendEvidence(SERVICE_SCOPE, {
      ...input,
      receivedAtMs: input.receivedAtMs + 1,
    })).toEqual({
      ok: true,
      value: {
        kind: "identical_replay",
        evidence: { ...input, schemaVersion: 1, serviceInstanceId: "service-instance_a" },
      },
    });
    expect((await store.appendEvidence(SERVICE_SCOPE, {
      ...input,
      contentHash: "d".repeat(64),
    })).value).toMatchObject({ kind: "replay_conflict" });
    expect((await store.appendEvidence(OTHER_SERVICE_SCOPE, {
      ...input,
      evidenceRef: "evidence_other",
    })).value).toMatchObject({ kind: "scope_mismatch" });

    expect(await store.listEvidenceByRefs(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRefs: ["evidence_a"],
    })).toEqual({
      ok: true,
      value: [{ ...input, schemaVersion: 1, serviceInstanceId: "service-instance_a" }],
    });
    expect(await store.listEvidenceByRefs(OTHER_OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRefs: ["evidence_a"],
    })).toEqual({ ok: true, value: [] });

    db.prepare("UPDATE managed_run_evidence SET subject_digest = 'invalid' WHERE evidence_ref = 'evidence_a'").run();
    expect((await store.appendEvidence(SERVICE_SCOPE, input)).ok).toBe(false);
    expect((await store.listEvidenceByRefs(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRefs: ["evidence_a"],
    })).ok).toBe(false);
  });

  it("rejects invalid unavailable and inactive evidence operations", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.appendEvidence(SERVICE_SCOPE, evidenceInput({
      subjectDigest: "invalid",
    }))).ok).toBe(false);
    expect((await store.appendEvidence(SERVICE_SCOPE, evidenceInput({
      managedRunId: "managed-run_missing",
    }))).value).toEqual({ kind: "not_found" });

    expect((await store.create(makeRecord())).ok).toBe(true);
    expect((await store.appendEvidence(SERVICE_SCOPE, evidenceInput())).value).toEqual({
      kind: "state_mismatch",
      status: "preparing",
    });
    expect((await store.listEvidenceByRefs(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRefs: ["evidence_a", "evidence_a"],
    })).ok).toBe(false);
    expect((await store.getByExternalRunRef(OWNER_SCOPE, "", "external-run_a")).ok).toBe(false);
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

  it("resolves an external run reference only inside its exact owner and service scope", async () => {
    const store = createSqliteManagedRunStore(db);
    const externalRunRef = "external-run_a";
    const record = makeRecord({
      externalRunRefDigest: createHash("sha256").update(externalRunRef, "utf8").digest("hex"),
    });
    expect((await store.create(record)).ok).toBe(true);

    expect(await store.getByExternalRunRef(OWNER_SCOPE, "service-instance_a", externalRunRef))
      .toEqual({ ok: true, value: record });
    expect(await store.getByExternalRunRef(OTHER_OWNER_SCOPE, "service-instance_a", externalRunRef))
      .toEqual({ ok: true, value: undefined });
    expect(await store.getByExternalRunRef(OWNER_SCOPE, "service-instance_b", externalRunRef))
      .toEqual({ ok: true, value: undefined });
    expect(await store.getByExternalRunRef(OWNER_SCOPE, "service-instance_a", "external-run_b"))
      .toEqual({ ok: true, value: undefined });

    expect((await store.create({
      ...record,
      managedRunId: "managed-run_b",
      activationDescriptorDigest: "e".repeat(64),
      activationDescriptorRef: "activation-descriptor_b",
    })).ok).toBe(true);
    expect((await store.getByExternalRunRef(OWNER_SCOPE, "service-instance_a", externalRunRef)).ok)
      .toBe(false);
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
      value: {
        lastAcceptedReportSequence: 2,
        pendingContinuation: true,
        lastHeartbeatAtMs: 1_800_000_000_200,
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM managed_run_reports").get()).toEqual({ count: 2 });
  });

  it("reads an exact contiguous report range only through the run owner scope", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(true);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_b",
      contentRef: "report-content_b",
      contentHash: "e".repeat(64),
      kind: "paused",
      receivedAtMs: 1_800_000_000_200,
      retainedUntilMs: 1_802_592_000_200,
    }))).ok).toBe(true);

    const range = await store.listReportRange(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      afterSequence: 0,
      throughSequence: 2,
    });
    expect(range).toMatchObject({
      ok: true,
      value: [
        { sequence: 1, kind: "progress", serviceReportId: "service-report_a" },
        { sequence: 2, kind: "paused", serviceReportId: "service-report_b" },
      ],
    });
    expect(await store.listReportRange(OTHER_OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      afterSequence: 0,
      throughSequence: 2,
    })).toEqual({ ok: true, value: [] });
    expect((await store.listReportRange(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      afterSequence: 2,
      throughSequence: 1,
    })).ok).toBe(false);
  });

  it("creates delivers and resolves durable attention without equating delivery to resolution", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_attention",
      contentRef: "report-content_attention",
      kind: "attention",
      attention: {
        attentionId: "attention-a",
        attentionRef: "report-content_attention",
        externalKey: "approval-a",
      },
    }))).value?.kind).toBe("accepted");

    const open = await store.listOpenAttention(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      limit: 10,
    });
    expect(open).toMatchObject({
      ok: true,
      value: [{
        attentionId: "attention-a",
        externalKey: "approval-a",
        status: "open",
        reportSequence: 1,
      }],
    });
    expect(await store.listOpenAttention(OTHER_OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      limit: 10,
    })).toEqual({ ok: true, value: [] });

    const claimed = await store.claimAttentionResponse(OWNER_SCOPE, {
      operationId: "attention-response-a",
      attentionId: "attention-a",
      responseRef: "attention-response-content-a",
      respondedAtMs: 1_800_000_000_200,
    });
    expect(claimed).toMatchObject({
      ok: true,
      value: { kind: "updated", record: { status: "response_pending" } },
    });
    const delivered = await store.markAttentionDelivered(OWNER_SCOPE, {
      operationId: "attention-delivery-a",
      attentionId: "attention-a",
      deliveredAtMs: 1_800_000_000_300,
    });
    expect(delivered).toMatchObject({
      ok: true,
      value: { kind: "updated", record: { status: "delivered" } },
    });
    expect(await store.listOpenAttention(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      limit: 10,
    })).toMatchObject({ ok: true, value: [{ status: "delivered" }] });

    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_resolution",
      contentRef: "report-content_resolution",
      kind: "resolution",
      receivedAtMs: 1_800_000_000_400,
      retainedUntilMs: 1_802_592_000_400,
      resolutionExternalKey: "approval-a",
    }))).value?.kind).toBe("accepted");
    expect(await store.listOpenAttention(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      limit: 10,
    })).toEqual({ ok: true, value: [] });
    expect(await store.getAttention(OWNER_SCOPE, "attention-a")).toMatchObject({
      ok: true,
      value: { status: "resolved", responseRef: "attention-response-content-a" },
    });
    expect(await store.get(OWNER_SCOPE, "managed-run_a")).toMatchObject({
      ok: true,
      value: { openAttentionCount: 0 },
    });
  });

  it("claims each owner response operation for only one attention handle", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    for (const [index, attentionId] of ["attention-operation-a", "attention-operation-b"].entries()) {
      expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
        serviceReportId: `service-report_${attentionId}`,
        contentRef: `report-content_${attentionId}`,
        kind: "attention",
        receivedAtMs: 1_800_000_000_100 + index,
        retainedUntilMs: 1_802_592_000_100 + index,
        attention: {
          attentionId,
          attentionRef: `report-content_${attentionId}`,
          externalKey: `approval-${index}`,
        },
      }))).value?.kind).toBe("accepted");
    }

    const operationId = "attention-response-owner-unique";
    expect((await store.claimAttentionResponse(OWNER_SCOPE, {
      operationId,
      attentionId: "attention-operation-a",
      responseRef: "attention-response-content-a",
      respondedAtMs: 1_800_000_000_200,
    })).value?.kind).toBe("updated");
    expect((await store.claimAttentionResponse(OWNER_SCOPE, {
      operationId,
      attentionId: "attention-operation-b",
      responseRef: "attention-response-content-b",
      respondedAtMs: 1_800_000_000_201,
    })).value?.kind).toBe("replay_conflict");
    const unclaimedAttention = await store.getAttention(OWNER_SCOPE, "attention-operation-b");
    expect(unclaimedAttention).toMatchObject({
      ok: true,
      value: { status: "open" },
    });
    expect(unclaimedAttention.value).not.toHaveProperty("responseRef");
    expect(await store.getAttentionResponseByOperation(OWNER_SCOPE, operationId)).toMatchObject({
      ok: true,
      value: { attentionId: "attention-operation-a", responseRef: "attention-response-content-a" },
    });
  });

  it("enforces durable attention replay scope state and timestamp boundaries", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_attention_replay",
      contentRef: "report-content_attention_replay",
      kind: "attention",
      attention: {
        attentionId: "attention-replay",
        attentionRef: "report-content_attention_replay",
        externalKey: "approval-replay",
      },
    }))).value?.kind).toBe("accepted");

    const response = {
      operationId: "attention-response-replay",
      attentionId: "attention-replay",
      responseRef: "attention-response-content-replay",
      respondedAtMs: 1_800_000_000_200,
    };
    expect((await store.markAttentionDelivered(OWNER_SCOPE, {
      operationId: "attention-delivery-too-early",
      attentionId: "attention-replay",
      deliveredAtMs: 1_800_000_000_150,
    })).value?.kind).toBe("state_mismatch");
    expect((await store.claimAttentionResponse(OWNER_SCOPE, {
      ...response,
      operationId: "attention-response-missing",
      attentionId: "attention-missing",
    })).value?.kind).toBe("not_found");
    expect((await store.claimAttentionResponse(OTHER_OWNER_SCOPE, response)).value?.kind).toBe("scope_mismatch");
    expect((await store.claimAttentionResponse(OWNER_SCOPE, {
      ...response,
      operationId: "attention-response-backward",
      respondedAtMs: 1_799_999_999_999,
    })).ok).toBe(false);

    expect((await store.claimAttentionResponse(OWNER_SCOPE, response)).value?.kind).toBe("updated");
    expect(await store.getAttentionResponseByOperation(
      OWNER_SCOPE,
      "attention-response-replay",
    )).toMatchObject({
      ok: true,
      value: { attentionId: "attention-replay", status: "response_pending" },
    });
    expect(await store.getAttentionResponseByOperation(
      OTHER_OWNER_SCOPE,
      "attention-response-replay",
    )).toEqual({ ok: true, value: undefined });
    expect((await store.claimAttentionResponse(OWNER_SCOPE, response)).value?.kind).toBe("identical_replay");
    expect((await store.claimAttentionResponse(OWNER_SCOPE, {
      ...response,
      responseRef: "attention-response-content-altered",
    })).value?.kind).toBe("replay_conflict");
    expect((await store.claimAttentionResponse(OTHER_OWNER_SCOPE, response)).value?.kind).toBe("scope_mismatch");
    expect((await store.claimAttentionResponse(OWNER_SCOPE, {
      ...response,
      operationId: "attention-response-after-claim",
    })).value?.kind).toBe("state_mismatch");

    const delivery = {
      operationId: "attention-delivery-replay",
      attentionId: "attention-replay",
      deliveredAtMs: 1_800_000_000_300,
    };
    expect((await store.markAttentionDelivered(OWNER_SCOPE, delivery)).value?.kind).toBe("updated");
    expect((await store.markAttentionDelivered(OWNER_SCOPE, delivery)).value?.kind).toBe("identical_replay");
    expect((await store.markAttentionDelivered(OWNER_SCOPE, {
      ...delivery,
      deliveredAtMs: 1_800_000_000_301,
    })).value?.kind).toBe("replay_conflict");
    expect((await store.markAttentionDelivered(OTHER_OWNER_SCOPE, delivery)).value?.kind).toBe("scope_mismatch");
  });

  it("rejects malformed attention descriptors collisions and invalid list bounds", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_attention_primary",
      contentRef: "report-content_attention_primary",
      kind: "attention",
      attention: {
        attentionId: "attention-primary",
        attentionRef: "report-content_attention_primary",
        externalKey: "approval-primary",
      },
    }))).value?.kind).toBe("accepted");

    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_attention_missing",
      contentRef: "report-content_attention_missing",
      kind: "attention",
    }))).ok).toBe(false);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_attention_unexpected",
      contentRef: "report-content_attention_unexpected",
      kind: "progress",
      attention: {
        attentionId: "attention-unexpected",
        attentionRef: "report-content_attention_unexpected",
      },
    }))).ok).toBe(false);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_resolution_unexpected",
      contentRef: "report-content_resolution_unexpected",
      kind: "progress",
      resolutionExternalKey: "approval-primary",
    }))).ok).toBe(false);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_attention_collision",
      contentRef: "report-content_attention_collision",
      kind: "attention",
      attention: {
        attentionId: "attention-collision",
        attentionRef: "report-content_attention_collision",
        externalKey: "approval-primary",
      },
    }))).ok).toBe(false);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_attention_identity_conflict",
      contentRef: "report-content_attention_identity_conflict",
      kind: "attention",
      attention: {
        attentionId: "attention-primary",
        attentionRef: "report-content_attention_identity_conflict",
        externalKey: "approval-other",
      },
    }))).ok).toBe(false);
    expect((await store.listOpenAttention(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      limit: 0,
    })).ok).toBe(false);
  });

  it("validates direct attention transitions and stored row corruption", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    const loaded = await store.get(OWNER_SCOPE, "managed-run_a");
    if (!loaded.ok || loaded.value === undefined) throw new Error("expected active managed run");
    const record = loaded.value;
    const attention = createManagedRunAttentionStoreStatements(db);
    const attentionInput = (attentionId: string, externalKey: string) => reportInput({
      kind: "attention",
      attention: {
        attentionId,
        attentionRef: `attention-content-${attentionId}`,
        externalKey,
      },
    });

    expect(attention.applyReport(record, 1, attentionInput("attention-direct", "approval-direct")).ok).toBe(true);
    expect(attention.applyReport(record, 2, attentionInput("attention-collision", "approval-direct")).ok).toBe(false);
    expect(attention.applyReport(record, 2, attentionInput("attention-direct", "approval-other")).ok).toBe(false);
    expect(attention.applyReport(record, 2, reportInput({
      kind: "attention",
      attention: {
        attentionId: "",
        attentionRef: "attention-content-invalid",
      },
    })).ok).toBe(false);
    expect(attention.applyReport(record, 2, reportInput({
      resolutionExternalKey: "approval-direct",
    })).ok).toBe(false);
    expect(attention.applyReport(record, 2, attentionInput("attention-invalid-response", "approval-invalid-response")).ok).toBe(true);
    expect(attention.claimResponse(OWNER_SCOPE, {
      operationId: "attention-response-invalid",
      attentionId: "attention-invalid-response",
      responseRef: "",
      respondedAtMs: 1_800_000_000_200,
    }).ok).toBe(false);

    expect(attention.claimResponse(OWNER_SCOPE, {
      operationId: "attention-response-corrupt",
      attentionId: "attention-direct",
      responseRef: "attention-response-content-direct",
      respondedAtMs: 1_800_000_000_200,
    }).value?.kind).toBe("updated");
    db.prepare(`
      UPDATE managed_run_attention_operations SET result_record = ?
      WHERE attention_id = ? AND operation_id = ? AND operation_kind = 'response'
    `).run("{", "attention-direct", "attention-response-corrupt");
    expect(attention.claimResponse(OWNER_SCOPE, {
      operationId: "attention-response-corrupt",
      attentionId: "attention-direct",
      responseRef: "attention-response-content-direct",
      respondedAtMs: 1_800_000_000_200,
    }).ok).toBe(false);
    db.prepare(`
      UPDATE managed_run_attention_operations SET result_record = ?
      WHERE attention_id = ? AND operation_id = ? AND operation_kind = 'response'
    `).run("{}", "attention-direct", "attention-response-corrupt");
    expect(attention.claimResponse(OWNER_SCOPE, {
      operationId: "attention-response-corrupt",
      attentionId: "attention-direct",
      responseRef: "attention-response-content-direct",
      respondedAtMs: 1_800_000_000_200,
    }).ok).toBe(false);

    expect(attention.applyReport(record, 3, attentionInput("attention-corrupt-row", "approval-corrupt-row")).ok).toBe(true);
    db.prepare("UPDATE managed_run_attention SET updated_at_ms = 'bad' WHERE attention_id = ?")
      .run("attention-corrupt-row");
    expect(attention.get(OWNER_SCOPE, "attention-corrupt-row").ok).toBe(false);
    expect(attention.applyReport(record, 3, attentionInput("attention-corrupt-row", "approval-corrupt-row")).ok).toBe(false);
    expect(attention.claimResponse(OWNER_SCOPE, {
      operationId: "attention-response-corrupt-row",
      attentionId: "attention-corrupt-row",
      responseRef: "attention-response-content-corrupt-row",
      respondedAtMs: 1_800_000_000_300,
    }).ok).toBe(false);
    expect(attention.listOpen(OWNER_SCOPE, { limit: 10 }).ok).toBe(false);
    db.prepare("UPDATE managed_run_attention SET updated_at_ms = ?, agent_id = '' WHERE attention_id = ?")
      .run(1_800_000_000_100, "attention-corrupt-row");
    expect(attention.listOpen({ ...OWNER_SCOPE, agentId: "" }, { limit: 10 }).ok).toBe(false);

    expect(attention.applyReport(record, 4, attentionInput("attention-corrupt-collision", "approval-corrupt-collision")).ok).toBe(true);
    db.prepare("UPDATE managed_run_attention SET updated_at_ms = 'bad' WHERE attention_id = ?")
      .run("attention-corrupt-collision");
    expect(attention.applyReport(record, 5, attentionInput("attention-collision-candidate", "approval-corrupt-collision")).ok).toBe(false);
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
      continuationOutcome: "completed",
      committedAtMs: 1_800_000_000_300,
    })).value?.kind).toBe("updated");
    expect(await store.claimContinuation(OWNER_SCOPE, claim)).toMatchObject({
      ok: true,
      value: {
        kind: "identical_replay",
        reducedRecord: {
          lastReducedReportSequence: 1,
          status: "active",
          statusReason: "report_activity",
        },
      },
    });
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

  it("settles a failed reduced interval without immediate replay", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(true);
    const claim = {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_failed_interval",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_200,
      expiresAtMs: 1_800_000_060_200,
    };
    expect((await store.claimContinuation(OWNER_SCOPE, claim)).value?.kind).toBe("claimed");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      managedRunId: claim.managedRunId,
      claimId: claim.claimId,
      throughReportSequence: claim.throughReportSequence,
      status: "unknown",
      statusReason: "service_state_unavailable",
      continuationOutcome: "failed",
      committedAtMs: 1_800_000_000_300,
    })).value?.kind).toBe("updated");
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      managedRunId: claim.managedRunId,
      claimId: claim.claimId,
      outcome: "failed",
      recordedAtMs: 1_800_000_000_400,
    })).value?.kind).toBe("updated");
    expect(await store.get(OWNER_SCOPE, claim.managedRunId)).toMatchObject({
      ok: true,
      value: {
        lastAcceptedReportSequence: 1,
        lastReducedReportSequence: 1,
        pendingContinuation: false,
        status: "unknown",
      },
    });

    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_after_failure",
      contentRef: "report-content_after_failure",
      contentHash: "e".repeat(64),
      receivedAtMs: 1_800_000_000_500,
      retainedUntilMs: 1_802_592_000_500,
    }))).value?.kind).toBe("accepted");
    expect((await store.claimContinuation(OWNER_SCOPE, {
      ...claim,
      claimId: "continuation-claim_after_failure",
      throughReportSequence: 2,
      claimedAtMs: 1_800_000_000_600,
      expiresAtMs: 1_800_000_060_600,
    })).value?.kind).toBe("claimed");
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

  it("releases only the exact service run lease and terminal binding", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.releaseTerminal(SERVICE_SCOPE, {
      managedRunId: "managed-run_missing",
      workspaceLeaseId: "workspace-lease_a",
      terminalSessionId: "terminal_a",
      releasedAtMs: 1_800_000_000_200,
    })).value?.kind).toBe("not_found");
    expect((await store.create(makeRecord({ workspaceLeaseId: "workspace-lease_a" }))).ok).toBe(true);
    expect((await store.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal_a",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_100,
    })).value?.kind).toBe("bound");
    const release = {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      terminalSessionId: "terminal_a",
      releasedAtMs: 1_800_000_000_200,
    };

    expect((await store.releaseTerminal(OTHER_SERVICE_SCOPE, release)).value?.kind)
      .toBe("scope_mismatch");
    expect((await store.releaseTerminal(SERVICE_SCOPE, {
      ...release,
      workspaceLeaseId: "workspace-lease_b",
    })).value?.kind).toBe("ownership_mismatch");
    expect((await store.releaseTerminal(SERVICE_SCOPE, {
      ...release,
      releasedAtMs: 1_799_999_999_999,
    })).ok).toBe(false);
    expect((await store.releaseTerminal(SERVICE_SCOPE, release)).value?.kind).toBe("released");
    expect((await store.releaseTerminal(SERVICE_SCOPE, release)).value?.kind)
      .toBe("identical_replay");
    expect(await store.get(OWNER_SCOPE, "managed-run_a")).toMatchObject({
      ok: true,
      value: { terminalSessionIds: [], updatedAtMs: 1_800_000_000_200 },
    });
  });

  it("atomically blocks new resource bindings after durable lease release reservation", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord({ workspaceLeaseId: "workspace-lease_a" }))).ok).toBe(true);
    const reservation = {
      operationId: "operation_release_reserved",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "reap_safe" as const,
      releasedAtMs: 1_800_000_000_100,
    };

    expect((await store.reserveRelease(SERVICE_SCOPE, reservation)).value?.kind).toBe("reserved");
    expect((await store.reserveRelease(SERVICE_SCOPE, reservation)).value?.kind).toBe("identical_replay");
    expect((await store.reserveRelease(SERVICE_SCOPE, {
      ...reservation,
      disposition: "preserve",
    })).value?.kind).toBe("replay_conflict");
    expect((await store.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal_after_release_reservation",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_200,
    })).value?.kind).toBe("release_reserved");
    expect((await store.bindExecutionAttachment(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      executionAttachmentId: "execution-attachment_after_release_reservation",
      attachmentServiceInstanceId: "service-instance_a",
      attachmentTenantId: "tenant_a",
      attachmentAgentId: "agent_a",
      boundAtMs: 1_800_000_000_200,
    })).value?.kind).toBe("release_reserved");
  });

  it("binds an execution attachment only under the exact run lease and owner", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord({ workspaceLeaseId: "workspace-lease_a" }))).ok).toBe(true);
    const binding = {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      executionAttachmentId: "execution-attachment_a",
      attachmentServiceInstanceId: "service-instance_a",
      attachmentTenantId: "tenant_a",
      attachmentAgentId: "agent_a",
      boundAtMs: 1_800_000_000_100,
    };

    expect((await store.bindExecutionAttachment(OWNER_SCOPE, binding)).value?.kind).toBe("bound");
    expect((await store.bindExecutionAttachment(OWNER_SCOPE, binding)).value?.kind).toBe("identical_replay");
    expect(await store.get(OWNER_SCOPE, "managed-run_a")).toMatchObject({
      ok: true,
      value: { executionAttachmentIds: ["execution-attachment_a"] },
    });
    expect((await store.bindExecutionAttachment(OWNER_SCOPE, {
      ...binding,
      executionAttachmentId: "execution-attachment_b",
      workspaceLeaseId: "workspace-lease_b",
      boundAtMs: 1_800_000_000_200,
    })).value?.kind).toBe("ownership_mismatch");
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

  it("returns explicit boundary outcomes for invalid transitions reports and bindings", async () => {
    const store = createSqliteManagedRunStore(db);
    const transition = {
      operationId: "operation_missing",
      managedRunId: "managed-run_missing",
      expectedStatuses: ["preparing" as const],
      nextStatus: "active" as const,
      nextStatusReason: "activation_acknowledged" as const,
      transitionedAtMs: 1_800_000_000_100,
    };
    expect((await store.claimTransition(SERVICE_SCOPE, transition)).value?.kind).toBe("not_found");
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      managedRunId: "managed-run_missing",
    }))).value?.kind).toBe("not_found");
    expect((await store.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_missing",
      terminalSessionId: "terminal_missing",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_100,
    })).value?.kind).toBe("not_found");
    expect((await store.claimContinuation(OWNER_SCOPE, {
      managedRunId: "managed-run_missing",
      claimId: "continuation-claim_missing",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_100,
      expiresAtMs: 1_800_000_060_100,
    })).value?.kind).toBe("not_found");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      managedRunId: "managed-run_missing",
      claimId: "continuation-claim_missing",
      throughReportSequence: 1,
      status: "active",
      statusReason: "report_activity",
      continuationOutcome: "completed",
      committedAtMs: 1_800_000_000_200,
    })).value?.kind).toBe("not_found");
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      managedRunId: "managed-run_missing",
      claimId: "continuation-claim_missing",
      outcome: "completed",
      recordedAtMs: 1_800_000_000_300,
    })).value?.kind).toBe("not_found");
    expect((await store.revoke(OWNER_SCOPE, {
      operationId: "operation_revoke_missing",
      managedRunId: "managed-run_missing",
      reason: "owner_cancelled",
      revokedAtMs: 1_800_000_000_100,
    })).value?.kind).toBe("not_found");

    expect((await store.create(makeRecord({ capturedToolIds: ["z_tool", "a_tool"] }))).ok).toBe(false);
    expect((await store.create(makeRecord())).ok).toBe(true);
    expect((await store.claimTransition(SERVICE_SCOPE, {
      ...transition,
      operationId: "operation_state_mismatch",
      managedRunId: "managed-run_a",
      expectedStatuses: ["active"],
    })).value).toEqual({ kind: "state_mismatch", status: "preparing" });
    expect((await store.claimTransition(SERVICE_SCOPE, {
      ...transition,
      operationId: "operation_time_regression",
      managedRunId: "managed-run_a",
      transitionedAtMs: 1_799_999_999_999,
    })).ok).toBe(false);

    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      receivedAtMs: 1_800_000_000_049,
    }))).ok).toBe(false);
    expect((await store.bindTerminal(OTHER_OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal_scope_mismatch",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_100,
    })).value?.kind).toBe("scope_mismatch");
    expect((await store.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal_time_regression",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_049,
    })).ok).toBe(false);

    const terminalBinding = {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal_replay",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_100,
    };
    expect((await store.bindTerminal(OWNER_SCOPE, terminalBinding)).value?.kind).toBe("bound");
    expect((await store.bindTerminal(OWNER_SCOPE, terminalBinding)).value?.kind).toBe("identical_replay");
    const leaseBinding = {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_replay",
      leaseTenantId: "tenant_a",
      leaseAgentId: "agent_a",
      boundAtMs: 1_800_000_000_200,
    };
    expect((await store.setWorkspaceLease(OWNER_SCOPE, leaseBinding)).value?.kind).toBe("bound");
    expect((await store.setWorkspaceLease(OWNER_SCOPE, leaseBinding)).value?.kind).toBe("identical_replay");
    expect((await store.setWorkspaceLease(OWNER_SCOPE, {
      ...leaseBinding,
      workspaceLeaseId: "workspace-lease_conflict",
      boundAtMs: 1_800_000_000_300,
    })).value?.kind).toBe("ownership_mismatch");

    expect((await store.listScoped({ scope: OWNER_SCOPE, limit: 0 })).ok).toBe(false);
    expect(await store.listScoped({ scope: OWNER_SCOPE, statuses: ["waiting"], limit: 10 }))
      .toEqual({ ok: true, value: [] });
    expect((await store.listRecoverable({
      kind: "recovery",
      statuses: [],
      updatedBeforeMs: 1_800_000_001_000,
      limit: 10,
    })).ok).toBe(false);
  });

  it("guards continuation claims reductions and outcomes across every authority check", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(true);
    const claim = {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_guarded",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_200,
      expiresAtMs: 1_800_000_060_200,
    };

    expect((await store.claimContinuation(OTHER_OWNER_SCOPE, claim)).value?.kind).toBe("scope_mismatch");
    expect((await store.claimContinuation(OWNER_SCOPE, {
      ...claim,
      expiresAtMs: claim.claimedAtMs,
    })).ok).toBe(false);
    expect((await store.claimContinuation(OWNER_SCOPE, claim)).value?.kind).toBe("claimed");
    expect((await store.claimContinuation(OTHER_OWNER_SCOPE, claim)).value?.kind).toBe("scope_mismatch");
    expect((await store.claimContinuation(OWNER_SCOPE, {
      ...claim,
      throughReportSequence: 2,
    })).value?.kind).toBe("replay_conflict");
    expect((await store.claimContinuation(OWNER_SCOPE, {
      ...claim,
      claimId: "continuation-claim_parallel",
    })).value?.kind).toBe("not_pending");

    const reduction = {
      managedRunId: "managed-run_a",
      claimId: claim.claimId,
      throughReportSequence: 1,
      status: "active" as const,
      statusReason: "report_activity" as const,
      continuationOutcome: "completed" as const,
      committedAtMs: 1_800_000_000_300,
    };
    expect((await store.commitReducedState(OTHER_OWNER_SCOPE, reduction)).value?.kind).toBe("scope_mismatch");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      ...reduction,
      claimId: "continuation-claim_missing",
    })).value?.kind).toBe("claim_mismatch");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      ...reduction,
      throughReportSequence: 2,
    })).value?.kind).toBe("cursor_regression");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      ...reduction,
      status: "preparing",
      statusReason: "awaiting_activation",
    })).value?.kind).toBe("invalid_transition");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      ...reduction,
      committedAtMs: 1_800_000_000_099,
    })).ok).toBe(false);
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: claim.claimId,
      outcome: "completed",
      recordedAtMs: 1_800_000_000_300,
    })).value?.kind).toBe("claim_mismatch");
    expect((await store.commitReducedState(OWNER_SCOPE, reduction)).value?.kind).toBe("updated");
    expect((await store.commitReducedState(OWNER_SCOPE, reduction)).value?.kind).toBe("identical_replay");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      ...reduction,
      status: "waiting",
      statusReason: "attention_pending",
    })).value?.kind).toBe("claim_mismatch");
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: claim.claimId,
      outcome: "completed",
      recordedAtMs: 1_800_000_000_299,
    })).ok).toBe(false);

    const outcome = {
      managedRunId: "managed-run_a",
      claimId: claim.claimId,
      outcome: "completed" as const,
      recordedAtMs: 1_800_000_000_400,
    };
    expect((await store.markContinuationOutcome(OTHER_OWNER_SCOPE, outcome)).value?.kind).toBe("scope_mismatch");
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      ...outcome,
      claimId: "continuation-claim_missing",
    })).value?.kind).toBe("claim_mismatch");
    expect((await store.markContinuationOutcome(OWNER_SCOPE, outcome)).value?.kind).toBe("updated");
    expect((await store.markContinuationOutcome(OWNER_SCOPE, outcome)).value?.kind).toBe("identical_replay");
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      ...outcome,
      outcome: "failed",
    })).value?.kind).toBe("claim_mismatch");
  });

  it("rejects malformed continuation rows at every mutation boundary", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(true);
    const claim = {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_malformed",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_200,
      expiresAtMs: 1_800_000_060_200,
    };
    expect((await store.claimContinuation(OWNER_SCOPE, claim)).value?.kind).toBe("claimed");
    db.prepare("UPDATE managed_run_continuation_claims SET claimed_at_ms = 'bad' WHERE claim_id = ?")
      .run(claim.claimId);

    expect((await store.claimContinuation(OWNER_SCOPE, claim)).ok).toBe(false);
    expect((await store.commitReducedState(OWNER_SCOPE, {
      managedRunId: claim.managedRunId,
      claimId: claim.claimId,
      throughReportSequence: claim.throughReportSequence,
      status: "active",
      statusReason: "report_activity",
      continuationOutcome: "completed",
      committedAtMs: 1_800_000_000_300,
    })).ok).toBe(false);
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      managedRunId: claim.managedRunId,
      claimId: claim.claimId,
      outcome: "completed",
      recordedAtMs: 1_800_000_000_400,
    })).ok).toBe(false);
  });

  it("rejects a reduced continuation whose durable outcome is missing", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(true);
    const claim = {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_missing-outcome",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_200,
      expiresAtMs: 1_800_000_060_200,
    };
    expect((await store.claimContinuation(OWNER_SCOPE, claim)).value?.kind).toBe("claimed");
    expect((await store.commitReducedState(OWNER_SCOPE, {
      managedRunId: claim.managedRunId,
      claimId: claim.claimId,
      throughReportSequence: claim.throughReportSequence,
      status: "active",
      statusReason: "report_activity",
      continuationOutcome: "completed",
      committedAtMs: 1_800_000_000_300,
    })).value?.kind).toBe("updated");
    db.prepare("UPDATE managed_run_continuation_claims SET reduction_outcome = NULL WHERE claim_id = ?")
      .run(claim.claimId);

    expect(await store.claimContinuation(OWNER_SCOPE, claim)).toEqual({
      ok: false,
      error: new Error("managed-run continuation reduction is missing its durable outcome"),
    });
  });

  it("atomically completes a paused run after verified handback evidence", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    await activate(store);
    expect((await store.claimTransition(SERVICE_SCOPE, {
      operationId: "operation_pause_for_handback",
      managedRunId: "managed-run_a",
      expectedStatuses: ["active"],
      nextStatus: "paused",
      nextStatusReason: "service_paused",
      transitionedAtMs: 1_800_000_000_100,
    })).value?.kind).toBe("claimed");
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      kind: "candidate_complete",
      receivedAtMs: 1_800_000_000_150,
    }))).value?.kind).toBe("accepted");
    expect((await store.claimContinuation(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_handback",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_200,
      expiresAtMs: 1_800_000_060_200,
    })).value?.kind).toBe("claimed");

    const completed = await store.commitReducedState(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_handback",
      throughReportSequence: 1,
      status: "succeeded",
      statusReason: "outcome_verified",
      continuationOutcome: "completed",
      terminalOutcome: { kind: "succeeded", recordedAtMs: 1_800_000_000_300 },
      committedAtMs: 1_800_000_000_300,
    });

    expect(completed).toMatchObject({
      ok: true,
      value: {
        kind: "updated",
        record: {
          status: "succeeded",
          statusReason: "outcome_verified",
          lastReducedReportSequence: 1,
        },
      },
    });
  });

  it("supports revocation replay while preserving exact owner scope", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    const revocation = {
      operationId: "operation_revoke",
      managedRunId: "managed-run_a",
      reason: "owner_cancelled" as const,
      revokedAtMs: 1_800_000_000_100,
    };
    expect((await store.revoke(OTHER_OWNER_SCOPE, revocation)).value?.kind).toBe("scope_mismatch");
    expect((await store.revoke(OWNER_SCOPE, revocation)).value?.kind).toBe("claimed");
    expect((await store.revoke(OWNER_SCOPE, revocation)).value?.kind).toBe("identical_replay");
    expect((await store.revoke(OWNER_SCOPE, {
      ...revocation,
      reason: "authority_revoked",
    })).value?.kind).toBe("replay_conflict");
  });

  it("rejects every malformed serialized field before rebuilding a managed run", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    const row = db.prepare("SELECT * FROM managed_runs WHERE managed_run_id = ?")
      .get("managed-run_a") as Parameters<typeof rowToManagedRunRecord>[0];

    expect(parseStoredManagedRunRecord("{not-json").ok).toBe(false);
    for (const field of [
      "delivery_origin",
      "response_locale_policy",
      "captured_agent_capabilities",
      "captured_tool_ids",
      "execution_attachment_ids",
      "terminal_session_ids",
      "terminal_outcome",
    ] as const) {
      expect(rowToManagedRunRecord({ ...row, [field]: "{not-json" }).ok, field).toBe(false);
    }
  });

  it("contains corrupt rows and converts database exceptions into results", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE managed_runs SET pending_continuation = 2 WHERE managed_run_id = ?")
      .run("managed-run_a");
    expect((await store.get(OWNER_SCOPE, "managed-run_a")).ok).toBe(false);
    expect((await store.listScoped({ scope: OWNER_SCOPE, limit: 10 })).ok).toBe(false);
    db.prepare("UPDATE managed_runs SET pending_continuation = 0 WHERE managed_run_id = ?")
      .run("managed-run_a");
    db.close();
    expect((await store.get(OWNER_SCOPE, "managed-run_a")).ok).toBe(false);
    db = new Database(":memory:");
    ensureManagedRunTables(db);
  });

  it("contains corrupt transactional rows without widening durable authority", async () => {
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord({
      externalRunRefDigest: createHash("sha256").update("external-run_a", "utf8").digest("hex"),
    }))).ok).toBe(true);
    await activate(store);

    db.prepare("UPDATE managed_run_operations SET input_hash = ? WHERE operation_id = ?")
      .run(Buffer.from([0]), "operation_activate");
    expect((await store.claimTransition(SERVICE_SCOPE, {
      operationId: "operation_activate",
      managedRunId: "managed-run_a",
      expectedStatuses: ["preparing"],
      nextStatus: "active",
      nextStatusReason: "activation_acknowledged",
      transitionedAtMs: 1_800_000_000_050,
    })).ok).toBe(false);

    db.prepare("UPDATE managed_runs SET response_locale_policy = ? WHERE managed_run_id = ?")
      .run("{not-json", "managed-run_a");
    expect((await store.claimTransition(SERVICE_SCOPE, {
      operationId: "operation_corrupt_run",
      managedRunId: "managed-run_a",
      expectedStatuses: ["active"],
      nextStatus: "waiting",
      nextStatusReason: "attention_pending",
      transitionedAtMs: 1_800_000_000_100,
    })).ok).toBe(false);
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(false);
    expect((await store.appendEvidence(SERVICE_SCOPE, evidenceInput())).ok).toBe(false);
    expect((await store.listEvidenceByRefs(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      evidenceRefs: ["evidence_a"],
    })).ok).toBe(false);
    expect((await store.getByExternalRunRef(OWNER_SCOPE, "service-instance_a", "external-run_a")).ok)
      .toBe(false);
    expect((await store.releaseTerminal(SERVICE_SCOPE, {
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      terminalSessionId: "terminal_corrupt_run",
      releasedAtMs: 1_800_000_000_100,
    })).ok).toBe(false);
    expect((await store.bindTerminal(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      terminalSessionId: "terminal_corrupt_run",
      terminalTenantId: "tenant_a",
      terminalAgentId: "agent_a",
      boundAtMs: 1_800_000_000_100,
    })).ok).toBe(false);
    expect((await store.claimContinuation(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_corrupt_run",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_100,
      expiresAtMs: 1_800_000_060_100,
    })).ok).toBe(false);
    expect((await store.commitReducedState(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_corrupt_run",
      throughReportSequence: 1,
      status: "active",
      statusReason: "report_activity",
      continuationOutcome: "completed",
      committedAtMs: 1_800_000_000_200,
    })).ok).toBe(false);
    expect((await store.markContinuationOutcome(OWNER_SCOPE, {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_corrupt_run",
      outcome: "completed",
      recordedAtMs: 1_800_000_000_300,
    })).ok).toBe(false);
    expect((await store.listScoped({ scope: OWNER_SCOPE, limit: 10 })).ok).toBe(false);

    db.prepare("UPDATE managed_runs SET response_locale_policy = ? WHERE managed_run_id = ?")
      .run(JSON.stringify(makeRecord().responseLocalePolicy), "managed-run_a");
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput({
      serviceReportId: "service-report_bad_retention",
      contentRef: "report-content_bad_retention",
      receivedAtMs: 1_800_000_000_200,
      retainedUntilMs: 1_800_000_000_199,
    }))).ok).toBe(false);

    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(true);
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE managed_run_reports SET schema_version = 2 WHERE service_report_id = ?")
      .run("service-report_a");
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(false);
    db.prepare("UPDATE managed_run_reports SET schema_version = 1, kind = ? WHERE service_report_id = ?")
      .run("invalid-kind", "service-report_a");
    expect((await store.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(false);
  });
});

describe("managed-run restart recovery scans", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("pages a stable managed-run recovery snapshot to exhaustion", async () => {
    const db = new Database(":memory:");
    ensureManagedRunTables(db);
    const store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord({ managedRunId: "managed-run_a" }))).ok).toBe(true);
    expect((await store.create(makeRecord({ managedRunId: "managed-run_b" }))).ok).toBe(true);
    const input = {
      kind: "recovery" as const,
      statuses: ["preparing" as const],
      updatedBeforeMs: 1_800_000_000_000,
      limit: 1,
    };

    const first = await store.listRecoverable(input);
    const second = await store.listRecoverable({ ...input, afterManagedRunId: "managed-run_a" });
    const exhausted = await store.listRecoverable({ ...input, afterManagedRunId: "managed-run_b" });

    expect(first).toMatchObject({
      ok: true,
      value: { records: [{ managedRunId: "managed-run_a" }], nextAfterManagedRunId: "managed-run_a" },
    });
    expect(second).toMatchObject({
      ok: true,
      value: { records: [{ managedRunId: "managed-run_b" }], nextAfterManagedRunId: "managed-run_b" },
    });
    expect(exhausted).toEqual({ ok: true, value: { records: [], invalid: [] } });
    db.close();
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

  it("recovers the recorded failed continuation outcome after reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-run-continuation-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "managed-runs.db");
    const firstDb = new Database(databasePath);
    ensureManagedRunTables(firstDb);
    const firstStore = createSqliteManagedRunStore(firstDb);
    expect((await firstStore.create(makeRecord())).ok).toBe(true);
    await activate(firstStore);
    expect((await firstStore.appendReportAndAdvanceAcceptedCursor(SERVICE_SCOPE, reportInput())).ok).toBe(true);
    const claim = {
      managedRunId: "managed-run_a",
      claimId: "continuation-claim_reopen_failure",
      throughReportSequence: 1,
      claimedAtMs: 1_800_000_000_200,
      expiresAtMs: 1_800_000_060_200,
    };
    expect((await firstStore.claimContinuation(OWNER_SCOPE, claim)).value?.kind).toBe("claimed");
    const reduction = {
      managedRunId: claim.managedRunId,
      claimId: claim.claimId,
      throughReportSequence: claim.throughReportSequence,
      status: "unknown" as const,
      statusReason: "service_state_unavailable" as const,
      continuationOutcome: "failed" as const,
      committedAtMs: 1_800_000_000_300,
    };
    expect((await firstStore.commitReducedState(OWNER_SCOPE, reduction)).value?.kind).toBe("updated");
    firstDb.close();

    const reopenedDb = new Database(databasePath);
    ensureManagedRunTables(reopenedDb);
    expect(await createSqliteManagedRunStore(reopenedDb).claimContinuation(OWNER_SCOPE, claim)).toMatchObject({
      ok: true,
      value: {
        kind: "identical_replay",
        reducedRecord: { status: "unknown", statusReason: "service_state_unavailable" },
        reducedOutcome: "failed",
      },
    });
    reopenedDb.close();
  });
});
