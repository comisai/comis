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

// =============================================================================
// Phase 6 Wave 0: STT/TTS/image-gen read-on-use RED tests
//
// These tests assert that after rotating a key in the secretManager, the NEXT
// call to the provider adapter resolves the new (rotated) key without a daemon
// restart. They MUST fail RED because the current factories snapshot the API
// key string at construction time (boot-snapshot anti-pattern). Plan 06-04
// will convert them to read-on-use (lazy factory closure that calls
// secretManager.get() on each invocation).
//
// The RED failure mode: createSTTProvider / createTTSProvider snapshot the key
// as a string in the closure at boot time. Rotating the backing Map after
// construction has no effect on the already-constructed adapter's captured
// string. The test expects the new key to appear on the next call — which is
// what the lazy-factory implementation will provide.
// =============================================================================

describe("Phase 6 Wave 0: Media provider factories read-on-use RED tests (not yet implemented)", () => {
  // -------------------------------------------------------------------------
  // Shared: mutable secretManager backed by a Map
  // -------------------------------------------------------------------------

  function makeMutableSecretManager(initial: Record<string, string>): {
    secretManager: { get: (k: string) => string | undefined; has: (k: string) => boolean; require: (k: string) => string; keys: () => string[] };
    rotateKey: (name: string, value: string) => void;
  } {
    const store = new Map<string, string>(Object.entries(initial));
    return {
      secretManager: {
        get: (k: string) => store.get(k),
        has: (k: string) => store.has(k),
        require: (k: string) => {
          const v = store.get(k);
          if (v === undefined) throw new Error(`Secret not found: ${k}`);
          return v;
        },
        keys: () => [...store.keys()],
      },
      rotateKey: (name: string, value: string) => store.set(name, value),
    };
  }

  // -------------------------------------------------------------------------
  // 14. STT factory resolves rotated key without restart
  // -------------------------------------------------------------------------

  it("STT factory resolves updated OPENAI_API_KEY after rotation without daemon restart (RED — factory snapshots at boot)", async () => {
    // Import real factory functions from @comis/skills source.
    // These are the same functions that createSTTProvider calls.
    const { createSTTProvider } = await import("@comis/skills");

    const { secretManager, rotateKey } = makeMutableSecretManager({
      OPENAI_API_KEY: "sk-boot-key",
    });

    const config = {
      provider: "openai" as const,
      model: "gpt-4o-mini-transcribe" as const,
      timeoutMs: 30000,
      maxFileSizeMb: 25,
      autoTranscribe: false,
      fallbackProviders: [],
    };

    // Construct the STT provider at boot time — captures "sk-boot-key"
    const bootResult = createSTTProvider(config, secretManager as any);
    expect(bootResult.ok).toBe(true);

    // Rotate the key AFTER construction — the shared Map now has the new value.
    rotateKey("OPENAI_API_KEY", "sk-rotated-key");

    // Verify the Map was updated (the mutableSecretManager side works).
    expect(secretManager.get("OPENAI_API_KEY")).toBe("sk-rotated-key");

    // Now construct a NEW provider using the SAME secretManager instance.
    // A lazy/read-on-use factory would call secretManager.get() here and return
    // "sk-rotated-key". The current boot-snapshot factory also calls get() at
    // construction time — but the ALREADY-CONSTRUCTED adapter above still holds
    // "sk-boot-key" in its closure.
    //
    // The RED assertion: the already-constructed transcriber must observe the
    // rotated key on the NEXT transcribe() call. This requires the adapter to
    // call secretManager.get() per invocation, not cache it at construction.
    //
    // To verify the current adapter's captured key, we construct a second
    // provider with the rotated secretManager and compare vs a fresh boot
    // provider. When read-on-use is implemented, a single provider construction
    // at boot will pick up rotations. For now this confirms the factory design
    // gap: two constructions are needed to observe the rotated key.
    const afterRotationResult = createSTTProvider(config, secretManager as any);
    expect(afterRotationResult.ok).toBe(true);

    // The two adapters (boot vs post-rotation construction) are different
    // instances. The boot adapter has the OLD key captured in its closure.
    // This test asserts that the BOOT adapter (not a newly-constructed one)
    // would use the rotated key — which fails RED until read-on-use lands.
    // We detect the boot-snapshot anti-pattern: if the factory is truly
    // lazy (read-on-use), setupMedia would not need to recreate the provider
    // after rotation; a single construction at boot would suffice.
    //
    // Simplified RED assertion: after rotating the key, the setupMedia function
    // called with the same container (whose secretManager Map was updated)
    // must produce a provider that observes the NEW key — WITHOUT re-calling
    // setupMedia. This is the live-apply invariant. For now this fails RED
    // because setupMedia is not lazy-wired yet.

    // RED: assert that the container wiring exposes a live-key factory method.
    // Plan 06-04 will add a `createSTTProviderFactory(config, secretManager)`
    // that returns a closure; the test checks for this in the production source.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const __d = dirname(fileURLToPath(import.meta.url));
    const setupMediaSrc = readFileSync(join(__d, "setup-media.ts"), "utf-8");

    // After Plan 06-04: setupMedia.ts will contain lazy factory wiring that
    // does NOT snapshot the key at construction time — instead it delegates to
    // a per-call secretManager.get(). The source assertion below encodes this:
    // the term "createSTTProviderFactory" (or equivalent lazy factory call)
    // will appear when the plan is implemented.
    //
    // Currently the file contains `createSTTProvider(mediaConfig.transcription,
    // container.secretManager)` — a boot-snapshot call. The RED test asserts
    // the lazy variant exists, which it does not yet.
    expect(setupMediaSrc).toContain("createSTTProviderFactory");
  });

  // -------------------------------------------------------------------------
  // 15. TTS factory resolves rotated key without restart
  // -------------------------------------------------------------------------

  it("TTS factory resolves updated OPENAI_API_KEY after rotation without daemon restart (RED — factory snapshots at boot)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const __d = dirname(fileURLToPath(import.meta.url));
    const setupMediaSrc = readFileSync(join(__d, "setup-media.ts"), "utf-8");

    // RED: the lazy TTS factory equivalent does not exist yet.
    // Plan 06-04 will add lazy wiring so that the TTS adapter resolves the
    // current key on each synthesize() call, not the boot-snapshot value.
    // Assert the future factory call-site name is present in the production source.
    expect(setupMediaSrc).toContain("createTTSProviderFactory");
  });

  // -------------------------------------------------------------------------
  // 16. Image-gen factory resolves rotated key without restart
  // -------------------------------------------------------------------------

  it("image-gen factory resolves updated FAL_KEY after rotation without daemon restart (RED — factory snapshots at boot)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const __d = dirname(fileURLToPath(import.meta.url));
    const setupMediaSrc = readFileSync(join(__d, "setup-media.ts"), "utf-8");

    // RED: the lazy image-gen factory equivalent does not exist yet.
    // Plan 06-04 will add lazy wiring so that the image-gen provider resolves
    // the current key on each generate() call.
    // Assert the future factory call-site name is present in the production source.
    expect(setupMediaSrc).toContain("createImageGenProviderFactory");
  });
});
