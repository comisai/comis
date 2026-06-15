// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Media RPC handler methods (vision, TTS, link processing, audio transcription).
 * Covers 15 methods:
 *   image.analyze, tts.synthesize, tts.auto_check, link.process,
 *   audio.transcribe,
 *   media.transcribe, media.describe_video, media.extract_document,
 *   media.test.stt, media.test.tts, media.test.vision,
 *   media.test.document, media.test.video, media.test.link,
 *   media.providers
 *
 * Uses the `@comis/core` contract registry. Method keys are computed-property
 * names (`[TtsSynthesizeContract.method]:`) so the bidirectional 1:1
 * architecture test resolves them through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/media.ts`. The
 * dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` (never model
 * internals in the contract schema). The dispatcher reads `_channelType` /
 * `_chatType` / `_sessionKey` / `_agentId` from `rawParams` BEFORE the strip
 * step (the internal fields flow into the handler body through the
 * un-stripped params; the contract-parsed `params` carry only the
 * user-facing keys).
 *
 * The bespoke pre-Zod validation (no-vision-registry guard, no-TTS-adapter
 * guard, no-resolveAttachment guard, scope-rule deny branch, source_type
 * switch-case, etc.) is intentionally retained for user-friendly error
 * UX matching the existing media-handlers.test.ts assertions. The
 * contract parse runs AFTER + serves as type-narrowing + defense-in-depth
 * + dev-mode response shape check.
 *
 * @module
 */

import {
  ImageAnalyzeContract,
  TtsSynthesizeContract,
  TtsAutoCheckContract,
  LinkProcessContract,
  AudioTranscribeContract,
  MediaTranscribeContract,
  MediaDescribeVideoContract,
  MediaExtractDocumentContract,
  MediaTestSttContract,
  MediaTestTtsContract,
  MediaTestVisionContract,
  MediaTestDocumentContract,
  MediaTestVideoContract,
  MediaTestLinkContract,
  MediaProvidersContract,
  safePath,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
  resolveVisionPath,
} from "@comis/core";
import type { ImageErrorKind } from "@comis/core";
import {
  selectVisionProvider,
  resolveVisionScope,
  shouldAutoTts,
  resolveOutputFormat,
  parseTtsDirective,
} from "@comis/skills";
// VIS-01 (187): the daemon-side vision gate — `isVisionCapable(getModel(...))`,
// the SAME dance setup-channels-media.ts:135 runs. @comis/agent + pi-ai are
// already daemon deps (graph-coordinator.ts:16, setup-channels-media.ts:35).
import { isVisionCapable } from "@comis/agent";
import { getModel } from "@earendil-works/pi-ai";
import { guessMimeFromExtension, detectMimeFromMagicBytes, mimeToExtension } from "../wiring/daemon-utils.js";
// VIS-04 (187): the vision-turn trajectory direct-emit helper (extracted to a
// sibling to keep this file ≤800 — the emits would otherwise push it over).
import { createVisionObsEmitter } from "./vision-obs-emit.js";
import { fetchImageBytesSsrfSafe } from "./ssrf-image-fetch.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import type { RpcHandler } from "./types.js";

/** Dependencies required by media handlers.
 *
 * Re-aliased from the cluster slice in api/types.ts. Single source of truth:
 * MediaApiDeps (shared with image-handlers via the nested `imageHandlerDeps`
 * field). The cluster slice covers media-handler fields (workspaceDirs,
 * defaultWorkspaceDir, defaultAgentId, logger).
 */
import type { MediaApiDeps as MediaHandlerDeps } from "./types.js";
export type { MediaHandlerDeps };

/**
 * Create media RPC handlers (vision, TTS, link processing).
 * @param deps - Injected dependencies
 * @returns Record mapping method names to handler functions
 */
export function createMediaHandlers(deps: MediaHandlerDeps): Record<string, RpcHandler> {
  return {
    [ImageAnalyzeContract.method]: async (rawParams) => {
      // VIS-01 (187): the registry is no longer the ONLY vision path — a
      // vision-capable MAIN provider serves image.analyze with no separate
      // vision key (deps.mainProviderVision). Short-circuit ONLY when NEITHER a
      // registry NOR a main-vision bridge is wired (the ladder's honest-
      // unavailable tier handles the no-capable-tier case with an errorKind).
      const hasRegistry = !!deps.visionRegistry && deps.visionRegistry.size > 0;
      if (!hasRegistry && !deps.mainProviderVision) {
        throw new Error("No vision provider available for image analysis.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = ImageAnalyzeContract.request.parse(userParams);
      // Support attachment_url as an alternative source type
      const attachmentUrl = params.attachment_url;
      const sourceType = attachmentUrl && !params.source_type
        ? "attachment"
        : params.source_type;
      const source = params.source ?? attachmentUrl ?? "";
      const prompt = params.prompt ?? "Describe this image in detail";
      const providedMimeType = params.mime_type;

      // Vision scope check: deny analysis for restricted contexts
      if (deps.visionRegistry && deps.mediaConfig.vision.scopeRules.length > 0) {
        const scopeAction = resolveVisionScope(
          deps.mediaConfig.vision.scopeRules,
          deps.mediaConfig.vision.defaultScopeAction,
          {
            channelType: rawParams._channelType as string | undefined,
            chatType: rawParams._chatType as string | undefined,
            sessionKey: rawParams._sessionKey as string | undefined,
          },
        );
        if (scopeAction === "deny") {
          deps.logger.info(
            { channelType: rawParams._channelType, chatType: rawParams._chatType },
            "Vision analysis denied by scope rule",
          );
          const result = { description: "Vision analysis not available for this context." };
          if (systemGetEnv("NODE_ENV") !== "production") {
            ImageAnalyzeContract.response.parse(result);
          }
          return result;
        }
      }

      let buffer: Buffer;
      let mimeType: string;

      switch (sourceType) {
        case "file": {
          const callerAgentId = rawParams._agentId as string | undefined;
          const agentDir = (callerAgentId && deps.workspaceDirs.get(callerAgentId)) ?? deps.defaultWorkspaceDir;
          const filePath = safePath(agentDir, source);
          buffer = await fs.readFile(filePath);
          mimeType = guessMimeFromExtension(filePath);
          break;
        }
        case "url": {
          // CR-01: route through the shared DNS-pinned SSRF fetcher — it
          // validates the host BEFORE connecting, pins DNS to the validated IP
          // (no rebinding TOCTOU window — a bare `fetch` would re-resolve DNS
          // and could be rebound to an internal/metadata IP), refuses redirects,
          // and bounds the download to maxBytes. The post-switch size check
          // below stays as defense-in-depth.
          const maxBytes = deps.mediaConfig.imageAnalysis.maxFileSizeMb * 1024 * 1024;
          const fetched = await fetchImageBytesSsrfSafe(source, maxBytes);
          buffer = fetched.buffer;
          mimeType = fetched.mimeType ?? "image/jpeg";
          break;
        }
        case "base64": {
          buffer = Buffer.from(source, "base64");
          mimeType = providedMimeType ?? detectMimeFromMagicBytes(buffer) ?? "image/jpeg";
          break;
        }
        case "attachment": {
          // Resolve platform-specific attachment URL (tg-file://, discord://, etc.)
          if (!deps.resolveAttachment) {
            throw new Error("Attachment resolution not available in this context.");
          }
          const resolved = await deps.resolveAttachment(attachmentUrl!);
          if (!resolved) {
            throw new Error(`Failed to resolve attachment: ${attachmentUrl}`);
          }
          buffer = resolved;
          mimeType = providedMimeType ?? detectMimeFromMagicBytes(buffer) ?? "image/jpeg";
          break;
        }
        default:
          throw new Error(`Unknown source_type: ${sourceType}. Use "file", "url", "base64", or "attachment".`);
      }

      // Validate buffer size
      const fileSizeMb = buffer.byteLength / (1024 * 1024);
      if (fileSizeMb > deps.mediaConfig.imageAnalysis.maxFileSizeMb) {
        throw new Error(`Image size ${fileSizeMb.toFixed(1)}MB exceeds limit of ${deps.mediaConfig.imageAnalysis.maxFileSizeMb}MB`);
      }

      // VIS-01/02/03 (187): the provider-following vision ladder. The handler is
      // a CONSUMER of resolveVisionPath + deps.mainProviderVision — it NEVER
      // re-derives provider selection (the 183 second-source-of-truth firewall).
      // Tiers: main-vision (the agent's MAIN model, reusing its creds) → registry
      // (selectVisionProvider, byte-identical to pre-187 when the main lacks
      // vision) → honest-unavailable. The buffer + scope + size guards above ran
      // FIRST (the V4/V5 security floor) and are untouched.
      const agentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
      const preferredProvider = deps.mediaConfig.vision.defaultProvider;
      const main = deps.resolveAgentMainProvider?.(agentId) ?? { providerId: "unknown" };
      // VIS-04: §2.7 clock (systemNowMs, never Date.now()) + the content-free
      // trajectory/§2.7-log emitter (fires media.vision.requested at construction).
      const visionStartMs = systemNowMs();
      const obs = createVisionObsEmitter(rawParams._callerSessionKey as string | undefined, deps.trajectoryRegistry, deps.logger, agentId, visionStartMs, systemNowMs, { provider: main.providerId, mainProvider: main.providerId });
      // The daemon-side vision gate (setup-channels-media.ts:135 dance): resolve
      // the main model id from the SINGLE source (deps.mainModelIdFor, backed by
      // the same resolveAgentModel as the bridge) and ask pi-ai if it sees
      // images. A resolution failure is conservative (not vision-capable).
      let visionCapable = false;
      if (deps.mainProviderVision && deps.mainModelIdFor) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi-ai getModel requires KnownProvider/KnownModel; config stores flexible strings (the proven setup-channels-media.ts cast).
          const resolvedModel = getModel(main.providerId as any, deps.mainModelIdFor(agentId) as any);
          if (resolvedModel) visionCapable = isVisionCapable(resolvedModel);
        } catch { /* model resolution failed → not vision-capable, use the registry */ }
      }
      const visionRegistry = deps.visionRegistry;
      const registryAvailable = !!visionRegistry && !!selectVisionProvider(visionRegistry, "image", preferredProvider);
      const sel = resolveVisionPath(
        {
          mediaKind: "image",
          mainProviderId: main.providerId,
          visionCapable,
          // The bridge owns the actual cred resolution; the gate only asks
          // "could the main serve?" — visionCapable implies a wired bridge here.
          mainCredsAvailable: visionCapable && deps.mainProviderVision != null,
          registryAvailable,
          ...(preferredProvider ? { explicitDefaultProvider: preferredProvider } : {}),
        },
        (reason) => deps.logger.debug({ agentId, hint: reason, step: "vision_resolve" }, "vision path skip"),
      );

      // main-vision FIRST. On a RUNTIME failure, fall back to the registry (its
      // OWN keys) — never throw the bridge err out (the registry is the safety
      // net; T-187-08: never silently retries on a different provider's creds).
      if (sel.ok && sel.path === "main-vision" && deps.mainProviderVision) {
        const r = await deps.mainProviderVision.describeImage(buffer, prompt, mimeType, agentId);
        if (r.ok) {
          // VIS-04: media.vision.completed (path main-vision; costUsd from the
          // bridge) + the §2.7 INFO completion line (one call).
          obs.succeeded({ provider: r.value.provider, mainProvider: main.providerId, path: "main-vision", model: r.value.model, costUsd: r.value.costUsd });
          const result = { description: r.value.text, provider: r.value.provider, model: r.value.model };
          if (systemGetEnv("NODE_ENV") !== "production") ImageAnalyzeContract.response.parse(result);
          return result;
        }
        // bridge runtime failure → registry fallback (media.vision.failed + §2.7 WARN).
        const bridgeKind = (r.error as { errorKind?: ImageErrorKind }).errorKind;
        obs.failed({ errorKind: bridgeKind ?? "dependency", path: "main-vision", provider: main.providerId, mainProvider: main.providerId, hint: "main-vision failed; falling back to the vision registry", message: "Main-provider vision failed, trying the registry" });
      }

      // registry SECOND (the EXISTING path, verbatim — VIS-02 byte-identical when
      // the main lacks vision or an explicit defaultProvider is set), OR the
      // main-vision runtime fallback lands here.
      if ((sel.ok && (sel.path === "registry" || sel.path === "main-vision"))) {
        const provider = visionRegistry ? selectVisionProvider(visionRegistry, "image", preferredProvider) : undefined;
        if (provider) {
          const visionResult = await provider.describeImage({ image: buffer, prompt, mimeType });
          if (!visionResult.ok) throw visionResult.error;
          // VIS-04: media.vision.completed (path registry; NO costUsd, Pitfall 4) + INFO line.
          obs.succeeded({ provider: visionResult.value.provider, mainProvider: main.providerId, path: "registry", model: visionResult.value.model });
          const result = { description: visionResult.value.text, provider: visionResult.value.provider, model: visionResult.value.model };
          if (systemGetEnv("NODE_ENV") !== "production") ImageAnalyzeContract.response.parse(result);
          return result;
        }
        // main-vision failed AND no registry provider → honest-unavailable below.
      }

      // honest-unavailable LAST — media.vision.failed + §2.7 WARN, never a crash.
      const imageErrorKind: ImageErrorKind = sel.ok === false ? sel.errorKind : "unsupported_provider";
      const hint = sel.ok === false ? sel.hint : "No vision provider available for image analysis.";
      obs.failed({ errorKind: imageErrorKind, path: "unavailable", provider: main.providerId, mainProvider: main.providerId, hint, message: "Vision analysis unavailable" });
      throw new Error("No vision provider available for image analysis.");
    },

    [TtsSynthesizeContract.method]: async (rawParams) => {
      if (!deps.ttsAdapter) {
        throw new Error("TTS not configured. Set media.tts.provider in config.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = TtsSynthesizeContract.request.parse(userParams);
      let text = params.text;
      const voice = params.voice;
      const format = params.format;

      // Parse and strip TTS directives from text (e.g., [[tts:voice=nova]])
      const directive = parseTtsDirective(text);
      if (directive.directive) {
        text = directive.cleanText;
      }

      // Resolve output format based on channel (Opus for Telegram, MP3 default)
      const channelType = rawParams._channelType as string | undefined;
      const resolved = resolveOutputFormat(channelType, deps.mediaConfig.tts.outputFormats);

      const ttsOpts: Record<string, unknown> = {};
      if (directive.directive?.voice ?? voice ?? deps.mediaConfig.tts.voice) {
        ttsOpts.voice = directive.directive?.voice ?? voice ?? deps.mediaConfig.tts.voice;
      }
      if (directive.directive?.format ?? format ?? deps.mediaConfig.tts.format) {
        ttsOpts.format = directive.directive?.format ?? format ?? deps.mediaConfig.tts.format;
      } else {
        // Use channel-resolved format when no explicit override
        ttsOpts.format = resolved.openai; // Use provider-appropriate format string
      }
      if (directive.directive?.speed) {
        ttsOpts.speed = directive.directive.speed;
      }

      const synthResult = await deps.ttsAdapter.synthesize(text, ttsOpts as { voice?: string; format?: string });
      if (!synthResult.ok) throw synthResult.error;

      // Determine file extension from mimeType
      const ext = mimeToExtension(synthResult.value.mimeType);
      const fileName = `tts-${randomUUID()}.${ext}`;

      // Create output directory using safePath
      const callerAgentId = rawParams._agentId as string | undefined;
      const agentDir = (callerAgentId && deps.workspaceDirs.get(callerAgentId)) ?? deps.defaultWorkspaceDir;
      const outputDir = safePath(agentDir, "media", "tts");
      // fs-safe-allowed: per-agent workspace media output dir (`<agentDir>/media/tts`); not ~/.comis/ directly
      await fs.mkdir(outputDir, { recursive: true });

      // Simple TTL cleanup: delete files older than 1 hour (best-effort)
      try {
        const entries = await fs.readdir(outputDir);
        const cutoff = systemNowMs() - 3_600_000;
        for (const entry of entries) {
          try {
            const entryPath = safePath(outputDir, entry);
            const stat = await fs.stat(entryPath);
            if (stat.mtimeMs < cutoff) {
              await fs.unlink(entryPath);
            }
          } catch {
            // Individual file cleanup failure is non-fatal
          }
        }
      } catch {
        // Cleanup failure is non-fatal
      }

      // Write audio file
      const filePath = safePath(outputDir, fileName);
      // fs-safe-allowed: per-agent workspace media output (`<agentDir>/media/tts/<file>`); not ~/.comis/ directly
      await fs.writeFile(filePath, synthResult.value.audio);

      const result = {
        filePath,
        mimeType: synthResult.value.mimeType,
        sizeBytes: synthResult.value.audio.byteLength,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        TtsSynthesizeContract.response.parse(result);
      }
      return result;
    },

    [TtsAutoCheckContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = TtsAutoCheckContract.request.parse(userParams);
      // Check if TTS should auto-trigger for a response
      const responseText = params.response_text;
      const hasInboundAudio = params.has_inbound_audio ?? false;
      const hasMediaUrl = params.has_media_url ?? false;

      const autoResult = shouldAutoTts(
        { autoMode: deps.mediaConfig.tts.autoMode, tagPattern: deps.mediaConfig.tts.tagPattern },
        { responseText, hasInboundAudio, hasMediaUrl },
      );

      const result = {
        shouldSynthesize: autoResult.shouldSynthesize,
        strippedText: autoResult.strippedText,
        mode: deps.mediaConfig.tts.autoMode,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        TtsAutoCheckContract.response.parse(result);
      }
      return result;
    },

    [LinkProcessContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = LinkProcessContract.request.parse(userParams);
      // Process message text through link understanding pipeline
      const messageText = params.text;
      const linkResult = await deps.linkRunner.processMessage(messageText);
      const result = {
        enrichedText: linkResult.enrichedText,
        linksProcessed: linkResult.linksProcessed,
        errors: linkResult.errors,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        LinkProcessContract.response.parse(result);
      }
      return result;
    },

    // Base64 audio transcription (gateway-facing)
    [AudioTranscribeContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guards: return `{ error }` shape (NOT throw) on
      // missing audio / no transcriber / provider error — matches the
      // existing test assertions and the gateway client's error-handling
      // path.
      if (typeof rawParams.audio !== "string") {
        return { error: "Missing required parameter: audio (base64-encoded string)" };
      }
      if (!deps.transcriber) {
        return { error: "STT not configured -- check integrations.media.transcription settings" };
      }
      const userParams = stripInternalFields(rawParams);
      const params = AudioTranscribeContract.request.parse(userParams);
      const audioBuffer = Buffer.from(params.audio as string, "base64");
      const mimeType = params.mimeType ?? "audio/ogg";
      const language = params.language;
      const sttResult = await deps.transcriber.transcribe(audioBuffer, { mimeType, language });
      if (!sttResult.ok) {
        return { error: sttResult.error.message };
      }
      const result = {
        text: sttResult.value.text,
        language: sttResult.value.language,
        durationMs: sttResult.value.durationMs,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        AudioTranscribeContract.response.parse(result);
      }
      return result;
    },

    // On-demand media processing RPC handlers

    [MediaTranscribeContract.method]: async (rawParams) => {
      if (!deps.transcriber) {
        throw new Error("Transcription service not configured. Set media.transcription.provider in config.");
      }
      if (!deps.resolveAttachment) {
        throw new Error("Attachment resolution not available in this context.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaTranscribeContract.request.parse(userParams);
      const attachmentUrl = params.attachment_url;
      const language = params.language;

      const buffer = await deps.resolveAttachment(attachmentUrl);
      if (!buffer) {
        throw new Error(`Failed to resolve attachment: ${attachmentUrl}`);
      }

      // Detect MIME type from magic bytes or default to audio/ogg (common for voice messages)
      const mimeType = detectMimeFromMagicBytes(buffer) ?? "audio/ogg";

      const sttResult = await deps.transcriber.transcribe(buffer, {
        mimeType,
        ...(language && { language }),
      });
      if (!sttResult.ok) throw sttResult.error;

      const result = {
        text: sttResult.value.text,
        language: sttResult.value.language,
        durationMs: sttResult.value.durationMs,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaTranscribeContract.response.parse(result);
      }
      return result;
    },

    [MediaDescribeVideoContract.method]: async (rawParams) => {
      if (!deps.visionRegistry || deps.visionRegistry.size === 0) {
        throw new Error("No vision provider available for video description.");
      }
      if (!deps.resolveAttachment) {
        throw new Error("Attachment resolution not available in this context.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaDescribeVideoContract.request.parse(userParams);
      const attachmentUrl = params.attachment_url;
      const prompt = params.prompt ?? "Describe this video concisely.";

      const buffer = await deps.resolveAttachment(attachmentUrl);
      if (!buffer) {
        throw new Error(`Failed to resolve attachment: ${attachmentUrl}`);
      }

      const mimeType = detectMimeFromMagicBytes(buffer) ?? "video/mp4";

      // VIS-03 (187): raw video → the gemini-video tier ONLY (Pitfall 3 — pi-ai
      // has no video content type, so main-vision is N/A for video). The handler
      // consumes resolveVisionPath (mediaKind:"video" → "gemini-video" |
      // "unavailable"); the describeVideo logic below is UNCHANGED. The
      // mainProviderVision bridge is NEVER called for video.
      const agentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
      const main = deps.resolveAgentMainProvider?.(agentId) ?? { providerId: "unknown" };
      // VIS-04: clock + the trajectory/§2.7-log emitter (fires
      // media.vision.requested at construction). Bridge N/A for video (Pitfall 3).
      const visionStartMs = systemNowMs();
      const obs = createVisionObsEmitter(rawParams._callerSessionKey as string | undefined, deps.trajectoryRegistry, deps.logger, agentId, visionStartMs, systemNowMs, { provider: main.providerId, mainProvider: main.providerId });
      const videoProvider = selectVisionProvider(deps.visionRegistry, "video", deps.mediaConfig.vision.defaultProvider);
      const registryAvailable = !!videoProvider?.describeVideo;
      const sel = resolveVisionPath(
        { mediaKind: "video", mainProviderId: main.providerId, visionCapable: false, mainCredsAvailable: false, registryAvailable },
        (reason) => deps.logger.debug({ agentId, hint: reason, step: "vision_resolve" }, "vision path skip"),
      );
      if (sel.ok === false || !videoProvider?.describeVideo) {
        // honest-unavailable — media.vision.failed + §2.7 WARN, NOT an undefined-method call.
        const imageErrorKind: ImageErrorKind = sel.ok === false ? sel.errorKind : "unsupported_provider";
        const hint = sel.ok === false ? sel.hint : "No video-capable vision provider available (requires Gemini or compatible provider).";
        obs.failed({ errorKind: imageErrorKind, path: "unavailable", provider: main.providerId, mainProvider: main.providerId, hint, message: "Video description unavailable" });
        throw new Error("No video-capable vision provider available (requires Gemini or compatible provider).");
      }

      const videoResult = await videoProvider.describeVideo({ video: buffer, prompt, mimeType });
      if (!videoResult.ok) throw videoResult.error;

      // VIS-04: media.vision.completed (path gemini-video; NO costUsd, Pitfall 4) + INFO line.
      obs.succeeded({ provider: videoResult.value.provider, mainProvider: main.providerId, path: "gemini-video", model: videoResult.value.model });
      const result = {
        description: videoResult.value.text,
        provider: videoResult.value.provider,
        model: videoResult.value.model,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaDescribeVideoContract.response.parse(result);
      }
      return result;
    },

    [MediaExtractDocumentContract.method]: async (rawParams) => {
      if (!deps.fileExtractor) {
        throw new Error("Document extraction service not configured. Set media.documentExtraction in config.");
      }
      if (!deps.resolveAttachment) {
        throw new Error("Attachment resolution not available in this context.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaExtractDocumentContract.request.parse(userParams);
      const attachmentUrl = params.attachment_url;

      const buffer = await deps.resolveAttachment(attachmentUrl);
      if (!buffer) {
        throw new Error(`Failed to resolve attachment: ${attachmentUrl}`);
      }

      const mimeType = detectMimeFromMagicBytes(buffer) ?? "application/octet-stream";

      const extractResult = await deps.fileExtractor.extract({
        source: "buffer",
        buffer,
        mimeType,
      });
      if (!extractResult.ok) throw extractResult.error;

      const result = {
        text: extractResult.value.text,
        fileName: extractResult.value.fileName,
        mimeType: extractResult.value.mimeType,
        extractedChars: extractResult.value.extractedChars,
        truncated: extractResult.value.truncated,
        durationMs: extractResult.value.durationMs,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaExtractDocumentContract.response.parse(result);
      }
      return result;
    },

    // Operator testing interface (base64 in/out, no disk I/O)

    [MediaTestSttContract.method]: async (rawParams) => {
      if (!deps.transcriber) {
        throw new Error("Transcription service not configured. Set integrations.media.transcription in config.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaTestSttContract.request.parse(userParams);
      const audio = params.audio;
      const mimeType = params.mimeType;
      const language = params.language;

      const buffer = Buffer.from(audio, "base64");
      const sttResult = await deps.transcriber.transcribe(buffer, {
        mimeType,
        ...(language && { language }),
      });
      if (!sttResult.ok) throw sttResult.error;

      const result = {
        text: sttResult.value.text,
        language: sttResult.value.language,
        durationMs: sttResult.value.durationMs,
        provider: deps.mediaConfig.tts.provider ?? "configured",
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaTestSttContract.response.parse(result);
      }
      return result;
    },

    [MediaTestTtsContract.method]: async (rawParams) => {
      if (!deps.ttsAdapter) {
        throw new Error("TTS not configured. Set integrations.media.tts.provider in config.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaTestTtsContract.request.parse(userParams);
      const text = params.text;
      const voice = params.voice;
      const format = params.format;

      const synthResult = await deps.ttsAdapter.synthesize(text, {
        voice: voice ?? deps.mediaConfig.tts.voice,
        format: format ?? deps.mediaConfig.tts.format,
      });
      if (!synthResult.ok) throw synthResult.error;

      const base64Audio = synthResult.value.audio.toString("base64");
      const result = {
        audio: base64Audio,
        mimeType: synthResult.value.mimeType,
        sizeBytes: synthResult.value.audio.byteLength,
        provider: deps.mediaConfig.tts.provider ?? "unknown",
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaTestTtsContract.response.parse(result);
      }
      return result;
    },

    // Vision, document extraction, and video analysis test handlers

    [MediaTestVisionContract.method]: async (rawParams) => {
      if (!deps.visionRegistry || deps.visionRegistry.size === 0) {
        throw new Error("No vision provider available. Configure integrations.media.vision in config.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaTestVisionContract.request.parse(userParams);
      const image = params.image;
      const mimeType = params.mimeType;
      const prompt = params.prompt ?? "Describe this image in detail";
      const preferredProvider = params.provider;

      const buffer = Buffer.from(image, "base64");

      const provider = selectVisionProvider(
        deps.visionRegistry,
        "image",
        preferredProvider ?? deps.mediaConfig.vision.defaultProvider,
      );
      if (!provider) {
        throw new Error("No vision provider available for image analysis.");
      }

      const visionResult = await provider.describeImage({ image: buffer, prompt, mimeType });
      if (!visionResult.ok) throw visionResult.error;

      const result = {
        description: visionResult.value.text,
        provider: visionResult.value.provider,
        model: visionResult.value.model,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaTestVisionContract.response.parse(result);
      }
      return result;
    },

    [MediaTestDocumentContract.method]: async (rawParams) => {
      if (!deps.fileExtractor) {
        throw new Error("Document extraction service not configured. Set integrations.media.documentExtraction in config.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaTestDocumentContract.request.parse(userParams);
      const file = params.file;
      const mimeType = params.mimeType;
      const fileName = params.fileName;

      const buffer = Buffer.from(file, "base64");

      const extractResult = await deps.fileExtractor.extract({
        source: "buffer",
        buffer,
        mimeType,
        fileName,
      });
      if (!extractResult.ok) throw extractResult.error;

      const result = {
        text: extractResult.value.text,
        fileName: extractResult.value.fileName ?? fileName ?? "unknown",
        mimeType: extractResult.value.mimeType,
        extractedChars: extractResult.value.extractedChars,
        truncated: extractResult.value.truncated,
        durationMs: extractResult.value.durationMs,
        pageCount: extractResult.value.pageCount,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaTestDocumentContract.response.parse(result);
      }
      return result;
    },

    [MediaTestVideoContract.method]: async (rawParams) => {
      if (!deps.visionRegistry || deps.visionRegistry.size === 0) {
        throw new Error("No vision provider available. Configure integrations.media.vision in config.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaTestVideoContract.request.parse(userParams);
      const video = params.video;
      const mimeType = params.mimeType;
      const prompt = params.prompt ?? "Describe this video concisely.";
      const preferredProvider = params.provider;

      const buffer = Buffer.from(video, "base64");

      const videoProvider = selectVisionProvider(
        deps.visionRegistry,
        "video",
        preferredProvider ?? deps.mediaConfig.vision.defaultProvider,
      );
      if (!videoProvider?.describeVideo) {
        throw new Error("No video-capable vision provider available (requires Gemini or compatible provider).");
      }

      const videoResult = await videoProvider.describeVideo({ video: buffer, prompt, mimeType });
      if (!videoResult.ok) throw videoResult.error;

      const result = {
        description: videoResult.value.text,
        provider: videoResult.value.provider,
        model: videoResult.value.model,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaTestVideoContract.response.parse(result);
      }
      return result;
    },

    // Link enrichment test and provider availability info

    [MediaTestLinkContract.method]: async (rawParams) => {
      if (!deps.linkRunner) {
        throw new Error("Link understanding not configured.");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MediaTestLinkContract.request.parse(userParams);
      const url = params.url;
      const linkResult = await deps.linkRunner.processMessage(url);
      const result = {
        enrichedText: linkResult.enrichedText,
        linksProcessed: linkResult.linksProcessed,
        errors: linkResult.errors,
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaTestLinkContract.response.parse(result);
      }
      return result;
    },

    [MediaProvidersContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      MediaProvidersContract.request.parse(userParams);
      const result = {
        stt: deps.transcriber ? {
          provider: "configured",
          model: undefined,
          fallback: [],
        } : null,
        tts: deps.ttsAdapter ? {
          provider: deps.mediaConfig.tts.provider ?? "unknown",
          voice: deps.mediaConfig.tts.voice ?? "default",
          format: deps.mediaConfig.tts.format ?? "mp3",
          autoMode: deps.mediaConfig.tts.autoMode,
        } : null,
        vision: deps.visionRegistry && deps.visionRegistry.size > 0 ? {
          providers: [...deps.visionRegistry.keys()],
          defaultProvider: deps.mediaConfig.vision.defaultProvider,
          videoCapable: [...deps.visionRegistry.entries()]
            .filter(([, v]) => typeof v.describeVideo === "function")
            .map(([k]) => k),
        } : null,
        documentExtraction: deps.fileExtractor ? {
          enabled: true,
          supportedMimes: ["application/pdf", "text/csv", "text/plain", "application/json"],
        } : null,
        linkUnderstanding: {
          enabled: !!deps.linkRunner,
          maxLinks: 5,
        },
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MediaProvidersContract.response.parse(result);
      }
      return result;
    },
  };
}
