// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type ComisLogger,
  type ManagedRunContentPort,
  type ManagedRunRecord,
  type ManagedRunStorePort,
} from "@comis/core";
import {
  createSqliteManagedRunContentStore,
  createSqliteManagedRunStore,
  initSchema,
} from "@comis/memory";
import { err } from "@comis/shared";
import {
  createManagedRunReportBridge,
  type ManagedRunReportBridgeDeps,
} from "./managed-run-report-bridge.js";

const NOW_MS = 1_800_000_000_000;
const RETENTION_MS = 30 * 86_400_000;
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
const conversationReference = createConversationRef(conversationScope);
if (!conversationReference.ok) throw conversationReference.error;

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

function makeRecord(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    schemaVersion: 1,
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorDigest: "d".repeat(64),
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: conversationReference.value,
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
    workspacePolicyHash: "b".repeat(64),
    rootRunId: "root-run_a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:read"],
    capturedToolIds: ["mcp:service_a.inspect"],
    capturedCapabilityViewHash: "c".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "active",
    statusReason: "activation_acknowledged",
    lastAcceptedReportSequence: 0,
    lastReducedReportSequence: 0,
    pendingContinuation: false,
    openAttentionCount: 0,
    createdAtMs: NOW_MS - 100,
    updatedAtMs: NOW_MS - 50,
    ...overrides,
  };
}

function makeInput() {
  return {
    serviceInstanceId: "service-instance_a",
    managedRunId: "managed-run_a",
    report: {
      serviceReportId: "service-report_a",
      kind: "progress" as const,
      summary: "Private progress body",
      details: "Private report details",
      artifactRefs: ["artifact_a"],
      observedAtMs: NOW_MS - 10,
    },
  };
}

describe("managed-run report bridge", () => {
  const temporaryDirectories: string[] = [];
  let db: Database.Database;
  let store: ManagedRunStorePort;
  let contentStore: ManagedRunContentPort;
  let logger: ComisLogger;
  let eventBus: TypedEventBus;

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db, 4);
    store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "managed-run-report-")));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const content = createSqliteManagedRunContentStore(db, {
      directoryPath: directory,
      nowMs: () => NOW_MS,
    });
    if (!content.ok) throw content.error;
    contentStore = content.value;
    logger = makeLogger();
    eventBus = new TypedEventBus();
  });

  afterEach(() => {
    db.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeBridge(overrides: Partial<ManagedRunReportBridgeDeps> = {}) {
    return createManagedRunReportBridge({
      store,
      contentStore,
      nowMs: () => NOW_MS,
      retentionMs: RETENTION_MS,
      maxObservedClockSkewMs: 60_000,
      eventBus,
      logger,
      ...overrides,
    });
  }

  it("commits a private report body and content-free sequence before emitting", async () => {
    const emitted = vi.fn();
    eventBus.on("managed_run:report_accepted", emitted);

    const accepted = await makeBridge().ingestReport(makeInput());

    expect(accepted).toMatchObject({
      ok: true,
      value: { kind: "accepted", report: { sequence: 1, kind: "progress" } },
    });
    expect(await contentStore.getReportBody({
      tenantId: "tenant_a",
      agentId: "agent_a",
      managedRunId: "managed-run_a",
    }, "service-report_a")).toMatchObject({
      ok: true,
      value: { summary: "Private progress body", details: "Private report details" },
    });
    expect(await store.get({ kind: "service", serviceInstanceId: "service-instance_a" }, "managed-run_a"))
      .toMatchObject({
        ok: true,
        value: { lastAcceptedReportSequence: 1, pendingContinuation: true },
      });
    expect(emitted).toHaveBeenCalledWith({
      managedRunId: "managed-run_a",
      serviceInstanceId: "service-instance_a",
      sequence: 1,
      kind: "progress",
      durationMs: 0,
      timestamp: NOW_MS,
    });
    expect(JSON.stringify(emitted.mock.calls)).not.toContain("Private progress body");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      managedRunId: "managed-run_a",
      sequence: 1,
      durationMs: 0,
    }), "Managed-run report accepted");
  });

  it("returns the original sequence for same replay and audits altered reuse", async () => {
    const bridge = makeBridge();
    expect((await bridge.ingestReport(makeInput())).ok).toBe(true);
    const replay = await bridge.ingestReport(makeInput());
    const altered = await bridge.ingestReport({
      ...makeInput(),
      report: { ...makeInput().report, summary: "Altered private body" },
    });

    expect(replay).toMatchObject({
      ok: true,
      value: { kind: "identical_replay", report: { sequence: 1 } },
    });
    expect(altered).toEqual({
      ok: true,
      value: { kind: "rejected", reasonCode: "replay_conflict" },
    });
    expect(logger.audit).toHaveBeenCalledWith(expect.objectContaining({
      decision: "deny",
      reasonCode: "replay_conflict",
    }), "Managed-run report rejected");
    const audit = logger.audit as ReturnType<typeof vi.fn>;
    expect(JSON.stringify(audit.mock.calls)).not.toContain("Altered private body");
  });

  it("derives durable attention identity and closes it only from a matching resolution", async () => {
    const bridge = makeBridge();
    const attention = await bridge.ingestReport({
      ...makeInput(),
      report: {
        serviceReportId: "service-report_attention",
        kind: "attention",
        externalKey: "approval-a",
        summary: "Approval is required",
      },
    });
    expect(attention).toMatchObject({ ok: true, value: { kind: "accepted" } });
    const open = await store.listOpenAttention({
      kind: "owner",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationReference.value,
    }, { managedRunId: "managed-run_a", limit: 10 });
    expect(open).toMatchObject({
      ok: true,
      value: [{
        attentionId: expect.stringMatching(/^attention-[a-f0-9]{48}$/),
        externalKey: "approval-a",
        status: "open",
      }],
    });

    const resolution = await bridge.ingestReport({
      ...makeInput(),
      report: {
        serviceReportId: "service-report_resolution",
        kind: "resolution",
        externalKey: "approval-a",
        summary: "Approval was applied",
      },
    });
    expect(resolution).toMatchObject({ ok: true, value: { kind: "accepted" } });
    expect(await store.listOpenAttention({
      kind: "owner",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationReference.value,
    }, { managedRunId: "managed-run_a", limit: 10 })).toEqual({ ok: true, value: [] });
  });

  it("persists the report identity as the external attention key when omitted", async () => {
    const accepted = await makeBridge().ingestReport({
      ...makeInput(),
      report: {
        serviceReportId: "service-report_without-key",
        kind: "blocked",
        summary: "Operator input is required",
      },
    });
    expect(accepted).toMatchObject({ ok: true, value: { kind: "accepted" } });

    expect(await store.listOpenAttention({
      kind: "owner",
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationReference.value,
    }, { managedRunId: "managed-run_a", limit: 10 })).toMatchObject({
      ok: true,
      value: [{ externalKey: "service-report_without-key", status: "open" }],
    });
  });

  it("accepts a delayed durable report observed during the managed run", async () => {
    db.prepare("UPDATE managed_runs SET created_at_ms = ?, updated_at_ms = ? WHERE managed_run_id = ?")
      .run(NOW_MS - 180_000, NOW_MS - 120_000, "managed-run_a");
    const delayed = await makeBridge().ingestReport({
      ...makeInput(),
      report: { ...makeInput().report, observedAtMs: NOW_MS - 120_000 },
    });

    expect(delayed).toMatchObject({
      ok: true,
      value: { kind: "accepted", report: { observedAtMs: NOW_MS - 120_000 } },
    });
  });

  it("rejects forged ownership and advisory time outside the managed-run lifetime", async () => {
    const forged = await makeBridge().ingestReport({
      ...makeInput(),
      serviceInstanceId: "service-instance_b",
    });
    const future = await makeBridge().ingestReport({
      ...makeInput(),
      report: { ...makeInput().report, observedAtMs: NOW_MS + 60_001 },
    });
    const beforeRun = await makeBridge().ingestReport({
      ...makeInput(),
      report: {
        ...makeInput().report,
        serviceReportId: "service-report_before-run",
        observedAtMs: NOW_MS - 60_101,
      },
    });

    expect(forged).toEqual({
      ok: true,
      value: { kind: "rejected", reasonCode: "managed_run_not_found" },
    });
    expect(future).toEqual({
      ok: true,
      value: { kind: "rejected", reasonCode: "observed_time_out_of_bounds" },
    });
    expect(beforeRun).toEqual({
      ok: true,
      value: { kind: "rejected", reasonCode: "observed_time_out_of_bounds" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM managed_run_content_index").get())
      .toEqual({ count: 0 });
  });

  it("removes a newly published body when the durable index transaction fails", async () => {
    const failingStore: ManagedRunStorePort = {
      ...store,
      appendReportAndAdvanceAcceptedCursor: vi.fn(async () => err(new Error("synthetic index failure"))),
    };

    const failed = await makeBridge({ store: failingStore }).ingestReport(makeInput());

    expect(failed.ok).toBe(false);
    expect(await contentStore.getReportBody({
      tenantId: "tenant_a",
      agentId: "agent_a",
      managedRunId: "managed-run_a",
    }, "service-report_a")).toEqual({ ok: true, value: undefined });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      errorKind: "internal",
      hint: expect.any(String),
    }), "Managed-run report transaction failed");
  });
});
