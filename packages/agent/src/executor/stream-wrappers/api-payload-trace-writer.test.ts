// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApiPayloadTraceWriter } from "./api-payload-trace-writer.js";
import type { ApiPayloadTraceConfig } from "./api-payload-trace-writer.js";
import { createMockLogger, createMockStreamFn, makeContext } from "./__test-helpers.js";

// Mock node:fs -- appendFileSync, statSync, renameSync, unlinkSync
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: vi.fn(),
    statSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import { appendFileSync, statSync, renameSync, unlinkSync } from "node:fs";
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockStatSync = vi.mocked(statSync);
const mockRenameSync = vi.mocked(renameSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

describe("createApiPayloadTraceWriter", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let base: ReturnType<typeof createMockStreamFn>;

  function makeModel(provider: string) {
    return {
      id: "claude-sonnet-4-5-20250929",
      name: "Claude Sonnet",
      api: "anthropic-messages",
      provider,
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } as any;
  }

  beforeEach(() => {
    logger = createMockLogger();
    base = createMockStreamFn();
    mockAppendFileSync.mockReset();
    mockStatSync.mockReset();
    mockRenameSync.mockReset();
    mockUnlinkSync.mockReset();
    // Default: statSync throws (file doesn't exist) -- no rotation
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT"); });
  });

  it("writes pre-call JSONL line with model ID and provider", () => {
    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);

    wrappedFn(model, context);

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(parsed.type).toBe("api_payload");
    expect(parsed.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.messageCount).toBe(0);
    expect(parsed.ts).toBeDefined();
  });

  it("includes options in trace output", () => {
    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);
    const options = { maxTokens: 4096, temperature: 0.7, cacheRetention: "short" };

    wrappedFn(model, context, options);

    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(parsed.options).toEqual({ maxTokens: 4096, temperature: 0.7, cacheRetention: "short" });
  });

  it("includes agent ID when provided", () => {
    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl", agentId: "agent-99" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    wrappedFn(makeModel("anthropic"), makeContext([]));

    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(parsed.agentId).toBe("agent-99");
  });

  it("includes session ID when provided", () => {
    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl", agentId: "agent-99", sessionId: "discord:guild:channel:user" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    wrappedFn(makeModel("anthropic"), makeContext([]));

    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(parsed.sessionId).toBe("discord:guild:channel:user");
  });

  it("passes through to next StreamFn unchanged", () => {
    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);
    const options = { maxTokens: 4096 };

    const result = wrappedFn(model, context, options);

    expect(base).toHaveBeenCalledWith(model, context, options);
    expect(result).toBe("stream-result");
  });

  it("handles empty options gracefully", () => {
    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    // Call with undefined options
    wrappedFn(makeModel("anthropic"), makeContext([]));

    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(parsed.options).toEqual({});
  });

  it("does not throw when appendFileSync fails and logs WARN with hint+errorKind", () => {
    mockAppendFileSync.mockImplementation(() => { throw new Error("disk full"); });

    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const result = wrappedFn(makeModel("anthropic"), makeContext([]));

    expect(base).toHaveBeenCalled();
    expect(result).toBe("stream-result");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        filePath: "/tmp/api.jsonl",
        hint: "Check trace output directory permissions and disk space",
        errorKind: "resource",
      }),
      "JSONL trace write failed",
    );
  });

  it("includes session ID in post-call usage line", async () => {
    const usageData = {
      input: 50,
      output: 25,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 75,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const mockStream = {
      result: () => Promise.resolve({ usage: usageData }),
    };
    base.mockReturnValue(mockStream);

    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl", agentId: "agent-s", sessionId: "slack:ch:user" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    wrappedFn(makeModel("anthropic"), makeContext([]));

    // Pre-call line should include sessionId
    const preCallParsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(preCallParsed.sessionId).toBe("slack:ch:user");

    // Wait for async usage capture
    await new Promise((r) => setTimeout(r, 0));

    // Post-call usage line should also include sessionId
    expect(mockAppendFileSync).toHaveBeenCalledTimes(2);
    const usageLine = JSON.parse((mockAppendFileSync.mock.calls[1][1] as string).trim());
    expect(usageLine.sessionId).toBe("slack:ch:user");
    expect(usageLine.type).toBe("api_usage");
  });

  it("writes post-call usage line when stream has result()", async () => {
    const usageData = {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const mockStream = {
      result: () => Promise.resolve({ usage: usageData }),
    };
    base.mockReturnValue(mockStream);

    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl", agentId: "agent-7" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    wrappedFn(makeModel("anthropic"), makeContext([]));

    // Pre-call line should be written synchronously
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);

    // Wait for the async usage capture to complete
    await new Promise((r) => setTimeout(r, 0));

    // Post-call usage line should now be written
    expect(mockAppendFileSync).toHaveBeenCalledTimes(2);
    const usageLine = JSON.parse((mockAppendFileSync.mock.calls[1][1] as string).trim());
    expect(usageLine.type).toBe("api_usage");
    expect(usageLine.agentId).toBe("agent-7");
    expect(usageLine.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(usageLine.usage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
    });
  });

  it("silently ignores when stream has no result() method", () => {
    // base returns plain string "stream-result" -- no result() method
    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const result = wrappedFn(makeModel("anthropic"), makeContext([]));

    // Only the pre-call line should be written
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    expect(result).toBe("stream-result");
  });

  it("returns a named function for logging", () => {
    const config: ApiPayloadTraceConfig = { filePath: "/tmp/api.jsonl" };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    expect(wrapper.name).toBe("apiPayloadTraceWriter");
  });

  it("passes maxSize and maxFiles through to appendJsonlLine (triggers rotation check)", () => {
    // File exists and is over maxSize -- rotation should trigger
    mockStatSync.mockReturnValue({ size: 10 * 1024 * 1024 } as any);

    const config: ApiPayloadTraceConfig = {
      filePath: "/tmp/api.jsonl",
      maxSize: "5m",
      maxFiles: 2,
    };
    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    wrappedFn(makeModel("anthropic"), makeContext([]));

    // statSync should have been called (rotation check)
    expect(mockStatSync).toHaveBeenCalledWith("/tmp/api.jsonl");
    // File should have been renamed to .1
    expect(mockRenameSync).toHaveBeenCalledWith("/tmp/api.jsonl", "/tmp/api.jsonl.1");
  });
});

describe("TTFT tracking in createApiPayloadTraceWriter", () => {
  let logger: ReturnType<typeof createMockLogger>;

  function makeModel(provider: string) {
    return {
      id: "claude-sonnet-4-5-20250929",
      name: "Claude Sonnet",
      api: "anthropic-messages",
      provider,
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } as any;
  }

  beforeEach(() => {
    logger = createMockLogger();
    mockAppendFileSync.mockReset();
    mockStatSync.mockReset();
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT"); });
  });

  it("logs ttftMs at DEBUG level per API call", async () => {
    const config: ApiPayloadTraceConfig = {
      filePath: "/tmp/api.jsonl",
      agentId: "test-agent",
      sessionId: "test-session",
    };

    // Create a stream mock that resolves result() with usage data
    const mockResult = {
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    };
    const resultPromise = Promise.resolve(mockResult);
    const streamMock = { result: () => resultPromise };
    const base = vi.fn().mockReturnValue(streamMock);

    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);

    wrappedFn(model, context);

    // Wait for the fire-and-forget result promise to complete
    await resultPromise;
    // Let microtasks settle
    await new Promise(r => setTimeout(r, 10));

    // Should have logged TTFT at DEBUG level
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        ttftMs: expect.any(Number),
        modelId: "claude-sonnet-4-5-20250929",
        provider: "anthropic",
        agentId: "test-agent",
        sessionId: "test-session",
      }),
      "TTFT (time-to-first-token proxy)",
    );
  });

  it("records TTFT per API call (each invocation gets its own timing)", async () => {
    const config: ApiPayloadTraceConfig = {
      filePath: "/tmp/api.jsonl",
      agentId: "test-agent",
    };

    const mockResult = {
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    };
    const resultPromise1 = Promise.resolve(mockResult);
    const resultPromise2 = Promise.resolve(mockResult);
    const base = vi.fn()
      .mockReturnValueOnce({ result: () => resultPromise1 })
      .mockReturnValueOnce({ result: () => resultPromise2 });

    const wrapper = createApiPayloadTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);

    // Two separate API calls
    wrappedFn(model, context);
    wrappedFn(model, context);

    // Wait for both result promises
    await resultPromise1;
    await resultPromise2;
    await new Promise(r => setTimeout(r, 10));

    // Should have two TTFT debug logs (one per API call)
    const ttftCalls = logger.debug.mock.calls.filter(
      (c: unknown[]) => c[1] === "TTFT (time-to-first-token proxy)",
    );
    expect(ttftCalls).toHaveLength(2);
  });
});
