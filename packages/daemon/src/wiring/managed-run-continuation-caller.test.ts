// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  formatSessionKey,
  type ManagedRunRecord,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import type {
  ContinuationExecutionEngine,
  ContinuationExecutionHooks,
} from "@comis/agent";
import { createManagedRunContinuationCaller } from "./managed-run-continuation-caller.js";

function makeLogger() {
  const child = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => child),
  } as unknown as import("@comis/core").ComisLogger;
}

function makeRecord(): ManagedRunRecord {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "recorded-conversation",
    conversationKind: "direct" as const,
  };
  const turnScope = {
    conversation: {
      tenantId: "tenant-a",
      agentId: "agent-a",
      partition: {
        kind: "endpoint-conversation-principal" as const,
        endpoint,
        principalId: "user-a",
      },
    },
    principal: { principalId: "user-a" },
    endpoint,
  };
  const conversationRef = createConversationRef(turnScope.conversation);
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
    turnScope,
    deliveryOrigin: {
      tenantId: "tenant-a",
      channelType: "echo",
      channelId: "recorded-conversation",
      userId: "user-a",
    },
    traceId: "10000000-0000-4000-8000-000000000001",
    trustLevel: "user",
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    workspacePolicyHash: computeWorkspacePolicyCombinedHash([]),
    rootRunId: "root-a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:mcp", "orch:read"],
    capturedToolIds: ["managed_respond", "managed_status"],
    capturedCapabilityViewHash: "b".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "active",
    statusReason: "report_activity",
    lastAcceptedReportSequence: 2,
    lastReducedReportSequence: 1,
    pendingContinuation: true,
    openAttentionCount: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

describe("createManagedRunContinuationCaller", () => {
  it("re-enters the exact recorded conversation with immutable policy and capability ceiling", async () => {
    const record = makeRecord();
    const policy: WorkspacePolicySnapshot = {
      agentId: record.agentId,
      sections: [],
      combinedHash: record.workspacePolicyHash,
    };
    const execute = vi.fn().mockResolvedValue(ok({
      result: { response: "continued" },
      tools: [],
    }));
    const engine = { execute, shutdown: vi.fn() } as unknown as ContinuationExecutionEngine;
    const resolveWorkspacePolicy = vi.fn().mockResolvedValue(ok(policy));
    const caller = createManagedRunContinuationCaller({
      engine,
      resolveWorkspacePolicy,
      logger: makeLogger(),
    });
    const hooks = {
      onProviderStart: () => ok(undefined),
      onJournalFinalizedResult: vi.fn(),
      onFinalizedResult: vi.fn(),
    } as unknown as ContinuationExecutionHooks<undefined>;

    const outcome = await caller.execute({
      record,
      claimId: "claim-a",
      triggeringSequence: 2,
      announcement: "Bounded managed-run snapshot",
      hooks,
    });

    expect(outcome.ok).toBe(true);
    expect(resolveWorkspacePolicy).toHaveBeenCalledWith(record.agentId, record.workspacePolicyHash);
    const input = execute.mock.calls[0]![0];
    expect(input).toEqual(expect.objectContaining({
      continuationId: "claim-a",
      source: "managed_run",
      sourceId: record.managedRunId,
      workspacePolicyHash: record.workspacePolicyHash,
      workspacePolicySnapshot: policy,
      capturedCapabilityCeiling: {
        toolIds: record.capturedToolIds,
        viewHash: record.capturedCapabilityViewHash,
      },
      hooks,
    }));
    expect(input.formattedSessionKey).toBe(formatSessionKey(input.sessionKey));
    expect(input.sessionKey).toEqual(expect.objectContaining({
      tenantId: "tenant-a",
      agentId: "agent-a",
      userId: "user-a",
      peerId: "user-a",
    }));
    expect(input.message).toEqual(expect.objectContaining({
      id: "claim-a",
      channelId: "recorded-conversation",
      channelType: "managed_run",
      senderId: "managed-run-controller",
      text: "Bounded managed-run snapshot",
      metadata: expect.objectContaining({
        managedRunId: record.managedRunId,
        triggeringSequence: 2,
        traceId: record.traceId,
      }),
    }));
  });

  it("fails closed before execution when the recorded policy snapshot cannot be resolved", async () => {
    const record = makeRecord();
    const execute = vi.fn();
    const caller = createManagedRunContinuationCaller({
      engine: { execute, shutdown: vi.fn() } as unknown as ContinuationExecutionEngine,
      resolveWorkspacePolicy: vi.fn().mockResolvedValue(err(new Error("snapshot unavailable"))),
      logger: makeLogger(),
    });

    const outcome = await caller.execute({
      record,
      claimId: "claim-a",
      triggeringSequence: 2,
      announcement: "Bounded managed-run snapshot",
      hooks: {} as ContinuationExecutionHooks<undefined>,
    });

    expect(outcome).toEqual(err(new Error("snapshot unavailable")));
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a policy snapshot whose content does not match its recorded hash", async () => {
    const record = { ...makeRecord(), workspacePolicyHash: "f".repeat(64) };
    const execute = vi.fn();
    const caller = createManagedRunContinuationCaller({
      engine: { execute, shutdown: vi.fn() } as unknown as ContinuationExecutionEngine,
      resolveWorkspacePolicy: vi.fn().mockResolvedValue(ok({
        agentId: record.agentId,
        sections: [],
        combinedHash: record.workspacePolicyHash,
      })),
      logger: makeLogger(),
    });

    const outcome = await caller.execute({
      record,
      claimId: "claim-corrupt-policy",
      triggeringSequence: 2,
      announcement: "Bounded managed-run snapshot",
      hooks: {} as ContinuationExecutionHooks<undefined>,
    });

    expect(outcome).toEqual(err(new Error(
      "Managed-run workspace policy does not match recorded authority",
    )));
    expect(execute).not.toHaveBeenCalled();
  });
});
