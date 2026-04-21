// SPDX-License-Identifier: Apache-2.0
/**
 * Media services setup: ffmpeg detection, temp directory, concurrency
 * semaphore, audio converter, TTS provider, vision provider registry,
 * and link understanding runner.
 * Extracted from daemon.ts steps 6.6.8 through 6.6.8.2 to isolate media
 * service initialization from the main wiring sequence.
 * @module
 */

import type { AppContainer, TTSPort, TranscriptionPort, VisionProvider, FileExtractionPort, WrapExternalContentOptions } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import {
  createTTSProvider,
  createSTTProvider,
  createFallbackTranscription,
  createVisionProviderRegistry,
  selectVisionProvider,
  createLinkRunner,
  type LinkRunner,
  detectFfmpeg,
  type FfmpegCapabilities,
  createMediaTempManager,
  type MediaTempManager,
  createMediaSemaphore,
  type MediaSemaphore,
  createAudioConverter,
  type AudioConverter,
  createSsrfGuardedFetcher,
  type SsrfGuardedFetcher,
  createFileExtractor,
  createPdfExtractor,
  createCompositeFileExtractor,
  createPdfPageRenderer,
  type PdfPageRenderer,
} from "@comis/skills";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the media setup phase. */
export interface MediaResult {
  /** Text-to-speech adapter (optional -- config/key may be missing). */
  ttsAdapter?: TTSPort;
  /** Vision provider registry keyed by provider name (optional). */
  visionRegistry?: Map<string, VisionProvider>;
  /** Link understanding pipeline runner. */
  linkRunner: LinkRunner;
  /** FFmpeg/ffprobe detection result from startup. */
  ffmpegCapabilities: FfmpegCapabilities;
  /** Managed temp directory for media scratch files. */
  mediaTempManager: MediaTempManager;
  /** Global concurrency limiter for media operations. */
  mediaSemaphore: MediaSemaphore;
  /** Audio converter -- only created if ffmpeg is available. */
  audioConverter?: AudioConverter;
  /** Speech-to-text transcriber (optional -- config/key may be missing). */
  transcriber?: TranscriptionPort;
  /** SSRF-guarded HTTP fetch utility for safe remote media downloads. */
  ssrfFetcher: SsrfGuardedFetcher;
  /** File extractor for document attachment processing (optional -- disabled by config). */
  fileExtractor?: FileExtractionPort;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create media services: ffmpeg detection, temp directory with cleanup,
 * concurrency semaphore, audio converter, TTS provider (factory selects
 * by config), vision provider registry (auto-discover by API key), and
 * link understanding runner (detect, fetch, format pipeline).
 * @param deps.container    - Bootstrap output (config, event bus, secret manager)
 * @param deps.skillsLogger - Module-bound logger for skills subsystem
 */
export async function setupMedia(deps: {
  container: AppContainer;
  skillsLogger: ComisLogger;
  /** Optional callback for suspicious content detection */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Promise<MediaResult> {
  const { container, skillsLogger } = deps;
  const mediaConfig = container.config.integrations.media;

  // 6.6.8.pre1. ffmpeg/ffprobe availability detection
  const ffmpegCapabilities = await detectFfmpeg();

  // Log each binary separately per user decision (not a single combined message)
  if (!ffmpegCapabilities.ffmpegAvailable) {
    skillsLogger.warn({
      hint: "Install ffmpeg for audio format conversion (voice messages will pass through raw without conversion)",
      errorKind: "dependency" as const,
    }, "ffmpeg not found — media conversion disabled");
  } else {
    skillsLogger.debug({ version: ffmpegCapabilities.ffmpegVersion }, "ffmpeg detected");
  }

  if (!ffmpegCapabilities.ffprobeAvailable) {
    skillsLogger.warn({
      hint: "Install ffprobe for audio codec verification and duration extraction (falling back to music-metadata)",
      errorKind: "dependency" as const,
    }, "ffprobe not found — codec verification disabled");
  } else {
    skillsLogger.debug({ version: ffmpegCapabilities.ffprobeVersion }, "ffprobe detected");
  }

  // 6.6.8.pre2. Managed temp directory
  const infraConfig = mediaConfig.infrastructure;
  const mediaTempManager = createMediaTempManager({
    ttlMs: infraConfig.tempFileTtlMs,
    cleanupIntervalMs: infraConfig.tempCleanupIntervalMs,
  }, skillsLogger);

  const initResult = await mediaTempManager.init();
  if (initResult.ok) {
    mediaTempManager.startCleanupInterval();
    skillsLogger.debug({
      managedDir: mediaTempManager.getManagedDir(),
      ttlMs: infraConfig.tempFileTtlMs,
      cleanupIntervalMs: infraConfig.tempCleanupIntervalMs,
    }, "Media temp directory initialized");
  } else {
    skillsLogger.warn({
      err: initResult.error.message,
      hint: "Media temp directory creation failed — file-based media operations may fail",
      errorKind: "resource" as const,
    }, "Media temp directory initialization failed");
  }

  // 6.6.8.pre3. Concurrency semaphore
  const mediaSemaphore = createMediaSemaphore(infraConfig.concurrencyLimit);
  skillsLogger.debug({ concurrencyLimit: infraConfig.concurrencyLimit }, "Media concurrency semaphore initialized");

  // 6.6.8.pre4. AudioConverter — only if ffmpeg available
  let audioConverter: AudioConverter | undefined;
  if (ffmpegCapabilities.ffmpegAvailable) {
    audioConverter = createAudioConverter({ logger: skillsLogger });
    skillsLogger.debug("Audio converter initialized");
  }

  // 6.6.8.pre4.5. SSRF-guarded fetcher — safe remote media downloads
  const ssrfFetcher = createSsrfGuardedFetcher(
    { maxBytes: infraConfig.maxRemoteFetchBytes },
    skillsLogger,
  );
  skillsLogger.debug({ maxBytes: infraConfig.maxRemoteFetchBytes }, "SSRF-guarded fetcher initialized");

  // 6.6.8.pre5. STT provider — factory selects from config
  let transcriber: TranscriptionPort | undefined;
  const sttResult = createSTTProvider(mediaConfig.transcription, container.secretManager);
  if (sttResult.ok) {
    // Build fallback chain if configured
    const fallbackProviders: TranscriptionPort[] = [];
    for (const fbProvider of mediaConfig.transcription.fallbackProviders) {
      const fbConfig = { ...mediaConfig.transcription, provider: fbProvider };
      const fbResult = createSTTProvider(fbConfig, container.secretManager);
      if (fbResult.ok) fallbackProviders.push(fbResult.value);
    }
    if (fallbackProviders.length > 0) {
      transcriber = createFallbackTranscription(
        [sttResult.value, ...fallbackProviders],
        skillsLogger,
      );
      skillsLogger.info({
        provider: mediaConfig.transcription.provider,
        fallbackCount: fallbackProviders.length,
      }, "STT service initialized with fallback chain");
    } else {
      transcriber = sttResult.value;
      skillsLogger.info({ provider: mediaConfig.transcription.provider }, "STT service initialized");
    }
  } else {
    skillsLogger.warn({
      err: sttResult.error.message,
      hint: "Configure STT provider in integrations.media.transcription section",
      errorKind: "config" as const,
    }, "STT service not configured");
  }

  // 6.6.8. TTS adapter — factory selects provider from config
  let ttsAdapter: TTSPort | undefined;
  const ttsResult = createTTSProvider(mediaConfig.tts, container.secretManager);
  if (ttsResult.ok) {
    ttsAdapter = ttsResult.value;
    skillsLogger.debug({ provider: mediaConfig.tts.provider }, "TTS service initialized");
  } else {
    skillsLogger.warn({ err: ttsResult.error.message, hint: "Configure TTS provider in integrations.media.tts section", errorKind: "config" as const }, "TTS service not configured");
  }

  // 6.6.8.1. Vision provider registry — auto-discover providers by API key
  // Service creation decoupled from vision.enabled flag:
  // Registry always created when API keys are valid so on-demand tools
  // (describe_image, describe_video) can use it even when auto-preprocessing is off.
  let visionRegistry: Map<string, VisionProvider> | undefined;
  {
    const registry = createVisionProviderRegistry({
      secretManager: container.secretManager,
      config: mediaConfig.vision,
    });
    if (registry.size > 0) {
      visionRegistry = registry;
      skillsLogger.debug(
        { providers: [...registry.keys()], autoEnabled: mediaConfig.vision.enabled },
        "Vision provider registry initialized",
      );
    } else {
      skillsLogger.debug("No vision providers configured (no API keys found)");
    }
  }

  // 6.6.8.2. Link understanding runner — detect, fetch, format pipeline
  const linkRunner: LinkRunner = createLinkRunner({
    config: mediaConfig.linkUnderstanding,
    logger: skillsLogger,
    onSuspiciousContent: deps.onSuspiciousContent,
  });
  if (mediaConfig.linkUnderstanding.enabled) {
    skillsLogger.debug("Link understanding pipeline enabled");
  }

  // 6.6.8.3. File extractor -- text + PDF document extraction
  // Service creation decoupled from documentExtraction.enabled flag:
  // Extractor always created so on-demand tools (extract_document) can use it
  // even when auto-preprocessing is off.
  const docExtractionConfig = mediaConfig.documentExtraction;
  let fileExtractor: FileExtractionPort | undefined;
  {
    const textExtractor = createFileExtractor({
      config: docExtractionConfig,
      logger: skillsLogger,
    });

    // Wire vision provider and page renderer for PDF image fallback
    let pdfVisionProvider: VisionProvider | undefined;
    let pdfPageRenderer: PdfPageRenderer | undefined;
    if (docExtractionConfig.pdfImageFallback && visionRegistry) {
      const selected = selectVisionProvider(visionRegistry, "image");
      if (selected) {
        pdfVisionProvider = selected;
        pdfPageRenderer = createPdfPageRenderer({ logger: skillsLogger });
        skillsLogger.debug(
          { provider: selected.id },
          "PDF image fallback enabled with vision provider",
        );
      } else {
        skillsLogger.warn({
          hint: "Enable a vision provider (OpenAI, Anthropic, or Google) with an API key to use PDF image fallback",
          errorKind: "config" as const,
        }, "PDF image fallback enabled but no vision provider available");
      }
    }

    const pdfExtractor = createPdfExtractor({
      config: docExtractionConfig,
      logger: skillsLogger,
      visionProvider: pdfVisionProvider,
      pdfPageRenderer,
    });
    fileExtractor = createCompositeFileExtractor({
      textExtractor,
      pdfExtractor,
    });
    skillsLogger.debug(
      { supportedMimes: fileExtractor.supportedMimes.length, autoEnabled: docExtractionConfig.enabled },
      "File extractor initialized",
    );
  }

  return {
    ttsAdapter, visionRegistry, linkRunner,
    ffmpegCapabilities, mediaTempManager, mediaSemaphore, audioConverter,
    transcriber, ssrfFetcher, fileExtractor,
  };
}
