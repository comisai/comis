// SPDX-License-Identifier: Apache-2.0
/**
 * Voice response pipeline orchestrator: chains auto-TTS decision -> synthesis ->
 * MP3-to-OGG/Opus conversion -> voice attachment delivery.
 *
 * This module is injected into channel-manager.ts to provide automatic voice
 * response capability.
 *
 * All error paths return ok({ voiceSent: false }) instead of err() so that
 * text delivery can proceed as fallback (TTS failure must not
 * block text response).
 *
 * Uses structural typing for all deps to avoid circular dependency on
 * @comis/skills -- same pattern as voice-sender.ts.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
import { safePath } from "@comis/core";
import type { SendMessageOptions, TtsAutoMode } from "@comis/core";
import { prepareVoicePayload } from "./voice-sender.js";

// ---------------------------------------------------------------------------
// Structural interfaces (avoids circular dep on @comis/skills)
// ---------------------------------------------------------------------------

/**
 * Structural subset of AudioConverter (declared locally -- NOT imported
 * from voice-sender.ts where it is not exported).
 */
export interface AudioConverterLike {
  toOggOpus(
    inputPath: string,
    outputPath: string,
  ): Promise<Result<{ readonly durationMs: number }, Error>>;
  verifyOpusCodec(filePath: string): Promise<Result<boolean, Error>>;
  extractWaveform(
    inputPath: string,
    tempDir: string,
  ): Promise<Result<{ readonly waveformBase64: string }, Error>>;
}

/**
 * Resolved output format with provider-specific format strings.
 * Structural match for ResolvedOutputFormat from tts-output-format.ts,
 * intentionally omitting voiceCompatible (pipeline uses mimeType detection).
 */
export interface ResolvedOutputFormatLike {
  readonly openai: string;
  readonly elevenlabs: string;
  readonly edge: string;
  readonly extension: string;
}

/**
 * Dependencies for the voice response pipeline.
 * All structural interfaces -- NO imports from @comis/skills.
 */
export interface VoiceResponsePipelineDeps {
  /** TTS adapter for speech synthesis. */
  readonly ttsAdapter: {
    synthesize(
      text: string,
      options?: { voice?: string; format?: string },
    ): Promise<Result<{ audio: Buffer; mimeType: string }, Error>>;
  };
  /** Audio converter for MP3-to-OGG/Opus conversion (undefined if ffmpeg not available). */
  readonly audioConverter: AudioConverterLike | undefined;
  /** Temp directory manager (returns undefined before init()). */
  readonly mediaTempManager: { getManagedDir(): string | undefined };
  /** Concurrency limiter using run() pattern (FIFO queue via p-queue). */
  readonly mediaSemaphore: {
    run<T>(fn: () => Promise<T>): Promise<T>;
  };
  /** Auto-TTS decision function. */
  readonly shouldAutoTts: (
    config: { autoMode: TtsAutoMode; tagPattern: string },
    ctx: {
      responseText: string;
      hasInboundAudio: boolean;
      hasMediaUrl: boolean;
    },
  ) => { shouldSynthesize: boolean; strippedText?: string };
  /** Output format resolver per channel type. */
  readonly resolveOutputFormat: (
    channelType: string | undefined,
    outputFormats?: Record<string, string>,
  ) => ResolvedOutputFormatLike;
  /** TTS configuration. */
  readonly ttsConfig: {
    autoMode: TtsAutoMode;
    tagPattern: string;
    voice?: string;
    maxTextLength: number;
    outputFormats?: Record<string, string>;
    providerFormatKey?: "openai" | "elevenlabs" | "edge";
  };
  /** Structured logger. */
  readonly logger: {
    debug(obj: Record<string, unknown>, msg: string): void;
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/**
 * Context for a single voice response execution.
 */
export interface VoiceResponseContext {
  /** Agent's text response to potentially synthesize. */
  readonly responseText: string;
  /** Original inbound message (check for voice attachment). */
  readonly originalMessage: {
    attachments?: ReadonlyArray<{
      type?: string;
      isVoiceNote?: boolean;
    }>;
  };
  /** Channel adapter for sending the voice attachment. */
  readonly adapter: {
    sendAttachment(
      channelId: string,
      payload: {
        type: "image" | "file" | "audio" | "video";
        url: string;
        mimeType?: string;
        isVoiceNote?: boolean;
        durationSecs?: number;
        waveform?: string;
      },
      options?: SendMessageOptions,
    ): Promise<Result<unknown, Error>>;
  };
  /** Channel type (e.g., "telegram", "discord"). */
  readonly channelType: string;
  /** Channel/chat ID for sending. */
  readonly channelId: string;
  /** Thread context for routing voice to forum topics. */
  readonly sendOptions?: SendMessageOptions;
}

/**
 * Result of a voice response pipeline execution.
 */
export interface VoiceResponseResult {
  /** Whether a voice message was successfully sent. */
  readonly voiceSent: boolean;
  /** Text with TTS directives stripped (for tagged mode). */
  readonly cleanedText?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a MIME type indicates OGG/Opus (no conversion needed for prepareVoicePayload input). */
function isOggOpusMime(mimeType: string): boolean {
  return (
    mimeType === "audio/ogg" ||
    mimeType === "audio/opus" ||
    mimeType === "audio/ogg; codecs=opus"
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Execute the voice response pipeline: auto-TTS decision -> synthesis ->
 * conversion -> voice attachment delivery.
 *
 * All error paths return ok({ voiceSent: false }) so text delivery can
 * proceed as fallback.
 *
 * @param deps - Pipeline dependencies (TTS adapter, audio converter, etc.)
 * @param ctx - Execution context (response text, original message, adapter)
 * @returns voiceSent:true on success, voiceSent:false on skip/failure
 */
export async function executeVoiceResponse(
  deps: VoiceResponsePipelineDeps,
  ctx: VoiceResponseContext,
): Promise<Result<VoiceResponseResult, Error>> {
  const startMs = Date.now();

  deps.logger.debug(
    { channelType: ctx.channelType },
    "Voice response pipeline started",
  );

  // Step 1: Detect inbound voice
  const hasInboundAudio =
    ctx.originalMessage.attachments?.some(
      (a) => a.isVoiceNote === true,
    ) ?? false;

  // Step 2: Auto-TTS decision
  const decision = deps.shouldAutoTts(
    { autoMode: deps.ttsConfig.autoMode, tagPattern: deps.ttsConfig.tagPattern },
    { responseText: ctx.responseText, hasInboundAudio, hasMediaUrl: false },
  );

  if (!decision.shouldSynthesize) {
    deps.logger.debug(
      { channelType: ctx.channelType, durationMs: Date.now() - startMs, reason: "auto-tts-skip" },
      "Voice response skipped",
    );
    return ok({ voiceSent: false });
  }

  // Step 3: Resolve output format
  const resolved = deps.resolveOutputFormat(
    ctx.channelType,
    deps.ttsConfig.outputFormats,
  );

  // Step 4: Select provider-specific format string
  const providerKey = deps.ttsConfig.providerFormatKey ?? "openai";
  const formatForProvider = resolved[providerKey];

  // Step 5: Truncate text if needed
  let text = decision.strippedText ?? ctx.responseText;
  if (text.length > deps.ttsConfig.maxTextLength) {
    deps.logger.warn(
      {
        originalLength: text.length,
        maxTextLength: deps.ttsConfig.maxTextLength,
        hint: "Text truncated before TTS synthesis",
        errorKind: "validation",
      },
      "TTS text truncated",
    );
    text = text.slice(0, deps.ttsConfig.maxTextLength);
  }

  // Step 6: Run TTS + conversion + send inside mediaSemaphore
  return await deps.mediaSemaphore.run(async () => {
    // Step 7: Synthesize
    const synthResult = await deps.ttsAdapter.synthesize(text, {
      voice: deps.ttsConfig.voice,
      format: formatForProvider,
    });

    if (!synthResult.ok) {
      deps.logger.warn(
        {
          err: synthResult.error.message,
          channelType: ctx.channelType,
          hint: "TTS synthesis failed; falling back to text-only response",
          errorKind: "dependency",
        },
        "TTS synthesis failed",
      );
      return ok({ voiceSent: false, cleanedText: decision.strippedText });
    }

    // Step 8: Check if conversion is needed
    const needsConversion = !isOggOpusMime(synthResult.value.mimeType);

    if (needsConversion && !deps.audioConverter) {
      deps.logger.warn(
        {
          mimeType: synthResult.value.mimeType,
          channelType: ctx.channelType,
          hint: "Install ffmpeg for voice response support with Edge TTS/ElevenLabs providers",
          errorKind: "dependency",
        },
        "Audio converter unavailable for non-Opus TTS output",
      );
      return ok({ voiceSent: false, cleanedText: decision.strippedText });
    }

    // Step 9: Get temp dir with null guard
    const managedDir = deps.mediaTempManager.getManagedDir();
    if (managedDir === undefined) {
      deps.logger.warn(
        {
          channelType: ctx.channelType,
          hint: "Media temp manager not initialized",
          errorKind: "resource",
        },
        "Media temp manager not initialized",
      );
      return ok({ voiceSent: false, cleanedText: decision.strippedText });
    }

    // Write TTS output to temp file
    const tempInputPath = safePath(
      managedDir,
      `tts-${randomUUID()}${resolved.extension}`,
    );
    await writeFile(tempInputPath, synthResult.value.audio);

    // Step 10: Always call prepareVoicePayload (handles conversion, codec verify,
    // waveform extraction, and duration probing for ALL audio types)
    const payloadResult = await prepareVoicePayload(tempInputPath, {
      audioConverter: deps.audioConverter!,
      tempDir: managedDir,
      logger: deps.logger,
    });

    if (!payloadResult.ok) {
      deps.logger.warn(
        {
          err: payloadResult.error.message,
          channelType: ctx.channelType,
          hint: "Voice payload preparation failed; falling back to text-only response",
          errorKind: "dependency",
        },
        "Voice payload preparation failed",
      );
      return ok({ voiceSent: false, cleanedText: decision.strippedText });
    }

    const payload = payloadResult.value;

    // Step 11: Send voice attachment
    const sendResult = await ctx.adapter.sendAttachment(ctx.channelId, {
      type: "audio",
      url: payload.oggPath,
      mimeType: "audio/ogg; codecs=opus",
      isVoiceNote: true,
      durationSecs: payload.durationSecs,
      waveform: payload.waveformBase64,
    }, ctx.sendOptions);

    // Step 12: Handle send failure
    if (!sendResult.ok) {
      deps.logger.warn(
        {
          err: sendResult.error.message,
          channelType: ctx.channelType,
          hint: "Voice attachment send failed; falling back to text-only response",
          errorKind: "network",
        },
        "Voice attachment send failed",
      );
      return ok({ voiceSent: false, cleanedText: decision.strippedText });
    }

    // Step 13: Success
    deps.logger.info(
      {
        channelType: ctx.channelType,
        durationMs: Date.now() - startMs,
        durationSecs: payload.durationSecs,
      },
      "Voice response sent",
    );

    return ok({ voiceSent: true, cleanedText: decision.strippedText });
  });
}
