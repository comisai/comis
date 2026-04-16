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

    expect(mockCreateSsrfGuardedFetcher).toHaveBeenCalledWith(
      { maxBytes: 25_000_000 },
      expect.anything(),
    );
  });

  // -------------------------------------------------------------------------
  // 6. Creates STT provider and fallback chain
  // -------------------------------------------------------------------------

  it("creates STT provider and fallback chain when fallbackProviders configured", async () => {
    const fbProvider = { transcribe: vi.fn(), name: "groq-stt" };
    mockCreateSTTProvider
      .mockReturnValueOnce({ ok: true, value: { transcribe: vi.fn(), name: "openai-stt" } })
      .mockReturnValueOnce({ ok: true, value: fbProvider });

    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig({
        transcription: { fallbackProviders: ["groq"] },
      }),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockCreateFallbackTranscription).toHaveBeenCalled();
    expect(result.transcriber).toBeDefined();
  });

  it("creates STT provider without fallback when no fallbackProviders", async () => {
    const setupMedia = await getSetupMedia();

    const result = await setupMedia({
      container: createMinimalMediaConfig({
        transcription: { fallbackProviders: [] },
      }),
      skillsLogger: createMockLogger() as any,
    });

    expect(mockCreateFallbackTranscription).not.toHaveBeenCalled();
    expect(result.transcriber).toBeDefined();
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
  });
});
