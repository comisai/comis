// SPDX-License-Identifier: Apache-2.0
import {
  computeWorkspacePolicyCombinedHash,
  hashWorkspacePolicyContent,
  type NormalizedMessage,
  type RequestContext,
  type TaskExtractionPort,
  type TaskExtractionTurn,
  type WorkspacePolicyPort,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import type { ExecutionResult } from "@comis/agent";
import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import type { FilterResult } from "./execution-filter.js";
import type { InteractiveDeliveryStageResult } from "./execution-deliver.js";
import { captureTaskExtractionTurn } from "./task-extraction-capture.js";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "22222222-2222-4222-8222-222222222222";

function policySnapshot(): WorkspacePolicySnapshot {
  const content = "# Policy\n\nUse the configured scope.";
  const section = {
    id: "workspace:role",
    sourceKind: "operator" as const,
    trust: "trusted" as const,
    stability: "stable" as const,
    content,
    contentHash: hashWorkspacePolicyContent(content),
    maxChars: 20_000,
  };
  return {
    agentId: "agent-a",
    sections: [section],
    combinedHash: computeWorkspacePolicyCombinedHash([section]),
  };
}

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: MESSAGE_ID,
    channelId: "chat-a",
    channelType: "telegram",
    senderId: "user-a",
    text: "wrapped conversation text that must not be captured",
    timestamp: 1_000,
    attachments: [],
    metadata: {},
    originalMessages: [{
      id: MESSAGE_ID,
      channelId: "chat-a",
      channelType: "telegram",
      senderId: "user-a",
      text: "Please check this later.",
      timestamp: 1_000,
    }],
    ...overrides,
  };
}

function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "tenant-a",
    userId: "user-a",
    agentId: "agent-a",
    sessionKey: "tenant-a:agent:agent-a:user-a:telegram:chat-a",
    traceId: TRACE_ID,
    startedAt: 1_000,
    trustLevel: "user",
    learningEligible: true,
    channelType: "telegram",
    deliveryOrigin: {
      tenantId: "tenant-a",
      channelType: "telegram",
      channelId: "chat-a",
      userId: "user-a",
    },
    turnScope: {
      conversation: {
        tenantId: "tenant-a",
        agentId: "agent-a",
        partition: { kind: "principal", principalId: "user-a" },
      },
      principal: { principalId: "user-a" },
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "telegram-main",
        conversationId: "chat-a",
        conversationKind: "direct",
      },
    },
    ...overrides,
  };
}

function executionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  const snapshot = policySnapshot();
  return {
    response: "I will follow up.",
    sessionKey: {
      tenantId: "tenant-a",
      agentId: "agent-a",
      userId: "user-a",
      channelId: "telegram",
      peerId: "chat-a",
    },
    executionId: "execution-a",
    workspacePolicyHash: snapshot.combinedHash,
    responseLocalePolicy: { locale: "en", source: "request", enforceLocale: true },
    sideEffectSummary: {
      schedulingCapabilityInvoked: false,
      outboundDeliveryCapabilityInvoked: false,
      deferredWorkCapabilityInvoked: false,
      unclassifiedInvocationObserved: false,
    },
    tokensUsed: { input: 1, output: 1, total: 2 },
    cost: { total: 0 },
    stepsExecuted: 0,
    llmCalls: 1,
    finishReason: "stop",
    ...overrides,
  } as ExecutionResult;
}

function acceptedDelivery(
  overrides: Record<string, unknown> = {},
): InteractiveDeliveryStageResult {
  return ok({
    status: "accepted",
    deliveredChunks: 1,
    settledAtMs: 5_000,
    lastMessageId: "message-out-a",
    queueDisposition: "settled",
    ...overrides,
  }) as InteractiveDeliveryStageResult;
}

function setup() {
  const snapshot = policySnapshot();
  const enqueue = vi.fn((_turn: TaskExtractionTurn) => ok("enqueued" as const));
  const get = vi.fn((hash: string) => hash === snapshot.combinedHash
    ? ok(snapshot)
    : { ok: false as const, error: { kind: "snapshot_not_found" as const, policyHash: hash } });
  const load = vi.fn();
  return {
    snapshot,
    enqueue,
    get,
    load,
    deps: {
      taskExtractionPort: { enqueue } as TaskExtractionPort,
      workspacePolicyPort: { get, load } as unknown as WorkspacePolicyPort,
    },
  };
}

function captureInput(overrides: {
  effectiveMsg?: NormalizedMessage;
  originalMsg?: NormalizedMessage;
  result?: ExecutionResult;
  filterResult?: FilterResult;
  delivery?: InteractiveDeliveryStageResult;
  requestContext?: RequestContext;
  abortReason?: "user_stop";
} = {}) {
  const effectiveMsg = overrides.effectiveMsg ?? message();
  return {
    agentId: "agent-a",
    channelInstanceId: "telegram-main",
    effectiveMsg,
    originalMsg: overrides.originalMsg ?? message({ originalMessages: undefined }),
    result: overrides.result ?? executionResult(),
    filterResult: overrides.filterResult ?? { deliver: true as const, text: "I will follow up." },
    delivery: overrides.delivery ?? acceptedDelivery(),
    requestContext: overrides.requestContext ?? requestContext(),
    ...(overrides.abortReason === undefined ? {} : { abortReason: overrides.abortReason }),
  };
}

describe("successful turn task extraction capture", () => {
  it("enqueues exact physical text and immutable execution artifacts after accepted delivery", () => {
    const built = setup();

    const outcome = captureTaskExtractionTurn(built.deps, captureInput());

    expect(outcome).toEqual({ status: "enqueued", disposition: "enqueued" });
    expect(built.enqueue).toHaveBeenCalledTimes(1);
    expect(built.enqueue).toHaveBeenCalledWith({
      sourceExecutionId: "execution-a",
      origin: expect.objectContaining({
        traceId: TRACE_ID,
        backgroundHopCount: 0,
        turnScope: requestContext().turnScope,
        deliveryOrigin: requestContext().deliveryOrigin,
      }),
      workspacePolicySnapshot: built.snapshot,
      responseLocalePolicy: { locale: "en", source: "request", enforceLocale: true },
      capturedAtMs: 5_000,
      userText: "Please check this later.",
      deliveredAssistantText: "I will follow up.",
    });
    expect(built.get).toHaveBeenCalledExactlyOnceWith(built.snapshot.combinedHash);
    expect(built.load).not.toHaveBeenCalled();
  });

  it("accepts an authenticated principal that differs from the raw platform sender id", () => {
    const built = setup();
    const mappedPrincipalContext = requestContext({
      userId: "principal-a",
      sessionKey: "tenant-a:agent:agent-a:principal-a:telegram:chat-a",
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "telegram",
        channelId: "chat-a",
        userId: "principal-a",
      },
      turnScope: {
        conversation: {
          tenantId: "tenant-a",
          agentId: "agent-a",
          partition: { kind: "principal", principalId: "principal-a" },
        },
        principal: { principalId: "principal-a" },
        endpoint: {
          channelType: "telegram",
          channelInstanceId: "telegram-main",
          conversationId: "chat-a",
          conversationKind: "direct",
        },
      },
    });

    const outcome = captureTaskExtractionTurn(
      built.deps,
      captureInput({ requestContext: mappedPrincipalContext }),
    );

    expect(outcome).toEqual({ status: "enqueued", disposition: "enqueued" });
    expect(built.enqueue).toHaveBeenCalledOnce();
  });

  it("fails closed for incomplete provenance execution rendering and delivery evidence", () => {
    const cases: Array<readonly [string, ReturnType<typeof captureInput>]> = [
      ["coalesced", captureInput({ effectiveMsg: message({
        originalMessages: [message().originalMessages![0]!, {
          ...message().originalMessages![0]!,
          id: "33333333-3333-4333-8333-333333333333",
          text: "Second physical message",
        }],
      }) })],
      ["mismatched sender", captureInput({ effectiveMsg: message({
        originalMessages: [{ ...message().originalMessages![0]!, senderId: "user-b" }],
      }) })],
      ["effective attachment", captureInput({ effectiveMsg: message({
        attachments: [{ type: "file", url: "tg-file://file-a" }],
      }) })],
      ["original attachment", captureInput({ originalMsg: message({
        originalMessages: undefined,
        attachments: [{ type: "audio", url: "tg-file://audio-a", isVoiceNote: true }],
      }) })],
      ["failed execution", captureInput({ result: executionResult({
        finishReason: "error",
        terminalErrorKind: "dependency",
      } as Partial<ExecutionResult>) })],
      ["active abort", captureInput({ abortReason: "user_stop" })],
      ["scheduling invocation", captureInput({ result: executionResult({
        sideEffectSummary: { ...executionResult().sideEffectSummary, schedulingCapabilityInvoked: true },
      }) })],
      ["outbound invocation", captureInput({ result: executionResult({
        sideEffectSummary: { ...executionResult().sideEffectSummary, outboundDeliveryCapabilityInvoked: true },
      }) })],
      ["deferred invocation", captureInput({ result: executionResult({
        sideEffectSummary: { ...executionResult().sideEffectSummary, deferredWorkCapabilityInvoked: true },
      }) })],
      ["unclassified invocation", captureInput({ result: executionResult({
        sideEffectSummary: { ...executionResult().sideEffectSummary, unclassifiedInvocationObserved: true },
      }) })],
      ["outbound media", captureInput({ filterResult: {
        deliver: true,
        text: "I will follow up.",
        mediaDelivery: { delivered: 1, failed: 0 },
      } })],
      ["partial delivery", captureInput({ delivery: ok({
        status: "partial",
        errorKind: "platform",
        deliveredChunks: 1,
        failedChunks: 1,
        settledAtMs: 5_000,
        queueDisposition: "settled",
      }) })],
      ["retry ownership", captureInput({ delivery: acceptedDelivery({ queueDisposition: "retry_pending" }) })],
      ["restart continuation", captureInput({ effectiveMsg: message({
        metadata: { isRestartContinuation: true },
      }) })],
      ["ineligible synthetic turn", captureInput({ requestContext: requestContext({ learningEligible: false }) })],
    ];

    for (const [name, input] of cases) {
      const built = setup();
      const outcome = captureTaskExtractionTurn(built.deps, input);
      expect(outcome.status, name).toBe("skipped");
      expect(built.enqueue, name).not.toHaveBeenCalled();
    }
  });

  it("rejects snapshot and origin mismatches without falling back to mutable policy", () => {
    const missing = setup();
    missing.get.mockReturnValue({
      ok: false,
      error: { kind: "snapshot_not_found", policyHash: missing.snapshot.combinedHash },
    });
    expect(captureTaskExtractionTurn(missing.deps, captureInput())).toMatchObject({
      status: "skipped",
      reason: "policy_snapshot_unavailable",
    });
    expect(missing.load).not.toHaveBeenCalled();
    expect(missing.enqueue).not.toHaveBeenCalled();

    const mismatched = setup();
    const mismatchedContext = requestContext({
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "telegram",
        channelId: "other-chat",
        userId: "user-a",
      },
    });
    expect(captureTaskExtractionTurn(
      mismatched.deps,
      captureInput({ requestContext: mismatchedContext }),
    )).toMatchObject({ status: "skipped", reason: "origin_mismatch" });
    expect(mismatched.enqueue).not.toHaveBeenCalled();
  });

  it("surfaces bounded queue pressure without undoing admission", () => {
    const built = setup();
    built.enqueue.mockReturnValue(ok("oldest_dropped"));

    expect(captureTaskExtractionTurn(built.deps, captureInput())).toEqual({
      status: "enqueued",
      disposition: "oldest_dropped",
    });
    expect(built.enqueue).toHaveBeenCalledTimes(1);
  });
});
