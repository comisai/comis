// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "@comis/core";

import {
  INTERACTIVE_SILENT_FAILURE_RESPONSE,
  applyInteractiveSilentRecovery,
  recoverInteractiveSilentResponse,
} from "./interactive-silent-recovery.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

describe("recoverInteractiveSilentResponse", () => {
  it("re-enters the model when an interactive request ends silently without delivery", async () => {
    const continueTurn = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const result = await recoverInteractiveSilentResponse({
      operationType: "interactive",
      response: "NO_REPLY",
      outboundDelivered: false,
      continueTurn,
      getVisibleResponse: () => "Visible answer",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(continueTurn).toHaveBeenCalledTimes(1);
    expect(result.value).toEqual({
      attempted: true,
      recovered: true,
      response: "Visible answer",
    });
  });

  it("allows a silent sentinel after successful delivery to the same route", async () => {
    const continueTurn = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const result = await recoverInteractiveSilentResponse({
      operationType: "interactive",
      response: "NO_REPLY",
      outboundDelivered: true,
      continueTurn,
      getVisibleResponse: () => "unused",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(continueTurn).not.toHaveBeenCalled();
    expect(result.value).toEqual({
      attempted: false,
      recovered: false,
      response: "NO_REPLY",
    });
  });

  it("preserves silent control responses for non-interactive operations", async () => {
    const continueTurn = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const result = await recoverInteractiveSilentResponse({
      operationType: "heartbeat",
      response: "HEARTBEAT_OK",
      outboundDelivered: false,
      continueTurn,
      getVisibleResponse: () => "unused",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(continueTurn).not.toHaveBeenCalled();
    expect(result.value.attempted).toBe(false);
    expect(result.value.response).toBe("HEARTBEAT_OK");
  });

  it("returns a visible error when the recovery turn is still silent", async () => {
    const result = await recoverInteractiveSilentResponse({
      operationType: "interactive",
      response: "<reply>NO_REPLY</reply>",
      outboundDelivered: false,
      continueTurn: async () => ({ ok: true as const, value: undefined }),
      getVisibleResponse: () => "[SILENT] still nothing",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      attempted: true,
      recovered: false,
      response: INTERACTIVE_SILENT_FAILURE_RESPONSE,
      finishReason: "error",
      failure: "still_silent",
    });
  });

  it("returns an error when the recovery call rejects", async () => {
    const result = await recoverInteractiveSilentResponse({
      operationType: "interactive",
      response: "NO_REPLY",
      outboundDelivered: false,
      continueTurn: async () => ({ ok: false as const, error: new Error("provider unavailable") }),
      getVisibleResponse: () => "unused",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(Error);
  });
});

describe("applyInteractiveSilentRecovery", () => {
  it("updates the execution result and emits a content-free recovery event", async () => {
    const messages = [{
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
    }];
    const prompt = vi.fn(async () => {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Visible answer" }],
      });
    });
    const emitSafely = vi.fn(() => ({
      hadListeners: false,
      failures: [],
      pendingFailures: Promise.resolve([]),
    }));
    const result = {
      response: "NO_REPLY",
      finishReason: "stop",
    };
    const params = {
      msg: { channelType: "telegram", channelId: "chat-1" },
      session: { messages, prompt },
      result,
      executionOverrides: { operationType: "interactive" },
      bridge: {
        getResult: () => ({}),
        hasOutboundDelivery: vi.fn(() => false),
      },
      agentId: "agent-1",
      sessionKey: {
        tenantId: "tenant-1",
        userId: "user-1",
        channelId: "chat-1",
      },
      deps: {
        eventBus: { emitSafely },
        clock: { now: () => 42 },
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      },
    } as unknown as RunPromptParams;

    await applyInteractiveSilentRecovery(params);

    expect(result).toEqual({ response: "Visible answer", finishReason: "stop" });
    expect(emitSafely).toHaveBeenCalledWith(
      "execution:recovery_attempted",
      expect.objectContaining({
        agentId: "agent-1",
        reason: "interactive_silent_sentinel",
        succeeded: true,
        timestamp: 42,
      }),
    );
    expect(JSON.stringify(emitSafely.mock.calls)).not.toContain("Visible answer");
  });

  it("preserves the recovered reply when an observer and warning logger throw", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("execution:recovery_attempted", () => {
      throw new Error("recovery observer carried user content");
    });
    eventBus.on("execution:recovery_attempted", laterObserver);
    const messages = [{
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
    }];
    const result = { response: "NO_REPLY", finishReason: "stop" };
    const params = {
      msg: { channelType: "telegram", channelId: "chat-1" },
      session: {
        messages,
        prompt: vi.fn(async () => {
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: "Recovered answer" }],
          });
        }),
      },
      result,
      executionOverrides: { operationType: "interactive" },
      bridge: {
        getResult: () => ({}),
        hasOutboundDelivery: vi.fn(() => false),
      },
      agentId: "agent-1",
      sessionKey: {
        tenantId: "tenant-1",
        userId: "user-1",
        channelId: "chat-1",
      },
      deps: {
        eventBus,
        clock: { now: () => 42 },
        logger: {
          info: vi.fn(),
          warn: vi.fn(() => {
            throw new Error("warning logger unavailable");
          }),
        },
      },
    } as unknown as RunPromptParams;

    await expect(applyInteractiveSilentRecovery(params)).resolves.toBeUndefined();

    expect(result).toEqual({ response: "Recovered answer", finishReason: "stop" });
    expect(laterObserver).toHaveBeenCalledOnce();
  });
});
