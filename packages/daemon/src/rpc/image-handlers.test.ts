// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for image generation RPC handlers.
 * Verifies the image.generate handler applies rate limiting,
 * safety checking, provider execution, and direct channel
 * delivery.
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createImageHandlers, type ImageHandlerDeps } from "./image-handlers.js";
import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// Mock node:fs/promises and node:os to avoid real filesystem I/O
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:os", () => ({
  tmpdir: () => "/tmp",
}));

vi.mock("@comis/core", () => ({
  safePath: (...segments: string[]) => segments.join("/"),
}));

vi.mock("@comis/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/shared")>();
  return {
    ...actual,
    suppressError: vi.fn(),
  };
});

function createMockDeps(overrides: Partial<ImageHandlerDeps> = {}): ImageHandlerDeps {
  return {
    provider: {
      id: "test-provider",
      isAvailable: () => true,
      execute: vi.fn().mockResolvedValue(ok({
        buffer: Buffer.from("fake-image-data"),
        mimeType: "image/png",
      })),
    },
    rateLimiter: {
      tryAcquire: vi.fn().mockReturnValue(true),
      reset: vi.fn(),
    },
    config: {
      provider: "fal",
      safetyChecker: true,
      maxPerHour: 10,
      defaultSize: "1024x1024",
      timeoutMs: 60000,
    },
    logger: createMockLogger() as any,
    getChannelAdapter: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe("createImageHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when prompt is missing", async () => {
    const deps = createMockDeps();
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      _agentId: "agent-1",
      // prompt is missing
    });

    expect(result).toEqual({ success: false, error: "Missing required parameter: prompt" });
    expect(deps.provider.execute).not.toHaveBeenCalled();
  });

  it("returns error when rate limited", async () => {
    const deps = createMockDeps({
      rateLimiter: {
        tryAcquire: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      },
    });
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a cat",
    });

    expect(result).toEqual({
      success: false,
      error: "Rate limit exceeded: max 10 images per hour",
    });
    expect(deps.provider.execute).not.toHaveBeenCalled();
  });

  it("calls provider.execute with correct input including safetyChecker", async () => {
    const deps = createMockDeps();
    const handlers = createImageHandlers(deps);
    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a red fox",
      size: "square_hd",
    });

    expect(deps.provider.execute).toHaveBeenCalledWith({
      prompt: "a red fox",
      size: "square_hd",
      safetyChecker: true,
    });
  });

  it("uses defaultSize from config when size not provided", async () => {
    const deps = createMockDeps();
    const handlers = createImageHandlers(deps);
    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "sunset",
    });

    expect(deps.provider.execute).toHaveBeenCalledWith(
      expect.objectContaining({ size: "1024x1024" }),
    );
  });

  it("returns error when provider fails", async () => {
    const deps = createMockDeps({
      provider: {
        id: "test-provider",
        isAvailable: () => true,
        execute: vi.fn().mockResolvedValue(err(new Error("Provider error: content blocked"))),
      },
    });
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "test prompt",
    });

    expect(result).toEqual({ success: false, error: "Provider error: content blocked" });
  });

  it("delivers image via adapter.sendAttachment on success", async () => {
    const mockSendAttachment = vi.fn().mockResolvedValue(ok("msg-123"));
    const deps = createMockDeps({
      getChannelAdapter: vi.fn().mockReturnValue({
        sendAttachment: mockSendAttachment,
      }),
    });
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a beautiful landscape",
      _callerChannelType: "telegram",
      _callerChannelId: "chat-42",
    });

    expect(mockSendAttachment).toHaveBeenCalledWith(
      "chat-42",
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        fileName: "generated-image.png",
      }),
    );
    expect(result).toEqual({ success: true, delivered: true, mimeType: "image/png" });
  });

  it("returns { success: true, delivered: true } after successful channel delivery", async () => {
    const mockSendAttachment = vi.fn().mockResolvedValue(ok("msg-456"));
    const deps = createMockDeps({
      getChannelAdapter: vi.fn().mockReturnValue({
        sendAttachment: mockSendAttachment,
      }),
    });
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "test",
      _callerChannelType: "discord",
      _callerChannelId: "channel-99",
    });

    expect(result).toEqual({
      success: true,
      delivered: true,
      mimeType: "image/png",
    });
  });

  it("falls back to base64 response when adapter not available", async () => {
    const deps = createMockDeps({
      getChannelAdapter: vi.fn().mockReturnValue(undefined),
    });
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a cat",
      _callerChannelType: "telegram",
      _callerChannelId: "chat-1",
    }) as any;

    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeDefined();
    expect(result.mimeType).toBe("image/png");
  });

  it("falls back to base64 when no channel context provided", async () => {
    const deps = createMockDeps();
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a dog",
    }) as any;

    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeDefined();
    expect(result.mimeType).toBe("image/png");
    // Should not attempt to get adapter
    expect(deps.getChannelAdapter).not.toHaveBeenCalled();
  });
});
