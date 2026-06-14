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
import { ImageGenError } from "./pi-image-adapter.js";
import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// Mock node:fs/promises and node:os to avoid real filesystem I/O
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    tmpdir: () => "/tmp",
  };
});

// Preserve the contract registry exports + stripInternalFields helper that
// the refactored handler now imports from @comis/core.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: (...segments: string[]) => segments.join("/"),
  };
});

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
    resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "openrouter" }),
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

  // ─── RES-01 keystone: the handler is no longer provider-blind ──────────────

  it("resolves the agent main provider with the default agentId when none provided", async () => {
    const deps = createMockDeps();
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      prompt: "a cat",
      // no _agentId → defaults to "default"
    });

    // RES-01: the handler calls deps.resolveAgentMainProvider with the resolved agentId.
    expect(deps.resolveAgentMainProvider).toHaveBeenCalledWith("default");
    // The existing happy-path delivery still works (provider mock returns ok).
    expect((result as any).success).toBe(true);
  });

  it("resolves the agent main provider with the supplied agentId for RES-01 lockstep", async () => {
    const deps = createMockDeps();
    const handlers = createImageHandlers(deps);
    await handlers["image.generate"]!({
      _agentId: "agent-x",
      prompt: "a fox",
    });

    // RES-01: the resolved id flows from the dispatcher-injected _agentId.
    expect(deps.resolveAgentMainProvider).toHaveBeenCalledWith("agent-x");
  });

  // ─── RES-03 honest-unavailable surfaced THROUGH the handler with the hint ──

  it("surfaces the RES-03 unavailable hint naming the provider config knob", async () => {
    const knobHint =
      'Set integrations.media.imageGeneration.provider to an image-capable provider (e.g. "openrouter").';
    const deps = createMockDeps({
      provider: {
        id: "unavailable",
        isAvailable: () => false,
        execute: vi.fn().mockResolvedValue(
          err(
            new ImageGenError("The selected provider cannot generate images.", {
              imageErrorKind: "unsupported_provider",
              hint: knobHint,
            }),
          ),
        ),
      },
    });
    const handlers = createImageHandlers(deps);
    const result = (await handlers["image.generate"]!({
      _agentId: "agent-anthropic",
      prompt: "a landscape",
    })) as { success: boolean; error: string; hint?: string };

    // The handler surfaces the typed error's message AND its knob-naming hint.
    expect(result.success).toBe(false);
    expect(result.error).toBe("The selected provider cannot generate images.");
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain("integrations.media.imageGeneration.provider");
  });

  // ─── WR-03 (§2.7): INFO completion line with durationMs on success ─────────

  it("emits an INFO completion line with durationMs on the channel-delivered success path (WR-03)", async () => {
    const mockSendAttachment = vi.fn().mockResolvedValue(ok("msg-789"));
    const deps = createMockDeps({
      getChannelAdapter: vi.fn().mockReturnValue({ sendAttachment: mockSendAttachment }),
    });
    const handlers = createImageHandlers(deps);
    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a sunset",
      _callerChannelType: "telegram",
      _callerChannelId: "chat-7",
    });

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        mainProvider: "openrouter",
        delivered: true,
        mimeType: "image/png",
        durationMs: expect.any(Number),
        step: "image_complete",
      }),
      expect.stringContaining("Image generation completed"),
    );
  });

  it("emits an INFO completion line with durationMs on the base64-fallback success path (WR-03)", async () => {
    const deps = createMockDeps({ getChannelAdapter: vi.fn().mockReturnValue(undefined) });
    const handlers = createImageHandlers(deps);
    await handlers["image.generate"]!({
      _agentId: "agent-2",
      prompt: "a dog",
    });

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-2",
        mainProvider: "openrouter",
        delivered: false,
        mimeType: "image/png",
        durationMs: expect.any(Number),
        step: "image_complete",
      }),
      expect.stringContaining("Image generation completed"),
    );
  });

  it("does NOT emit a completion INFO line on the failure path (WR-03)", async () => {
    const deps = createMockDeps({
      provider: {
        id: "test-provider",
        isAvailable: () => true,
        execute: vi.fn().mockResolvedValue(err(new Error("Provider error: content blocked"))),
      },
    });
    const handlers = createImageHandlers(deps);
    await handlers["image.generate"]!({ _agentId: "agent-1", prompt: "x" });

    const completionInfo = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      ([payload]) => (payload as { step?: string })?.step === "image_complete",
    );
    expect(completionInfo).toBe(false);
  });

  it("omits the hint field when the provider error carries no hint", async () => {
    const deps = createMockDeps({
      provider: {
        id: "test-provider",
        isAvailable: () => true,
        execute: vi.fn().mockResolvedValue(err(new Error("Provider error: content blocked"))),
      },
    });
    const handlers = createImageHandlers(deps);
    const result = (await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "test prompt",
    })) as { success: boolean; error: string; hint?: string };

    // A plain Error has no .hint → the handler returns the legacy shape (no hint key).
    expect(result).toEqual({ success: false, error: "Provider error: content blocked" });
    expect("hint" in result).toBe(false);
  });

  // ─── WR-05 (184-REVIEW): multi-agent credential-misroute is a DOCUMENTED ────
  // deferral (Phase 186). The boot-selected `provider` port is the DEFAULT
  // agent's; a non-default agent whose resolved main provider DIFFERS runs the
  // default agent's port/credentials. Until 186 re-selects per-request, the
  // handler must at least make the divergence OBSERVABLE (not silent), so triage
  // is not misled by the per-request obs line that names the caller's provider
  // while execution uses the default's port.

  it("WARNs when the caller's resolved provider diverges from the boot-selected port (misroute risk)", async () => {
    const logger = createMockLogger() as unknown as ReturnType<typeof createMockLogger> & {
      warn: ReturnType<typeof vi.fn>;
    };
    const deps = createMockDeps({
      // Boot-selected port = the DEFAULT agent's (openrouter).
      provider: {
        id: "openrouter",
        isAvailable: () => true,
        execute: vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" })),
      },
      // The CALLER (non-default agent) resolves to a DIFFERENT provider (codex).
      resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "openai-codex" }),
      logger: logger as never,
    });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({ _agentId: "agent-codex", prompt: "a fox" });

    const warned = logger.warn.mock.calls.find(
      ([payload]) => (payload as { step?: string }).step === "image_provider_divergence",
    );
    expect(warned).toBeDefined();
    const [payload] = warned as [Record<string, unknown>, string];
    expect(payload.agentId).toBe("agent-codex");
    expect(payload.callerProvider).toBe("openai-codex");
    expect(payload.executedProvider).toBe("openrouter");
    expect(payload.errorKind).toBe("precondition");
    expect(payload.hint).toContain("186");
  });

  it("does NOT WARN when the caller's provider matches the boot-selected port (shared-provider agents)", async () => {
    const logger = createMockLogger() as unknown as ReturnType<typeof createMockLogger> & {
      warn: ReturnType<typeof vi.fn>;
    };
    const deps = createMockDeps({
      provider: {
        id: "openrouter",
        isAvailable: () => true,
        execute: vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" })),
      },
      resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "openrouter" }),
      logger: logger as never,
    });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({ _agentId: "agent-2", prompt: "a fox" });

    const warned = logger.warn.mock.calls.find(
      ([payload]) => (payload as { step?: string }).step === "image_provider_divergence",
    );
    expect(warned).toBeUndefined();
  });
});
