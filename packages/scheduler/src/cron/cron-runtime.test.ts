// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createConversationRef } from "@comis/core";
import {
  CronRuntimeExecutionInputSchema,
  CronRuntimeOutcomeSchema,
  CronRuntimeErrorSchema,
} from "./cron-runtime.js";

const sessionKey = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  userId: "cron-job_a",
  channelId: "cron",
};

const commonJob = {
  id: "job_a",
  name: "Daily review",
  agentId: "agent_a",
  schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: 1_000 },
  lifecycle: {
    status: "scheduled" as const,
    nextRunAtMs: 61_000,
    consecutiveDependencyErrors: 0,
  },
};

const commonInput = {
  executionId: "execution_a",
  scheduledForMs: 61_000,
  trigger: "scheduled" as const,
};

const deliveryConversationScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: { kind: "channel-principal" as const, channelType: "telegram", principalId: "user_a" },
};
const deliveryConversationRef = createConversationRef(deliveryConversationScope);
if (!deliveryConversationRef.ok) throw deliveryConversationRef.error;

describe("cron runtime boundary contracts", () => {
  it("accepts an agent-turn input with its governed root and exact job snapshot", () => {
    const parsed = CronRuntimeExecutionInputSchema.safeParse({
      ...commonInput,
      kind: "agent_turn",
      rootRunId: "root-cron-execution_a",
      job: {
        ...commonJob,
        source: "authored",
        payload: { kind: "agent_turn", message: "Review new items" },
        sessionPolicy: { strategy: "rolling", maxHistoryTurns: 4 },
        continuationMode: "none",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects mismatched work kinds and roots on ungoverned work", () => {
    const heartbeatJob = {
      ...commonJob,
      source: "authored",
      payload: { kind: "heartbeat_event", text: "Check tasks", wakeMode: "now" },
    };
    expect(CronRuntimeExecutionInputSchema.safeParse({
      ...commonInput,
      kind: "agent_turn",
      rootRunId: "root-cron-execution_a",
      job: heartbeatJob,
    }).success).toBe(false);
    expect(CronRuntimeExecutionInputSchema.safeParse({
      ...commonInput,
      kind: "heartbeat_event",
      rootRunId: "root-cron-execution_a",
      job: heartbeatJob,
    }).success).toBe(false);
  });

  it("accepts all four direct runtime input variants", () => {
    const inputs = [
      {
        ...commonInput,
        kind: "heartbeat_event",
        job: {
          ...commonJob,
          source: "authored",
          payload: { kind: "heartbeat_event", text: "Check tasks", wakeMode: "now" },
        },
      },
      {
        ...commonInput,
        kind: "internal_action",
        rootRunId: "root-cron-execution_a",
        job: {
          ...commonJob,
          source: "built_in",
          payload: { kind: "internal_action", action: "memory_lifecycle" },
        },
      },
      {
        ...commonInput,
        kind: "delivery_only",
        job: {
          ...commonJob,
          source: "authored",
          payload: { kind: "delivery", text: "Reminder" },
          deliveryTarget: {
            conversation: {
              conversationScope: deliveryConversationScope,
              conversationRef: deliveryConversationRef.value,
            },
            destinationEndpoint: {
              channelType: "telegram",
              channelInstanceId: "default",
              conversationId: "chat_a",
              conversationKind: "direct",
            },
          },
        },
      },
    ];

    expect(inputs.every((input) => CronRuntimeExecutionInputSchema.safeParse(input).success)).toBe(true);
  });

  it("accepts a complete agent-turn outcome without flattening delivery truth", () => {
    const parsed = CronRuntimeOutcomeSchema.safeParse({
      kind: "agent_turn",
      outcome: {
        agentExecutionId: "agent-execution_a",
        rootRunId: "root-cron-execution_a",
        sessionKey,
        execution: { status: "completed", finishReason: "stop" },
        modelResolved: "provider/model",
        modelResolutionSource: "cron_job_override",
        metrics: { durationMs: 20, totalTokens: 12, costUsd: 0.01, toolCalls: 1, llmCalls: 1 },
        wakeGate: { status: "not_configured" },
        delivery: {
          status: "partial",
          errorKind: "platform",
          deliveredChunks: 1,
          failedChunks: 1,
          settledAtMs: 80_000,
        },
        continuation: { mode: "none", status: "not_requested" },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects contradictory delivery and continuation evidence", () => {
    expect(CronRuntimeOutcomeSchema.safeParse({
      kind: "delivery_only",
      delivery: { status: "accepted", deliveredChunks: 0, settledAtMs: 80_000 },
    }).success).toBe(false);
    expect(CronRuntimeOutcomeSchema.safeParse({
      kind: "wake_gate_skip",
      rootRunId: "root-cron-execution_a",
      durationMs: 4,
      toolCalls: 0,
      delivery: { status: "not_requested" },
      continuation: { mode: "origin_history", status: "not_requested" },
    }).success).toBe(false);
  });

  it("bounds internal-action counters and validates keyless model evidence", () => {
    const valid = {
      kind: "internal_action",
      action: "memory_lifecycle",
      rootRunId: "root-cron-execution_a",
      modelResolved: null,
      modelResolutionSource: null,
      metrics: { totalTokens: null, costUsd: null, llmCalls: 0 },
      execution: { status: "completed", counters: [{ name: "rows_swept", value: 3 }] },
    };
    expect(CronRuntimeOutcomeSchema.safeParse(valid).success).toBe(true);
    expect(CronRuntimeOutcomeSchema.safeParse({
      ...valid,
      modelResolved: "provider/model",
    }).success).toBe(false);
    expect(CronRuntimeOutcomeSchema.safeParse({
      ...valid,
      execution: {
        status: "completed",
        counters: Array.from({ length: 33 }, (_, index) => ({ name: `counter_${index}`, value: index })),
      },
    }).success).toBe(false);
  });

  it("accepts only closed proven-pre-dispatch runtime errors", () => {
    expect(CronRuntimeErrorSchema.safeParse({
      code: "not_bound",
      errorKind: "precondition",
      message: "Runtime executor is not bound",
    }).success).toBe(true);
    expect(CronRuntimeErrorSchema.safeParse({
      code: "platform_uncertain",
      errorKind: "platform",
      message: "Send may have begun",
    }).success).toBe(false);
  });
});
