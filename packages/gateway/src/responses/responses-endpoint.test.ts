// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createResponsesRoute, type ResponsesEndpointDeps } from "./responses-endpoint.js";
import type { ResponseObject, ResponseStreamEvent } from "./responses-types.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

function createMockDeps(
  overrides: Partial<ResponsesEndpointDeps> = {},
): ResponsesEndpointDeps {
  return {
    executeAgent: vi.fn(async () => ({
      response: "Hello from Comis!",
      tokensUsed: { input: 10, output: 20, total: 30 },
      finishReason: "stop",
      stepsExecuted: 0,
      llmCalls: 1,
      status: "success",
    })),
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("createResponsesRoute", () => {
  describe("non-streaming", () => {
    it("forwards a non-stream request disconnect to the executing turn", async () => {
      let markExecutionStarted!: () => void;
      const executionStarted = new Promise<void>((resolve) => {
        markExecutionStarted = resolve;
      });
      let executionSignal: AbortSignal | undefined;
      const emit = vi.fn();
      const deps = createMockDeps({
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
      });
      const app = createResponsesRoute(deps);
      const controller = new AbortController();
      const pendingResponse = app.request(new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", input: "Hello" }),
        signal: controller.signal,
      }));
      await executionStarted;

      controller.abort("client disconnected");

      expect(executionSignal?.aborted).toBe(true);
      await expect(pendingResponse).resolves.toMatchObject({ status: 500 });
      const diagnostic = emit.mock.calls.find(
        (call) => call[0] === "diagnostic:message_processed",
      );
      expect(diagnostic?.[1]).toMatchObject({
        status: "error",
        failureStage: "delivery",
        errorKind: "platform",
      });
    });

    it("records a resolved non-stream response as undeliverable after disconnect", async () => {
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
      const deps = createMockDeps({
        executeAgent: vi.fn(() => {
          markExecutionStarted();
          return execution;
        }),
        eventBus: createMockEventBus({ emit }),
      });
      const app = createResponsesRoute(deps);
      const controller = new AbortController();
      const pendingResponse = app.request(new Request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", input: "Hello" }),
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

    it("returns a complete ResponseObject", async () => {
      const deps = createMockDeps();
      const app = createResponsesRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          input: "Hello",
        }),
      });

      expect(res.status).toBe(200);
      const body: ResponseObject = await res.json();

      expect(body.id).toMatch(/^resp_/);
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
      expect(body.model).toBe("gpt-4");
      expect(body.output).toHaveLength(1);
      expect(body.output[0].type).toBe("message");
      expect(body.output[0].role).toBe("assistant");
      expect(body.output[0].status).toBe("completed");
      expect(body.output[0].content).toHaveLength(1);
      expect(body.output[0].content[0].type).toBe("output_text");
      expect(body.output[0].content[0].text).toBe("Hello from Comis!");
      expect(body.usage).toEqual({
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      });
    });

    it("calls executeAgent with correct session key", async () => {
      const deps = createMockDeps();
      const app = createResponsesRoute(deps);

      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", input: "Hi" }),
      });

      expect(deps.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/Subject: Conversation turn 1; role=user/),
          sessionKey: expect.objectContaining({
            userId: "responses-api",
            channelId: "responses",
          }),
        }),
      );
    });

    it("preserves exact interleaved role order across the complete response input", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const deps = createMockDeps({ logger });
      const app = createResponsesRoute(deps);

      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          input: [
            { role: "system", content: "First response instruction" },
            { role: "user", content: "PRIVATE_RESPONSE_QUESTION" },
            { role: "assistant", content: "PRIVATE_RESPONSE_ANSWER" },
            { role: "system", content: "Second response instruction" },
            { role: "user", content: "PRIVATE_RESPONSE_FOLLOWUP" },
          ],
        }),
      });

      const call = vi.mocked(deps.executeAgent).mock.calls[0]![0];
      expect(call.systemPrompt).toContain("Subject: Conversation turn 1; role=system");
      expect(call.message).toContain("Subject: Conversation turn 2; role=user");
      expect(call.message).toContain("Subject: Conversation turn 3; role=assistant");
      expect(call.message).toContain("Subject: Conversation turn 4; role=system");
      expect(call.message).toContain("Subject: Conversation turn 5; role=user");
      const completeConversation = `${call.systemPrompt}\n\n${call.message}`;
      expect(completeConversation.indexOf("First response instruction")).toBeLessThan(
        completeConversation.indexOf("PRIVATE_RESPONSE_QUESTION"),
      );
      expect(completeConversation.indexOf("PRIVATE_RESPONSE_QUESTION")).toBeLessThan(
        completeConversation.indexOf("PRIVATE_RESPONSE_ANSWER"),
      );
      expect(completeConversation.indexOf("PRIVATE_RESPONSE_ANSWER")).toBeLessThan(
        completeConversation.indexOf("Second response instruction"),
      );
      expect(completeConversation.indexOf("Second response instruction")).toBeLessThan(
        completeConversation.indexOf("PRIVATE_RESPONSE_FOLLOWUP"),
      );
      expect(completeConversation.match(/<<<UNTRUSTED_[a-f0-9]+>>>/g)).toHaveLength(5);
      expect(JSON.stringify([
        ...logger.info.mock.calls,
        ...logger.error.mock.calls,
      ])).not.toContain("PRIVATE_RESPONSE_QUESTION");
    });

    it("returns 500 on executeAgent error", async () => {
      const deps = createMockDeps({
        executeAgent: vi.fn(async () => {
          throw new Error("Agent crashed");
        }),
      });
      const app = createResponsesRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", input: "Hi" }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("server_error");
    });
  });

  describe("validation", () => {
    it("returns 400 for missing model", async () => {
      const deps = createMockDeps();
      const app = createResponsesRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "Hello" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("returns 400 for missing input", async () => {
      const deps = createMockDeps();
      const app = createResponsesRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("returns 400 for empty array input with no user messages", async () => {
      const deps = createMockDeps();
      const app = createResponsesRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          input: [{ role: "system", content: "System only" }],
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("No user message");
    });
  });

  describe("streaming", () => {
    it("emits semantic events in correct order with increasing sequence numbers", async () => {
      const deltas = ["Hello", " world", "!"];
      const deps = createMockDeps({
        executeAgent: vi.fn(async (params) => {
          // Deliver deltas via onDelta callback
          for (const delta of deltas) {
            params.onDelta?.(delta);
          }
          return {
            response: "Hello world!",
            tokensUsed: { input: 5, output: 15, total: 20 },
            finishReason: "stop",
            stepsExecuted: 0,
            llmCalls: 1,
            status: "success" as const,
          };
        }),
      });

      const app = createResponsesRoute(deps);
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          input: "Hi",
          stream: true,
        }),
      });

      expect(res.status).toBe(200);

      // Read SSE body and parse events
      const text = await res.text();
      const events: ResponseStreamEvent[] = [];
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          events.push(JSON.parse(data) as ResponseStreamEvent);
        }
      }

      // Verify event order
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toEqual([
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta", // "Hello"
        "response.output_text.delta", // " world"
        "response.output_text.delta", // "!"
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]);

      // Verify sequence numbers are monotonically increasing
      const seqNums = events.map((e) => e.sequence_number);
      for (let i = 1; i < seqNums.length; i++) {
        expect(seqNums[i]).toBeGreaterThan(seqNums[i - 1]);
      }
      expect(seqNums[0]).toBe(0);

      // Verify delta events contain the correct content
      const deltaEvents = events.filter(
        (e) => e.type === "response.output_text.delta",
      ) as Array<{ delta: string }>;
      expect(deltaEvents.map((e) => e.delta)).toEqual(deltas);

      // Verify text.done has full accumulated text
      const textDone = events.find(
        (e) => e.type === "response.output_text.done",
      ) as { text: string };
      expect(textDone.text).toBe("Hello world!");

      // Verify completed response has usage
      const completed = events.find(
        (e) => e.type === "response.completed",
      ) as { response: ResponseObject };
      expect(completed.response.status).toBe("completed");
      expect(completed.response.usage).toEqual({
        input_tokens: 5,
        output_tokens: 15,
        total_tokens: 20,
      });

      // Verify [DONE] terminal marker is present
      expect(text).toContain("data: [DONE]");
    });

    it("emits response.failed on executeAgent error", async () => {
      const deps = createMockDeps({
        executeAgent: vi.fn(async () => {
          throw new Error("Agent crashed");
        }),
      });

      const app = createResponsesRoute(deps);
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          input: "Hi",
          stream: true,
        }),
      });

      const text = await res.text();
      const events: ResponseStreamEvent[] = [];
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          events.push(JSON.parse(data) as ResponseStreamEvent);
        }
      }

      // Should have initial events then response.failed
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("response.in_progress");
      expect(eventTypes[eventTypes.length - 1]).toBe("response.failed");

      // Verify failed response
      const failedEvent = events.find(
        (e) => e.type === "response.failed",
      ) as { response: ResponseObject };
      expect(failedEvent.response.status).toBe("failed");

      // Verify [DONE] terminal marker follows
      expect(text).toContain("data: [DONE]");
    });

    it("response IDs match across all events", async () => {
      const deps = createMockDeps({
        executeAgent: vi.fn(async (params) => {
          params.onDelta?.("Hi");
          return {
            response: "Hi",
            tokensUsed: { input: 1, output: 1, total: 2 },
            finishReason: "stop",
            stepsExecuted: 0,
            llmCalls: 1,
            status: "success" as const,
          };
        }),
      });

      const app = createResponsesRoute(deps);
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          input: "Hello",
          stream: true,
        }),
      });

      const text = await res.text();
      const events: ResponseStreamEvent[] = [];
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          events.push(JSON.parse(line.slice(6)));
        }
      }

      // Extract response IDs
      const responseIds = new Set<string>();
      const itemIds = new Set<string>();
      for (const event of events) {
        if ("response" in event) {
          responseIds.add((event as { response: ResponseObject }).response.id);
        }
        if ("item_id" in event) {
          itemIds.add((event as { item_id: string }).item_id);
        }
        if ("item" in event && "id" in (event as { item: OutputItem }).item) {
          itemIds.add((event as { item: { id: string } }).item.id);
        }
      }

      // All response IDs should be the same
      expect(responseIds.size).toBe(1);
      const responseId = [...responseIds][0];
      expect(responseId).toMatch(/^resp_/);

      // All item IDs should be the same
      expect(itemIds.size).toBe(1);
      const itemId = [...itemIds][0];
      expect(itemId).toMatch(/^msg_/);
    });
  });
});
