// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCacheTraceWriter, parseSize, rotateIfNeeded } from "./cache-trace-writer.js";
import type { CacheTraceConfig } from "./cache-trace-writer.js";
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

describe("createCacheTraceWriter", () => {
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

  it("writes JSONL line with model ID and message count", () => {
    const config: CacheTraceConfig = { filePath: "/tmp/trace.jsonl" };
    const wrapper = createCacheTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const userMsg: Message = { role: "user", content: "hello", timestamp: Date.now() };
    const context = makeContext([userMsg]);

    wrappedFn(model, context);

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [filePath, line] = mockAppendFileSync.mock.calls[0];
    expect(filePath).toBe("/tmp/trace.jsonl");

    const parsed = JSON.parse((line as string).trim());
    expect(parsed.type).toBe("cache_trace");
    expect(parsed.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.messageCount).toBe(1);
    expect(parsed.ts).toBeDefined();
  });

  it("includes truncated system prompt SHA-256 digest", () => {
    const config: CacheTraceConfig = { filePath: "/tmp/trace.jsonl" };
    const wrapper = createCacheTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);

    wrappedFn(model, context);

    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    // systemPromptDigest should be a 16-char hex string
    expect(parsed.systemPromptDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("includes agent ID when provided", () => {
    const config: CacheTraceConfig = { filePath: "/tmp/trace.jsonl", agentId: "agent-42" };
    const wrapper = createCacheTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    wrappedFn(makeModel("anthropic"), makeContext([]));

    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(parsed.agentId).toBe("agent-42");
  });

  it("includes session ID when provided", () => {
    const config: CacheTraceConfig = { filePath: "/tmp/trace.jsonl", agentId: "agent-42", sessionId: "telegram:chat123:user456" };
    const wrapper = createCacheTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    wrappedFn(makeModel("anthropic"), makeContext([]));

    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(parsed.sessionId).toBe("telegram:chat123:user456");
  });

  it("includes tool count from context", () => {
    const config: CacheTraceConfig = { filePath: "/tmp/trace.jsonl" };
    const wrapper = createCacheTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const context: Context = {
      systemPrompt: "test prompt",
      messages: [],
      tools: [{ name: "bash" } as any, { name: "file_read" } as any],
    };

    wrappedFn(makeModel("anthropic"), context);

    const parsed = JSON.parse((mockAppendFileSync.mock.calls[0][1] as string).trim());
    expect(parsed.toolCount).toBe(2);
  });

  it("passes through to next StreamFn unchanged", () => {
    const config: CacheTraceConfig = { filePath: "/tmp/trace.jsonl" };
    const wrapper = createCacheTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const model = makeModel("anthropic");
    const context = makeContext([]);
    const options = { maxTokens: 4096 };

    const result = wrappedFn(model, context, options);

    expect(base).toHaveBeenCalledWith(model, context, options);
    expect(result).toBe("stream-result");
  });

  it("does not throw when appendFileSync fails", () => {
    mockAppendFileSync.mockImplementation(() => { throw new Error("disk full"); });

    const config: CacheTraceConfig = { filePath: "/tmp/trace.jsonl" };
    const wrapper = createCacheTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    const result = wrappedFn(makeModel("anthropic"), makeContext([]));

    // Should still call next and return result despite write failure
    expect(base).toHaveBeenCalled();
    expect(result).toBe("stream-result");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        filePath: "/tmp/trace.jsonl",
        hint: "Check trace output directory permissions and disk space",
        errorKind: "resource",
      }),
      "JSONL trace write failed",
    );
  });

  it("returns a named function for logging", () => {
    const config: CacheTraceConfig = { filePath: "/tmp/trace.jsonl" };
    const wrapper = createCacheTraceWriter(config, logger);
    expect(wrapper.name).toBe("cacheTraceWriter");
  });

  it("passes maxSize and maxFiles through to appendJsonlLine (triggers rotation check)", () => {
    // File exists and is over maxSize -- rotation should trigger
    mockStatSync.mockReturnValue({ size: 10 * 1024 * 1024 } as any);

    const config: CacheTraceConfig = {
      filePath: "/tmp/trace.jsonl",
      maxSize: "5m",
      maxFiles: 2,
    };
    const wrapper = createCacheTraceWriter(config, logger);
    const wrappedFn = wrapper(base);

    wrappedFn(makeModel("anthropic"), makeContext([]));

    // statSync should have been called (rotation check)
    expect(mockStatSync).toHaveBeenCalledWith("/tmp/trace.jsonl");
    // File should have been renamed to .1
    expect(mockRenameSync).toHaveBeenCalledWith("/tmp/trace.jsonl", "/tmp/trace.jsonl.1");
  });
});


// ---------------------------------------------------------------------------
// parseSize
// ---------------------------------------------------------------------------

describe("parseSize", () => {
  it('parses "5m" to 5242880 bytes', () => {
    expect(parseSize("5m")).toBe(5 * 1024 * 1024);
  });

  it('parses "1g" to 1073741824 bytes', () => {
    expect(parseSize("1g")).toBe(1024 * 1024 * 1024);
  });

  it('parses "500k" to 512000 bytes', () => {
    expect(parseSize("500k")).toBe(500 * 1024);
  });

  it('parses "1024" (no suffix) to 1024 bytes', () => {
    expect(parseSize("1024")).toBe(1024);
  });

  it("handles uppercase suffixes", () => {
    expect(parseSize("10M")).toBe(10 * 1024 * 1024);
    expect(parseSize("2G")).toBe(2 * 1024 * 1024 * 1024);
    expect(parseSize("100K")).toBe(100 * 1024);
  });

  it("returns 0 for unparseable strings", () => {
    expect(parseSize("")).toBe(0);
    expect(parseSize("abc")).toBe(0);
    expect(parseSize("10mb")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rotateIfNeeded
// ---------------------------------------------------------------------------

describe("rotateIfNeeded", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    mockStatSync.mockReset();
    mockRenameSync.mockReset();
    mockUnlinkSync.mockReset();
  });

  it("does nothing when maxSize is undefined", () => {
    rotateIfNeeded("/tmp/trace.jsonl", undefined, 3, logger);
    expect(mockStatSync).not.toHaveBeenCalled();
  });

  it("does nothing when maxFiles is undefined", () => {
    rotateIfNeeded("/tmp/trace.jsonl", "5m", undefined, logger);
    expect(mockStatSync).not.toHaveBeenCalled();
  });

  it("does nothing when file does not exist (statSync throws)", () => {
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT"); });

    rotateIfNeeded("/tmp/trace.jsonl", "5m", 3, logger);

    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("does nothing when file is under maxSize", () => {
    mockStatSync.mockReturnValue({ size: 1024 } as any);

    rotateIfNeeded("/tmp/trace.jsonl", "5m", 3, logger);

    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("rotates file when over maxSize -- renames to .1", () => {
    mockStatSync.mockReturnValue({ size: 6 * 1024 * 1024 } as any); // 6MB > 5MB

    rotateIfNeeded("/tmp/trace.jsonl", "5m", 3, logger);

    // Should rename current file to .1
    expect(mockRenameSync).toHaveBeenCalledWith("/tmp/trace.jsonl", "/tmp/trace.jsonl.1");
  });

  it("shifts existing .1 to .2 during rotation", () => {
    mockStatSync.mockReturnValue({ size: 6 * 1024 * 1024 } as any);

    rotateIfNeeded("/tmp/trace.jsonl", "5m", 3, logger);

    // Should shift .2 -> .3, .1 -> .2, then current -> .1
    const renameCalls = mockRenameSync.mock.calls;
    expect(renameCalls).toContainEqual(["/tmp/trace.jsonl.1", "/tmp/trace.jsonl.2"]);
    expect(renameCalls).toContainEqual(["/tmp/trace.jsonl.2", "/tmp/trace.jsonl.3"]);
    expect(renameCalls).toContainEqual(["/tmp/trace.jsonl", "/tmp/trace.jsonl.1"]);
  });

  it("deletes oldest file beyond maxFiles", () => {
    mockStatSync.mockReturnValue({ size: 6 * 1024 * 1024 } as any);

    rotateIfNeeded("/tmp/trace.jsonl", "5m", 2, logger);

    // With maxFiles=2, should try to delete .2 (the oldest after rotation)
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/trace.jsonl.2");
  });

  it("logs WARN with hint+errorKind when rename fails", () => {
    mockStatSync.mockReturnValue({ size: 6 * 1024 * 1024 } as any);
    // Make the final rename (current -> .1) throw
    mockRenameSync.mockImplementation((from) => {
      if (from === "/tmp/trace.jsonl") throw new Error("EPERM");
    });

    rotateIfNeeded("/tmp/trace.jsonl", "5m", 3, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        filePath: "/tmp/trace.jsonl",
        hint: "Trace file rotation failed; tracing continues to current file",
        errorKind: "resource",
      }),
      "Trace file rotation failed",
    );
  });

  it("does not throw even when rotation fails completely", () => {
    mockStatSync.mockReturnValue({ size: 6 * 1024 * 1024 } as any);
    mockRenameSync.mockImplementation(() => { throw new Error("EPERM"); });

    // Should not throw
    expect(() => {
      rotateIfNeeded("/tmp/trace.jsonl", "5m", 3, logger);
    }).not.toThrow();
  });
});

