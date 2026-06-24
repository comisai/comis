// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockDetectFfmpeg = vi.hoisted(() => vi.fn(async () => ({
  ffmpegAvailable: true,
  ffmpegVersion: "6.0",
  ffprobeAvailable: true,
  ffprobeVersion: "6.0",
})));
const mockCreateMediaTempManager = vi.hoisted(() => vi.fn(() => ({
  init: vi.fn(async () => ({ ok: true })),
  startCleanupInterval: vi.fn(),
  stopCleanupInterval: vi.fn(),
  getManagedDir: vi.fn(() => "/tmp/comis-media"),
})));
const mockCreateMediaSemaphore = vi.hoisted(() => vi.fn(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
})));
const mockCreateAudioConverter = vi.hoisted(() => vi.fn(() => ({
  convert: vi.fn(),
})));
const mockCreateSsrfGuardedFetcher = vi.hoisted(() => vi.fn(() => ({
  fetch: vi.fn(),
})));
const mockCreateSTTProvider = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  value: { transcribe: vi.fn(), name: "openai-stt" },
})));
const mockCreateFallbackTranscription = vi.hoisted(() => vi.fn(() => ({
  transcribe: vi.fn(),
  name: "fallback-stt",
})));
const mockCreateTTSProvider = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  value: { synthesize: vi.fn(), name: "openai-tts" },
})));
const mockCreateVisionProviderRegistry = vi.hoisted(() => vi.fn(() => new Map()));
const mockSelectVisionProvider = vi.hoisted(() => vi.fn(() => undefined));
const mockCreateLinkRunner = vi.hoisted(() => vi.fn(() => ({
  processMessage: vi.fn(async () => ({ enrichedText: "", linksProcessed: 0, errors: [] })),
})));
const mockCreateFileExtractor = vi.hoisted(() => vi.fn(() => ({
  extract: vi.fn(),
  supportedMimes: ["text/plain"],
})));
const mockCreatePdfExtractor = vi.hoisted(() => vi.fn(() => ({
  extract: vi.fn(),
  supportedMimes: ["application/pdf"],
})));
const mockCreateCompositeFileExtractor = vi.hoisted(() => vi.fn(() => ({
  extract: vi.fn(),
  supportedMimes: ["text/plain", "application/pdf"],
})));
const mockCreatePdfPageRenderer = vi.hoisted(() => vi.fn(() => ({
  render: vi.fn(),
})));

vi.mock("@comis/skills", () => ({
  detectFfmpeg: mockDetectFfmpeg,
  createMediaTempManager: mockCreateMediaTempManager,
  createMediaSemaphore: mockCreateMediaSemaphore,
  createAudioConverter: mockCreateAudioConverter,
  createSsrfGuardedFetcher: mockCreateSsrfGuardedFetcher,
  createSTTProvider: mockCreateSTTProvider,
  createFallbackTranscription: mockCreateFallbackTranscription,
  createTTSProvider: mockCreateTTSProvider,
  createVisionProviderRegistry: mockCreateVisionProviderRegistry,
  selectVisionProvider: mockSelectVisionProvider,
  createLinkRunner: mockCreateLinkRunner,
  createFileExtractor: mockCreateFileExtractor,
  createPdfExtractor: mockCreatePdfExtractor,
  createCompositeFileExtractor: mockCreateCompositeFileExtractor,
  createPdfPageRenderer: mockCreatePdfPageRenderer,
}));

// ---------------------------------------------------------------------------
// Helpers
function createMinimalMediaConfig(overrides: Record<string, any> = {}) {
  return {
    config: {
      integrations: {
        media: {
          tts: { provider: "openai", voice: "alloy", maxTextLength: 4096 },
          transcription: {
            provider: "openai",
            autoTranscribe: false,
            fallbackProviders: [],
            ...overrides.transcription,
          },
          vision: { enabled: false, videoTimeoutMs: 30000, videoMaxDescriptionChars: 500, ...overrides.vision },
          linkUnderstanding: { enabled: true, ...overrides.linkUnderstanding },
          documentExtraction: {
            enabled: false,
            pdfImageFallback: false,
            ...overrides.documentExtraction,
          },
          infrastructure: {
            tempFileTtlMs: 3600000,
            tempCleanupIntervalMs: 600000,
            concurrencyLimit: 4,
            maxRemoteFetchBytes: 50_000_000,
            ...overrides.infrastructure,
          },
          ...overrides.media,
        },
      },
    },
    secretManager: {
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
    },
    eventBus: { on: vi.fn(), emit: vi.fn() },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    mockDetectFfmpeg.mockResolvedValue({
      ffmpegAvailable: true,
      ffmpegVersion: "6.0",
      ffprobeAvailable: true,
      ffprobeVersion: "6.0",
    });
    mockCreateSTTProvider.mockReturnValue({
      ok: true,
      value: { transcribe: vi.fn(), name: "openai-stt" },
    });
    mockCreateTTSProvider.mockReturnValue({
      ok: true,
      value: { synthesize: vi.fn(), name: "openai-tts" },
    });
    mockCreateVisionProviderRegistry.mockReturnValue(new Map());
  });

  async function getSetupMedia() {
    const mod = await import("./setup-media.js");
    return mod.setupMedia;
  }

  // -------------------------------------------------------------------------
  // 1. Detects ffmpeg capabilities and logs warnings
  // -------------------------------------------------------------------------

  it("detects ffmpeg capabilities and logs per-binary warnings when missing", async () => {
    mockDetectFfmpeg.mockResolvedValue({
      ffmpegAvailable: false,
      ffmpegVersion: undefined,
      ffprobeAvailable: false,
      ffprobeVersion: undefined,
    });

    const skillsLogger = createMockLogger();
    const setupMedia = await getSetupMedia();

    await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: skillsLogger as any,
    });

    expect(mockDetectFfmpeg).toHaveBeenCalled();
    expect(skillsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      expect.stringContaining("ffmpeg not found"),
    );
    expect(skillsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      expect.stringContaining("ffprobe not found"),
    );
  });

  it("logs debug when ffmpeg and ffprobe are available", async () => {
    const skillsLogger = createMockLogger();
    const setupMedia = await getSetupMedia();

    await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: skillsLogger as any,
    });

    expect(skillsLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ version: "6.0" }),
      "ffmpeg detected",
    );
    expect(skillsLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ version: "6.0" }),
      "ffprobe detected",
    );
  });

  // -------------------------------------------------------------------------
  // 2. Creates mediaTempManager, calls init() and startCleanupInterval
  // -------------------------------------------------------------------------

  it("creates mediaTempManager, calls init() and startCleanupInterval on success", async () => {
    const setupMedia = await getSetupMedia();

    await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockCreateMediaTempManager).toHaveBeenCalled();
    const manager = mockCreateMediaTempManager.mock.results[0].value;
    expect(manager.init).toHaveBeenCalled();
    expect(manager.startCleanupInterval).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Logs warn when mediaTempManager.init() returns err
  // -------------------------------------------------------------------------

  it("logs warn when mediaTempManager.init() returns err", async () => {
    const failingManager = {
      init: vi.fn(async () => ({ ok: false, error: { message: "Permission denied" } })),
      startCleanupInterval: vi.fn(),
      stopCleanupInterval: vi.fn(),
      getManagedDir: vi.fn(),
    };
    mockCreateMediaTempManager.mockReturnValue(failingManager);

    const skillsLogger = createMockLogger();
    const setupMedia = await getSetupMedia();

    await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: skillsLogger as any,
    });

    expect(failingManager.startCleanupInterval).not.toHaveBeenCalled();
    expect(skillsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "Permission denied",
        errorKind: "resource",
      }),
      "Media temp directory initialization failed",
    );
  });

  // -------------------------------------------------------------------------
  // 4. Creates audioConverter only when ffmpeg available
  // -------------------------------------------------------------------------

  it("creates audioConverter when ffmpeg available", async () => {
    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockCreateAudioConverter).toHaveBeenCalled();
    expect(result.audioConverter).toBeDefined();
  });

  it("skips audioConverter when ffmpeg not available", async () => {
    mockDetectFfmpeg.mockResolvedValue({
      ffmpegAvailable: false,
      ffmpegVersion: undefined,
      ffprobeAvailable: false,
      ffprobeVersion: undefined,
    });

    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockCreateAudioConverter).not.toHaveBeenCalled();
    expect(result.audioConverter).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. Creates ssrfFetcher with maxRemoteFetchBytes
  // -------------------------------------------------------------------------

  it("creates ssrfFetcher with maxRemoteFetchBytes from infra config", async () => {
    const setupMedia = await getSetupMedia();

    await setupMedia({
      container: createMinimalMediaConfig({
        infrastructure: { maxRemoteFetchBytes: 25_000_000 },
      }),
      skillsLogger: createMockLogger() as any,
    });

    // objectContaining tolerates the additional trustedFetchOrigins config (MEDIA-INPUT-SSRF,
    // d3ef5be3) — this test pins only that maxBytes is threaded from the infra config.
    expect(mockCreateSsrfGuardedFetcher).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 25_000_000 }),
      expect.anything(),
    );
  });

  // -------------------------------------------------------------------------
  // 6. Creates STT provider and fallback chain
  // -------------------------------------------------------------------------

  it("creates STT provider and fallback chain when fallbackProviders configured — chain built per transcribe() call", async () => {
    // With lazy-delegation wiring, createFallbackTranscription is called
    // on each transcribe() invocation (not during setupMedia). We verify this by
    // calling transcribe() and asserting the fallback chain was built at that point.
    const primaryTranscribe = vi.fn(async () => ({ ok: true as const, value: { text: "hello", language: "en" } }));
    mockCreateSTTProvider
      .mockReturnValue({ ok: true, value: { transcribe: primaryTranscribe, name: "openai-stt" } });
    // createFallbackTranscription must delegate to the chain's transcribe()
    mockCreateFallbackTranscription.mockImplementation((providers: any[]) => ({
      transcribe: async (...args: any[]) => providers[0].transcribe(...args),
    }));

    const setupMedia = await getSetupMedia();
    const result = await setupMedia({
      container: createMinimalMediaConfig({
        transcription: { fallbackProviders: ["groq"] },
      }),
      skillsLogger: createMockLogger() as any,
    });
    expect(result.transcriber).toBeDefined();

    // createFallbackTranscription is NOT called during setupMedia with lazy wiring
    expect(mockCreateFallbackTranscription).not.toHaveBeenCalled();

    // Calling transcribe() triggers lazy factory resolution + fallback chain build
    await result.transcriber!.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });
    expect(mockCreateFallbackTranscription).toHaveBeenCalled();
  });

  it("creates STT provider without fallback when no fallbackProviders", async () => {
    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig({
        transcription: { fallbackProviders: [] },
      }),
      skillsLogger: createMockLogger() as any,
    });

    expect(result.transcriber).toBeDefined();
    // No fallback wiring (even lazily)
    await result.transcriber!.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });
    expect(mockCreateFallbackTranscription).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Logs warn when STT provider returns err
  // -------------------------------------------------------------------------

  it("logs warn when createSTTProvider returns err", async () => {
    mockCreateSTTProvider.mockReturnValue({
      ok: false,
      error: { message: "No API key" },
    });

    const skillsLogger = createMockLogger();
    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: skillsLogger as any,
    });

    expect(result.transcriber).toBeUndefined();
    expect(skillsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "No API key",
        errorKind: "config",
      }),
      "STT service not configured",
    );
  });

  // -------------------------------------------------------------------------
  // 8. Creates TTS adapter when provider returns ok, skips on err
  // -------------------------------------------------------------------------

  it("creates TTS adapter when createTTSProvider returns ok", async () => {
    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockCreateTTSProvider).toHaveBeenCalled();
    expect(result.ttsAdapter).toBeDefined();
  });

  it("skips TTS adapter when createTTSProvider returns err", async () => {
    mockCreateTTSProvider.mockReturnValue({
      ok: false,
      error: { message: "No TTS key" },
    });

    const skillsLogger = createMockLogger();
    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: skillsLogger as any,
    });

    expect(result.ttsAdapter).toBeUndefined();
    expect(skillsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "No TTS key",
        errorKind: "config",
      }),
      "TTS service not configured",
    );
  });

  // -------------------------------------------------------------------------
  // 9. Creates vision registry when providers have API keys
  // -------------------------------------------------------------------------

  it("creates vision registry when providers have API keys (registry.size > 0)", async () => {
    const registry = new Map([["openai", { id: "openai", describe: vi.fn() }]]);
    mockCreateVisionProviderRegistry.mockReturnValue(registry);

    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    expect(result.visionRegistry).toBe(registry);
  });

  it("skips vision registry when no providers configured", async () => {
    mockCreateVisionProviderRegistry.mockReturnValue(new Map());

    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    expect(result.visionRegistry).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9b. visionRegistryHolder materialises on first secret:changed rotation
  // -------------------------------------------------------------------------

  it("visionRegistryHolder.value is updated when registry materialises from undefined at first rotation", async () => {
    // Scenario: no vision providers at boot (visionRegistry = undefined).
    // After a credential rotation, visionRegistryHolder.value must reflect the
    // newly-materialised registry — even though the BootContext visionRegistry
    // field holds the original undefined snapshot.
    mockCreateVisionProviderRegistry.mockReturnValue(new Map()); // boot: empty → undefined

    let secretChangedListener: ((ev: { name: string; action?: string }) => void) | undefined;
    const fakeEventBus = {
      on: vi.fn((event: string, fn: (payload: any) => void) => {
        if (event === "secret:changed") secretChangedListener = fn;
      }),
      emit: vi.fn(),
    };
    const container = {
      ...createMinimalMediaConfig(),
      eventBus: fakeEventBus,
    } as any;

    const setupMedia = await getSetupMedia();
    const result = await setupMedia({ container, skillsLogger: createMockLogger() as any });

    // Boot state: no registry (no vision API keys at boot)
    expect(result.visionRegistry).toBeUndefined();
    expect(result.visionRegistryHolder.value).toBeUndefined();

    // Simulate rotation: now OPENAI_API_KEY is present — registry materialises
    const rotatedRegistry = new Map([["openai", { id: "openai", describe: vi.fn() }]]);
    mockCreateVisionProviderRegistry.mockReturnValue(rotatedRegistry);

    expect(secretChangedListener).toBeDefined();
    secretChangedListener!({ name: "OPENAI_API_KEY" });

    // The holder must be updated — consumers holding visionRegistryHolder
    // see the new registry on their next access without re-reading the boot snapshot.
    expect(result.visionRegistryHolder.value).toBe(rotatedRegistry);

    // The point-in-time snapshot (result.visionRegistry) is still undefined —
    // the holder is the authoritative live reference after first materialisation.
    expect(result.visionRegistry).toBeUndefined();
  });

  it("visionRegistryHolder.value is set at boot when registry is non-empty", async () => {
    const bootRegistry = new Map([["openai", { id: "openai", describe: vi.fn() }]]);
    mockCreateVisionProviderRegistry.mockReturnValue(bootRegistry);

    const setupMedia = await getSetupMedia();
    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    // Both the snapshot and the holder point at the same registry at boot
    expect(result.visionRegistry).toBe(bootRegistry);
    expect(result.visionRegistryHolder.value).toBe(bootRegistry);
  });

  // -------------------------------------------------------------------------
  // 10. Creates linkRunner with config and onSuspiciousContent callback
  // -------------------------------------------------------------------------

  it("creates linkRunner with config and onSuspiciousContent callback", async () => {
    const onSuspicious = vi.fn();
    const setupMedia = await getSetupMedia();

    await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
      onSuspiciousContent: onSuspicious,
    });

    expect(mockCreateLinkRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        onSuspiciousContent: onSuspicious,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 11. Creates composite file extractor with text + PDF extractors
  // -------------------------------------------------------------------------

  it("creates composite file extractor with text + PDF extractors", async () => {
    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockCreateFileExtractor).toHaveBeenCalled();
    expect(mockCreatePdfExtractor).toHaveBeenCalled();
    expect(mockCreateCompositeFileExtractor).toHaveBeenCalled();
    expect(result.fileExtractor).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 12. Wires PDF vision fallback when pdfImageFallback and vision available
  // -------------------------------------------------------------------------

  it("wires PDF vision fallback when pdfImageFallback is true and vision provider available", async () => {
    const visionProvider = { id: "openai", describe: vi.fn() };
    const registry = new Map([["openai", visionProvider]]);
    mockCreateVisionProviderRegistry.mockReturnValue(registry);
    mockSelectVisionProvider.mockReturnValue(visionProvider);

    const setupMedia = await getSetupMedia();

    await setupMedia({
      container: createMinimalMediaConfig({
        documentExtraction: { pdfImageFallback: true },
      }),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockSelectVisionProvider).toHaveBeenCalledWith(registry, "image");
    expect(mockCreatePdfPageRenderer).toHaveBeenCalled();
    expect(mockCreatePdfExtractor).toHaveBeenCalledWith(
      expect.objectContaining({
        visionProvider,
        pdfPageRenderer: expect.anything(),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 13. Returns all result fields
  // -------------------------------------------------------------------------

  it("returns all expected result fields", async () => {
    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });

    expect(result).toHaveProperty("ffmpegCapabilities");
    expect(result).toHaveProperty("mediaTempManager");
    expect(result).toHaveProperty("mediaSemaphore");
    expect(result).toHaveProperty("ssrfFetcher");
    expect(result).toHaveProperty("linkRunner");
    expect(result).toHaveProperty("fileExtractor");
    // Stable holder returned alongside the boot snapshot
    expect(result).toHaveProperty("visionRegistryHolder");
    expect(result.visionRegistryHolder).toHaveProperty("value");
  });
});

// =============================================================================
// STT/TTS read-on-use behavioral tests
//
// These tests verify that the transcriber and ttsAdapter returned by setupMedia
// are lazy-delegation wrappers: each transcribe()/synthesize() call re-invokes
// the underlying factory (createSTTProvider / createTTSProvider) with the
// current secretManager state. This means a rotated API key is observed on the
// LIVE path without a daemon restart.
//
// The key behavioral invariant: createSTTProvider / createTTSProvider are
// called DURING transcribe()/synthesize(), not only during setupMedia(). After
// clearing mocks post-setup, a subsequent transcribe()/synthesize() call must
// invoke the factory again — confirming read-on-use, not boot-snapshot.
// =============================================================================

describe("STT/TTS lazy-delegation — rotated key observed per call without restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectFfmpeg.mockResolvedValue({
      ffmpegAvailable: true, ffmpegVersion: "6.0",
      ffprobeAvailable: true, ffprobeVersion: "6.0",
    });
    mockCreateVisionProviderRegistry.mockReturnValue(new Map());
  });

  async function getSetupMedia() {
    const mod = await import("./setup-media.js");
    return mod.setupMedia;
  }

  // -------------------------------------------------------------------------
  // 14. STT re-invokes factory on each transcribe() call (read-on-use)
  // -------------------------------------------------------------------------

  it("STT transcribe() re-invokes createSTTProvider on each call — rotated key is observed without restart", async () => {
    // The mock adapter returned by createSTTProvider needs transcribe() so the
    // lazy wrapper can delegate to it.
    const innerTranscribe = vi.fn(async () => ({
      ok: true as const,
      value: { text: "hello", language: "en" },
    }));
    mockCreateSTTProvider.mockReturnValue({
      ok: true,
      value: { transcribe: innerTranscribe, name: "openai-stt" },
    });

    const setupMedia = await getSetupMedia();
    const result = await setupMedia({
      container: createMinimalMediaConfig({ transcription: { fallbackProviders: [] } }),
      skillsLogger: createMockLogger() as any,
    });
    expect(result.transcriber).toBeDefined();

    // Clear the call counts recorded during setupMedia.
    // With boot-snapshot: createSTTProvider was called once in setupMedia and
    //   never again → after clearing, the count stays 0 on the next transcribe().
    // With lazy-delegation: createSTTProvider is called on each
    //   transcribe() → after clearing, the count is 1 after one transcribe().
    vi.clearAllMocks();

    await result.transcriber!.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    // The factory must have been re-invoked during transcribe() — not just at boot.
    expect(mockCreateSTTProvider).toHaveBeenCalledOnce();
    // And the inner transcribe delegate was called (the delegation chain works).
    expect(innerTranscribe).toHaveBeenCalledOnce();
  });

  it("STT transcribe() re-invokes factory on every call — second call observes second invocation", async () => {
    const innerTranscribe = vi.fn(async () => ({
      ok: true as const,
      value: { text: "hello", language: "en" },
    }));
    mockCreateSTTProvider.mockReturnValue({
      ok: true,
      value: { transcribe: innerTranscribe, name: "openai-stt" },
    });

    const setupMedia = await getSetupMedia();
    const result = await setupMedia({
      container: createMinimalMediaConfig({ transcription: { fallbackProviders: [] } }),
      skillsLogger: createMockLogger() as any,
    });
    vi.clearAllMocks();

    await result.transcriber!.transcribe(Buffer.from("a1"), { mimeType: "audio/ogg" });
    await result.transcriber!.transcribe(Buffer.from("a2"), { mimeType: "audio/ogg" });

    // Two transcribe() calls → two factory invocations (the key is read fresh each time).
    expect(mockCreateSTTProvider).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 15. TTS re-invokes factory on each synthesize() call (read-on-use)
  // -------------------------------------------------------------------------

  it("TTS synthesize() re-invokes createTTSProvider on each call — rotated key is observed without restart", async () => {
    const innerSynthesize = vi.fn(async () => ({
      ok: true as const,
      value: { audio: Buffer.from("mp3"), mimeType: "audio/mpeg" },
    }));
    mockCreateTTSProvider.mockReturnValue({
      ok: true,
      value: { synthesize: innerSynthesize, name: "openai-tts" },
    });

    const setupMedia = await getSetupMedia();
    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });
    expect(result.ttsAdapter).toBeDefined();

    vi.clearAllMocks();

    await result.ttsAdapter!.synthesize("hello", { voice: "alloy" });

    // Factory must have been re-invoked during synthesize() — read-on-use confirmed.
    expect(mockCreateTTSProvider).toHaveBeenCalledOnce();
    expect(innerSynthesize).toHaveBeenCalledOnce();
  });

  it("TTS synthesize() re-invokes factory on every call — second call observes second invocation", async () => {
    const innerSynthesize = vi.fn(async () => ({
      ok: true as const,
      value: { audio: Buffer.from("mp3"), mimeType: "audio/mpeg" },
    }));
    mockCreateTTSProvider.mockReturnValue({
      ok: true,
      value: { synthesize: innerSynthesize, name: "openai-tts" },
    });

    const setupMedia = await getSetupMedia();
    const result = await setupMedia({
      container: createMinimalMediaConfig(),
      skillsLogger: createMockLogger() as any,
    });
    vi.clearAllMocks();

    await result.ttsAdapter!.synthesize("hello", {});
    await result.ttsAdapter!.synthesize("world", {});

    expect(mockCreateTTSProvider).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 16. image-gen lazy factory still exported (symbol-export sanity)
  // -------------------------------------------------------------------------

  it("createImageGenProviderFactory is exported from setup-media for callers that need on-demand image-gen", async () => {
    const mod = await import("./setup-media.js");
    // The factory is exported so callers can build on-demand image-gen providers
    // without snapshotting the key at construction time.
    expect(typeof mod.createImageGenProviderFactory).toBe("function");
    expect(typeof mod.createImageGenGetter).toBe("function");
  });
});

// =============================================================================
// WR-01 / WR-02 (Phase 193 code-review): the construction seam MUST build from
// the resolver's CHOSEN provider, not the raw config.
//
// The documented CRED-01 follow-main path is: STT config provider:"auto",
// default agent main = openai, OPENAI_API_KEY present, localEngineAvailable()
// === false. resolveStt() then returns {ok:true, provider:"openai",
// source:"follow-main-key"} — but pre-fix setup-media passed the RAW config
// (provider:"auto") to createSTTProvider, which hits the factory's `default`
// branch → err("Unknown STT provider: auto") → transcriber stays undefined and
// the operator sees a misleading "not configured" WARN. No prior test exercised
// the construct seam AFTER a follow-main resolution (daemon.test.ts mocks
// setupMedia; the boot-gate overrides it).
//
// To faithfully reproduce the bug, the createSTTProvider / createTTSProvider
// mocks below mirror the REAL skills factory (stt-factory.ts:35-67,
// tts-factory.ts): keyed providers → {ok}, anything else (including "auto")
// → err("Unknown … provider: <provider>"). With that mock, a config carrying
// provider:"auto" yields an undefined transcriber (RED); only threading the
// resolved provider:"openai" into construction flips it green.
// =============================================================================

describe("setupMedia — construction follows the resolver's chosen provider (WR-01/WR-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectFfmpeg.mockResolvedValue({
      ffmpegAvailable: true, ffmpegVersion: "6.0",
      ffprobeAvailable: true, ffprobeVersion: "6.0",
    });
    mockCreateVisionProviderRegistry.mockReturnValue(new Map());
    // Mirror the real factory: only keyed providers construct; "auto" (and any
    // other unknown) returns the "Unknown … provider" err the default branch
    // produces.
    mockCreateSTTProvider.mockImplementation((config: any) => {
      if (config.provider === "openai" || config.provider === "groq" || config.provider === "deepgram") {
        return { ok: true, value: { transcribe: vi.fn(), name: `${config.provider}-stt` } };
      }
      return { ok: false, error: { message: `Unknown STT provider: ${config.provider}` } };
    });
    mockCreateTTSProvider.mockImplementation((config: any) => {
      if (config.provider === "openai" || config.provider === "elevenlabs") {
        return { ok: true, value: { synthesize: vi.fn(), name: `${config.provider}-tts` } };
      }
      return { ok: false, error: { message: `Unknown TTS provider: ${config.provider}` } };
    });
  });

  async function getSetupMedia() {
    const mod = await import("./setup-media.js");
    return mod.setupMedia;
  }

  /** A selector stub whose resolveStt/resolveTts return the supplied selections. */
  function fakeSelector(stt: any, tts: any) {
    return { resolveStt: () => stt, resolveTts: () => tts } as any;
  }

  it("constructs the STT transcriber from the resolved provider after a follow-main resolution (config 'auto' → resolved 'openai')", async () => {
    const setupMedia = await getSetupMedia();
    const result = await setupMedia({
      // STT config is the documented default: provider "auto".
      container: createMinimalMediaConfig({ transcription: { provider: "auto", fallbackProviders: [] } }),
      skillsLogger: createMockLogger() as any,
      // The resolver followed the main provider's key → openai is usable.
      audioSelector: fakeSelector(
        { ok: true, provider: "openai", keyless: false, source: "follow-main-key" },
        { ok: true, provider: "edge", keyless: true, source: "keyless-local" },
      ),
    });

    // The bug: pre-fix, construction passed provider:"auto" → factory default
    // branch → err → transcriber undefined. The transcriber MUST be built for
    // the resolved openai provider.
    expect(result.transcriber).toBeDefined();
    // createSTTProvider must have been called with the RESOLVED provider, not "auto".
    // Plan 02: a third arg — the scoped dataDir — is threaded through.
    expect(mockCreateSTTProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
      expect.anything(),
      expect.any(String),
    );
    // It must NEVER be called with the raw "auto" once a selector approved openai.
    expect(mockCreateSTTProvider).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "auto" }),
      expect.anything(),
      expect.any(String),
    );
  });

  it("threads the resolved STT model from the selection into construction (WR-02)", async () => {
    const setupMedia = await getSetupMedia();
    await setupMedia({
      container: createMinimalMediaConfig({ transcription: { provider: "auto", model: "config-default", fallbackProviders: [] } }),
      skillsLogger: createMockLogger() as any,
      audioSelector: fakeSelector(
        { ok: true, provider: "openai", keyless: false, model: "whisper-resolved", source: "follow-main-key" },
        { ok: true, provider: "edge", keyless: true, source: "keyless-local" },
      ),
    });

    // The selection's model must reach the adapter config, not the raw config model.
    expect(mockCreateSTTProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "whisper-resolved" }),
      expect.anything(),
      expect.any(String),
    );
  });

  it("constructs the TTS adapter from the resolved provider when edge is disabled and follow-main wins (config 'auto' → resolved 'openai')", async () => {
    const setupMedia = await getSetupMedia();
    const result = await setupMedia({
      container: createMinimalMediaConfig({ media: { tts: { provider: "auto", voice: "alloy", maxTextLength: 4096 } } }),
      skillsLogger: createMockLogger() as any,
      audioSelector: fakeSelector(
        { ok: true, provider: "openai", keyless: false, source: "follow-main-key" },
        // An operator disabled edge; the resolver fell through to follow-main openai.
        { ok: true, provider: "openai", keyless: false, source: "follow-main-key" },
      ),
    });

    expect(result.ttsAdapter).toBeDefined();
    // createTTSProvider must be called with the RESOLVED provider, not "auto".
    // TTS-02: a third arg — the scoped dataDir — is threaded through (mirrors STT).
    expect(mockCreateTTSProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
      expect.anything(),
      expect.any(String),
    );
    expect(mockCreateTTSProvider).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "auto" }),
      expect.anything(),
      expect.any(String),
    );
  });

  it("preserves pre-193 behavior: with NO selector, construction uses the raw config provider unchanged", async () => {
    const setupMedia = await getSetupMedia();
    await setupMedia({
      // No audioSelector → pre-193 callers (test harnesses) construct from config.
      container: createMinimalMediaConfig({ transcription: { provider: "openai", fallbackProviders: [] } }),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockCreateSTTProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
      expect.anything(),
      expect.any(String),
    );
  });

  // Plan 02 (LOCAL-01): the scoped container.config.dataDir is threaded into every
  // createSTTProvider call site so the in-process `local` adapter writes its model
  // cache to <dataDir>/models/whisper/. process.env is NOT used.
  it("threads the scoped container.config.dataDir into the local STT provider construction", async () => {
    const setupMedia = await getSetupMedia();
    const container = createMinimalMediaConfig({
      transcription: { provider: "local", fallbackProviders: [] },
    });
    // The in-process local adapter must cache under THIS dataDir.
    container.config.dataDir = "/var/lib/comis-test";
    // Mirror the real factory: the local provider constructs successfully.
    mockCreateSTTProvider.mockReturnValue({
      ok: true,
      value: { transcribe: vi.fn(), name: "local-stt" },
    });

    await setupMedia({
      container,
      skillsLogger: createMockLogger() as any,
      audioSelector: fakeSelector(
        { ok: true, provider: "local", keyless: true, source: "keyless-local" },
        { ok: true, provider: "edge", keyless: true, source: "keyless-local" },
      ),
    });

    // The resolved 'local' provider AND the scoped dataDir reach the factory.
    expect(mockCreateSTTProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "local" }),
      expect.anything(),
      "/var/lib/comis-test",
    );
  });
});
