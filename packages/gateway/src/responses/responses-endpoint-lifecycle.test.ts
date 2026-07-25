// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamingHarness = vi.hoisted(() => ({
  callbackResult: undefined as
    | Promise<{ ok: true } | { ok: false; error: unknown }>
    | undefined,
  order: [] as string[],
  abortListeners: [] as Array<() => void>,
  rejectWrite: undefined as string | undefined,
  terminalAdvanceMs: 0,
  writes: [] as string[],
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
  createResponsesRoute,
  type ResponsesEndpointDeps,
} from "./responses-endpoint.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

type DeltaKind = "text" | "thinking";

interface KindAwareExecuteParams {
  message: string;
  sessionKey: { userId: string; channelId: string; peerId: string };
  onDelta?: (delta: string, kind?: DeltaKind) => void;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude",
    input: "Hello",
    ...overrides,
  };
}

function successfulResult(): Record<string, unknown> {
  return {
    response: "Visible answer",
    tokensUsed: { input: 10, output: 20, total: 30 },
    finishReason: "end_turn",
    stepsExecuted: 2,
    llmCalls: 3,
    status: "success",
    traceId: "trace-responses-1",
    agentId: "agent-1",
    sessionKey: "tenant:responses-api:responses",
  };
}

function createDeps(overrides: Record<string, unknown> = {}): ResponsesEndpointDeps {
  return {
    tenantId: "tenant-a",
    agentId: "agent-a",
    executeAgent: vi.fn().mockResolvedValue(successfulResult()),
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  } as unknown as ResponsesEndpointDeps;
}

function diagnosticCalls(emit: ReturnType<typeof vi.fn>): unknown[][] {
  return emit.mock.calls.filter(
    (call) => call[0] === "diagnostic:message_processed",
  );
}

function eventType(data: string): string {
  if (data === "[DONE]") return "done";
  return (JSON.parse(data) as { type?: string }).type ?? "unknown";
}

function streamedTextDeltas(): string[] {
  return streamingHarness.writes
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as { type?: string; delta?: string })
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta ?? "");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  streamingHarness.callbackResult = undefined;
  streamingHarness.order.length = 0;
  streamingHarness.abortListeners.length = 0;
  streamingHarness.rejectWrite = undefined;
  streamingHarness.terminalAdvanceMs = 0;
  streamingHarness.writes.length = 0;
  streamingHarness.writeSSE.mockReset().mockImplementation(async ({ data }) => {
    const marker = eventType(data);
    if (streamingHarness.rejectWrite === marker) {
      streamingHarness.order.push(`write:${marker}:rejected`);
      throw new Error(`client closed during ${marker}`);
    }
    if (data === "[DONE]" && streamingHarness.terminalAdvanceMs > 0) {
      vi.setSystemTime(Date.now() + streamingHarness.terminalAdvanceMs);
    }
    streamingHarness.writes.push(data);
    streamingHarness.order.push(`write:${eventType(data)}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenResponses model and streaming-content boundaries", () => {
  it("rejects an unknown requested model before invoking the executor", async () => {
    const executeAgent = vi.fn().mockResolvedValue(successfulResult());
    const resolveModel = vi.fn().mockReturnValue(undefined);
    const app = createResponsesRoute(createDeps({ executeAgent, resolveModel }));

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ model: "missing-model" })),
    });

    expect(resolveModel).toHaveBeenCalledOnce();
    expect(resolveModel).toHaveBeenCalledWith("missing-model");
    expect(executeAgent).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Model not found: missing-model" },
    });
  });

  it("forwards the resolved agent identity to execution", async () => {
    const executeAgent = vi.fn().mockResolvedValue(successfulResult());
    const resolveModel = vi.fn().mockReturnValue({
      provider: "anthropic",
      modelId: "model-b",
      agentId: "agent-b",
    });
    const app = createResponsesRoute(createDeps({ executeAgent, resolveModel }));

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ model: "agent-b" })),
    });

    expect(response.status).toBe(200);
    expect(executeAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-b",
      traceId: expect.any(String),
    }));
  });

  it("streams text deltas while withholding executor thinking deltas", async () => {
    const executeAgent = vi.fn(async (params: KindAwareExecuteParams) => {
      params.onDelta?.("private chain of thought", "thinking");
      params.onDelta?.("Visible answer", "text");
      return successfulResult();
    });
    const app = createResponsesRoute(createDeps({ executeAgent }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    expect(streamingHarness.callbackResult).toBeDefined();
    await streamingHarness.callbackResult;

    expect(streamedTextDeltas()).toEqual(["Visible answer"]);
    expect(streamingHarness.writes.join("\n")).not.toContain("private chain of thought");
  });
});

describe("OpenResponses lifecycle diagnostics", () => {
  it("returns a failed response without a completed output item for lifecycle errors", async () => {
    const executeAgent = vi.fn().mockResolvedValue({
      ...successfulResult(),
      response: "blocked",
      status: "error",
      failureStage: "execution",
      errorKind: "precondition",
    });
    const app = createResponsesRoute(createDeps({ executeAgent }));

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    const body = await response.json() as { status: string; output: unknown[] };

    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.output).toEqual([]);
  });

  it("emits one canonical diagnostic for a non-streaming success", async () => {
    const emit = vi.fn();
    const executeAgent = vi.fn(async () => {
      vi.setSystemTime(1_100);
      return successfulResult();
    });
    const app = createResponsesRoute(createDeps({ executeAgent, eventBus: createMockEventBus({ emit }) }));

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });

    expect(response.status).toBe(200);
    const calls = diagnosticCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      channelId: "responses",
      channelType: "responses",
      agentId: "agent-1",
      sessionKey: "tenant:responses-api:responses",
      traceId: "trace-responses-1",
      toolCalls: 2,
      llmCalls: 3,
      status: "success",
      receivedAt: 1_000,
      executionDurationMs: 100,
      deliveryDurationMs: 0,
      totalDurationMs: 100,
      tokensUsed: 30,
      finishReason: "end_turn",
      timestamp: 1_100,
    });
  });

  it("emits streaming success once after terminal writes with partitioned timing", async () => {
    streamingHarness.terminalAdvanceMs = 25;
    const emit = vi.fn((event: string) => {
      if (event === "diagnostic:message_processed") {
        streamingHarness.order.push("diagnostic");
      }
    });
    const executeAgent = vi.fn(async () => {
      vi.setSystemTime(1_100);
      return successfulResult();
    });
    const app = createResponsesRoute(createDeps({ executeAgent, eventBus: createMockEventBus({ emit }) }));

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
      status: "success",
      toolCalls: 2,
      llmCalls: 3,
      receivedAt: 1_000,
      executionDurationMs: 100,
      deliveryDurationMs: 25,
      totalDurationMs: 125,
      timestamp: 1_125,
    });
    expect(streamingHarness.order.at(-2)).toBe("write:done");
    expect(streamingHarness.order.at(-1)).toBe("diagnostic");
  });

  it("aborts the executing turn and records one delivery failure when the client disconnects", async () => {
    const emit = vi.fn();
    let executionSignal: AbortSignal | undefined;
    const executeAgent = vi.fn((params: { signal: AbortSignal }) => {
      executionSignal = params.signal;
      return new Promise<{
        response: string;
        tokensUsed: { input: number; output: number; total: number };
        finishReason: string;
        stepsExecuted: number;
        llmCalls: number;
        status: "aborted";
      }>((resolve) => {
        params.signal.addEventListener("abort", () => resolve({
          response: "",
          tokensUsed: { input: 3, output: 1, total: 4 },
          finishReason: "stop",
          stepsExecuted: 2,
          llmCalls: 1,
          status: "aborted",
        }), { once: true });
      });
    });
    const app = createResponsesRoute(createDeps({
      executeAgent,
      eventBus: createMockEventBus({ emit }),
    }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledTimes(1));
    expect(streamingHarness.abortListeners).toHaveLength(1);

    streamingHarness.abortListeners[0]!();
    await streamingHarness.callbackResult;

    expect(executionSignal?.aborted).toBe(true);
    const diagnostics = diagnosticCalls(emit);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.[1]).toMatchObject({
      status: "error",
      failureStage: "delivery",
      errorKind: "platform",
      toolCalls: 2,
      llmCalls: 1,
    });
  });

  it("emits one execution-error diagnostic for a non-streaming rejection", async () => {
    const emit = vi.fn();
    let requestedTraceId: string | undefined;
    const executeAgent = vi.fn(async (params: { traceId?: string }) => {
      requestedTraceId = params.traceId;
      vi.setSystemTime(1_075);
      throw new Error("provider unavailable");
    });
    const overrides = {
      tenantId: "tenant",
      agentId: "agent-1",
      executeAgent,
      eventBus: createMockEventBus({ emit }),
    };
    const app = createResponsesRoute(createDeps(overrides));

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });

    expect(response.status).toBe(500);
    const calls = diagnosticCalls(emit);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      channelType: "responses",
      agentId: "agent-1",
      sessionKey: expect.stringMatching(/^tenant:agent:agent-1:responses-api:responses:peer:resp_/),
      traceId: requestedTraceId,
      status: "error",
      failureStage: "execution",
      toolCalls: null,
      llmCalls: null,
      receivedAt: 1_000,
      executionDurationMs: 75,
      deliveryDurationMs: 0,
      totalDurationMs: 75,
      tokensUsed: 0,
      finishReason: "error",
      timestamp: 1_075,
    });
    expect(calls[0]?.[1]).not.toHaveProperty("errorKind");
    expect(requestedTraceId).toBeDefined();
  });

  it("emits one execution-error diagnostic before streaming failure events", async () => {
    const emit = vi.fn((event: string) => {
      if (event === "diagnostic:message_processed") {
        streamingHarness.order.push("diagnostic");
      }
    });
    const executeAgent = vi.fn(async () => {
      vi.setSystemTime(1_075);
      throw new Error("provider unavailable");
    });
    const app = createResponsesRoute(createDeps({ executeAgent, eventBus: createMockEventBus({ emit }) }));

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
      failureStage: "execution",
      toolCalls: null,
      llmCalls: null,
      executionDurationMs: 75,
      deliveryDurationMs: 0,
      totalDurationMs: 75,
    });
    expect(calls[0]?.[1]).not.toHaveProperty("errorKind");
    expect(streamingHarness.order.indexOf("diagnostic")).toBeLessThan(
      streamingHarness.order.indexOf("write:response.failed"),
    );
  });

  it("streams a failed terminal event for a resolved timeout lifecycle", async () => {
    const emit = vi.fn();
    const executeAgent = vi.fn().mockResolvedValue({
      ...successfulResult(),
      status: "timeout",
      failureStage: "execution",
      errorKind: "timeout",
      finishReason: "prompt_timeout",
    });
    const app = createResponsesRoute(createDeps({ executeAgent, eventBus: createMockEventBus({ emit }) }));

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ stream: true })),
    });
    await streamingHarness.callbackResult;

    expect(streamingHarness.writes.map(eventType)).toContain("response.failed");
    expect(streamingHarness.writes.map(eventType)).not.toContain("response.completed");
    expect(diagnosticCalls(emit)[0]?.[1]).toMatchObject({
      status: "timeout",
      failureStage: "execution",
      errorKind: "timeout",
      finishReason: "prompt_timeout",
    });
  });

  it("preserves a resolved timeout diagnostic when its failed terminal event cannot finish delivery", async () => {
    streamingHarness.rejectWrite = "done";
    const emit = vi.fn();
    const logger = { info: vi.fn(), error: vi.fn() };
    const executeAgent = vi.fn().mockResolvedValue({
      ...successfulResult(),
      status: "timeout",
      failureStage: "execution",
      errorKind: "timeout",
      finishReason: "prompt_timeout",
    });
    const app = createResponsesRoute(createDeps({
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
      status: "timeout",
      failureStage: "execution",
      errorKind: "timeout",
      finishReason: "prompt_timeout",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "platform" }),
      expect.stringContaining("delivery failed"),
    );
  });

  it("observes failed terminal delivery after a Responses executor rejection", async () => {
    streamingHarness.rejectWrite = "response.failed";
    const emit = vi.fn();
    const logger = { info: vi.fn(), error: vi.fn() };
    const app = createResponsesRoute(createDeps({
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

describe("OpenResponses daemon composition", () => {
  function responsesFactoryBlock(): string {
    const source = readFileSync(
      new URL("../../../daemon/src/wiring/setup-gateway-routes.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const responsesApp = createResponsesRoute({");
    const end = source.indexOf('openaiApi.route("/responses", responsesApp);', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("passes the shared configured-model resolver into the Responses route", () => {
    expect(
      /createResponsesRoute\(\{\s*resolveModel,/.test(responsesFactoryBlock()),
    ).toBe(true);
  });

  it("passes the event bus and canonical executor metadata into the Responses route", () => {
    const block = responsesFactoryBlock();
    expect(block.includes("eventBus: container.eventBus")).toBe(true);
    expect(/stepsExecuted:\s*result\.stepsExecuted/.test(block)).toBe(true);
    expect(/llmCalls:\s*result\.llmCalls/.test(block)).toBe(true);
    expect(/traceId:\s*turnTraceId/.test(block)).toBe(true);
    expect(/agentId:\s*defaultAgentId/.test(block)).toBe(true);
    expect(/sessionKey:\s*formatSessionKey\(sk\)/.test(block)).toBe(true);
  });
});
