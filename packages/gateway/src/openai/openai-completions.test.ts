// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  createOpenaiCompletionsRoute,
  type OpenaiCompletionsDeps,
} from "./openai-completions.js";

/** Create mock deps with optional overrides. */
function createMockDeps(
  overrides?: Partial<OpenaiCompletionsDeps>,
): OpenaiCompletionsDeps {
  return {
    executeAgent: vi.fn().mockResolvedValue({
      response: "Hello from the agent!",
      tokensUsed: { input: 10, output: 20, total: 30 },
      finishReason: "stop",
    }),
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

/** Build a valid request body. */
function validBody(overrides?: Record<string, unknown>) {
  return {
    model: "claude",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

describe("createOpenaiCompletionsRoute", () => {
  describe("non-streaming", () => {
    it("returns a valid ChatCompletion JSON response", async () => {
      const deps = createMockDeps();
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toMatch(/^chatcmpl-/);
      expect(json.object).toBe("chat.completion");
      expect(typeof json.created).toBe("number");
      expect(json.model).toBe("claude");
      expect(json.choices).toHaveLength(1);
      expect(json.choices[0].index).toBe(0);
      expect(json.choices[0].message.role).toBe("assistant");
      expect(json.choices[0].message.content).toBe("Hello from the agent!");
      expect(json.choices[0].finish_reason).toBe("stop");
      expect(json.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      });
    });

    it("passes user message and session key to executeAgent", async () => {
      const executeAgent = vi.fn().mockResolvedValue({
        response: "ok",
        tokensUsed: { input: 0, output: 0, total: 0 },
        finishReason: "stop",
      });
      const deps = createMockDeps({ executeAgent });
      const app = createOpenaiCompletionsRoute(deps);

      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });

      expect(executeAgent).toHaveBeenCalledTimes(1);
      const call = executeAgent.mock.calls[0][0];
      expect(call.message).toBe("Hello");
      expect(call.sessionKey).toEqual({
        userId: "openai-api",
        channelId: "openai",
        peerId: expect.stringMatching(/^chatcmpl-/),
      });
      expect(call.onDelta).toBeUndefined();
    });

    it("extracts the LAST user message from messages array", async () => {
      const executeAgent = vi.fn().mockResolvedValue({
        response: "ok",
        tokensUsed: { input: 0, output: 0, total: 0 },
        finishReason: "stop",
      });
      const deps = createMockDeps({ executeAgent });
      const app = createOpenaiCompletionsRoute(deps);

      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validBody({
            messages: [
              { role: "user", content: "First message" },
              { role: "assistant", content: "Sure" },
              { role: "user", content: "Second message" },
            ],
          }),
        ),
      });

      expect(executeAgent.mock.calls[0][0].message).toBe("Second message");
    });

    it("maps max_steps finish reason to length", async () => {
      const deps = createMockDeps({
        executeAgent: vi.fn().mockResolvedValue({
          response: "Truncated",
          tokensUsed: { input: 5, output: 5, total: 10 },
          finishReason: "max_steps",
        }),
      });
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });

      const json = await res.json();
      expect(json.choices[0].finish_reason).toBe("length");
    });
  });

  describe("streaming", () => {
    it("does NOT stream thinking/reasoning deltas into delta.content (reasoning-leak; streamed must == final, live 2026-06-20)", async () => {
      // qwen3.6 + other reasoning models emit thinking deltas (kind:"thinking"). The
      // non-stream path strips them (final content = answer only); the stream MUST too.
      // The executor threads onDelta(delta, kind) — the route had ignored the kind and
      // wrote EVERY delta to content, leaking the model's raw reasoning to API clients.
      const executeAgent = vi.fn().mockImplementation(async (params) => {
        if (params.onDelta) {
          params.onDelta("The user wants me to say hi. I should ", "thinking");
          params.onDelta("just output it.", "thinking");
          params.onDelta("Hi!", "text");
        }
        return { response: "Hi!", tokensUsed: { input: 5, output: 5, total: 10 }, finishReason: "stop" };
      });
      const app = createOpenaiCompletionsRoute(createMockDeps({ executeAgent }));
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody({ stream: true })),
      });
      const text = await res.text();
      const content = text
        .split("\n").filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data:\s*/, "").trim())
        .filter((d) => d !== "[DONE]")
        .map((d) => { try { return JSON.parse(d).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } })
        .join("");
      expect(content).toBe("Hi!"); // ONLY the text delta — no thinking leaked
      expect(content).not.toContain("The user wants me to say hi");
    });

    it("returns SSE chunks with role, content, finish, usage, and [DONE]", async () => {
      const executeAgent = vi.fn().mockImplementation(async (params) => {
        // Simulate streaming by calling onDelta
        if (params.onDelta) {
          params.onDelta("Hello");
          params.onDelta(" world");
        }
        return {
          response: "Hello world",
          tokensUsed: { input: 5, output: 10, total: 15 },
          finishReason: "stop",
        };
      });

      const deps = createMockDeps({ executeAgent });
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody({ stream: true })),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const text = await res.text();

      // Parse SSE data lines
      const dataLines = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s*/, "").trim());

      expect(dataLines.length).toBeGreaterThanOrEqual(5);

      // First chunk: role announcement
      const roleChunk = JSON.parse(dataLines[0]);
      expect(roleChunk.id).toMatch(/^chatcmpl-/);
      expect(roleChunk.object).toBe("chat.completion.chunk");
      expect(roleChunk.choices[0].delta).toEqual({ role: "assistant" });
      expect(roleChunk.choices[0].finish_reason).toBeNull();

      // Content chunks
      const content1 = JSON.parse(dataLines[1]);
      expect(content1.choices[0].delta).toEqual({ content: "Hello" });
      expect(content1.choices[0].finish_reason).toBeNull();

      const content2 = JSON.parse(dataLines[2]);
      expect(content2.choices[0].delta).toEqual({ content: " world" });

      // Finish chunk
      const finishChunk = JSON.parse(dataLines[3]);
      expect(finishChunk.choices[0].delta).toEqual({});
      expect(finishChunk.choices[0].finish_reason).toBe("stop");

      // Usage chunk
      const usageChunk = JSON.parse(dataLines[4]);
      expect(usageChunk.choices).toEqual([]);
      expect(usageChunk.usage).toEqual({
        prompt_tokens: 5,
        completion_tokens: 10,
        total_tokens: 15,
      });

      // [DONE] marker
      const lastData = dataLines[dataLines.length - 1];
      expect(lastData).toBe("[DONE]");

      // All chunks share the same id
      const ids = dataLines
        .filter((d) => d !== "[DONE]")
        .map((d) => JSON.parse(d).id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(1);
    });

    it("provides onDelta callback to executeAgent", async () => {
      const executeAgent = vi.fn().mockResolvedValue({
        response: "ok",
        tokensUsed: { input: 0, output: 0, total: 0 },
        finishReason: "stop",
      });
      const deps = createMockDeps({ executeAgent });
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody({ stream: true })),
      });

      // Must consume the response body to trigger the stream callback
      await res.text();

      expect(executeAgent).toHaveBeenCalledTimes(1);
      const call = executeAgent.mock.calls[0][0];
      expect(typeof call.onDelta).toBe("function");
    });
  });

  describe("validation errors", () => {
    it("returns 400 with OpenAI error format for missing messages", async () => {
      const deps = createMockDeps();
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude" }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.type).toBe("invalid_request_error");
      expect(typeof json.error.message).toBe("string");
      expect(json.error.code).toBeNull();
    });

    it("returns 400 for invalid temperature", async () => {
      const deps = createMockDeps();
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody({ temperature: 5 })),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.type).toBe("invalid_request_error");
    });

    it("returns 400 when no user message is found", async () => {
      const deps = createMockDeps();
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          validBody({
            messages: [{ role: "system", content: "You are helpful" }],
          }),
        ),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toContain("No user message");
    });
  });

  describe("model resolution", () => {
    it("returns 404 when resolveModel returns undefined", async () => {
      const deps = createMockDeps({
        resolveModel: vi.fn().mockReturnValue(undefined),
      });
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody({ model: "nonexistent" })),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.type).toBe("not_found_error");
      expect(json.error.message).toContain("nonexistent");
    });

    it("proceeds when resolveModel returns a valid model", async () => {
      const deps = createMockDeps({
        resolveModel: vi
          .fn()
          .mockReturnValue({ provider: "anthropic", modelId: "claude-sonnet" }),
      });
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });

      expect(res.status).toBe(200);
    });

    it("proceeds when resolveModel is not provided", async () => {
      const deps = createMockDeps();
      // resolveModel is undefined by default
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("error handling", () => {
    it("returns 500 on unexpected executeAgent error (non-streaming)", async () => {
      const deps = createMockDeps({
        executeAgent: vi.fn().mockRejectedValue(new Error("Agent crashed")),
      });
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.type).toBe("server_error");
      expect(json.error.message).toBe("Internal server error");
    });

    it("logs error details on server error", async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const deps = createMockDeps({
        executeAgent: vi.fn().mockRejectedValue(new Error("Boom")),
        logger,
      });
      const app = createOpenaiCompletionsRoute(deps);

      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });

      expect(logger.error).toHaveBeenCalled();
    });
  });

  // Live finding 2026-06-18 (VPS): a single-agent chat-API turn's outcome was
  // observed (outcome_events row) but NEVER resolved — the OpenAI-compat path
  // bypasses the channel execution-pipeline (the sole diagnostic:message_processed
  // emitter) and never fires graph:completed, so the Verified Learning resolve loop
  // (RANK reward / FORGET accrual / SURFACE promote-demote) never ran for chat-API
  // turns and they were invisible to obs. The route must emit the per-turn diagnostic.
  describe("diagnostic:message_processed emit (Verified Learning resolve + obs)", () => {
    it("emits one diagnostic:message_processed carrying the turn traceId (non-streaming)", async () => {
      const emit = vi.fn();
      const executeAgent = vi.fn().mockResolvedValue({
        response: "ok",
        tokensUsed: { input: 1, output: 2, total: 3 },
        finishReason: "stop",
        traceId: "trace-abc",
        agentId: "default",
        // The wiring returns the FORMATTED tenant-qualified key; the emit must carry it
        // verbatim so downstream tenant derivation finds the right pool (live 2026-06-18).
        sessionKey: "default:openai-api:openai",
      });
      const deps = createMockDeps({ executeAgent, eventBus: { emit } });
      const app = createOpenaiCompletionsRoute(deps);

      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });

      const call = emit.mock.calls.find(
        (c) => c[0] === "diagnostic:message_processed",
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        channelType: "openai",
        agentId: "default",
        traceId: "trace-abc",
        // MUST be the 3-part tenant-qualified key from the wiring, NOT a 2-part fallback.
        sessionKey: "default:openai-api:openai",
        success: true,
        finishReason: "stop",
      });
    });

    it("emits diagnostic:message_processed on a streaming completion too", async () => {
      const emit = vi.fn();
      const executeAgent = vi.fn().mockImplementation(async (params) => {
        params.onDelta?.("hi");
        return {
          response: "hi",
          tokensUsed: { input: 1, output: 1, total: 2 },
          finishReason: "stop",
          traceId: "trace-stream",
          agentId: "default",
        };
      });
      const deps = createMockDeps({ executeAgent, eventBus: { emit } });
      const app = createOpenaiCompletionsRoute(deps);

      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody({ stream: true })),
      });
      await res.text();

      const call = emit.mock.calls.find(
        (c) => c[0] === "diagnostic:message_processed",
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        channelType: "openai",
        traceId: "trace-stream",
      });
    });

    it("does not emit or throw when no eventBus is wired (back-compat)", async () => {
      const deps = createMockDeps(); // no eventBus
      const app = createOpenaiCompletionsRoute(deps);
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody()),
      });
      expect(res.status).toBe(200);
    });
  });
});
