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
import { validateUrl } from "@comis/core";
import type { PersistedFile } from "@comis/skills/tools";
import { readFile } from "node:fs/promises";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

/** DEL-01: a successful PersistedFile the per-agent persist getter returns. The
 *  filePath is what sendAttachment receives (the PERSISTED path, NOT a tmpdir
 *  path) and sizeBytes is the OBS-01 field (Plan 02 consumes it). */
const PERSISTED_OK: PersistedFile = {
  // A durable workspace path under ~/.comis/workspace/media/photos/ — what
  // MediaPersistenceService returns. Deliberately NOT under an OS temp dir and
  // NOT a `comis-img-*` ephemeral filename (the pre-DEL-01 signature the
  // delivery assertion rejects).
  filePath: "/home/agent/.comis/workspace/media/photos/abc123.png",
  relativePath: "photos/abc123.png",
  mimeType: "image/png",
  sizeBytes: 4242,
  mediaKind: "image",
  savedAt: 0,
};

// Mock node:fs/promises and node:os to avoid real filesystem I/O
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  // IN-01: the reference-image file path branch reads the resolved (safePath-
  // confined) path. Returns deterministic bytes; tests assert WHICH path it
  // was called with (workspace-confined), not the contents.
  readFile: vi.fn().mockResolvedValue(Buffer.from("REF-FILE-BYTES")),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    tmpdir: () => "/tmp",
  };
});

// CR-01: the reference_image URL branch now routes through the shared
// DNS-pinned SSRF fetcher (ssrf-image-fetch.ts → undici Agent + fetch). Mock
// `undici` so Agent is a real class (constructor args captured) and `fetch`
// delegates to globalThis.fetch — NEVER the real network. Mirrors the
// ssrf-fetcher.test.ts seam.
const { undiciAgentCtor, undiciAgentClose } = vi.hoisted(() => {
  const undiciAgentCtor = vi.fn();
  const undiciAgentClose = vi.fn().mockResolvedValue(undefined);
  return { undiciAgentCtor, undiciAgentClose };
});

vi.mock("undici", () => {
  class MockAgent {
    close = undiciAgentClose;
    constructor(args: unknown) {
      undiciAgentCtor(args);
    }
  }
  const fetch = (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args);
  return { Agent: MockAgent, fetch };
});

// Preserve the contract registry exports + stripInternalFields helper that
// the refactored handler now imports from @comis/core.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    // safePath joins segments here (the real guard is unit-tested in core); the
    // IN-01 path-traversal test asserts the handler routes the agent-supplied
    // path THROUGH safePath (confinement under the workspace), mirroring the
    // media-handlers.test.ts convention.
    safePath: (...segments: string[]) => segments.join("/"),
    // validateUrl defaults to ok WITH a resolved value (hostname/ip/url) so the
    // CR-01 URL branch can pin DNS to the validated IP; the SSRF test overrides
    // it to reject.
    validateUrl: vi.fn(async () => ({
      ok: true,
      value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("https://example.com/ref.png") },
    })),
    // isValidImageModel / listImageModels come through `...actual` (the real
    // IN-02 enumeration) so the reject hint lists the genuine model lists.
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
    // IN-01 (185): the reference-image file path branch resolves the agent
    // workspace dir from these (mirrors MediaApiDeps; threaded through
    // imageHandlerDeps this plan).
    workspaceDirs: new Map<string, string>(),
    defaultWorkspaceDir: "/tmp/test-workspace",
    // DEL-01 (186): the per-agent persist getter (MediaPersistenceService.persist
    // bound to the agent's workspace). Defaults to a successful PersistedFile so
    // the existing handler tests still construct valid deps after the type grows.
    persist: vi.fn().mockResolvedValue(ok(PERSISTED_OK)),
    ...overrides,
  };
}

describe("ImageHandlerDeps.persist type (DEL-01)", () => {
  it("exposes a per-agent persist getter returning Result<PersistedFile, Error>", () => {
    // Type-level proof that the dep exists with the (agentId, buffer, opts)
    // signature. The assignment fails to compile if types.ts lacks the field
    // (the RED state before the GREEN type widen) or if the shape diverges.
    const persist: ImageHandlerDeps["persist"] = async (
      agentId: string,
      buffer: Buffer,
      opts: { mediaKind: "image"; mimeType: string },
    ) => {
      void agentId;
      void buffer;
      void opts;
      return ok(PERSISTED_OK);
    };
    expect(typeof persist).toBe("function");
  });
});

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

  // ─── DEL-01: durable persistence replaces the tmpdir write+delete ──────────

  it("DEL-01: persists the image and hands sendAttachment the PERSISTED filePath (not a tmpdir path)", async () => {
    const mockSendAttachment = vi.fn().mockResolvedValue(ok("msg-del01"));
    const persist = vi.fn().mockResolvedValue(ok(PERSISTED_OK));
    const deps = createMockDeps({
      getChannelAdapter: vi.fn().mockReturnValue({ sendAttachment: mockSendAttachment }),
      persist,
    });
    const handlers = createImageHandlers(deps);
    const result = await handlers["image.generate"]!({
      _agentId: "agent-del01",
      prompt: "a durable landscape",
      _callerChannelType: "telegram",
      _callerChannelId: "chat-del01",
    });

    // The handler persists the generated buffer via the per-agent getter,
    // scoped to the caller's agentId with mediaKind:"image" (T-186-01 — the
    // service routes to the agent's confined `photos/` subdir).
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      "agent-del01",
      expect.any(Buffer),
      expect.objectContaining({ mediaKind: "image", mimeType: "image/png" }),
    );
    // sendAttachment receives the PERSISTED durable path — NOT an OS-tmpdir
    // `comis-img-*` ephemeral path (the whole point of DEL-01). It lives under
    // the agent workspace media dir.
    const attachment = mockSendAttachment.mock.calls[0]?.[1] as { url: string };
    expect(attachment.url).toBe(PERSISTED_OK.filePath);
    expect(attachment.url).not.toMatch(/comis-img-/);
    expect(attachment.url).toContain("workspace/media/photos/");
    expect(result).toEqual({ success: true, delivered: true, mimeType: "image/png" });
  });

  it("DEL-01: a persistence failure WARNs and falls through to base64 (no crash, no sendAttachment)", async () => {
    const mockSendAttachment = vi.fn().mockResolvedValue(ok("should-not-be-called"));
    const persist = vi.fn().mockResolvedValue(err(new Error("disk full")));
    const deps = createMockDeps({
      getChannelAdapter: vi.fn().mockReturnValue({ sendAttachment: mockSendAttachment }),
      persist,
    });
    const handlers = createImageHandlers(deps);
    const result = (await handlers["image.generate"]!({
      _agentId: "agent-del01b",
      prompt: "a doomed render",
      _callerChannelType: "telegram",
      _callerChannelId: "chat-del01b",
    })) as { success: boolean; imageBase64?: string; mimeType: string };

    // Persist failed → base64 fallback, delivery skipped, no crash.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(mockSendAttachment).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeDefined();
    expect(result.mimeType).toBe("image/png");
    // OBS-02: the persist-failure branch carries errorKind + a hint (§2.7).
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "network",
        hint: expect.stringContaining("persist"),
        step: "image_persist",
      }),
      expect.any(String),
    );
  });

  // ─── DEL-02 (regression-guard): capability-driven, NEVER a channel-name list ─

  it("DEL-02: an adapter present but LACKING sendAttachment degrades to base64 (no undefined-method call)", async () => {
    // The adapter object has NO sendAttachment property (today only IRC). The
    // capability gate (typeof adapter.sendAttachment === "function") must skip
    // delivery and fall through to base64 — never call an undefined method.
    const persist = vi.fn().mockResolvedValue(ok(PERSISTED_OK));
    const deps = createMockDeps({
      getChannelAdapter: vi.fn().mockReturnValue({ /* no sendAttachment */ }),
      persist,
    });
    const handlers = createImageHandlers(deps);
    const result = (await handlers["image.generate"]!({
      _agentId: "agent-del02",
      prompt: "an IRC-bound image",
      _callerChannelType: "irc",
      _callerChannelId: "#chan",
    })) as { success: boolean; imageBase64?: string; mimeType: string };

    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeDefined();
    expect(result.mimeType).toBe("image/png");
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

// ───────────────────────────────────────────────────────────────────────────
// IN-01 reference-image resolution (SSRF / path-traversal safe) + IN-02 model
// validation + CFG-02 param threading (185-03, Task 2)
// ───────────────────────────────────────────────────────────────────────────

describe("createImageHandlers IN-01 reference_image resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset validateUrl to the default ok between tests (the SSRF case overrides).
    (validateUrl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true,
      value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("https://example.com/ref.png") },
    }));
  });

  const REF_B64 = Buffer.from("PNGBYTES").toString("base64");

  it("Test 1: a raw base64 reference_image is decoded and threaded to execute() (data path)", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openrouter", isAvailable: () => true, execute },
    });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "edit this",
      reference_image: `data:image/png;base64,${REF_B64}`,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImage: expect.objectContaining({ data: REF_B64, mimeType: "image/png" }),
      }),
    );
    // base64/data-uri must NOT touch the filesystem or the network.
    expect(readFile).not.toHaveBeenCalled();
  });

  it("Test 2: a workspace file path is confined by safePath under the agent workspace dir", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openrouter", isAvailable: () => true, execute },
      workspaceDirs: new Map([["agent-1", "/ws/agent-1"]]),
    });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "edit this",
      reference_image: "sub/ref.png",
    });

    // safePath is mocked to join segments — the resolved path must start under
    // the agent's workspace dir (confinement), and that path is what readFile reads.
    expect(readFile).toHaveBeenCalledWith("/ws/agent-1/sub/ref.png");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImage: expect.objectContaining({ mimeType: expect.any(String) }) }),
    );
  });

  it("Test 3: a path-traversal reference_image stays under the workspace root (never reads outside)", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openrouter", isAvailable: () => true, execute },
      workspaceDirs: new Map([["agent-1", "/ws/agent-1"]]),
    });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "edit this",
      reference_image: "../../etc/passwd",
    });

    // The handler routes the path THROUGH safePath (the T-185-09 confinement
    // floor): readFile is called with a path that begins at the workspace root,
    // NOT a bare /etc/passwd. (The real safePath rejects the escape; the mocked
    // join proves the guard is on the path.)
    const calledPath = (readFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string | undefined;
    if (calledPath !== undefined) {
      expect(calledPath.startsWith("/ws/agent-1")).toBe(true);
    }
    // Either way, it must never read a path that resolves outside the workspace.
    expect(readFile).not.toHaveBeenCalledWith("/etc/passwd");
  });

  it("Test 4: an internal-metadata URL is SSRF-blocked before any fetch", async () => {
    (validateUrl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: false,
      error: new Error("blocked private IP"),
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openrouter", isAvailable: () => true, execute },
    });
    const handlers = createImageHandlers(deps);

    // The handler is @allow-throw — an SSRF-blocked reference throws (caught by
    // rpc-dispatch → JSON-RPC error in production), exactly like the
    // media-handlers SSRF path. The security floor is: no fetch to the internal
    // endpoint, and no provider.execute.
    await expect(
      handlers["image.generate"]!({
        _agentId: "agent-1",
        prompt: "edit this",
        reference_image: "http://169.254.169.254/latest/meta-data",
      }),
    ).rejects.toThrow(/SSRF blocked/);

    expect(validateUrl).toHaveBeenCalledWith("http://169.254.169.254/latest/meta-data");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("Test 5: absence of reference_image keeps execute() text-only (no referenceImage — no regression)", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openrouter", isAvailable: () => true, execute },
    });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({ _agentId: "agent-1", prompt: "a fox" });

    expect(execute).toHaveBeenCalledTimes(1);
    const arg = execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.referenceImage).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  // ─── CR-01: the URL branch MUST route through the DNS-pinned SSRF fetcher ───
  // (not a bare fetch that re-resolves DNS), closing the DNS-rebinding TOCTOU
  // window. A successful fetch must (a) validate the host, (b) pin the undici
  // Agent dispatcher to the validated IP, (c) refuse redirects.

  it("CR-01: a reference_image URL is fetched with a DNS-pinned dispatcher (no rebind window)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
    } as unknown as Response);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    undiciAgentCtor.mockClear();
    try {
      const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
      const deps = createMockDeps({ provider: { id: "openrouter", isAvailable: () => true, execute } });
      const handlers = createImageHandlers(deps);

      await handlers["image.generate"]!({
        _agentId: "agent-1",
        prompt: "edit this",
        reference_image: "https://example.com/ref.png",
      });

      // The host was SSRF-validated, the pinned Agent was constructed (dispatcher),
      // and fetch refused redirects + carried the pinned dispatcher.
      expect(validateUrl).toHaveBeenCalledWith("https://example.com/ref.png");
      expect(undiciAgentCtor).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]! as [string, { redirect?: string; dispatcher?: unknown }];
      expect(url).toBe("https://example.com/ref.png");
      expect(init.redirect).toBe("error");
      expect(init.dispatcher).toBeDefined();
      // The decoded bytes are threaded to execute().
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceImage: expect.objectContaining({
            data: Buffer.from([1, 2, 3]).toString("base64"),
            mimeType: "image/png",
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ─── WR-01: data-uri decode is size-capped (resource exhaustion) ───────────

  it("WR-01: an oversized data-uri reference_image is rejected before threading to execute()", async () => {
    // 21 MB of base64 'A' decodes to > 20 MB (MAX_REFERENCE_BYTES). Must reject.
    const oversized = "A".repeat(28 * 1024 * 1024);
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({ provider: { id: "openrouter", isAvailable: () => true, execute } });
    const handlers = createImageHandlers(deps);

    await expect(
      handlers["image.generate"]!({
        _agentId: "agent-1",
        prompt: "edit this",
        reference_image: `data:image/png;base64,${oversized}`,
      }),
    ).rejects.toThrow(/exceeds the size limit/);
    expect(execute).not.toHaveBeenCalled();
  });

  // ─── WR-02: workspace-file read is size-capped ─────────────────────────────

  it("WR-02: an oversized workspace-file reference_image is rejected before threading to execute()", async () => {
    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Buffer.alloc(21 * 1024 * 1024, 1),
    );
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openrouter", isAvailable: () => true, execute },
      workspaceDirs: new Map([["agent-1", "/ws/agent-1"]]),
    });
    const handlers = createImageHandlers(deps);

    await expect(
      handlers["image.generate"]!({
        _agentId: "agent-1",
        prompt: "edit this",
        reference_image: "big.png",
      }),
    ).rejects.toThrow(/exceeds the size limit/);
    expect(execute).not.toHaveBeenCalled();
  });

  // ─── WR-03: charset-parameterized data-URIs accepted; non-base64 not decoded ─

  it("WR-03: a charset-parameterized base64 data-URI is accepted (mime stripped of params)", async () => {
    const payload = Buffer.from("PNGBYTES").toString("base64");
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({ provider: { id: "openrouter", isAvailable: () => true, execute } });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "edit this",
      // A parameterized media type before ;base64 must still match + decode.
      reference_image: `data:image/png;charset=utf-8;base64,${payload}`,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        // mime is the bare media type (params stripped), payload base64-decoded.
        referenceImage: expect.objectContaining({ data: payload, mimeType: "image/png" }),
      }),
    );
  });

  it("WR-03: a non-base64 (URL-encoded) data-URI is NOT base64-decoded into garbage", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({ provider: { id: "openrouter", isAvailable: () => true, execute } });
    const handlers = createImageHandlers(deps);

    // RFC 2397: no `;base64` token → the payload is URL-encoded text, NOT base64.
    // The handler must URL-decode it (not mis-decode it as base64 garbage).
    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "edit this",
      reference_image: "data:text/plain,Hello%20World",
    });

    const arg = execute.mock.calls[0]![0] as { referenceImage?: { data: string; mimeType: string } };
    // The decoded bytes must equal the URL-decoded "Hello World", NOT
    // Buffer.from("Hello%20World","base64") garbage.
    expect(arg.referenceImage?.data).toBe(Buffer.from("Hello World", "utf-8").toString("base64"));
    expect(arg.referenceImage?.mimeType).toBe("text/plain");
  });
});

describe("createImageHandlers IN-02 model validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (validateUrl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true,
      value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("https://example.com/ref.png") },
    }));
  });

  it("Test 6: an unknown model for the resolved provider is rejected with a hint LISTING valid models (no execute)", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openai", isAvailable: () => true, execute },
      resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "openai" }),
    });
    const handlers = createImageHandlers(deps);

    const result = (await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a fox",
      model: "bogus-model",
    })) as { success: boolean; error?: string; hint?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("bogus-model");
    // The hint LISTS the valid openai models (IN-02 actionable reject).
    expect(result.hint).toContain("gpt-image-1");
    expect(execute).not.toHaveBeenCalled();
  });

  it("Test 7: a valid model for the resolved provider is accepted and threaded to execute()", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openai", isAvailable: () => true, execute },
      resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "openai" }),
    });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a fox",
      model: "gpt-image-1",
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-image-1" }));
  });

  it("Test 8 (CFG-02): a provider with an EMPTY Comis-side list does NOT reject every model (validate strictly only when listed)", async () => {
    // openrouter has no Comis-side IMAGE_MODELS_BY_PROVIDER entry; a model arg
    // must NOT be rejected (else every openrouter model is 'unknown'). The arg
    // still flows through to execute (the provider/openrouter catalog decides).
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "openrouter", isAvailable: () => true, execute },
      resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "openrouter" }),
    });
    const handlers = createImageHandlers(deps);

    const result = (await handlers["image.generate"]!({
      _agentId: "agent-1",
      prompt: "a fox",
      model: "black-forest-labs/flux.2-pro",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ model: "black-forest-labs/flux.2-pro" }),
    );
  });

  // ─── WR-05: validate against the provider that ACTUALLY executes ───────────
  // In a multi-agent daemon the boot-selected port (deps.provider) belongs to
  // the DEFAULT agent; a non-default caller may resolve a DIFFERENT main
  // provider. The model must be validated against the EXECUTING provider (the
  // port that will run it), not the caller's — else a model valid for the
  // caller passes Comis-side validation then fails late at the executing SDK.

  it("WR-05: rejects a model valid for the CALLER but invalid for the EXECUTING (default) provider", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      // Boot-selected port = the DEFAULT agent's (google).
      provider: { id: "google", isAvailable: () => true, execute },
      // The CALLER resolves to openai (gpt-image-1 is valid for openai).
      resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "openai" }),
    });
    const handlers = createImageHandlers(deps);

    const result = (await handlers["image.generate"]!({
      _agentId: "agent-openai",
      prompt: "a fox",
      model: "gpt-image-1", // valid for openai, NOT for the executing google port
    })) as { success: boolean; error?: string; hint?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("gpt-image-1");
    // The reject names the EXECUTING provider + lists ITS models (reality).
    expect(result.error).toContain("google");
    expect(result.hint).toContain("gemini-2.5-flash-image");
    expect(execute).not.toHaveBeenCalled();
  });

  it("WR-05: accepts a model valid for the EXECUTING (default) provider even when the caller differs", async () => {
    const execute = vi.fn().mockResolvedValue(ok({ buffer: Buffer.from("x"), mimeType: "image/png" }));
    const deps = createMockDeps({
      provider: { id: "google", isAvailable: () => true, execute },
      resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "openai" }),
    });
    const handlers = createImageHandlers(deps);

    await handlers["image.generate"]!({
      _agentId: "agent-openai",
      prompt: "a fox",
      model: "gemini-2.5-flash-image", // valid for the executing google port
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-2.5-flash-image" }));
  });
});
