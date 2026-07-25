// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { planDueTaskClaim } from "./task-selector.js";
import type { FollowupTaskAttemptRecord, FollowupTaskRecord, FollowupTaskStoreFile } from "./task-types.js";

const NOW_MS = 100_000_000;

function pendingTask(): Extract<FollowupTaskRecord, { status: "pending" }> {
  return {
    id: "task-a",
    agentId: "agent-a",
    origin: {
      turnScope: {
        conversation: { tenantId: "tenant-a", agentId: "agent-a", partition: { kind: "agent" } },
        principal: { principalId: "user-a" },
        endpoint: {
          channelType: "echo",
          channelInstanceId: "echo-a",
          conversationId: "conversation-a",
          conversationKind: "direct",
        },
      },
      conversationRef: "conversation-a",
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "echo",
        channelId: "conversation-a",
        userId: "user-a",
      },
      traceId: null,
      responseLocalePolicy: { source: "unset", enforceLocale: false },
      backgroundHopCount: 0,
    },
    sourceExecutionId: "source-a",
    lastSourceExecutionId: "source-a",
    sourceOccurrenceCount: 1,
    workspacePolicyHash: "a".repeat(64),
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    text: "Check the outcome",
    contentTrust: "derived",
    confidence: 0.9,
    createdAtMs: 1,
    dueEarliestMs: 2,
    dueLatestMs: NOW_MS + 90_000_000,
    expiresAtMs: NOW_MS + 90_000_000,
    dedupeKey: "b".repeat(64),
    attemptCount: 0,
    preAcceptanceFailureCount: 0,
    status: "pending",
    nextAttemptAtMs: NOW_MS,
  };
}

function plan(attempts: FollowupTaskAttemptRecord[]) {
  const root: FollowupTaskStoreFile = {
    formatVersion: 1,
    tasks: [pendingTask()],
    attempts,
    policySnapshots: [],
  };
  return planDueTaskClaim({
    root,
    nowMs: NOW_MS,
    agentId: "agent-a",
    bootId: "boot-a",
    rootRunId: "root-a",
    attemptId: "attempt-new",
    maxPerCheck: 1,
    maxPerDayPerConversation: 1,
    quietUntilMs: null,
  });
}

describe("follow-up task rolling visibility selection", () => {
  it("counts active reservations only for the exact tenant agent and conversation", () => {
    const unrelated = {
      id: "attempt-unrelated",
      tenantId: "tenant-other",
      agentId: "agent-a",
      conversationRef: "conversation-a",
      status: "checking",
    } as FollowupTaskAttemptRecord;
    const active = {
      id: "attempt-active",
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef: "conversation-a",
      status: "checking",
    } as FollowupTaskAttemptRecord;

    expect(plan([unrelated, active])).toMatchObject({
      result: { status: "daily_cap", deferredTaskCount: 1, expiredTaskCount: 0 },
      root: { tasks: [{ status: "pending", nextAttemptAtMs: NOW_MS + 60_000 }] },
    });
  });

  it("uses recent unknown-delivery visibility while ignoring evidence outside the rolling day", () => {
    const recent = {
      id: "attempt-recent",
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef: "conversation-a",
      status: "delivery_unknown",
      deliveringAtMs: NOW_MS - 1_000,
    } as FollowupTaskAttemptRecord;
    expect(plan([recent])).toMatchObject({
      result: { status: "daily_cap" },
      root: { tasks: [{ nextAttemptAtMs: NOW_MS - 1_000 + 86_400_000 }] },
    });

    const old = { ...recent, id: "attempt-old", deliveringAtMs: NOW_MS - 86_400_001 } as FollowupTaskAttemptRecord;
    expect(plan([old])).toMatchObject({ result: { status: "claimed" } });
  });
});
