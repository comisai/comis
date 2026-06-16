// SPDX-License-Identifier: Apache-2.0
/**
 * Media services setup: ffmpeg detection, temp directory, concurrency
 * semaphore, audio converter, TTS provider, vision provider registry,
 * and link understanding runner.
 * Extracted from daemon.ts steps 6.6.8 through 6.6.8.2 to isolate media
 * service initialization from the main wiring sequence.
 * @module
 */

import * as os from "node:os";
import type { AppContainer, TTSPort, TranscriptionPort, VisionProvider, FileExtractionPort, WrapExternalContentOptions, SecretManager, ImageGenerationConfig, TranscriptionConfig, TtsConfig } from "@comis/core";
import { STT_ERR_TO_LOG, safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { createAudioProviderSelector } from "./setup-audio-provider.js";
// OBS-03 (196): the resolved-voice-selection shape the daemon RPC handlers consume.
// Type-only (erased at runtime — no madge edge); same-package, so no project-ref cycle.
import type { ResolvedVoiceSelection } from "../api/types.js";
import {
  createTTSProvider,
  createSTTProvider,
  createImageGenProvider,
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
  /**
   * Stable holder for the vision registry. When visionRegistry
   * is undefined at boot (no vision API keys) and materialises later via a
   * secret:changed rotation, the .value field is updated in place so all
   * downstream consumers holding this reference see the new registry without
   * needing to re-read the boot snapshot.
   *
   * Use `visionRegistryHolder.value` in contexts that must observe the
   * first-materialisation transition (e.g. RPC dispatch deps assembled once at
   * boot that are used across the daemon lifetime). The plain `visionRegistry`
   * field is a point-in-time snapshot of the boot value and may be stale after
   * the first rotation when it was initially undefined.
   */
  visionRegistryHolder: { value: Map<string, VisionProvider> | undefined };
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
  /** OBS-03 (196): the boot-resolved STT/TTS selections (`source`/`keyless`/
   *  `provider` + the `onSkip` reasons), threaded to the daemon RPC handlers for
   *  the `media.stt.*`/`media.tts.*` trajectory emit. Present only when the audio
   *  selector ran AND resolved (`sel.ok`); undefined otherwise. */
  voiceSelection?: { stt?: ResolvedVoiceSelection; tts?: ResolvedVoiceSelection };
}

// ---------------------------------------------------------------------------
// Lazy per-call factory functions for boot-snapshot consumer conversion.
//
// These factories return a fresh provider on each call by re-reading
// secretManager.get() at invocation time rather than snapshotting the key at
// construction time. After secret rotation the next call observes the new value
// without requiring a daemon restart.
// ---------------------------------------------------------------------------

/**
 * Return a lazy getter that re-creates the STT provider on each call,
 * reading the current secretManager state at invocation time.
 * Satisfies the read-on-use invariant.
 *
 * `dataDir` is a stable boot value (`container.config.dataDir`) captured once and
 * threaded into the in-process `local` adapter's model-cache root on every
 * re-creation — the per-call wrapper rebuilds the adapter but the cache scope is
 * fixed at boot (Plan 02 LOCAL-01).
 */
export function createSTTProviderFactory(
  config: TranscriptionConfig,
  secretManager: SecretManager,
  dataDir: string,
): () => ReturnType<typeof createSTTProvider> {
  return () => createSTTProvider(config, secretManager, dataDir);
}

/**
 * Return a lazy getter that re-creates the TTS provider on each call,
 * reading the current secretManager state at invocation time.
 * Satisfies the read-on-use invariant.
 *
 * `dataDir` is a stable boot value (`container.config.dataDir`) captured once and
 * threaded into the in-process `local`/`piper` adapter's model-cache root
 * (`<dataDir>/models/tts/`) on every re-creation — mirrors
 * `createSTTProviderFactory` (TTS-02).
 */
export function createTTSProviderFactory(
  config: TtsConfig,
  secretManager: SecretManager,
  dataDir: string,
): () => ReturnType<typeof createTTSProvider> {
  return () => createTTSProvider(config, secretManager, dataDir);
}

/**
 * Return a lazy getter that re-creates the image-generation provider on each
 * call, reading the current secretManager state at invocation time.
 * Returns undefined when the required API key is absent or config is missing
 * (graceful degradation). Unwraps the Result returned by createImageGenProvider.
 * Satisfies the read-on-use invariant.
 */
export function createImageGenProviderFactory(
  imageGenConfig: ImageGenerationConfig | undefined,
  secretManager: SecretManager,
): () => import("@comis/core").ImageGenerationPort | undefined {
  if (!imageGenConfig) return () => undefined;
  return () => {
    const r = createImageGenProvider(imageGenConfig, secretManager);
    return r.ok ? r.value ?? undefined : undefined;
  };
}

/** Alias for createImageGenProviderFactory — used by daemon.ts composition root. */
export const createImageGenGetter = createImageGenProviderFactory;

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
  /**
   * The keyless-first audio selector (Phase 193, built in the daemon via
   * `createAudioProviderSelector`). When present, STT/TTS construction is GATED
   * on `resolveStt()`/`resolveTts()` BEFORE `createSTTProvider`/`createTTSProvider`
   * — an honest-unavailable resolution (`sel.ok===false`) constructs NO adapter
   * (so a Codex/OAuth-only main never builds the empty-bearer OpenAI adapter →
   * 401; the inbound path skip-don't-throws). Absent (test harnesses) → the
   * pre-193 behavior (construct directly from config).
   */
  audioSelector?: ReturnType<typeof createAudioProviderSelector>;
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

  // 6.6.8.pre5. STT provider — keyless-first resolution THEN factory construction.
  //
  // Phase 193 (RES-05 / STEER-01): when the daemon supplies the audio selector,
  // resolve the provider BEFORE constructing any adapter. An honest-unavailable
  // resolution (`!sel.ok` — e.g. a Codex/OAuth-only main with no audio key, or
  // STT `auto` before the local engine lands in Phase 194) constructs NO adapter:
  // `transcriber` stays undefined, the honest-unavailable is logged once, and the
  // downstream inbound path skip-don't-throws (audio-preflight returns
  // {transcribed:false} — the message still reaches the agent). This replaces the
  // empty-bearer `createOpenAISttAdapter({ apiKey: secretManager.get(...) ?? "" })`
  // → 401 that today's hardcoded `provider:"openai"` default produced. Use a
  // lazy-delegation wrapper for the rotated-key read-on-use invariant.
  let transcriber: TranscriptionPort | undefined;
  const sttSel = deps.audioSelector?.resolveStt();
  if (sttSel && !sttSel.ok) {
    skillsLogger.warn(
      {
        err: sttSel.errorKind,
        errorKind: STT_ERR_TO_LOG[sttSel.errorKind],
        hint: sttSel.hint,
        step: "stt_unavailable",
      },
      "STT unavailable — keyless-first resolution (no adapter constructed)",
    );
  }
  // The construction-gating predicate, computed in exactly ONE place (WR-03):
  // blocked ONLY when the selector ran and returned honest-unavailable (`ok ===
  // false`) — that gates construction OFF (no empty-bearer adapter). An undefined
  // selector (test harnesses / pre-193 callers) is NOT blocked (construct
  // directly). Keeping the gate and the logged-branch derived from this single
  // discriminant prevents a future edit from making them diverge.
  // The scoped model-cache root for the in-process `local` adapters. Resolved
  // ONCE at function scope from `container.config.dataDir` (NEVER process.env) so
  // BOTH the STT (`<dataDir>/models/whisper/`, Plan 194-02 LOCAL-01) and the TTS
  // (`<dataDir>/models/tts/`, TTS-02) construct/factory sites thread the identical
  // value in lockstep; the `safePath(homedir, ".comis")` fallback mirrors
  // daemon.ts when the config field is unset.
  const dataDir = container.config.dataDir ?? safePath(os.homedir(), ".comis");

  const sttBlocked = sttSel?.ok === false;
  // Construct only when NOT blocked by the resolver. For 193 an approved
  // `sttSel.provider` is openai/groq/deepgram (keyed cases the factory handles) —
  // `local` resolves only when localEngineAvailable() is true (false in 193, the
  // Phase 194 seam), so the factory never sees `local` yet; `edge` is TTS-only.
  if (!sttBlocked) {
    // WR-01/WR-02: thread the RESOLVED provider (+ its model) into construction
    // so the factory sees the provider the resolver actually approved (e.g. a
    // CRED-01 follow-main `auto`→openai), NOT the raw config `provider:"auto"`
    // which would hit the factory `default` → err. Mirrors the fallback loop
    // below. Only override when a selector ran (`sttSel?.ok`); preserve pre-193
    // behavior (construct straight from config) when no selector was supplied.
    const sttConfig = sttSel?.ok
      ? {
          ...mediaConfig.transcription,
          // The resolver derives `provider` from the same capability maps +
          // config enum, so it is always a member of the config provider union;
          // `SttSelection.provider` is declared `string` only to decouple the
          // resolver type from the schema. Cast to the field's exact type.
          provider: sttSel.provider as typeof mediaConfig.transcription.provider,
          ...(sttSel.model ? { model: sttSel.model } : {}),
        }
      : mediaConfig.transcription;
    const sttResult = createSTTProvider(sttConfig, container.secretManager, dataDir);
    if (sttResult.ok) {
      // Build the lazy factory for the primary provider
      const sttFactory = createSTTProviderFactory(sttConfig, container.secretManager, dataDir);

      // Build fallback factories if configured
      const fallbackFactories: Array<() => ReturnType<typeof createSTTProvider>> = [];
      for (const fbProvider of mediaConfig.transcription.fallbackProviders) {
        const fbConfig = { ...mediaConfig.transcription, provider: fbProvider };
        const fbResult = createSTTProvider(fbConfig, container.secretManager, dataDir);
        if (fbResult.ok) {
          fallbackFactories.push(createSTTProviderFactory(fbConfig, container.secretManager, dataDir));
        }
      }
      const hasFallback = fallbackFactories.length > 0;

      // Lazy-delegation wrapper: delegates transcribe() to a fresh provider on
      // each call so a rotated key is observed without a daemon restart.
      transcriber = {
        transcribe: async (audio, options) => {
          const primaryResult = sttFactory();
          if (!primaryResult.ok) return primaryResult;
          if (!hasFallback) {
            return primaryResult.value.transcribe(audio, options);
          }
          const chain: TranscriptionPort[] = [primaryResult.value];
          for (const fbFactory of fallbackFactories) {
            const fbResult = fbFactory();
            if (fbResult.ok) chain.push(fbResult.value);
          }
          return createFallbackTranscription(chain, skillsLogger).transcribe(audio, options);
        },
      };

      if (hasFallback) {
        skillsLogger.info({
          // Report the RESOLVED provider actually constructed (e.g. follow-main
          // `auto`→openai), not the raw config `provider` — so the boot log is
          // the ground truth for "which STT backend is live".
          provider: sttConfig.provider,
          fallbackCount: fallbackFactories.length,
        }, "STT service initialized with fallback chain");
      } else {
        skillsLogger.info({ provider: sttConfig.provider }, "STT service initialized");
      }
    } else {
      skillsLogger.warn({
        err: sttResult.error.message,
        hint: "Configure STT provider in integrations.media.transcription section",
        errorKind: "config" as const,
      }, "STT service not configured");
    }
  }

  // 6.6.8. TTS adapter — keyless-first resolution THEN factory construction.
  //
  // Phase 193 (RES-02 / RES-05): when the daemon supplies the audio selector,
  // resolve TTS BEFORE constructing any adapter. `auto`/default resolves to the
  // keyless Edge adapter (no key); an explicit keyed provider with a present key
  // resolves explicit; honest-unavailable (`!sel.ok`) constructs NO adapter +
  // logs once. Use a lazy-delegation wrapper for the rotated-key read-on-use.
  let ttsAdapter: TTSPort | undefined;
  const ttsSel = deps.audioSelector?.resolveTts();
  if (ttsSel && !ttsSel.ok) {
    skillsLogger.warn(
      {
        err: ttsSel.errorKind,
        // STT_ERR_TO_LOG is intentionally shared: TTS reuses the SttErrorKind
        // vocabulary + its log bridge (voice-error.ts, design Assumption A3) —
        // `TtsSelection.errorKind` is typed `SttErrorKind`. The STT-named symbol
        // here is correct, not a copy-paste (IN-01).
        errorKind: STT_ERR_TO_LOG[ttsSel.errorKind],
        hint: ttsSel.hint,
        step: "tts_unavailable",
      },
      "TTS unavailable — keyless-first resolution (no adapter constructed)",
    );
  }
  // Single discriminant for the construction gate (WR-03) — see the STT note above.
  const ttsBlocked = ttsSel?.ok === false;
  if (!ttsBlocked) {
    // WR-01: thread the RESOLVED provider into construction (mirrors STT). Today
    // `auto`→edge works because the default config already carries
    // `provider:"edge"`, but an operator who disables edge and relies on
    // follow-main would otherwise hit the identical `default`→err trap. Only
    // override when a selector ran; preserve pre-193 behavior otherwise.
    const ttsConfig = ttsSel?.ok
      ? { ...mediaConfig.tts, provider: ttsSel.provider as typeof mediaConfig.tts.provider }
      : mediaConfig.tts;
    const ttsResult = createTTSProvider(ttsConfig, container.secretManager, dataDir);
    if (ttsResult.ok) {
      const ttsFactory = createTTSProviderFactory(ttsConfig, container.secretManager, dataDir);
      // Lazy-delegation wrapper: delegates synthesize() to a fresh provider on
      // each call so a rotated key is observed without a daemon restart.
      ttsAdapter = {
        synthesize: async (text, options) => {
          const result = ttsFactory();
          if (!result.ok) return result;
          return result.value.synthesize(text, options);
        },
      };
      skillsLogger.debug({ provider: ttsConfig.provider }, "TTS service initialized");
    } else {
      skillsLogger.warn({ err: ttsResult.error.message, hint: "Configure TTS provider in integrations.media.tts section", errorKind: "config" as const }, "TTS service not configured");
    }
  }

  // 6.6.8.1. Vision provider registry — auto-discover providers by API key
  // Service creation decoupled from vision.enabled flag:
  // Registry always created when API keys are valid so on-demand tools
  // (describe_image, describe_video) can use it even when auto-preprocessing is off.
  //
  // The registry is wrapped in a stable holder object so that
  // when it materialises from undefined at first rotation, all downstream
  // consumers holding visionRegistryHolder (rather than the point-in-time
  // visionRegistry snapshot) observe the new registry via .value.
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

  // Stable holder — carries the current registry reference so the
  // first-materialisation path (undefined → Map) is visible to all consumers
  // that hold this holder rather than the point-in-time snapshot.
  const visionRegistryHolder: { value: Map<string, VisionProvider> | undefined } = {
    value: visionRegistry,
  };

  // Rebuild vision registry on credential rotation so rotated vision API
  // keys are observed without a daemon restart. The subscription rebuilds the Map
  // in place so all downstream consumers holding a reference to visionRegistry
  // see the new providers on their next invocation. When the registry was absent
  // at boot (undefined), the holder is also updated so late-bound consumers
  // holding visionRegistryHolder see the first-materialisation transition.
  const VISION_KEYS = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"]);
  container.eventBus.on("secret:changed", ({ name }) => {
    if (!VISION_KEYS.has(name)) return;
    const updated = createVisionProviderRegistry({
      secretManager: container.secretManager,
      config: mediaConfig.vision,
    });
    if (visionRegistry) {
      // Rebuild in place: existing consumers holding a Map reference see the new providers.
      visionRegistry.clear();
      for (const [k, v] of updated) {
        visionRegistry.set(k, v);
      }
      // holder.value already points at visionRegistry (same reference) — no-op update.
    } else if (updated.size > 0) {
      // Registry was absent at boot (no keys then); materialise it now.
      visionRegistry = updated;
      // Update the holder so late-bound consumers holding visionRegistryHolder
      // observe the first-materialisation transition (the point-in-time snapshot
      // remains undefined; only the holder is updated).
      visionRegistryHolder.value = updated;
    }
    skillsLogger.info(
      { name, providers: visionRegistryHolder.value ? [...visionRegistryHolder.value.keys()] : [], step: "credential-rotation-vision" },
      "Vision provider registry rebuilt after credential rotation",
    );
  });

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

  // OBS-03 (196): surface the boot-resolved STT/TTS selections so the daemon RPC
  // handlers thread `source`/`keyless`/`provider` + the collected `onSkip` reasons
  // onto the `media.stt.*`/`media.tts.*` trajectory (no re-derivation — the SAME
  // SttSelection/TtsSelection the adapter construction above used). Present only
  // when the selector ran AND resolved (`sel.ok`); an honest-unavailable or
  // selector-less boot leaves the slice undefined (the handler falls back to the
  // config-derived provider + keyless).
  const voiceSelection: { stt?: ResolvedVoiceSelection; tts?: ResolvedVoiceSelection } = {};
  if (sttSel?.ok) {
    // Optional-call `sttSkips` — a selector built before the 196 skip-collection
    // (or a partial test mock) may not expose it; an absent collector → no onSkip.
    const skips = deps.audioSelector?.sttSkips?.() ?? [];
    voiceSelection.stt = {
      provider: sttSel.provider,
      keyless: sttSel.keyless,
      source: sttSel.source,
      ...(skips.length > 0 ? { onSkip: skips } : {}),
    };
  }
  if (ttsSel?.ok) {
    const skips = deps.audioSelector?.ttsSkips?.() ?? [];
    voiceSelection.tts = {
      provider: ttsSel.provider,
      keyless: ttsSel.keyless,
      source: ttsSel.source,
      ...(skips.length > 0 ? { onSkip: skips } : {}),
    };
  }

  return {
    ttsAdapter, visionRegistry, visionRegistryHolder, linkRunner,
    ffmpegCapabilities, mediaTempManager, mediaSemaphore, audioConverter,
    transcriber, ssrfFetcher, fileExtractor,
    ...(voiceSelection.stt !== undefined || voiceSelection.tts !== undefined
      ? { voiceSelection }
      : {}),
  };
}
