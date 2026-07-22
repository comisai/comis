// SPDX-License-Identifier: Apache-2.0
import {
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  hashWorkspacePolicyContent,
} from "@comis/core";
import { describe, expect, it } from "vitest";
import { parseFollowupTaskStoreFile } from "./task-types.js";

function fixture() {
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "agent" as const },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  const content = "# Role\n\nStay within the configured scope.";
  const section = {
    id: "workspace:role",
    sourceKind: "operator" as const,
    trust: "trusted" as const,
    stability: "stable" as const,
    content,
    contentHash: hashWorkspacePolicyContent(content),
    maxChars: 20_000,
  };
  const policy = {
    agentId: "agent-a",
    sections: [section],
    combinedHash: computeWorkspacePolicyCombinedHash([section]),
  };
  const task = {
    id: "task-a",
    agentId: "agent-a",
    origin: {
      turnScope: {
        conversation,
        principal: { principalId: "user-a" },
        endpoint: {
          channelType: "echo",
          channelInstanceId: "echo-main",
          conversationId: "conversation-a",
          conversationKind: "direct" as const,
        },
      },
      conversationRef: conversationRef.value,
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "echo",
        channelId: "conversation-a",
        userId: "user-a",
      },
      traceId: "trace-a",
      backgroundHopCount: 0,
    },
    sourceExecutionId: "execution-a",
    lastSourceExecutionId: "execution-a",
    sourceOccurrenceCount: 1,
    workspacePolicyHash: policy.combinedHash,
    responseLocalePolicy: { source: "unset" as const, enforceLocale: false },
    text: "Check the outcome",
    contentTrust: "derived" as const,
    confidence: 0.9,
    createdAtMs: 1_000,
    dueEarliestMs: 61_000,
    dueLatestMs: 121_000,
    expiresAtMs: 2_592_001_000,
    dedupeKey: "d".repeat(64),
    attemptCount: 0,
    preAcceptanceFailureCount: 0,
    status: "pending" as const,
    nextAttemptAtMs: 61_000,
  };
  return {
    conversationRef: conversationRef.value,
    policy,
    task,
    root: { formatVersion: 1 as const, tasks: [task], attempts: [], policySnapshots: [policy] },
  };
}

function makeCheckingTask(task: ReturnType<typeof fixture>["task"], attemptId: string) {
  const { nextAttemptAtMs: _nextAttemptAtMs, ...base } = task;
  return { ...base, status: "checking" as const, activeAttemptId: attemptId, attemptCount: 1 };
}

function successfulCheck() {
  return {
    status: "settled" as const,
    agentExecutionId: "execution-check-a",
    modelResolved: "example:model",
    modelResolutionSource: "family_default" as const,
    execution: { status: "completed" as const, finishReason: "stop" as const },
    metrics: { durationMs: 100, totalTokens: 20, costUsd: 0.001, toolCalls: 0 as const, llmCalls: 1 },
  };
}

function attemptBase(data: ReturnType<typeof fixture>) {
  return {
    id: "attempt-a",
    bootId: "boot-a",
    rootRunId: "root-task-a",
    taskIds: ["task-a"],
    tenantId: "tenant-a",
    agentId: "agent-a",
    conversationRef: data.conversationRef,
    startedAtMs: 61_000,
  };
}

describe("follow-up task store schemas", () => {
  it("parses a pending task with a hash-verified policy snapshot", () => {
    const parsed = parseFollowupTaskStoreFile(fixture().root);
    expect(parsed).toMatchObject({ ok: true, value: { formatVersion: 1 } });
  });

  it("rejects contradictory task windows", () => {
    const data = fixture();
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [{ ...data.task, dueLatestMs: 500 }],
    })).toMatchObject({ ok: false, error: { code: "invalid_record" } });
  });

  it("rejects active tasks without one matching nonterminal attempt", () => {
    const data = fixture();
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [makeCheckingTask(data.task, "attempt-a")],
    })).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
  });

  it("parses exact active task and checking-attempt ownership", () => {
    const data = fixture();
    const attempt = {
      id: "attempt-a",
      bootId: "boot-a",
      rootRunId: "root-task-a",
      taskIds: ["task-a"],
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef: data.conversationRef,
      startedAtMs: 61_000,
      status: "checking",
    };
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [makeCheckingTask(data.task, "attempt-a")],
      attempts: [attempt],
    })).toMatchObject({ ok: true });
  });

  it("rejects corrupted and wrong-agent policy references", () => {
    const data = fixture();
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      policySnapshots: [{ ...data.policy, combinedHash: "f".repeat(64) }],
    })).toMatchObject({ ok: false, error: { code: "invalid_policy" } });
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      policySnapshots: [{ ...data.policy, agentId: "agent-other" }],
    })).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
  });

  it("rejects delivering attempts without successful settled execution evidence", () => {
    const data = fixture();
    const attempt = {
      id: "attempt-a",
      bootId: "boot-a",
      rootRunId: "root-task-a",
      taskIds: ["task-a"],
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef: data.conversationRef,
      startedAtMs: 61_000,
      status: "delivering",
      check: { status: "not_returned" },
      deliveringAtMs: 62_000,
    };
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [{ ...data.task, status: "delivering", activeAttemptId: "attempt-a", attemptCount: 1 }],
      attempts: [attempt],
    })).toMatchObject({ ok: false, error: { code: "invalid_record" } });
  });

  it("rejects duplicate task identifiers", () => {
    const data = fixture();
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [data.task, data.task],
    })).toMatchObject({ ok: false, error: { code: "duplicate_id" } });
  });

  it("rejects not-returned evidence outside owner recovery", () => {
    const data = fixture();
    const attempt = {
      ...attemptBase(data),
      status: "failed",
      check: { status: "not_returned" },
      deliveringAtMs: null,
      failureStage: "model",
      errorKind: "dependency",
      deliveredChunks: 0,
      failedChunks: 0,
      terminalAtMs: 62_000,
    };
    expect(parseFollowupTaskStoreFile({ ...data.root, attempts: [attempt] })).toMatchObject({
      ok: false,
      error: { code: "invalid_record" },
    });
  });

  it("rejects executor failure evidence whose code disagrees with its stage", () => {
    const data = fixture();
    const attempt = {
      ...attemptBase(data),
      status: "failed",
      check: { status: "not_started", code: "invalid_target", errorKind: "validation" },
      deliveringAtMs: null,
      failureStage: "executor_invalid_input",
      errorKind: "validation",
      deliveredChunks: 0,
      failedChunks: 0,
      terminalAtMs: 62_000,
    };
    expect(parseFollowupTaskStoreFile({ ...data.root, attempts: [attempt] })).toMatchObject({
      ok: false,
      error: { code: "invalid_record" },
    });
  });

  it("preserves output-guard authentication failures in terminal attempt evidence", () => {
    const data = fixture();
    const attempt = {
      ...attemptBase(data),
      status: "failed",
      check: successfulCheck(),
      deliveringAtMs: null,
      failureStage: "output_guard",
      errorKind: "auth",
      deliveredChunks: 0,
      failedChunks: 0,
      terminalAtMs: 62_000,
    };
    expect(parseFollowupTaskStoreFile({ ...data.root, attempts: [attempt] })).toMatchObject({ ok: true });
  });

  it("rejects terminal task status that disagrees with its attempt", () => {
    const data = fixture();
    const { nextAttemptAtMs: _nextAttemptAtMs, ...base } = data.task;
    const attempt = {
      ...attemptBase(data),
      status: "dismissed",
      check: successfulCheck(),
      terminalAtMs: 62_000,
    };
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [{ ...base, status: "delivered", terminalAttemptId: "attempt-a", terminalAtMs: 62_000 }],
      attempts: [attempt],
    })).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
  });
});
