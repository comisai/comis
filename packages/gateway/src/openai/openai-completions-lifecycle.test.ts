// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamingHarness = vi.hoisted(() => ({
  callbackResult: undefined as
    | Promise<{ ok: true } | { ok: false; error: unknown }>
    | undefined,
  order: [] as string[],
  abortListeners: [] as Array<() => void>,
  rejectWrite: undefined as string | undefined,
  terminalAdvanceMs: 0,
  writeSSE: vi.fn<(message: { data: string }) => Promise<void>>(),
}));

vi.mock("hono/streaming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hono/streaming")>();
  return {
    ...actual,
    streamSSE: (
      _context: unknown,
      callback: (stream: {
        aborted: boolean;
        onAbort(listener: () => void): void;
        writeSSE: typeof streamingHarness.writeSSE;
      }) => Promise<void>,
    ): Response => {
      streamingHarness.callbackResult = callback({
        aborted: false,
        onAbort: (listener) => { streamingHarness.abortListeners.push(listener); },
        writeSSE: streamingHarness.writeSSE,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      return new Response("", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  };
});

import {
  createOpenaiCompletionsRoute,
  type OpenaiCompletionsDeps,
} from "./openai-completions.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

function createDeps(
  overrides: Partial<OpenaiCompletionsDeps> = {},
): OpenaiCompletionsDeps {
  return {
    executeAgent: vi.fn().mockResolvedValue({
      response: "Hello",
      tokensUsed: { input: 2, output: 3, total: 5 },
      finishReason: "stop",
      stepsExecuted: 0,
      llmCalls: 1,
      status: "success",
    }),
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function classifyWrite(data: string): string {
  if (data === "[DONE]") return "write:done";
  const parsed = JSON.parse(data) as {
    error?: unknown;
    choices?: Array<{
      delta?: { content?: string; role?: string };
      finish_reason?: string | null;
    }>;
    usage?: unknown;
  };
  if (parsed.error !== undefined) return "write:error";
  if (parsed.usage !== undefined) return "write:usage";
  if (parsed.choices?.[0]?.finish_reason) return "write:finish";
  if (parsed.choices?.[0]?.delta?.content !== undefined) return "write:delta";
  return "write:role";
}

function diagnosticCalls(emit: ReturnType<typeof vi.fn>): unknown[][] {
  return emit.mock.calls.filter(
    (call) => call[0] === "diagnostic:message_processed",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  streamingHarness.callbackResult = undefined;
  streamingHarness.order.length = 0;
  streamingHarness.abortListeners.length = 0;
  streamingHarness.rejectWrite = undefined;
  streamingHarness.terminalAdvanceMs = 0;
  streamingHarness.writeSSE.mockReset().mockImplementation(async ({ data }) => {
    const marker = classifyWrite(data);
    if (streamingHarness.rejectWrite === marker) {
      streamingHarness.order.push(`${marker}:rejected`);
      throw new Error(`client closed during ${marker}`);
    }
    if (data === "[DONE]" && streamingHarness.terminalAdvanceMs > 0) {
      vi.setSystemTime(Date.now() + streamingHarness.terminalAdvanceMs);
    }
    await Promise.resolve();
    streamingHarness.order.push(marker);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAI completion lifecycle diagnostics", () => {
  it("emits one execution error diagnostic before returning a non-streaming 500", async () => {
    const order: string[] = [];
    const emit = vi.fn((event: string) => {
      if (event === "diagnostic:message_processed") order.push("diagnostic");
    });
    let requestedTraceId: string | undefined;
    const overrides = {
      tenantId: "tenant",
      agentId: "agent-1",
      executeAgent: vi.fn().mockImplementation((params: { traceId?: string }) => {
        requestedTraceId = params.traceId;
        throw new Error("provider unavailable");
      }),
      eventBus: createMockEventBus({ emit }),
    };
    const app = createOpenaiCompletionsRoute(createDeps(overrides));

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    }).then((result) => {
      order.push("response");
      return result;
    });

    expect(response.status).toBe(500);
    const calls = diagnosticCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      channelType: "openai",
      agentId: "agent-1",
      sessionKey: expect.stringMatching(/^tenant:openai-api:openai:peer:chatcmpl-/),
      traceId: requestedTraceId,
      status: "error",
      failureStage: "execution",
      toolCalls: null,
      llmCalls: null,
      finishReason: "error",
    });
    expect(calls[0]?.[1]).not.toHaveProperty("errorKind");
    expect(requestedTraceId).toBeDefined();
    expect(order).toEqual(["diagnostic", "response"]);
  });

  it("emits one execution error diagnostic before terminal streaming error events", async () => {
    const emit = vi.fn((event: string) => {
      if (event === "diagnostic:message_processed") {
        streamingHarness.order.push("diagnostic");
      }
    });
    const app = createOpenaiCompletionsRoute(createDeps({
      executeAgent: vi.fn().mockRejectedValue(new Error("provider unavailable")),
      eventBus: createMockEventBus({ emit }),
    }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    expect(streamingHarness.callbackResult).toBeDefined();
    await streamingHarness.callbackResult;

    const calls = diagnosticCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      channelType: "openai",
      status: "error",
      failureStage: "execution",
      toolCalls: null,
      llmCalls: null,
      finishReason: "error",
    });
    expect(calls[0]?.[1]).not.toHaveProperty("errorKind");
    expect(streamingHarness.order.indexOf("diagnostic")).toBeLessThan(
      streamingHarness.order.indexOf("write:error"),
    );
    expect(streamingHarness.order.indexOf("diagnostic")).toBeLessThan(
      streamingHarness.order.indexOf("write:done"),
    );
  });

  it("emits streaming success only after all terminal writes resolve", async () => {
    const emit = vi.fn((event: string) => {
      if (event === "diagnostic:message_processed") {
        streamingHarness.order.push("diagnostic");
      }
    });
    const app = createOpenaiCompletionsRoute(createDeps({ eventBus: createMockEventBus({ emit }) }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    expect(streamingHarness.callbackResult).toBeDefined();
    await streamingHarness.callbackResult;

    expect(diagnosticCalls(emit)).toHaveLength(1);
    expect(streamingHarness.order).toEqual([
      "write:role",
      "write:finish",
      "write:usage",
      "write:done",
      "diagnostic",
    ]);
  });

  it("partitions streaming execution and terminal delivery durations", async () => {
    streamingHarness.terminalAdvanceMs = 25;
    const emit = vi.fn();
    const executeAgent = vi.fn(async () => {
      vi.setSystemTime(1_100);
      return {
        response: "Hello",
        tokensUsed: { input: 2, output: 3, total: 5 },
        finishReason: "stop",
        stepsExecuted: 0,
        llmCalls: 1,
        status: "success" as const,
      };
    });
    const app = createOpenaiCompletionsRoute(createDeps({
      executeAgent,
      eventBus: createMockEventBus({ emit }),
    }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    await streamingHarness.callbackResult;

    expect(diagnosticCalls(emit)[0]?.[1]).toMatchObject({
      receivedAt: 1_000,
      executionDurationMs: 100,
      deliveryDurationMs: 25,
      totalDurationMs: 125,
      timestamp: 1_125,
    });
  });

  it("classifies a rejected terminal stream write as a delivery error", async () => {
    streamingHarness.rejectWrite = "write:done";
    const emit = vi.fn((event: string) => {
      if (event === "diagnostic:message_processed") {
        streamingHarness.order.push("diagnostic");
      }
    });
    const app = createOpenaiCompletionsRoute(createDeps({ eventBus: createMockEventBus({ emit }) }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    expect(streamingHarness.callbackResult).toBeDefined();
    await streamingHarness.callbackResult;

    const calls = diagnosticCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "delivery",
    });
    expect(calls[0]?.[1]).not.toMatchObject({ status: "success" });
  });

  it("classifies a rejected initial stream write before execution as delivery failure", async () => {
    streamingHarness.rejectWrite = "write:role";
    const emit = vi.fn();
    const executeAgent = vi.fn();
    const app = createOpenaiCompletionsRoute(createDeps({
      executeAgent,
      eventBus: createMockEventBus({ emit }),
    }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    await streamingHarness.callbackResult;

    expect(executeAgent).not.toHaveBeenCalled();
    expect(diagnosticCalls(emit)).toHaveLength(1);
    expect(diagnosticCalls(emit)[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "delivery",
      errorKind: "platform",
      toolCalls: null,
      llmCalls: null,
    });
  });

  it("classifies a rejected content-delta write as delivery failure", async () => {
    streamingHarness.rejectWrite = "write:delta";
    const emit = vi.fn();
    const executeAgent = vi.fn(async (params: {
      onDelta?: (delta: string, kind?: "text" | "thinking") => void;
    }) => {
      params.onDelta?.("visible", "text");
      return {
        response: "visible",
        tokensUsed: { input: 2, output: 3, total: 5 },
        finishReason: "stop",
        stepsExecuted: 0,
        llmCalls: 1,
        status: "success" as const,
      };
    });
    const app = createOpenaiCompletionsRoute(createDeps({
      executeAgent,
      eventBus: createMockEventBus({ emit }),
    }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    await streamingHarness.callbackResult;

    expect(diagnosticCalls(emit)).toHaveLength(1);
    expect(diagnosticCalls(emit)[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "delivery",
      errorKind: "platform",
    });
  });

  it("preserves a resolved execution failure when terminal delivery also fails", async () => {
    streamingHarness.rejectWrite = "write:done";
    const emit = vi.fn();
    const logger = { info: vi.fn(), error: vi.fn() };
    const executeAgent = vi.fn().mockResolvedValue({
      response: "blocked",
      tokensUsed: { input: 2, output: 1, total: 3 },
      finishReason: "stop",
      stepsExecuted: 1,
      llmCalls: 1,
      status: "error",
      failureStage: "execution",
      errorKind: "precondition",
    });
    const app = createOpenaiCompletionsRoute(createDeps({
      executeAgent,
      eventBus: createMockEventBus({ emit }),
      logger,
    }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    await streamingHarness.callbackResult;

    expect(diagnosticCalls(emit)).toHaveLength(1);
    expect(diagnosticCalls(emit)[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "execution",
      errorKind: "precondition",
      finishReason: "stop",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "platform" }),
      expect.stringContaining("delivery failed"),
    );
  });

  it("observes terminal delivery failure after an executor rejection without replacing its diagnostic", async () => {
    streamingHarness.rejectWrite = "write:error";
    const emit = vi.fn();
    const logger = { info: vi.fn(), error: vi.fn() };
    const app = createOpenaiCompletionsRoute(createDeps({
      executeAgent: vi.fn().mockRejectedValue(new Error("executor rejected")),
      eventBus: createMockEventBus({ emit }),
      logger,
    }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    await streamingHarness.callbackResult;

    expect(diagnosticCalls(emit)).toHaveLength(1);
    expect(diagnosticCalls(emit)[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "execution",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "platform" }),
      expect.stringContaining("delivery failed"),
    );
  });
});
