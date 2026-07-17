// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createOpenaiCompletionsRoute } from "./openai-completions.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

describe("OpenAI completion real stream cancellation", () => {
  it("forwards a non-stream request disconnect to the executing turn", async () => {
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    let executionSignal: AbortSignal | undefined;
    const emit = vi.fn();
    const app = createOpenaiCompletionsRoute({
      executeAgent: vi.fn((params) => {
        executionSignal = params.signal;
        markExecutionStarted();
        return new Promise((_, reject) => {
          params.signal.addEventListener(
            "abort",
            () => reject(new Error("request cancelled")),
            { once: true },
          );
        });
      }),
      eventBus: createMockEventBus({ emit }),
      logger: { info: vi.fn(), error: vi.fn() },
    });
    const controller = new AbortController();
    const pendingResponse = app.request(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "Hello" }],
      }),
      signal: controller.signal,
    }));
    await executionStarted;

    controller.abort("client disconnected");

    expect(executionSignal?.aborted).toBe(true);
    await expect(pendingResponse).resolves.toMatchObject({ status: 500 });
    expect(emit.mock.calls.filter(
      (call) => call[0] === "diagnostic:message_processed",
    )).toEqual([
      ["diagnostic:message_processed", expect.objectContaining({
        status: "error",
        failureStage: "delivery",
        errorKind: "platform",
      })],
    ]);
  });

  it("records a non-stream disconnect even when execution ignores cancellation", async () => {
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    let resolveExecution!: (value: {
      response: string;
      tokensUsed: { input: number; output: number; total: number };
      finishReason: string;
      stepsExecuted: number;
      llmCalls: number;
      status: "success";
    }) => void;
    const execution = new Promise<Parameters<typeof resolveExecution>[0]>((resolve) => {
      resolveExecution = resolve;
    });
    const emit = vi.fn();
    const app = createOpenaiCompletionsRoute({
      executeAgent: vi.fn(() => {
        markExecutionStarted();
        return execution;
      }),
      eventBus: createMockEventBus({ emit }),
      logger: { info: vi.fn(), error: vi.fn() },
    });
    const controller = new AbortController();
    const pendingResponse = app.request(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "Hello" }],
      }),
      signal: controller.signal,
    }));
    await executionStarted;

    controller.abort("client disconnected");
    resolveExecution({
      response: "late response",
      tokensUsed: { input: 2, output: 3, total: 5 },
      finishReason: "stop",
      stepsExecuted: 1,
      llmCalls: 1,
      status: "success",
    });

    await expect(pendingResponse).resolves.toMatchObject({ status: 500 });
    const diagnostic = emit.mock.calls.find(
      (call) => call[0] === "diagnostic:message_processed",
    );
    expect(diagnostic?.[1]).toMatchObject({
      status: "error",
      failureStage: "delivery",
      errorKind: "platform",
      toolCalls: 1,
      llmCalls: 1,
    });
  });

  it("redacts a caller-influenced abort reason from streaming error logs", async () => {
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    let resolveExecution!: (value: {
      response: string;
      tokensUsed: { input: number; output: number; total: number };
      finishReason: string;
      stepsExecuted: number;
      llmCalls: number;
      status: "success";
    }) => void;
    const execution = new Promise<Parameters<typeof resolveExecution>[0]>((resolve) => {
      resolveExecution = resolve;
    });
    const emit = vi.fn();
    const logger = { info: vi.fn(), error: vi.fn() };
    const app = createOpenaiCompletionsRoute({
      executeAgent: vi.fn(() => {
        markExecutionStarted();
        return execution;
      }),
      eventBus: createMockEventBus({ emit }),
      logger,
    });
    const controller = new AbortController();
    const response = await app.request(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
      signal: controller.signal,
    }));
    const reader = response.body!.getReader();
    await reader.read();
    await executionStarted;

    controller.abort("PRIVATE_ABORT_REASON_MUST_NOT_REACH_LOGS");
    resolveExecution({
      response: "late response",
      tokensUsed: { input: 2, output: 3, total: 5 },
      finishReason: "stop",
      stepsExecuted: 1,
      llmCalls: 1,
      status: "success",
    });

    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "PRIVATE_ABORT_REASON_MUST_NOT_REACH_LOGS",
    );
  });

  it("records client cancellation as delivery failure instead of success", async () => {
    let resolveExecution!: (value: {
      response: string;
      tokensUsed: { input: number; output: number; total: number };
      finishReason: string;
      stepsExecuted: number;
      llmCalls: number;
      status: "success";
      traceId: string;
      agentId: string;
      sessionKey: string;
    }) => void;
    const execution = new Promise<Parameters<typeof resolveExecution>[0]>((resolve) => {
      resolveExecution = resolve;
    });
    const emit = vi.fn();
    let executionSignal: AbortSignal | undefined;
    const app = createOpenaiCompletionsRoute({
      executeAgent: vi.fn((params) => {
        executionSignal = params.signal;
        return execution;
      }),
      eventBus: createMockEventBus({ emit }),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    await vi.waitFor(() => expect(executionSignal).toBeDefined());

    await reader.cancel();
    expect(executionSignal?.aborted).toBe(true);
    resolveExecution({
      response: "Hello",
      tokensUsed: { input: 2, output: 3, total: 5 },
      finishReason: "stop",
      stepsExecuted: 0,
      llmCalls: 1,
      status: "success",
      traceId: "trace-1",
      agentId: "agent-1",
      sessionKey: "tenant:openai-api:openai",
    });

    await vi.waitFor(() => {
      const diagnostic = emit.mock.calls.find(
        (call) => call[0] === "diagnostic:message_processed",
      );
      expect(diagnostic?.[1]).toMatchObject({
        status: "error",
        failureStage: "delivery",
        errorKind: "platform",
      });
    });
    const diagnostics = emit.mock.calls.filter(
      (call) => call[0] === "diagnostic:message_processed",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.[1]).not.toMatchObject({ status: "success" });
  });

  it("keeps a disconnect as the primary delivery failure when cancellation aborts execution", async () => {
    const emit = vi.fn();
    const executeAgent = vi.fn((params: { signal: AbortSignal }) => (
      new Promise<{
        response: string;
        tokensUsed: { input: number; output: number; total: number };
        finishReason: string;
        stepsExecuted: number;
        llmCalls: number;
        status: "aborted";
      }>((resolve) => {
        params.signal.addEventListener("abort", () => resolve({
          response: "",
          tokensUsed: { input: 2, output: 1, total: 3 },
          finishReason: "stop",
          stepsExecuted: 1,
          llmCalls: 1,
          status: "aborted",
        }), { once: true });
      })
    ));
    const app = createOpenaiCompletionsRoute({
      executeAgent,
      eventBus: createMockEventBus({ emit }),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledTimes(1));

    await reader.cancel();

    await vi.waitFor(() => {
      const diagnostic = emit.mock.calls.find(
        (call) => call[0] === "diagnostic:message_processed",
      );
      expect(diagnostic?.[1]).toMatchObject({
        status: "error",
        failureStage: "delivery",
        errorKind: "platform",
        toolCalls: 1,
        llmCalls: 1,
      });
    });
    expect(emit.mock.calls.filter(
      (call) => call[0] === "diagnostic:message_processed",
    )).toHaveLength(1);
  });

  it("keeps cancellation timing open until the in-flight execution settles", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let resolveExecution!: (value: {
        response: string;
        tokensUsed: { input: number; output: number; total: number };
        finishReason: string;
        stepsExecuted: number;
        llmCalls: number;
        status: "success";
      }) => void;
      const execution = new Promise<Parameters<typeof resolveExecution>[0]>((resolve) => {
        resolveExecution = resolve;
      });
      let markExecutionStarted!: () => void;
      const executionStarted = new Promise<void>((resolve) => {
        markExecutionStarted = resolve;
      });
      let resolveDiagnostic!: (payload: Record<string, unknown>) => void;
      const diagnosticPromise = new Promise<Record<string, unknown>>((resolve) => {
        resolveDiagnostic = resolve;
      });
      const emit = vi.fn((event: string, payload: Record<string, unknown>) => {
        if (event === "diagnostic:message_processed") resolveDiagnostic(payload);
      });
      const app = createOpenaiCompletionsRoute({
        executeAgent: vi.fn(() => {
          markExecutionStarted();
          return execution;
        }),
        eventBus: createMockEventBus({ emit }),
        logger: { info: vi.fn(), error: vi.fn() },
      });

      const response = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude",
          stream: true,
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
      const reader = response.body!.getReader();
      await reader.read();
      await executionStarted;

      vi.setSystemTime(1_050);
      await reader.cancel();
      vi.setSystemTime(1_100);
      resolveExecution({
        response: "Hello",
        tokensUsed: { input: 2, output: 3, total: 5 },
        finishReason: "stop",
        stepsExecuted: 1,
        llmCalls: 2,
        status: "success",
      });

      await expect(diagnosticPromise).resolves.toMatchObject({
        status: "error",
        failureStage: "delivery",
        receivedAt: 1_000,
        executionDurationMs: 100,
        deliveryDurationMs: 0,
        totalDurationMs: 100,
        timestamp: 1_100,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
