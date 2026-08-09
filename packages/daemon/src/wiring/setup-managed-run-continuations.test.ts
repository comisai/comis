// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  type DeliveryService,
  type ManagedRunContentPort,
  type ManagedRunRecord,
  type ManagedRunReportBody,
  type ManagedRunReportIndex,
  type ManagedRunStorePort,
  type OutwardSendLedgerPort,
} from "@comis/core";
import type { ContinuationExecutionEngine, ExecutionResult } from "@comis/agent";
import { ok } from "@comis/shared";
import {
  createManagedRunContinuationDelivery,
  setupManagedRunContinuations,
} from "./setup-managed-run-continuations.js";

const NOW_MS = 1_800_000_000_000;

function makeLogger() {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => child),
  } as unknown as import("@comis/core").ComisLogger;
}

function makeRecord(): ManagedRunRecord {
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
  const ref = createConversationRef(conversation);
  if (!ref.ok) throw ref.error;
  return {
    schemaVersion: 1,
    managedRunId: "managed-run-a",
    serviceInstanceId: "service-a",
    externalRunRefDigest: "1".repeat(64),
    activationDescriptorDigest: "2".repeat(64),
    tenantId: "tenant-a",
    agentId: "agent-a",
    principalId: "user-a",
    conversationRef: ref.value,
    turnScope: { conversation, principal: { principalId: "user-a" }, endpoint },
    deliveryOrigin: {
      tenantId: "tenant-a", channelType: "echo", channelId: "conversation-a", userId: "user-a",
    },
    traceId: "10000000-0000-4000-8000-000000000001",
    trustLevel: "user",
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    workspacePolicyHash: computeWorkspacePolicyCombinedHash([]),
    rootRunId: "root-a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:read"],
    capturedToolIds: ["managed_status"],
    capturedCapabilityViewHash: "b".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "active",
    statusReason: "report_activity",
    lastAcceptedReportSequence: 1,
    lastReducedReportSequence: 0,
    pendingContinuation: true,
    openAttentionCount: 0,
    createdAtMs: NOW_MS - 2_000,
    updatedAtMs: NOW_MS - 1_000,
    lastHeartbeatAtMs: NOW_MS - 1_000,
  };
}

function reportAndBody(): { report: ManagedRunReportIndex; body: ManagedRunReportBody } {
  const body: ManagedRunReportBody = {
    schemaVersion: 1,
    serviceReportId: "report-a",
    kind: "candidate_complete",
    summary: "Work is complete",
  };
  return {
    body,
    report: {
      schemaVersion: 1,
      serviceInstanceId: "service-a",
      managedRunId: "managed-run-a",
      serviceReportId: "report-a",
      sequence: 1,
      kind: "candidate_complete",
      contentRef: "report-a",
      contentHash: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
      receivedAtMs: NOW_MS - 1_000,
      retainedUntilMs: NOW_MS + 60_000,
    },
  };
}

describe("managed-run continuation composition", () => {
  it("routes an accepted report through the shared caller with recorded policy and ceiling", async () => {
    const eventBus = new TypedEventBus();
    const record = makeRecord();
    const evidence = reportAndBody();
    const store = {
      get: vi.fn(async () => ok(record)),
      claimContinuation: vi.fn(async () => ok({ kind: "claimed" as const, record })),
      listReportRange: vi.fn(async () => ok([evidence.report])),
      commitReducedState: vi.fn(async (_scope, input) => ok({
        kind: "updated" as const,
        record: { ...record, ...input, pendingContinuation: false },
      })),
      markContinuationOutcome: vi.fn(async () => ok({
        kind: "updated" as const,
        record: { ...record, pendingContinuation: false },
      })),
      listRecoverable: vi.fn(async () => ok({ records: [], invalid: [] })),
      listOpenAttention: vi.fn(async () => ok([])),
    } as unknown as ManagedRunStorePort;
    const contentStore = {
      getReportBody: vi.fn(async () => ok(evidence.body)),
    } as unknown as ManagedRunContentPort;
    const finalized = {
      response: "Final managed answer",
      executionId: "execution-a",
      finishReason: "stop",
    } as unknown as ExecutionResult;
    const deliver = vi.fn(async () => ok({ deliveryState: "verified" as const }));
    const execute = vi.fn(async (input) => {
      expect(input.workspacePolicyHash).toBe(record.workspacePolicyHash);
      expect(input.capturedCapabilityCeiling).toEqual({
        toolIds: record.capturedToolIds,
        viewHash: record.capturedCapabilityViewHash,
      });
      expect(input.hooks.onProviderStart()).toEqual(ok(undefined));
      await input.hooks.onJournalFinalizedResult(finalized);
      const finalizedValue = await input.hooks.onFinalizedResult(finalized, "ready");
      return ok({ result: finalized, finalizedValue, tools: [] });
    });
    const engine = { execute, shutdown: vi.fn(async () => undefined) } as unknown as ContinuationExecutionEngine;
    const attentionReplies = { bind: vi.fn() } as unknown as import("@comis/core").ManagedAttentionReplyPort;
    const setup = await setupManagedRunContinuations({
      eventBus,
      store,
      contentStore,
      attentionReplies,
      engine,
      recoverFinalizedResult: vi.fn(async () => ok(undefined)),
      resolveWorkspacePolicy: vi.fn(async () => ok({
        agentId: "agent-a",
        sections: [],
        combinedHash: record.workspacePolicyHash,
      })),
      deliver,
      nowMs: () => NOW_MS,
      heartbeatMaxAgeMs: 60_000,
      claimTtlMs: 60_000,
      recoveryBatchSize: 10,
      logger: makeLogger(),
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.value.attentionReplies).toBe(attentionReplies);

    eventBus.emit("managed_run:report_accepted", {
      managedRunId: record.managedRunId,
      serviceInstanceId: record.serviceInstanceId,
      sequence: 1,
      kind: "candidate_complete",
      durationMs: 1,
      timestamp: NOW_MS,
    });
    await setup.value.runtime.waitUntilIdle();

    expect(execute).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(record, expect.stringMatching(/^continuation-/), {
      response: finalized.response,
      executionId: finalized.executionId,
      cleanupRequired: false,
    }, "ready");
    expect(store.commitReducedState).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      status: "succeeded",
      statusReason: "outcome_verified",
    }));
    await setup.value.shutdown();
    expect(engine.shutdown).toHaveBeenCalledOnce();
  });

  it("resumes a journaled managed result without executing the continuation again", async () => {
    const eventBus = new TypedEventBus();
    const record = makeRecord();
    const evidence = reportAndBody();
    const store = {
      get: vi.fn(async () => ok(record)),
      claimContinuation: vi.fn(async () => ok({ kind: "identical_replay" as const, record })),
      listReportRange: vi.fn(async () => ok([evidence.report])),
      commitReducedState: vi.fn(async (_scope, input) => ok({
        kind: "updated" as const,
        record: { ...record, ...input, pendingContinuation: false },
      })),
      markContinuationOutcome: vi.fn(async () => ok({
        kind: "updated" as const,
        record: { ...record, pendingContinuation: false },
      })),
      listRecoverable: vi.fn(async () => ok({ records: [], invalid: [] })),
    } as unknown as ManagedRunStorePort;
    const contentStore = {
      getReportBody: vi.fn(async () => ok(evidence.body)),
    } as unknown as ManagedRunContentPort;
    const journaled = {
      response: "Journaled managed answer",
      executionId: "execution-journaled",
      cleanupRequired: false,
    };
    const recoverFinalizedResult = vi.fn(async () => ok(journaled));
    const deliver = vi.fn(async () => ok({ deliveryState: "verified" as const }));
    const execute = vi.fn();
    const engine = {
      execute,
      shutdown: vi.fn(async () => undefined),
    } as unknown as ContinuationExecutionEngine;
    const setup = await setupManagedRunContinuations({
      eventBus,
      store,
      contentStore,
      attentionReplies: { bind: vi.fn() } as unknown as import("@comis/core").ManagedAttentionReplyPort,
      engine,
      recoverFinalizedResult,
      resolveWorkspacePolicy: vi.fn(async () => ok({
        agentId: "agent-a",
        sections: [],
        combinedHash: record.workspacePolicyHash,
      })),
      deliver,
      nowMs: () => NOW_MS,
      heartbeatMaxAgeMs: 60_000,
      claimTtlMs: 60_000,
      recoveryBatchSize: 10,
      logger: makeLogger(),
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;

    eventBus.emit("managed_run:report_accepted", {
      managedRunId: record.managedRunId,
      serviceInstanceId: record.serviceInstanceId,
      sequence: 1,
      kind: "candidate_complete",
      durationMs: 1,
      timestamp: NOW_MS,
    });
    await setup.value.runtime.waitUntilIdle();

    expect(recoverFinalizedResult).toHaveBeenCalledWith(expect.objectContaining({
      agentId: record.agentId,
      journalKey: expect.stringMatching(/^continuation-/),
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(
      record,
      expect.stringMatching(/^continuation-/),
      journaled,
      "ready",
    );
    expect(store.commitReducedState).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      status: "succeeded",
      statusReason: "outcome_verified",
    }));
    await setup.value.shutdown();
  });

  it("protects finalized delivery with exact endpoint authority and the outward ledger", async () => {
    const record = makeRecord();
    const adapter = { channelId: "echo-main", channelType: "echo" };
    const deliverToChannel = vi.fn(async () => ok({
      platform: { status: "accepted" as const, attemptedChunks: 1, acceptedChunks: 1, lastMessageId: "message-a" },
      queue: { status: "not_queued" as const },
    }));
    const ledger = {
      allocateStep: vi.fn(async () => ok(3)),
      lookup: vi.fn(async () => ok(undefined)),
      begin: vi.fn(async () => ok(undefined)),
      markUnknown: vi.fn(async () => ok(undefined)),
      commit: vi.fn(async () => ok(undefined)),
    } as unknown as OutwardSendLedgerPort;
    const delivery = createManagedRunContinuationDelivery({
      adaptersByType: new Map([["echo", adapter as never]]),
      deliveryService: { deliverToChannel } as unknown as DeliveryService,
      outwardLedger: ledger,
      logger: makeLogger(),
    });
    const result = await delivery(record, "claim-a", {
      response: "Final managed answer",
      executionId: "execution-a",
      cleanupRequired: false,
    }, "ready");

    expect(result).toEqual(ok({ deliveryState: "verified" }));
    expect(ledger.allocateStep).toHaveBeenCalledWith("root-a", "managed-run-continuation:claim-a");
    expect(deliverToChannel).toHaveBeenCalledWith(adapter, "conversation-a", "Final managed answer", expect.objectContaining({
      completionMode: "settled",
      authority: {
        tenantId: "tenant-a",
        agentId: "agent-a",
        conversationRef: record.conversationRef,
      },
      destinationEndpoint: record.turnScope.endpoint,
      origin: "managed-run-continuation",
    }));
  });
});
