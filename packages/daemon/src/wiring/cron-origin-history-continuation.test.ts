// SPDX-License-Identifier: Apache-2.0
import { createConversationLocator, type DeliveredAssistantHistoryPort } from "@comis/core";
import { err, ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { describe, expect, it, vi } from "vitest";
import { createCronOriginHistoryContinuation } from "./cron-origin-history-continuation.js";

const EXECUTION_ID = "cron_execution_a";
const SETTLED_AT_MS = 1_800_000_000_000;

function input(): Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }> {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: "telegram_primary",
    conversationId: "chat_a",
    conversationKind: "direct" as const,
  };
  const locator = createConversationLocator({
    tenantId: "tenant_a",
    agentId: "agent_a",
    partition: { kind: "endpoint-conversation", endpoint },
  });
  if (!locator.ok) throw locator.error;
  return {
    kind: "agent_turn",
    executionId: EXECUTION_ID,
    scheduledForMs: SETTLED_AT_MS,
    trigger: "scheduled",
    rootRunId: `root-cron-${EXECUTION_ID}`,
    job: {
      id: "job_a",
      name: "Status check",
      agentId: "agent_a",
      source: "authored",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: SETTLED_AT_MS },
      lifecycle: { status: "scheduled", nextRunAtMs: SETTLED_AT_MS + 60_000, consecutiveDependencyErrors: 0 },
      payload: { kind: "agent_turn", message: "Check status" },
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 3 },
      continuationMode: "origin_history",
      deliveryTarget: { conversation: locator.value, destinationEndpoint: endpoint },
    },
  };
}

function makeLogger() {
  return { warn: vi.fn() } as never;
}

describe("cron origin-history continuation", () => {
  it("appends exact accepted text and receipt authority through the typed port", async () => {
    const append = vi.fn(async () => ok("appended" as const));
    const logger = makeLogger();
    const continueHistory = createCronOriginHistoryContinuation({
      history: { append } satisfies DeliveredAssistantHistoryPort,
      logger,
    });

    const outcome = await continueHistory({
      input: input(),
      sourceExecutionId: "agent_execution_a",
      visibleText: "Exact visible text",
      delivery: {
        status: "accepted",
        deliveredChunks: 1,
        lastMessageId: "platform_message_a",
        settledAtMs: SETTLED_AT_MS,
      },
    });

    expect(outcome).toEqual({ mode: "origin_history", status: "appended" });
    expect(append).toHaveBeenCalledWith({
      conversation: input().job.deliveryTarget!.conversation,
      deliveredText: "Exact visible text",
      sourceExecutionId: "agent_execution_a",
      attemptId: EXECUTION_ID,
      lastPlatformMessageId: "platform_message_a",
      deliveredAtMs: SETTLED_AT_MS,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("preserves already-present idempotency and maps port failure without resend authority", async () => {
    const already = createCronOriginHistoryContinuation({
      history: { append: vi.fn(async () => ok("already_present" as const)) },
      logger: makeLogger(),
    });
    await expect(already({
      input: input(),
      sourceExecutionId: "agent_execution_a",
      visibleText: "Exact visible text",
      delivery: { status: "accepted", deliveredChunks: 1, settledAtMs: SETTLED_AT_MS },
    })).resolves.toEqual({ mode: "origin_history", status: "already_present" });

    const logger = makeLogger();
    const failed = createCronOriginHistoryContinuation({
      history: {
        append: vi.fn(async () => err({ code: "session_locked", errorKind: "resource" as const })),
      },
      logger,
    });
    await expect(failed({
      input: input(),
      sourceExecutionId: "agent_execution_a",
      visibleText: "Exact visible text",
      delivery: { status: "accepted", deliveredChunks: 1, settledAtMs: SETTLED_AT_MS },
    })).resolves.toEqual({ mode: "origin_history", status: "failed", errorKind: "resource" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: EXECUTION_ID,
        step: "origin_history",
        historyErrorCode: "session_locked",
        errorKind: "resource",
        hint: expect.any(String),
      }),
      "Cron origin-history continuation failed",
    );
  });

  it("defensively skips any delivery whose full acceptance is not established", async () => {
    const append = vi.fn();
    const continueHistory = createCronOriginHistoryContinuation({
      history: { append } as DeliveredAssistantHistoryPort,
      logger: makeLogger(),
    });

    const outcome = await continueHistory({
      input: input(),
      sourceExecutionId: "agent_execution_a",
      visibleText: "Exact visible text",
      delivery: {
        status: "unknown",
        errorKind: "dependency",
        deliveredChunks: 0,
        failedChunks: 1,
        ambiguousChunks: 1,
        settledAtMs: SETTLED_AT_MS,
      },
    });

    expect(outcome).toEqual({
      mode: "origin_history",
      status: "skipped",
      reason: "delivery_not_accepted",
    });
    expect(append).not.toHaveBeenCalled();
  });
});
