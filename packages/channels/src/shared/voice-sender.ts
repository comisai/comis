/**
 * Shared voice preparation pipeline: OGG/Opus conversion, codec verification,
 * waveform extraction, and duration probing.
 *
 * Converts arbitrary audio input to a validated OGG/Opus voice payload suitable
 * for platform-specific voice send APIs (Telegram sendVoice, WhatsApp ptt:true).
 *
 * Codec verification via AudioConverter.verifyOpusCodec.
 * Anti-pattern compliance: Waveform failure degrades gracefully (empty waveform)
 * instead of blocking voice send.
 *
 * Uses structural typing for AudioConverter to avoid circular dependency on
 * @comis/skills -- same pattern as telegram-resolver.ts, discord-resolver.ts.
 *
 * @module
 */

import * as crypto from "node:crypto";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath } from "@comis/core";

// ---------------------------------------------------------------------------
// Structural interfaces (avoids circular dep on @comis/skills)
// ---------------------------------------------------------------------------

/** Structural subset of ConversionResult (avoids circular dep on @comis/skills). */
interface ConversionResultLike {
  readonly durationMs: number;
}

/** Structural subset of WaveformResult (avoids circular dep on @comis/skills). */
interface WaveformResultLike {
  readonly waveformBase64: string;
}

/** Structural interface for AudioConverter (avoids circular dep on @comis/skills). */
interface AudioConverterLike {
  toOggOpus(inputPath: string, outputPath: string): Promise<Result<ConversionResultLike, Error>>;
  verifyOpusCodec(filePath: string): Promise<Result<boolean, Error>>;
  extractWaveform(inputPath: string, tempDir: string): Promise<Result<WaveformResultLike, Error>>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Prepared voice payload ready for platform-specific send APIs. */
export interface VoicePayload {
  readonly oggPath: string;
  readonly durationSecs: number;
  readonly waveformBase64: string;
  readonly codecVerified: boolean;
}

/** Dependencies for prepareVoicePayload. */
export interface VoicePrepareDeps {
  readonly audioConverter: AudioConverterLike;
  readonly tempDir: string;
  readonly logger: {
    debug(obj: Record<string, unknown>, msg: string): void;
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Convert audio to OGG/Opus, verify codec, extract waveform, and probe duration.
 *
 * Steps:
 * 1. Generate output path using safePath (NEVER path.join)
 * 2. Convert to OGG/Opus via AudioConverter
 * 3. Verify Opus codec
 * 4. Extract waveform (cosmetic, graceful degradation on failure)
 * 5. Return VoicePayload with all metadata
 *
 * @param inputPath - Path to the source audio file
 * @param deps - AudioConverter, temp directory, and logger
 * @returns VoicePayload on success, Error on conversion/codec failure
 */
export async function prepareVoicePayload(
  inputPath: string,
  deps: VoicePrepareDeps,
): Promise<Result<VoicePayload, Error>> {
  // 1. Generate output path using safePath (NEVER path.join)
  const outputPath = safePath(deps.tempDir, `voice-${crypto.randomUUID()}.ogg`);

  // 2. Convert to OGG/Opus
  const conversionResult = await deps.audioConverter.toOggOpus(inputPath, outputPath);
  if (!conversionResult.ok) {
    return err(conversionResult.error);
  }

  // 3. Verify Opus codec
  const verifyResult = await deps.audioConverter.verifyOpusCodec(outputPath);
  if (!verifyResult.ok) {
    return err(verifyResult.error);
  }
  if (!verifyResult.value) {
    return err(new Error("Codec verification failed: file is not OGG/Opus"));
  }

  // 4. Extract waveform (cosmetic -- graceful degradation on failure)
  let waveformBase64 = "";
  const waveformResult = await deps.audioConverter.extractWaveform(outputPath, deps.tempDir);
  if (waveformResult.ok) {
    waveformBase64 = waveformResult.value.waveformBase64;
  } else {
    deps.logger.warn(
      {
        err: waveformResult.error.message,
        hint: "Waveform extraction failed; voice will be sent without waveform preview",
        errorKind: "dependency",
      },
      "Waveform extraction failed",
    );
  }

  // 5. Calculate duration from conversion result
  const durationSecs = Math.round(conversionResult.value.durationMs / 1000);

  // Log success
  deps.logger.debug(
    { durationSecs, codecVerified: true, hasWaveform: waveformBase64.length > 0 },
    "Voice payload prepared",
  );

  return ok({
    oggPath: outputPath,
    durationSecs,
    waveformBase64,
    codecVerified: true,
  });
}
