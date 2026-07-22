// SPDX-License-Identifier: Apache-2.0
import { createConversationRef } from "@comis/core";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCronSettledDelivery } from "./cron-settled-delivery.js";

const NOW_MS = 1_800_000_000_000;

function target() {
  const destinationEndpoint = {
    channelType: "telegram",
    channelInstanceId: "bot-a",
    conversationId: "chat-a",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "endpoint-conversation" as const, endpoint: destinationEndpoint },
  };
  const ref = createConversationRef(conversationScope);
  if (!ref.ok) throw ref.error;
  return {
    conversation: { conversationScope, conversationRef: ref.value },
    destinationEndpoint,
  };
}

function makeDeps() {
  const adapter = { channelId: "bot-a", channelType: "telegram", sendMessage: vi.fn() };
  return {
    clock: createFakeClock(NOW_MS),
    adaptersByType: new Map([["telegram", adapter]]),
    deliveryService: {
      deliverToChannel: vi.fn(async () => ok({
        chunks: [],
        totalChars: 2,
        queueDisposition: "settled" as const,
        platform: {
          status: "accepted" as const,
          deliveredChunks: 1,
          settledAtMs: NOW_MS,
          lastMessageId: "message-a",
        },
      })),
      drainInFlight: vi.fn(),
    },
    outputGuard: {
      scan: vi.fn(() => ok({ safe: true, blocked: false, findings: [], sanitized: "OK" })),
    },
    isQuietHours: vi.fn(() => ok(false)),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    _adapter: adapter,
  };
}

describe("cron settled delivery", () => {
  it("uses the exact target instance, output guard, and settled completion mode", async () => {
    const deps = makeDeps();
    const deliver = createCronSettledDelivery(deps);

    await expect(deliver({
      executionId: "execution-a",
      jobId: "job-a",
      text: " raw ",
      target: target(),
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: "accepted",
      deliveredChunks: 1,
      settledAtMs: NOW_MS,
      lastMessageId: "message-a",
    });

    expect(deps.outputGuard.scan).toHaveBeenCalledWith(" raw ");
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      deps._adapter,
      "chat-a",
      "OK",
      expect.objectContaining({
        completionMode: "settled",
        origin: "cron",
        destinationEndpoint: target().destinationEndpoint,
      }),
    );
  });

  it("fails before send for quiet hours, cancellation, guard rejection, or instance drift", async () => {
    const cases = [
      {
        mutate: (deps: ReturnType<typeof makeDeps>) => deps.isQuietHours.mockReturnValue(ok(true)),
        expected: { status: "suppressed", reason: "quiet_hours" },
      },
      {
        mutate: (_deps: ReturnType<typeof makeDeps>, controller: AbortController) => controller.abort(),
        expected: { status: "pre_send_failed", reason: "cancelled", errorKind: "precondition" },
      },
      {
        mutate: (deps: ReturnType<typeof makeDeps>) => deps.outputGuard.scan.mockReturnValue(
          ok({ safe: false, blocked: true, findings: [], sanitized: "" }),
        ),
        expected: { status: "pre_send_failed", reason: "output_guard", errorKind: "auth" },
      },
      {
        mutate: (deps: ReturnType<typeof makeDeps>) => {
          deps._adapter.channelId = "bot-b";
        },
        expected: { status: "pre_send_failed", reason: "target_precondition", errorKind: "precondition" },
      },
    ] as const;

    for (const testCase of cases) {
      const deps = makeDeps();
      const controller = new AbortController();
      testCase.mutate(deps, controller);
      const deliver = createCronSettledDelivery(deps);
      await expect(deliver({
        executionId: "execution-a",
        jobId: "job-a",
        text: "raw",
        target: target(),
        signal: controller.signal,
      })).resolves.toEqual(testCase.expected);
      expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
    }
  });

  it("returns immutable unknown evidence when the delivery boundary rejects after entry", async () => {
    const deps = makeDeps();
    deps.deliveryService.deliverToChannel.mockResolvedValue(err(new Error("transport settlement lost")));
    const deliver = createCronSettledDelivery(deps);

    await expect(deliver({
      executionId: "execution-a",
      jobId: "job-a",
      text: "raw",
      target: target(),
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: "unknown",
      errorKind: "dependency",
      deliveredChunks: 0,
      failedChunks: 1,
      ambiguousChunks: 1,
      settledAtMs: NOW_MS,
    });
  });
});
