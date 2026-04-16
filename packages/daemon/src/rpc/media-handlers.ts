/**
 * Media RPC handler methods (vision, TTS, link processing, audio transcription).
 * Covers 15 methods:
 *   image.analyze, tts.synthesize, tts.auto_check, link.process,
 *   audio.transcribe,
 *   media.transcribe, media.describe_video, media.extract_document,
 *   media.test.stt, media.test.tts, media.test.vision,
 *   media.test.document, media.test.video, media.test.link,
 *   media.providers
 * Extracted from daemon.ts rpcCallInner switch block
 * Added media.test.stt/tts for operator testing interface.
 * Added media.test.vision/document/video for operator testing.
 * Added media.test.link and media.providers for link test + config panel.
 * @module
 */

import type { VisionProvider, TTSPort, VisionScopeRule, TtsOutputFormat, TtsAutoMode, TranscriptionPort, FileExtractionPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { LinkRunner } from "@comis/skills";
import { safePath, validateUrl } from "@comis/core";
import {
  selectVisionProvider,
  resolveVisionScope,
  shouldAutoTts,
  resolveOutputFormat,
  parseTtsDirective,
} from "@comis/skills";
import { guessMimeFromExtension, detectMimeFromMagicBytes, mimeToExtension } from "../wiring/daemon-utils.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import type { RpcHandler } from "./types.js";

/** Dependencies required by media handlers. */
export interface MediaHandlerDeps {
  visionRegistry?: Map<string, VisionProvider>;
  mediaConfig: {
    imageAnalysis: { maxFileSizeMb: number };
    vision: {
      scopeRules: ReadonlyArray<VisionScopeRule>;
      defaultScopeAction: "allow" | "deny";
      defaultProvider?: string;
    };
    tts: {
      provider?: string;
      autoMode: TtsAutoMode;
      tagPattern: string;
      voice?: string;
      format?: string;
      outputFormats?: TtsOutputFormat;
    };
  };
  ttsAdapter?: TTSPort;
  linkRunner: LinkRunner;
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
  defaultAgentId: string;
  logger: ComisLogger;
  /** Attachment URL resolver for on-demand media tool handlers. */
  resolveAttachment?: (url: string) => Promise<Buffer | null>;
  /** Speech-to-text transcriber for media.transcribe handler. */
  transcriber?: TranscriptionPort;
  /** File extractor for media.extract_document handler. */
  fileExtractor?: FileExtractionPort;
}

/**
 * Create media RPC handlers (vision, TTS, link processing).
 * @param deps - Injected dependencies
 * @returns Record mapping method names to handler functions
 */
export function createMediaHandlers(deps: MediaHandlerDeps): Record<string, RpcHandler> {
  return {
    "image.analyze": async (params) => {
      if (!deps.visionRegistry || deps.visionRegistry.size === 0) {
        throw new Error("No vision provider available for image analysis.");
      }
      // Support attachment_url as an alternative source type
      const attachmentUrl = params.attachment_url as string | undefined;
      const sourceType = attachmentUrl && !params.source_type
        ? "attachment"
        : (params.source_type as string);
      const source = params.source as string ?? attachmentUrl ?? "";
      const prompt = (params.prompt as string) ?? "Describe this image in detail";
      const providedMimeType = params.mime_type as string | undefined;

      // Vision scope check: deny analysis for restricted contexts
      if (deps.visionRegistry && deps.mediaConfig.vision.scopeRules.length > 0) {
        const scopeAction = resolveVisionScope(
          deps.mediaConfig.vision.scopeRules,
          deps.mediaConfig.vision.defaultScopeAction,
          {
            channelType: params._channelType as string | undefined,
            chatType: params._chatType as string | undefined,
            sessionKey: params._sessionKey as string | undefined,
          },
        );
        if (scopeAction === "deny") {
          deps.logger.info(
            { channelType: params._channelType, chatType: params._chatType },
            "Vision analysis denied by scope rule",
          );
          return { description: "Vision analysis not available for this context." };
        }
      }

      let buffer: Buffer;
      let mimeType: string;

      switch (sourceType) {
        case "file": {
          const callerAgentId = params._agentId as string | undefined;
          const agentDir = (callerAgentId && deps.workspaceDirs.get(callerAgentId)) ?? deps.defaultWorkspaceDir;
          const filePath = safePath(agentDir, source);
          buffer = await fs.readFile(filePath);
          mimeType = guessMimeFromExtension(filePath);
          break;
        }
        case "url": {
          // Validate URL through SSRF guard before fetching
          const urlCheck = await validateUrl(source);
          if (!urlCheck.ok) {
            throw new Error(`SSRF blocked: ${urlCheck.error.message}`);
          }
          const response = await fetch(source, { redirect: "error" });
          if (!response.ok) {
            throw new Error(`Failed to fetch image: HTTP ${response.status}`);
          }
          // Content-Length check before downloading
          const contentLength = response.headers.get("content-length");
          const maxBytes = deps.mediaConfig.imageAnalysis.maxFileSizeMb * 1024 * 1024;
          if (contentLength && parseInt(contentLength, 10) > maxBytes) {
            throw new Error(`Image file size exceeds limit of ${deps.mediaConfig.imageAnalysis.maxFileSizeMb}MB`);
          }
          const arrayBuffer = await response.arrayBuffer();
          buffer = Buffer.from(arrayBuffer);
          mimeType = response.headers.get("content-type") ?? "image/jpeg";
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

      // Use vision provider registry for provider auto-selection
      const preferredProvider = deps.mediaConfig.vision.defaultProvider;
      const provider = selectVisionProvider(deps.visionRegistry, "image", preferredProvider);
      if (!provider) {
        throw new Error("No vision provider available for image analysis.");
      }
      const visionResult = await provider.describeImage({
        image: buffer,
        prompt,
        mimeType,
      });
      if (!visionResult.ok) throw visionResult.error;
      return { description: visionResult.value.text, provider: visionResult.value.provider, model: visionResult.value.model };
    },

    "tts.synthesize": async (params) => {
      if (!deps.ttsAdapter) {
        throw new Error("TTS not configured. Set media.tts.provider in config.");
      }
      let text = params.text as string;
      const voice = params.voice as string | undefined;
      const format = params.format as string | undefined;

      // Parse and strip TTS directives from text (e.g., [[tts:voice=nova]])
      const directive = parseTtsDirective(text);
      if (directive.directive) {
        text = directive.cleanText;
      }

      // Resolve output format based on channel (Opus for Telegram, MP3 default)
      const channelType = params._channelType as string | undefined;
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
      const callerAgentId = params._agentId as string | undefined;
      const agentDir = (callerAgentId && deps.workspaceDirs.get(callerAgentId)) ?? deps.defaultWorkspaceDir;
      const outputDir = safePath(agentDir, "media", "tts");
      await fs.mkdir(outputDir, { recursive: true });

      // Simple TTL cleanup: delete files older than 1 hour (best-effort)
      try {
        const entries = await fs.readdir(outputDir);
        const cutoff = Date.now() - 3_600_000;
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
      await fs.writeFile(filePath, synthResult.value.audio);

      return {
        filePath,
        mimeType: synthResult.value.mimeType,
        sizeBytes: synthResult.value.audio.byteLength,
      };
    },

    "tts.auto_check": async (params) => {
      // Check if TTS should auto-trigger for a response
      const responseText = params.response_text as string;
      const hasInboundAudio = params.has_inbound_audio as boolean ?? false;
      const hasMediaUrl = params.has_media_url as boolean ?? false;

      const autoResult = shouldAutoTts(
        { autoMode: deps.mediaConfig.tts.autoMode, tagPattern: deps.mediaConfig.tts.tagPattern },
        { responseText, hasInboundAudio, hasMediaUrl },
      );

      return {
        shouldSynthesize: autoResult.shouldSynthesize,
        strippedText: autoResult.strippedText,
        mode: deps.mediaConfig.tts.autoMode,
      };
    },

    "link.process": async (params) => {
      // Process message text through link understanding pipeline
      const messageText = params.text as string;
      const linkResult = await deps.linkRunner.processMessage(messageText);
      return {
        enrichedText: linkResult.enrichedText,
        linksProcessed: linkResult.linksProcessed,
        errors: linkResult.errors,
      };
    },

    // Base64 audio transcription (gateway-facing)
    "audio.transcribe": async (params) => {
      if (typeof params.audio !== "string") {
        return { error: "Missing required parameter: audio (base64-encoded string)" };
      }
      if (!deps.transcriber) {
        return { error: "STT not configured -- check integrations.media.transcription settings" };
      }
      const audioBuffer = Buffer.from(params.audio as string, "base64");
      const mimeType = typeof params.mimeType === "string" ? params.mimeType : "audio/ogg";
      const language = typeof params.language === "string" ? params.language : undefined;
      const result = await deps.transcriber.transcribe(audioBuffer, { mimeType, language });
      if (!result.ok) {
        return { error: result.error.message };
      }
      return {
        text: result.value.text,
        language: result.value.language,
        durationMs: result.value.durationMs,
      };
    },

    // On-demand media processing RPC handlers

    "media.transcribe": async (params) => {
      if (!deps.transcriber) {
        throw new Error("Transcription service not configured. Set media.transcription.provider in config.");
      }
      if (!deps.resolveAttachment) {
        throw new Error("Attachment resolution not available in this context.");
      }
      const attachmentUrl = params.attachment_url as string;
      const language = params.language as string | undefined;

      const buffer = await deps.resolveAttachment(attachmentUrl);
      if (!buffer) {
        throw new Error(`Failed to resolve attachment: ${attachmentUrl}`);
      }

      // Detect MIME type from magic bytes or default to audio/ogg (common for voice messages)
      const mimeType = detectMimeFromMagicBytes(buffer) ?? "audio/ogg";

      const result = await deps.transcriber.transcribe(buffer, {
        mimeType,
        ...(language && { language }),
      });
      if (!result.ok) throw result.error;

      return {
        text: result.value.text,
        language: result.value.language,
        durationMs: result.value.durationMs,
      };
    },

    "media.describe_video": async (params) => {
      if (!deps.visionRegistry || deps.visionRegistry.size === 0) {
        throw new Error("No vision provider available for video description.");
      }
      if (!deps.resolveAttachment) {
        throw new Error("Attachment resolution not available in this context.");
      }
      const attachmentUrl = params.attachment_url as string;
      const prompt = (params.prompt as string) ?? "Describe this video concisely.";

      const buffer = await deps.resolveAttachment(attachmentUrl);
      if (!buffer) {
        throw new Error(`Failed to resolve attachment: ${attachmentUrl}`);
      }

      const mimeType = detectMimeFromMagicBytes(buffer) ?? "video/mp4";

      const videoProvider = selectVisionProvider(deps.visionRegistry, "video", deps.mediaConfig.vision.defaultProvider);
      if (!videoProvider?.describeVideo) {
        throw new Error("No video-capable vision provider available (requires Gemini or compatible provider).");
      }

      const result = await videoProvider.describeVideo({ video: buffer, prompt, mimeType });
      if (!result.ok) throw result.error;

      return {
        description: result.value.text,
        provider: result.value.provider,
        model: result.value.model,
      };
    },

    "media.extract_document": async (params) => {
      if (!deps.fileExtractor) {
        throw new Error("Document extraction service not configured. Set media.documentExtraction in config.");
      }
      if (!deps.resolveAttachment) {
        throw new Error("Attachment resolution not available in this context.");
      }
      const attachmentUrl = params.attachment_url as string;

      const buffer = await deps.resolveAttachment(attachmentUrl);
      if (!buffer) {
        throw new Error(`Failed to resolve attachment: ${attachmentUrl}`);
      }

      const mimeType = detectMimeFromMagicBytes(buffer) ?? "application/octet-stream";

      const result = await deps.fileExtractor.extract({
        source: "buffer",
        buffer,
        mimeType,
      });
      if (!result.ok) throw result.error;

      return {
        text: result.value.text,
        fileName: result.value.fileName,
        mimeType: result.value.mimeType,
        extractedChars: result.value.extractedChars,
        truncated: result.value.truncated,
        durationMs: result.value.durationMs,
      };
    },

    // Operator testing interface (base64 in/out, no disk I/O)

    "media.test.stt": async (params) => {
      if (!deps.transcriber) {
        throw new Error("Transcription service not configured. Set integrations.media.transcription in config.");
      }
      const audio = params.audio as string;
      const mimeType = params.mimeType as string;
      const language = params.language as string | undefined;

      const buffer = Buffer.from(audio, "base64");
      const result = await deps.transcriber.transcribe(buffer, {
        mimeType,
        ...(language && { language }),
      });
      if (!result.ok) throw result.error;

      return {
        text: result.value.text,
        language: result.value.language,
        durationMs: result.value.durationMs,
        provider: deps.mediaConfig.tts.provider ?? "configured",
      };
    },

    "media.test.tts": async (params) => {
      if (!deps.ttsAdapter) {
        throw new Error("TTS not configured. Set integrations.media.tts.provider in config.");
      }
      const text = params.text as string;
      const voice = params.voice as string | undefined;
      const format = params.format as string | undefined;

      const synthResult = await deps.ttsAdapter.synthesize(text, {
        voice: voice ?? deps.mediaConfig.tts.voice,
        format: format ?? deps.mediaConfig.tts.format,
      });
      if (!synthResult.ok) throw synthResult.error;

      const base64Audio = synthResult.value.audio.toString("base64");
      return {
        audio: base64Audio,
        mimeType: synthResult.value.mimeType,
        sizeBytes: synthResult.value.audio.byteLength,
        provider: deps.mediaConfig.tts.provider ?? "unknown",
      };
    },

    // Vision, document extraction, and video analysis test handlers

    "media.test.vision": async (params) => {
      if (!deps.visionRegistry || deps.visionRegistry.size === 0) {
        throw new Error("No vision provider available. Configure integrations.media.vision in config.");
      }
      const image = params.image as string;
      const mimeType = params.mimeType as string;
      const prompt = (params.prompt as string) ?? "Describe this image in detail";
      const preferredProvider = params.provider as string | undefined;

      const buffer = Buffer.from(image, "base64");

      const provider = selectVisionProvider(
        deps.visionRegistry,
        "image",
        preferredProvider ?? deps.mediaConfig.vision.defaultProvider,
      );
      if (!provider) {
        throw new Error("No vision provider available for image analysis.");
      }

      const result = await provider.describeImage({ image: buffer, prompt, mimeType });
      if (!result.ok) throw result.error;

      return {
        description: result.value.text,
        provider: result.value.provider,
        model: result.value.model,
      };
    },

    "media.test.document": async (params) => {
      if (!deps.fileExtractor) {
        throw new Error("Document extraction service not configured. Set integrations.media.documentExtraction in config.");
      }
      const file = params.file as string;
      const mimeType = params.mimeType as string;
      const fileName = params.fileName as string | undefined;

      const buffer = Buffer.from(file, "base64");

      const result = await deps.fileExtractor.extract({
        source: "buffer",
        buffer,
        mimeType,
        fileName,
      });
      if (!result.ok) throw result.error;

      return {
        text: result.value.text,
        fileName: result.value.fileName ?? fileName ?? "unknown",
        mimeType: result.value.mimeType,
        extractedChars: result.value.extractedChars,
        truncated: result.value.truncated,
        durationMs: result.value.durationMs,
        pageCount: result.value.pageCount,
      };
    },

    "media.test.video": async (params) => {
      if (!deps.visionRegistry || deps.visionRegistry.size === 0) {
        throw new Error("No vision provider available. Configure integrations.media.vision in config.");
      }
      const video = params.video as string;
      const mimeType = params.mimeType as string;
      const prompt = (params.prompt as string) ?? "Describe this video concisely.";
      const preferredProvider = params.provider as string | undefined;

      const buffer = Buffer.from(video, "base64");

      const videoProvider = selectVisionProvider(
        deps.visionRegistry,
        "video",
        preferredProvider ?? deps.mediaConfig.vision.defaultProvider,
      );
      if (!videoProvider?.describeVideo) {
        throw new Error("No video-capable vision provider available (requires Gemini or compatible provider).");
      }

      const result = await videoProvider.describeVideo({ video: buffer, prompt, mimeType });
      if (!result.ok) throw result.error;

      return {
        description: result.value.text,
        provider: result.value.provider,
        model: result.value.model,
      };
    },

    // Link enrichment test and provider availability info

    "media.test.link": async (params) => {
      if (!deps.linkRunner) {
        throw new Error("Link understanding not configured.");
      }
      const url = params.url as string;
      const linkResult = await deps.linkRunner.processMessage(url);
      return {
        enrichedText: linkResult.enrichedText,
        linksProcessed: linkResult.linksProcessed,
        errors: linkResult.errors,
      };
    },

    "media.providers": async () => {
      return {
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
    },
  };
}
