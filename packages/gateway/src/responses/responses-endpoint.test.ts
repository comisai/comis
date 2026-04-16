import { describe, it, expect, vi } from "vitest";
import { createResponsesRoute, type ResponsesEndpointDeps } from "./responses-endpoint.js";
import type { ResponseObject, ResponseStreamEvent } from "./responses-types.js";

function createMockDeps(
  overrides: Partial<ResponsesEndpointDeps> = {},
): ResponsesEndpointDeps {
  return {
    executeAgent: vi.fn(async () => ({
      response: "Hello from Comis!",
      tokensUsed: { input: 10, output: 20, total: 30 },
      finishReason: "stop",
    })),
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("createResponsesRoute", () => {
  describe("non-streaming", () => {
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
          message: "Hi",
          sessionKey: expect.objectContaining({
            userId: "responses-api",
            channelId: "responses",
          }),
        }),
      );
    });

    it("extracts user messages from array input", async () => {
      const deps = createMockDeps();
      const app = createResponsesRoute(deps);

      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          input: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "What is 2+2?" },
            { role: "user", content: "Tell me more." },
          ],
        }),
      });

      expect(deps.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "What is 2+2?\nTell me more.",
        }),
      );
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
