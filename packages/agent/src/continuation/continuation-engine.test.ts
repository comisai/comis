// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  createConversationRef,
  formatSessionKey,
  getContext,
  type NormalizedMessage,
  type SessionKey,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import { ok } from "@comis/shared";
import {
  createContinuationExecutionEngine,
  createContinuationRequestContext,
  type ContinuationOriginAuthority,
} from "./continuation-engine.js";
import type { AgentExecutor, ExecutionResult } from "../executor/types.js";

function makeLogger() {
  const child = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => child),
  } as unknown as import("@comis/core").ComisLogger;
}

function makeAuthority(): ContinuationOriginAuthority {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-a",
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
    turnScope,
    deliveryOrigin: {
      tenantId: "tenant-a",
      channelType: "echo",
      channelId: "conversation-a",
      userId: "user-a",
    },
    traceId: "10000000-0000-4000-8000-000000000001",
    trustLevel: "user",
    responseLocalePolicy: { source: "unset", enforceLocale: false },
  };
}

describe("createContinuationExecutionEngine", () => {
  it("executes a managed continuation with exact reconstructed authority and lifecycle hooks", async () => {
    const authority = makeAuthority();
    const sessionKey: SessionKey = {
      tenantId: "tenant-a",
      agentId: "agent-a",
      userId: "user-a",
      channelId: "echo:conversation-a",
    };
    const requestContext = createContinuationRequestContext(authority, sessionKey, "a".repeat(64));
    expect(requestContext.ok).toBe(true);
    if (!requestContext.ok) return;
    const finalized = {
      response: "continued",
      executionId: "execution-a",
      finishReason: "stop",
    } as unknown as ExecutionResult;
    const execute = vi.fn(async (...args: Parameters<AgentExecutor["execute"]>) => {
      expect(getContext()).toEqual(expect.objectContaining({
        tenantId: "tenant-a",
        agentId: "agent-a",
        userId: "user-a",
        trustLevel: "user",
        traceId: authority.traceId,
      }));
      const overrides = args[7];
      expect(overrides?.onProviderStart?.()).toEqual(ok(undefined));
      await overrides?.onJournalFinalizedResult?.(finalized);
      await overrides?.onFinalizedResult?.(finalized, "ready");
      return finalized;
    });
    const tools = [{ name: "managed_respond" }, { name: "managed_status" }];
    const currentTools = [
      { name: "unrelated_current_tool" },
      { name: "managed_respond" },
      { name: "managed_status" },
    ];
    const assembleToolsForAgent = vi.fn(async () => currentTools);
    const engine = createContinuationExecutionEngine({
      eventBus: new TypedEventBus(),
      getExecutor: () => ({ execute }) as unknown as AgentExecutor,
      assembleToolsForAgent: assembleToolsForAgent as never,
      logger: makeLogger(),
    });
    const beforeExecute = vi.fn();
    const onJournalFinalizedResult = vi.fn().mockResolvedValue(undefined);
    const onFinalizedResult = vi.fn().mockResolvedValue({ outboxId: "outbox-a" });
    const message: NormalizedMessage = {
      id: "continuation-a",
      channelId: "conversation-a",
      channelType: "managed_run",
      senderId: "managed-run-controller",
      text: "Bounded continuation context",
      timestamp: 1,
      attachments: [],
      metadata: {},
    };
    const workspacePolicySnapshot: WorkspacePolicySnapshot = {
      agentId: "agent-a",
      sections: [],
      combinedHash: "a".repeat(64),
    };

    const outcome = await engine.execute({
      continuationId: "continuation-a",
      source: "managed_run",
      sourceId: "managed-run-a",
      agentId: "agent-a",
      authority,
      requestContext: requestContext.value,
      sessionKey,
      formattedSessionKey: formatSessionKey(sessionKey),
      message,
      journalKey: "continuation-a",
      workspacePolicyHash: workspacePolicySnapshot.combinedHash,
      workspacePolicySnapshot,
      capturedCapabilityCeiling: {
        toolIds: ["managed_respond", "managed_status"],
        viewHash: "b".repeat(64),
      },
      beforeExecute,
      hooks: {
        onProviderStart: () => ok(undefined),
        onJournalFinalizedResult,
        onFinalizedResult,
      },
    });

    expect(outcome).toEqual(ok({
      result: finalized,
      finalizedValue: { outboxId: "outbox-a" },
      tools,
    }));
    expect(execute).toHaveBeenCalledWith(
      message,
      sessionKey,
      tools,
      undefined,
      "agent-a",
      undefined,
      undefined,
      expect.objectContaining({
        operationType: "interactive",
        finalizedResultJournalKey: "continuation-a",
        workspacePolicySnapshot,
      }),
    );
    expect(assembleToolsForAgent).toHaveBeenCalledWith("agent-a", { sessionKey });
    expect(beforeExecute).toHaveBeenCalledOnce();
    expect(onJournalFinalizedResult).toHaveBeenCalledWith(finalized);
    expect(onFinalizedResult).toHaveBeenCalledWith(finalized, "ready");
    await engine.shutdown();
  });
});
