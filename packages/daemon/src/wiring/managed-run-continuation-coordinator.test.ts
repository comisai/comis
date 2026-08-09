// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  type ManagedRunContentPort,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
  type ManagedRunReportBody,
  type ManagedRunReportIndex,
  type ManagedRunStorePort,
} from "@comis/core";
import { ok } from "@comis/shared";
import {
  createManagedRunContinuationCoalescer,
  createManagedRunContinuationCoordinator,
  type ManagedRunContinuationExecutionInput,
} from "./managed-run-continuation-coordinator.js";

const NOW_MS = 1_800_000_000_000;

function makeLogger() {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => child),
  } as unknown as import("@comis/core").ComisLogger;
}

function makeRecord(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-a",
    conversationKind: "direct" as const,
  };
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal" as const,
      endpoint,
      principalId: "user-a",
    },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    schemaVersion: 1,
    managedRunId: "managed-run-a",
    serviceInstanceId: "service-a",
    externalRunRefDigest: "1".repeat(64),
    activationDescriptorDigest: "2".repeat(64),
    tenantId: "tenant-a",
    agentId: "agent-a",
    principalId: "user-a",
    conversationRef: conversationRef.value,
    turnScope: { conversation, principal: { principalId: "user-a" }, endpoint },
    deliveryOrigin: {
      tenantId: "tenant-a", channelType: "echo", channelId: "conversation-a", userId: "user-a",
    },
    traceId: "10000000-0000-4000-8000-000000000001",
    trustLevel: "user",
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    workspacePolicyHash: "a".repeat(64),
    rootRunId: "root-a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:mcp", "orch:read"],
    capturedToolIds: ["managed_status"],
    capturedCapabilityViewHash: "b".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "active",
    statusReason: "report_activity",
    lastAcceptedReportSequence: 2,
    lastReducedReportSequence: 0,
    pendingContinuation: true,
    openAttentionCount: 0,
    createdAtMs: NOW_MS - 10_000,
    updatedAtMs: NOW_MS - 1_000,
    lastHeartbeatAtMs: NOW_MS - 1_000,
    ...overrides,
  };
}

function report(sequence: number, kind: ManagedRunReportIndex["kind"]): ManagedRunReportIndex {
  const value = {
    schemaVersion: 1,
    serviceInstanceId: "service-a",
    managedRunId: "managed-run-a",
    serviceReportId: `report-${sequence}`,
    sequence,
    kind,
    contentRef: `report-${sequence}`,
    contentHash: "",
    receivedAtMs: NOW_MS - 1_000 + sequence,
    retainedUntilMs: NOW_MS + 60_000,
  } as ManagedRunReportIndex;
  return {
    ...value,
    contentHash: createHash("sha256").update(JSON.stringify(body(value)), "utf8").digest("hex"),
  };
}

function body(index: ManagedRunReportIndex): ManagedRunReportBody {
  return {
    schemaVersion: 1,
    serviceReportId: index.serviceReportId,
    kind: index.kind,
    summary: `${index.kind} summary`,
  };
}

function ownerScope(record = makeRecord()): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: record.tenantId,
    agentId: record.agentId,
    principalId: record.principalId,
    conversationRef: record.conversationRef,
  };
}

function makeCoordinator(overrides: {
  record?: ManagedRunRecord;
  reports?: ManagedRunReportIndex[];
  missingBody?: boolean;
  execute?: (input: ManagedRunContinuationExecutionInput) => Promise<ReturnType<typeof ok<{ deliveryState: "verified" }>>>;
} = {}) {
  const recordValue = overrides.record ?? makeRecord();
  const reports = overrides.reports ?? [report(1, "progress"), report(2, "candidate_complete")];
  const commitReducedState = vi.fn(async (_scope, input) => ok({
    kind: "updated" as const,
    record: { ...recordValue, ...input },
  }));
  const markContinuationOutcome = vi.fn(async () => ok({
    kind: "updated" as const,
    record: { ...recordValue, pendingContinuation: false },
  }));
  const store = {
    get: vi.fn(async () => ok(recordValue)),
    claimContinuation: vi.fn(async () => ok({ kind: "claimed" as const, record: recordValue })),
    listReportRange: vi.fn(async () => ok(reports)),
    commitReducedState,
    markContinuationOutcome,
  } as unknown as ManagedRunStorePort;
  const contentStore = {
    getReportBody: vi.fn(async (_scope, contentRef) => ok(
      overrides.missingBody ? undefined : body(reports.find((item) => item.contentRef === contentRef)!),
    )),
  } as unknown as ManagedRunContentPort;
  const execute = vi.fn(overrides.execute ?? (async () => ok({ deliveryState: "verified" as const })));
  const coordinator = createManagedRunContinuationCoordinator({
    store,
    contentStore,
    execute,
    nowMs: () => NOW_MS,
    heartbeatMaxAgeMs: 10_000,
    claimTtlMs: 60_000,
    eventBus: new TypedEventBus(),
    logger: makeLogger(),
  });
  return { coordinator, store, contentStore, execute, commitReducedState, markContinuationOutcome };
}

describe("managed-run continuation coordination", () => {
  it("persists finalized candidate delivery before committing the exact reduced cursor", async () => {
    let commitReducedState: ReturnType<typeof vi.fn> | undefined;
    const setup = makeCoordinator({
      execute: async (input) => {
        expect(input.record.workspacePolicyHash).toBe("a".repeat(64));
        expect(input.record.capturedToolIds).toEqual(["managed_status"]);
        expect(input.announcement).toContain("UNTRUSTED_");
        expect(commitReducedState).not.toHaveBeenCalled();
        return ok({ deliveryState: "verified" as const });
      },
    });
    commitReducedState = setup.commitReducedState;

    const result = await setup.coordinator.process(ownerScope(), "managed-run-a");

    expect(result).toEqual(ok({ kind: "processed", throughReportSequence: 2, pendingAfterCurrent: false }));
    expect(setup.store.listReportRange).toHaveBeenCalledWith(ownerScope(), {
      managedRunId: "managed-run-a",
      afterSequence: 0,
      throughSequence: 2,
    });
    expect(setup.commitReducedState).toHaveBeenCalledWith(ownerScope(), expect.objectContaining({
      throughReportSequence: 2,
      status: "succeeded",
      statusReason: "outcome_verified",
      terminalOutcome: { kind: "succeeded", recordedAtMs: NOW_MS },
    }));
    expect(setup.markContinuationOutcome).toHaveBeenCalledWith(ownerScope(), expect.objectContaining({
      outcome: "completed",
    }));
  });

  it("commits unknown without executing when required private report evidence is unavailable", async () => {
    const setup = makeCoordinator({ missingBody: true });

    const result = await setup.coordinator.process(ownerScope(), "managed-run-a");

    expect(result.ok).toBe(true);
    expect(setup.execute).not.toHaveBeenCalled();
    expect(setup.commitReducedState).toHaveBeenCalledWith(ownerScope(), expect.objectContaining({
      status: "unknown",
      statusReason: "service_state_unavailable",
    }));
    expect(setup.markContinuationOutcome).toHaveBeenCalledWith(ownerScope(), expect.objectContaining({
      outcome: "completed",
    }));
  });

  it("folds concurrent notifications into at most one follow-up execution per run", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const process = vi.fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue(undefined);
    const coalescer = createManagedRunContinuationCoalescer({ process });

    const initial = coalescer.request("managed-run-a");
    const foldedA = coalescer.request("managed-run-a");
    const foldedB = coalescer.request("managed-run-a");
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([initial, foldedA, foldedB]);

    expect(process).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenNthCalledWith(1, "managed-run-a");
    expect(process).toHaveBeenNthCalledWith(2, "managed-run-a");
  });
});
