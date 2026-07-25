// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "@comis/core";
import {
  emitGatewayTurnDiagnostic,
  formatGatewayErrorForLog,
} from "./turn-diagnostic.js";

describe("gateway turn diagnostic timing bounds", () => {
  it("uses a content-free fallback when an error name accessor throws", () => {
    const hostileError = new Error("private upstream response body");
    Object.defineProperty(hostileError, "name", {
      get(): never {
        throw new Error("private accessor failure");
      },
    });

    expect(formatGatewayErrorForLog(hostileError)).toBe("UnknownError");
  });

  it("never emits negative lifecycle durations when the wall clock moves backward", () => {
    const emit = vi.fn();
    const emitSafely = vi.fn((event: string, payload: unknown) => {
      emit(event, payload);
      return { hadListeners: false, failures: [] };
    });

    emitGatewayTurnDiagnostic(
      {
        eventBus: { emitSafely },
        logger: { error: vi.fn() },
      },
      {
        messageId: "message-1",
        channelId: "openai",
        channelType: "openai",
        fallbackAgentId: "agent-1",
        fallbackSessionKey: "tenant:user:openai",
        fallbackTraceId: "trace-1",
        result: {
          tokensUsed: { total: 3 },
          finishReason: "stop",
          stepsExecuted: 1,
          llmCalls: 1,
          status: "success",
        },
        receivedAt: 1_000,
        executionCompletedAt: 900,
        completedAt: 800,
      },
    );

    expect(emit).toHaveBeenCalledWith(
      "diagnostic:message_processed",
      expect.objectContaining({
        receivedAt: 1_000,
        executionDurationMs: 0,
        deliveryDurationMs: 0,
        totalDurationMs: 0,
        timestamp: 1_000,
      }),
    );
  });

  it("reaches later diagnostic subscribers and reports each isolated failure", () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    const error = vi.fn();
    eventBus.on("diagnostic:message_processed", () => {
      throw new Error("first diagnostic subscriber failed");
    });
    eventBus.on("diagnostic:message_processed", laterObserver);

    emitGatewayTurnDiagnostic(
      { eventBus, logger: { error } },
      {
        messageId: "message-2",
        channelId: "openai",
        channelType: "openai",
        fallbackAgentId: "agent-1",
        fallbackSessionKey: "tenant:user:openai",
        fallbackTraceId: "trace-2",
        result: {
          tokensUsed: { total: 3 },
          finishReason: "stop",
          stepsExecuted: 1,
          llmCalls: 1,
          status: "success",
        },
        receivedAt: 1_000,
        executionCompletedAt: 1_100,
        completedAt: 1_200,
      },
    );

    expect(laterObserver).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "diagnostic:message_processed",
        listenerIndex: 0,
        errorKind: "internal",
        hint: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it("reports a rejected asynchronous diagnostic subscriber without rejecting the turn", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    const error = vi.fn();
    eventBus.on("diagnostic:message_processed", async () => {
      await Promise.resolve();
      throw new Error("async diagnostic subscriber failed");
    });
    eventBus.on("diagnostic:message_processed", laterObserver);

    emitGatewayTurnDiagnostic(
      { eventBus, logger: { error } },
      {
        messageId: "message-3",
        channelId: "responses",
        channelType: "responses",
        fallbackAgentId: "agent-1",
        fallbackSessionKey: "tenant:user:responses",
        fallbackTraceId: "trace-3",
        result: {
          tokensUsed: { total: 2 },
          finishReason: "stop",
          stepsExecuted: 1,
          llmCalls: 1,
          status: "success",
        },
        receivedAt: 1_000,
        executionCompletedAt: 1_100,
        completedAt: 1_200,
      },
    );

    expect(laterObserver).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "diagnostic:message_processed",
        listenerIndex: 0,
        errorKind: "internal",
      }),
      expect.any(String),
    ));
  });
});
