// SPDX-License-Identifier: Apache-2.0
import { createConversationLocator } from "@comis/core";
import { err, ok } from "@comis/shared";
import type { CronRuntimeExecutionInput } from "@comis/scheduler";
import { describe, expect, it, vi } from "vitest";
import { createCronContinuationExecutor } from "./cron-continuation-executor.js";

const EXECUTION_ID = "cron_execution_a";
const NEXT_PHASE_MS = 1_800_000_060_000;

function input(mode: "heartbeat_excerpt" | "origin_history"):
Extract<CronRuntimeExecutionInput, { kind: "agent_turn" }> {
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
    scheduledForMs: 1_800_000_000_000,
    trigger: "scheduled",
    rootRunId: `root-cron-${EXECUTION_ID}`,
    job: {
      id: "job_a",
      name: "Status check",
      agentId: "agent_a",
      source: "authored",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_800_000_000_000 },
      lifecycle: { status: "scheduled", nextRunAtMs: NEXT_PHASE_MS, consecutiveDependencyErrors: 0 },
      payload: { kind: "agent_turn", message: "Check status" },
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 3 },
      continuationMode: mode,
      ...(mode === "origin_history"
        ? { deliveryTarget: { conversation: locator.value, destinationEndpoint: endpoint } }
        : {}),
    },
  };
}

function makeDeps() {
  return {
    continueOriginHistory: vi.fn(async () => ({ mode: "origin_history" as const, status: "appended" as const })),
    resolveNextPeriodicPhaseMs: vi.fn(() => ok(NEXT_PHASE_MS)),
    coordinator: {
      admitSystemEventWake: vi.fn(() => ok({
        queueDisposition: "duplicate" as const,
        wake: {
          status: "coalesced" as const,
          correlationId: "heartbeat_a",
          lane: "normal" as const,
          retainedReason: "cron" as const,
        },
      })),
    },
    logger: { warn: vi.fn() } as never,
  };
}

describe("cron continuation executor", () => {
  it("admits a UTF-8-safe complete heartbeat excerpt at the next periodic phase", async () => {
    const deps = makeDeps();
    const continueTurn = createCronContinuationExecutor(deps);

    const outcome = await continueTurn({
      input: input("heartbeat_excerpt"),
      sourceExecutionId: "agent_execution_a",
      visibleText: "🙂".repeat(2_000),
      delivery: { status: "not_requested" },
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      mode: "heartbeat_excerpt",
      status: "admitted",
      correlationId: "heartbeat_a",
      queueDisposition: "duplicate",
    });
    expect(deps.resolveNextPeriodicPhaseMs).toHaveBeenCalledWith("agent_a");
    const request = deps.coordinator.admitSystemEventWake.mock.calls[0]![0];
    expect(request).toMatchObject({
      target: { kind: "agent", agentId: "agent_a" },
      reason: "cron",
      wakeMode: "next-heartbeat",
      notBeforeMs: NEXT_PHASE_MS,
      event: {
        trigger: "cron",
        contextKey: "16:cron_execution_a17:heartbeat_excerpt",
      },
    });
    expect(Buffer.byteLength(request.event.text, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(request.event.text).toMatch(/^(🙂)+$/u);
  });

  it("maps periodic and atomic-admission failures without inventing a wake", async () => {
    const noPeriodic = makeDeps();
    noPeriodic.resolveNextPeriodicPhaseMs.mockReturnValue(err({
      message: "disabled",
      errorKind: "precondition" as const,
    }));
    const first = createCronContinuationExecutor(noPeriodic);
    await expect(first({
      input: input("heartbeat_excerpt"),
      sourceExecutionId: "agent_execution_a",
      visibleText: "visible",
      delivery: { status: "not_requested" },
      signal: new AbortController().signal,
    })).resolves.toEqual({ mode: "heartbeat_excerpt", status: "failed", errorKind: "precondition" });
    expect(noPeriodic.coordinator.admitSystemEventWake).not.toHaveBeenCalled();

    const full = makeDeps();
    full.coordinator.admitSystemEventWake.mockReturnValue(err({
      code: "queue_full" as const,
      errorKind: "resource" as const,
    }));
    const second = createCronContinuationExecutor(full);
    await expect(second({
      input: input("heartbeat_excerpt"),
      sourceExecutionId: "agent_execution_a",
      visibleText: "visible",
      delivery: { status: "not_requested" },
      signal: new AbortController().signal,
    })).resolves.toEqual({ mode: "heartbeat_excerpt", status: "failed", errorKind: "resource" });
  });

  it("delegates origin-history mode with the unchanged accepted evidence", async () => {
    const deps = makeDeps();
    const continueTurn = createCronContinuationExecutor(deps);
    const request = {
      input: input("origin_history"),
      sourceExecutionId: "agent_execution_a",
      visibleText: "visible",
      delivery: { status: "accepted" as const, deliveredChunks: 1, settledAtMs: NEXT_PHASE_MS },
      signal: new AbortController().signal,
    };

    await expect(continueTurn(request)).resolves.toEqual({ mode: "origin_history", status: "appended" });
    expect(deps.continueOriginHistory).toHaveBeenCalledWith(request);
    expect(deps.coordinator.admitSystemEventWake).not.toHaveBeenCalled();
  });
});
