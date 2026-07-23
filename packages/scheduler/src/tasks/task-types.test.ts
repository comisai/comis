// SPDX-License-Identifier: Apache-2.0
import {
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  hashWorkspacePolicyContent,
} from "@comis/core";
import { describe, expect, it } from "vitest";
import {
  FollowupTaskAttemptRecordSchema,
  FollowupTaskRecordSchema,
  parseFollowupTaskStoreFile,
} from "./task-types.js";

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
      responseLocalePolicy: { source: "unset", enforceLocale: false },
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

  it("rejects malformed envelopes and duplicate attempt or policy identifiers", () => {
    const data = fixture();
    expect(parseFollowupTaskStoreFile(null)).toMatchObject({ ok: false, error: { code: "invalid_record" } });
    const checking = {
      ...attemptBase(data),
      status: "checking",
    };
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [makeCheckingTask(data.task, "attempt-a")],
      attempts: [checking, checking],
    })).toMatchObject({ ok: false, error: { code: "duplicate_id" } });
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      policySnapshots: [data.policy, data.policy],
    })).toMatchObject({ ok: false, error: { code: "duplicate_id" } });
  });

  it("rejects task authority whose identity text or timestamps contradict the base contract", () => {
    const data = fixture();
    expect(FollowupTaskRecordSchema.safeParse({ ...data.task, agentId: "agent-other" }).success).toBe(false);
    expect(FollowupTaskRecordSchema.safeParse({ ...data.task, text: "é".repeat(2_049) }).success).toBe(false);
    expect(FollowupTaskRecordSchema.safeParse({ ...data.task, nextAttemptAtMs: 500 }).success).toBe(false);
    expect(FollowupTaskRecordSchema.safeParse({ ...data.task, nextAttemptAtMs: data.task.expiresAtMs + 1 }).success).toBe(false);
    const { nextAttemptAtMs: _nextAttemptAtMs, ...terminalBase } = data.task;
    expect(FollowupTaskRecordSchema.safeParse({
      ...terminalBase,
      status: "cancelled",
      terminalAttemptId: null,
      terminalAtMs: 500,
    }).success).toBe(false);
  });

  it("rejects duplicate task ownership and contradictory attempt timestamps", () => {
    const data = fixture();
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...attemptBase(data),
      status: "checking",
      taskIds: ["task-a", "task-a"],
    }).success).toBe(false);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...attemptBase(data),
      status: "dismissed",
      check: successfulCheck(),
      terminalAtMs: 60_999,
    }).success).toBe(false);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...attemptBase(data),
      status: "delivering",
      check: successfulCheck(),
      deliveringAtMs: 60_999,
    }).success).toBe(false);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...attemptBase(data),
      status: "delivered",
      check: successfulCheck(),
      deliveringAtMs: 62_000,
      deliveredChunks: 1,
      failedChunks: 0,
      lastPlatformMessageId: null,
      deliveredAtMs: 61_500,
      terminalAtMs: 61_900,
      history: { status: "appended" },
    }).success).toBe(false);
  });

  it("enforces fixed failure kinds output guard kinds and delivery evidence pairing", () => {
    const data = fixture();
    const failed = {
      ...attemptBase(data),
      status: "failed",
      check: successfulCheck(),
      deliveringAtMs: null,
      failureStage: "deadline",
      errorKind: "dependency",
      deliveredChunks: 0,
      failedChunks: 0,
      terminalAtMs: 62_000,
    };
    expect(FollowupTaskAttemptRecordSchema.safeParse(failed).success).toBe(false);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...failed,
      failureStage: "output_guard",
      errorKind: "platform",
    }).success).toBe(false);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...failed,
      failureStage: "delivery_rejected",
      errorKind: "platform",
      failedChunks: 1,
    }).success).toBe(false);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...failed,
      failureStage: "model",
      failedChunks: 1,
    }).success).toBe(false);
  });

  it("rejects contradictory unknown-delivery chunk and ownership evidence", () => {
    const data = fixture();
    const deliveryUnknown = {
      ...attemptBase(data),
      status: "delivery_unknown",
      check: successfulCheck(),
      deliveringAtMs: 61_500,
      terminalAtMs: 62_000,
    };

    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...deliveryUnknown,
      delivery: {
        source: "platform_ambiguous",
        errorKind: "platform",
        deliveredChunks: 0,
        failedChunks: 1,
        ambiguousChunks: 2,
        lastPlatformMessageId: null,
      },
    }).success).toBe(false);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...deliveryUnknown,
      delivery: {
        source: "owner_recovery",
        errorKind: "timeout",
        deliveredChunks: null,
        failedChunks: null,
        ambiguousChunks: null,
        lastPlatformMessageId: null,
      },
    }).success).toBe(false);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...deliveryUnknown,
      delivery: {
        source: "runtime_unsettled",
        errorKind: "internal",
        deliveredChunks: null,
        failedChunks: null,
        ambiguousChunks: null,
        lastPlatformMessageId: null,
      },
    }).success).toBe(false);
  });

  it("accepts owner recovery only with reserved not-returned evidence", () => {
    const data = fixture();
    const ownerRecovery = {
      ...attemptBase(data),
      status: "failed",
      check: { status: "not_returned" },
      deliveringAtMs: null,
      failureStage: "owner_recovery_before_delivery",
      errorKind: "internal",
      deliveredChunks: 0,
      failedChunks: 0,
      terminalAtMs: 62_000,
    };
    expect(FollowupTaskAttemptRecordSchema.safeParse(ownerRecovery).success).toBe(true);
    expect(FollowupTaskAttemptRecordSchema.safeParse({
      ...ownerRecovery,
      check: successfulCheck(),
    }).success).toBe(false);
  });

  it("rejects graph edges with missing tasks or mismatched owner identity", () => {
    const data = fixture();
    const checking = { ...attemptBase(data), status: "checking" };
    expect(parseFollowupTaskStoreFile({ ...data.root, attempts: [checking] })).toMatchObject({
      ok: false,
      error: { code: "invalid_graph" },
    });
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [makeCheckingTask(data.task, "attempt-a")],
      attempts: [{ ...checking, agentId: "agent-other" }],
    })).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [makeCheckingTask(data.task, "attempt-a")],
      attempts: [{ ...checking, tenantId: "tenant-other" }],
    })).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [makeCheckingTask(data.task, "attempt-a")],
      attempts: [{ ...checking, taskIds: ["task-other"] }],
    })).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
  });

  it("rejects terminal graph edges with missing attempts or mismatched terminal time", () => {
    const data = fixture();
    const { nextAttemptAtMs: _nextAttemptAtMs, ...base } = data.task;
    const dismissed = {
      ...attemptBase(data),
      status: "dismissed",
      check: successfulCheck(),
      terminalAtMs: 62_000,
    };
    const terminalTask = { ...base, status: "dismissed", terminalAttemptId: "attempt-a", terminalAtMs: 62_000 };
    expect(parseFollowupTaskStoreFile({ ...data.root, tasks: [terminalTask] })).toMatchObject({
      ok: false,
      error: { code: "invalid_graph" },
    });
    expect(parseFollowupTaskStoreFile({
      ...data.root,
      tasks: [{ ...terminalTask, terminalAtMs: 62_001 }],
      attempts: [dismissed],
    })).toMatchObject({ ok: false, error: { code: "invalid_graph" } });
  });
});
