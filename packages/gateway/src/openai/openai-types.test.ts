// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ChatCompletionRequestSchema,
  createOpenAIError,
  mapFinishReason,
} from "./openai-types.js";

describe("ChatCompletionRequestSchema", () => {
  it("validates a well-formed request", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "claude",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("claude");
      expect(result.data.stream).toBe(false); // default
    }
  });

  it("validates a request with all optional fields", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "claude",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 1024,
      stream_options: { include_usage: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(true);
      expect(result.data.temperature).toBe(0.7);
      expect(result.data.max_tokens).toBe(1024);
      expect(result.data.stream_options?.include_usage).toBe(true);
    }
  });

  it("rejects missing model", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty model string", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing messages", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "claude",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty messages array", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "claude",
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid temperature (too high)", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "claude",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid temperature (negative)", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "claude",
      messages: [{ role: "user", content: "Hello" }],
      temperature: -0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "claude",
      messages: [{ role: "function", content: "Hello" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields on messages (strictObject)", () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: "claude",
      messages: [{ role: "user", content: "Hello", name: "test" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("createOpenAIError", () => {
  it("maps 400 to invalid_request_error", () => {
    const err = createOpenAIError(400, "Bad request");
    expect(err.error.type).toBe("invalid_request_error");
    expect(err.error.message).toBe("Bad request");
    expect(err.error.param).toBeNull();
    expect(err.error.code).toBeNull();
  });

  it("maps 401 to authentication_error", () => {
    const err = createOpenAIError(401, "Unauthorized");
    expect(err.error.type).toBe("authentication_error");
  });

  it("maps 403 to permission_error", () => {
    const err = createOpenAIError(403, "Forbidden");
    expect(err.error.type).toBe("permission_error");
  });

  it("maps 404 to not_found_error", () => {
    const err = createOpenAIError(404, "Not found");
    expect(err.error.type).toBe("not_found_error");
  });

  it("maps 429 to rate_limit_error", () => {
    const err = createOpenAIError(429, "Too many requests");
    expect(err.error.type).toBe("rate_limit_error");
  });

  it("maps 500 to server_error", () => {
    const err = createOpenAIError(500, "Internal error");
    expect(err.error.type).toBe("server_error");
  });

  it("maps unknown status to server_error", () => {
    const err = createOpenAIError(502, "Bad gateway");
    expect(err.error.type).toBe("server_error");
  });

  it("includes param when provided", () => {
    const err = createOpenAIError(400, "Invalid", "temperature");
    expect(err.error.param).toBe("temperature");
  });
});

describe("mapFinishReason", () => {
  it("maps stop to stop", () => {
    expect(mapFinishReason("stop")).toBe("stop");
  });

  it("maps max_steps to length", () => {
    expect(mapFinishReason("max_steps")).toBe("length");
  });

  it("maps budget_exceeded to stop", () => {
    expect(mapFinishReason("budget_exceeded")).toBe("stop");
  });

  it("maps circuit_open to stop", () => {
    expect(mapFinishReason("circuit_open")).toBe("stop");
  });

  it("maps error to stop", () => {
    expect(mapFinishReason("error")).toBe("stop");
  });

  it("maps unknown reason to stop", () => {
    expect(mapFinishReason("unknown")).toBe("stop");
  });
});
