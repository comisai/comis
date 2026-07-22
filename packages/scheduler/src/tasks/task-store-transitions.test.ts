// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createConversationRef } from "@comis/core";
import type {
  FollowupTaskAttemptRecord,
  FollowupTaskRecord,
  FollowupTaskStoreFile,
  SuccessfulTaskCheckExecutionEvidence,
} from "./task-types.js";
import {
  buildDeliveryTerminal,
  buildDismissedTerminal,
  buildRetryableFailure,
  createTaskStoreMutex,
  isTaskStoreNodeError,
  resolveClaimedTasks,
  snapshotTaskStoreRoot,
  terminalizeClosedWindow,
  terminalizeConfigurationDisabled,
  validTaskStoreId,
  validTaskStoreTime,
} from "./task-store-transitions.js";

const NOW_MS = 1_000_000;

const conversation = { tenantId: "tenant-a", agentId: "agent-a", partition: { kind: "agent" as const } };
const conversationRefResult = createConversationRef(conversation);
if (!conversationRefResult.ok) throw conversationRefResult.error;

const check: SuccessfulTaskCheckExecutionEvidence = {
  status: "settled",
  agentExecutionId: "agent-execution-a",
  modelResolved: "provider/model",
  modelResolutionSource: "agent_primary",
  metrics: { durationMs: 10, totalTokens: 5, costUsd: 0.01, toolCalls: 0, llmCalls: 1 },
  execution: { status: "completed", finishReason: "stop" },
};

function task(
  id: string,
  status: "checking" | "delivering" = "checking",
  overrides: Record<string, unknown> = {},
): FollowupTaskRecord {
  return {
    id,
    agentId: "agent-a",
    origin: {
      turnScope: { conversation, principal: { principalId: "user-a" } },
      conversationRef: conversationRefResult.value,
    },
    sourceExecutionId: "source-a",
    lastSourceExecutionId: "source-a",
    sourceOccurrenceCount: 1,
    workspacePolicyHash: "a".repeat(64),
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    text: "check outcome",
    contentTrust: "derived",
    confidence: 0.9,
    createdAtMs: 1_000,
    dueEarliestMs: 2_000,
    dueLatestMs: NOW_MS + 3 * 60 * 60_000,
    expiresAtMs: NOW_MS + 4 * 60 * 60_000,
    dedupeKey: "b".repeat(64),
    attemptCount: 1,
    preAcceptanceFailureCount: 0,
    status,
    activeAttemptId: "attempt-a",
    ...overrides,
  } as unknown as FollowupTaskRecord;
}

function checkingAttempt(overrides: Record<string, unknown> = {}): Extract<FollowupTaskAttemptRecord, { status: "checking" }> {
  return {
    id: "attempt-a",
    bootId: "boot-a",
    rootRunId: "root-a",
    taskIds: ["task-a", "task-b"],
    tenantId: "tenant-a",
    agentId: "agent-a",
    conversationRef: conversationRefResult.value,
    startedAtMs: NOW_MS,
    status: "checking",
    ...overrides,
  } as Extract<FollowupTaskAttemptRecord, { status: "checking" }>;
}

function deliveringAttempt(overrides: Record<string, unknown> = {}): Extract<FollowupTaskAttemptRecord, { status: "delivering" }> {
  return {
    ...checkingAttempt(overrides),
    status: "delivering",
    check,
    deliveringAtMs: NOW_MS + 100,
  } as Extract<FollowupTaskAttemptRecord, { status: "delivering" }>;
}

function root(
  tasks: FollowupTaskRecord[] = [task("task-a"), task("task-b")],
  attempt: FollowupTaskAttemptRecord = checkingAttempt(),
): FollowupTaskStoreFile {
  return { formatVersion: 1, tasks, attempts: [attempt], policySnapshots: [] };
}

describe("follow-up task store transitions", () => {
  it("resolves only a complete and consistently owned claim graph", () => {
    expect(resolveClaimedTasks(root(), checkingAttempt())).toMatchObject({
      ok: true,
      value: [{ id: "task-a" }, { id: "task-b" }],
    });
    expect(resolveClaimedTasks(root([task("task-a")]), checkingAttempt())).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
    expect(resolveClaimedTasks(
      root([task("task-a"), task("task-b", "checking", { activeAttemptId: "attempt-b" })]),
      checkingAttempt(),
    )).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("returns claimed tasks to pending when configuration becomes disabled", () => {
    const unrelated = task("task-c", "checking", { activeAttemptId: "attempt-c" });
    const result = terminalizeConfigurationDisabled(
      root([task("task-a"), task("task-b"), unrelated]),
      checkingAttempt(),
      check,
      NOW_MS + 200,
    );

    expect(result.value).toEqual({ status: "configuration_disabled" });
    expect(result.root.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "task-a", status: "pending", nextAttemptAtMs: NOW_MS + 200 }),
      expect.objectContaining({ id: "task-c", status: "checking", activeAttemptId: "attempt-c" }),
    ]));
    expect(result.root.attempts[0]).toMatchObject({
      status: "failed",
      failureStage: "configuration_disabled",
      errorKind: "precondition",
    });
  });

  it("expires elapsed claims while reopening claims whose window remains valid", () => {
    const expired = task("task-a", "checking", { dueLatestMs: NOW_MS + 50, expiresAtMs: NOW_MS + 50 });
    const pending = task("task-b");
    const result = terminalizeClosedWindow(
      root([expired, pending]),
      checkingAttempt(),
      check,
      [expired as Extract<FollowupTaskRecord, { status: "checking" }>, pending as Extract<FollowupTaskRecord, { status: "checking" }>],
      NOW_MS + 200,
    );

    expect(result.value).toEqual({ status: "delivery_window_closed" });
    expect(result.root.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "task-a", status: "expired", terminalAttemptId: "attempt-a" }),
      expect.objectContaining({ id: "task-b", status: "pending", nextAttemptAtMs: NOW_MS + 200 }),
    ]));
  });

  it("terminalizes accepted partial and ambiguous deliveries with exact evidence", () => {
    const attempt = deliveringAttempt();
    const deliveringRoot = root([task("task-a", "delivering"), task("task-b", "delivering")], attempt);
    const accepted = buildDeliveryTerminal(deliveringRoot, attempt, {
      status: "accepted",
      deliveredChunks: 2,
      failedChunks: 0,
      lastPlatformMessageId: "message-a",
      deliveredAtMs: NOW_MS + 150,
      history: { status: "appended" },
    }, NOW_MS + 200);
    expect(accepted).toMatchObject({
      ok: true,
      value: { tasks: [{ status: "delivered" }, { status: "delivered" }], attempts: [{ status: "delivered" }] },
    });

    const partial = buildDeliveryTerminal(deliveringRoot, attempt, {
      status: "partial",
      errorKind: "platform",
      deliveredChunks: 1,
      failedChunks: 1,
      lastPlatformMessageId: null,
      deliveredAtMs: NOW_MS + 150,
    }, NOW_MS + 200);
    expect(partial).toMatchObject({
      ok: true,
      value: { tasks: [{ status: "delivery_partial" }, { status: "delivery_partial" }] },
    });

    const unknown = buildDeliveryTerminal(deliveringRoot, attempt, {
      status: "unknown",
      delivery: {
        source: "platform_ambiguous",
        errorKind: "platform",
        deliveredChunks: 1,
        failedChunks: 2,
        ambiguousChunks: 1,
        lastPlatformMessageId: "message-a",
      },
    }, NOW_MS + 200);
    expect(unknown).toMatchObject({
      ok: true,
      value: { tasks: [{ status: "delivery_unknown" }, { status: "delivery_unknown" }] },
    });
  });

  it("rejects malformed accepted partial and unknown delivery evidence", () => {
    const attempt = deliveringAttempt();
    const deliveringRoot = root([task("task-a", "delivering"), task("task-b", "delivering")], attempt);
    expect(buildDeliveryTerminal(deliveringRoot, attempt, {
      status: "accepted",
      deliveredChunks: 0,
      failedChunks: 0,
      lastPlatformMessageId: "",
      deliveredAtMs: NOW_MS,
      history: { status: "already_present" },
    }, NOW_MS + 200)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(buildDeliveryTerminal(deliveringRoot, attempt, {
      status: "partial",
      errorKind: "platform",
      deliveredChunks: 1,
      failedChunks: 0,
      lastPlatformMessageId: null,
      deliveredAtMs: NOW_MS + 150,
    }, NOW_MS + 200)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(buildDeliveryTerminal(deliveringRoot, attempt, {
      status: "unknown",
      delivery: {
        source: "platform_ambiguous",
        errorKind: "platform",
        deliveredChunks: 0,
        failedChunks: 1,
        ambiguousChunks: 2,
        lastPlatformMessageId: null,
      },
    }, NOW_MS + 200)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(buildDeliveryTerminal(deliveringRoot, attempt, {
      status: "unknown",
      delivery: {
        source: "owner_recovery",
        errorKind: "timeout",
        deliveredChunks: null,
        failedChunks: null,
        ambiguousChunks: null,
        lastPlatformMessageId: null,
      },
    }, NOW_MS + 200)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("terminalizes dismissed checks without mutating unrelated task ownership", () => {
    const unrelated = task("task-c", "checking", { activeAttemptId: "attempt-c" });
    const result = buildDismissedTerminal(
      root([task("task-a"), task("task-b"), unrelated]),
      checkingAttempt(),
      check,
      NOW_MS + 200,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        tasks: [
          { status: "dismissed", terminalAttemptId: "attempt-a" },
          { status: "dismissed", terminalAttemptId: "attempt-a" },
          { status: "checking", activeAttemptId: "attempt-c" },
        ],
      },
    });
  });

  it("schedules bounded retries before expiring exhausted or late tasks", () => {
    const attempt = checkingAttempt();
    const scheduled = buildRetryableFailure({
      root: root(),
      attempt,
      check: { ...check, execution: { status: "failed", finishReason: "error", errorKind: "dependency" } },
      failureStage: "model",
      errorKind: "dependency",
      failedChunks: 0,
      nowMs: NOW_MS,
      retryLimit: 3,
    });
    expect(scheduled).toMatchObject({
      ok: true,
      value: {
        disposition: "retry_scheduled",
        root: { tasks: [{ status: "pending", preAcceptanceFailureCount: 1 }, { status: "pending" }] },
      },
    });

    const expired = buildRetryableFailure({
      root: root([
        task("task-a", "checking", { dueLatestMs: NOW_MS + 1, expiresAtMs: NOW_MS + 1 }),
        task("task-b", "checking", { preAcceptanceFailureCount: 3 }),
      ]),
      attempt,
      check: { ...check, execution: { status: "failed", finishReason: "error", errorKind: "dependency" } },
      failureStage: "model",
      errorKind: "dependency",
      failedChunks: 0,
      nowMs: NOW_MS,
      retryLimit: 3,
    });
    expect(expired).toMatchObject({
      ok: true,
      value: { disposition: "expired", root: { tasks: [{ status: "expired" }, { status: "expired" }] } },
    });
  });

  it("preserves delivery rejection timing and rejects contradictory failure evidence", () => {
    const attempt = deliveringAttempt();
    const deliveringRoot = root([task("task-a", "delivering"), task("task-b", "delivering")], attempt);
    expect(buildRetryableFailure({
      root: deliveringRoot,
      attempt,
      check,
      failureStage: "delivery_rejected",
      errorKind: "platform",
      failedChunks: 1,
      nowMs: NOW_MS + 200,
      retryLimit: 3,
    })).toMatchObject({
      ok: true,
      value: { root: { attempts: [{ status: "failed", deliveringAtMs: NOW_MS + 100 }] } },
    });
    expect(buildRetryableFailure({
      root: root(),
      attempt: checkingAttempt(),
      check,
      failureStage: "executor_invalid_input",
      errorKind: "dependency",
      failedChunks: 0,
      nowMs: NOW_MS + 200,
      retryLimit: 3,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("validates primitive store values snapshots and serialized failures", async () => {
    expect(validTaskStoreTime(0)).toBe(true);
    expect(validTaskStoreTime(-1)).toBe(false);
    expect(validTaskStoreTime(1.5)).toBe(false);
    expect(validTaskStoreId("task-a")).toBe(true);
    expect(validTaskStoreId("")).toBe(false);
    expect(validTaskStoreId("é".repeat(129))).toBe(false);
    expect(isTaskStoreNodeError(Object.assign(new Error("missing"), { code: "ENOENT" }), "ENOENT")).toBe(true);
    expect(isTaskStoreNodeError(new Error("missing"), "ENOENT")).toBe(false);

    const original = root();
    const snapshot = snapshotTaskStoreRoot(original);
    snapshot.tasks.splice(0, 1);
    expect(original.tasks).toHaveLength(2);

    const mutex = createTaskStoreMutex();
    const order: string[] = [];
    await expect(mutex.serialize(async () => {
      order.push("first");
      throw new Error("expected failure");
    })).rejects.toThrow("expected failure");
    await expect(mutex.serialize(async () => {
      order.push("second");
      return "done";
    })).resolves.toBe("done");
    expect(order).toEqual(["first", "second"]);
  });
});
