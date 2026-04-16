/**
 * Audio attachment handler for media preprocessor.
 *
 * Extracts and processes audio attachments: preflight transcription check,
 * resolve attachment, transcribe via TranscriptionPort, logging.
 *
 * @module
 */

import type { Attachment, TranscriptionPort } from "@comis/core";
import type { MediaProcessorLogger } from "./media-preprocessor.js";
import { resolveMediaAttachment } from "./media-handler-factory.js";

/** Deps subset needed by the audio handler. */
export interface AudioHandlerDeps {
  readonly transcriber?: TranscriptionPort;
  readonly resolveAttachment: (attachment: Attachment) => Promise<Buffer | null>;
  readonly logger: MediaProcessorLogger;
}

/** Result produced by audio processing. */
export interface AudioHandlerResult {
  textPrefix?: string;
  transcription?: { attachmentUrl: string; text: string; language?: string };
}

/**
 * Process a single audio attachment.
 *
 * - If no transcriber, returns hint text prefix.
 * - If att.transcription exists (preflight), reuses it.
 * - Otherwise resolves + transcribes via TranscriptionPort.
 */
export async function processAudioAttachment(
  att: Attachment,
  deps: AudioHandlerDeps,
  buildHint: (att: Attachment) => string,
): Promise<AudioHandlerResult> {
  if (!deps.transcriber) {
    deps.logger.debug?.({ url: att.url, reason: "no-transcriber" }, "Audio skipped: no transcriber");
    return { textPrefix: buildHint(att) };
  }

  // Skip if already transcribed by preflight
  if (att.transcription) {
    deps.logger.debug?.({ url: att.url, reason: "preflight" }, "Audio attachment already transcribed, reusing");
    return {
      textPrefix: `[Voice message transcription]: ${att.transcription}`,
      transcription: { attachmentUrl: att.url, text: att.transcription },
    };
  }

  const buffer = await resolveMediaAttachment(att, deps.resolveAttachment, deps.logger, "Audio");
  if (!buffer) return {};

  const sttStart = Date.now();
  try {
    const result = await deps.transcriber.transcribe(buffer, {
      mimeType: att.mimeType ?? "audio/ogg",
    });

    if (result.ok) {
      const durationMs = Date.now() - sttStart;
      deps.logger.info(
        { url: att.url, language: result.value.language },
        "Audio attachment transcribed",
      );
      deps.logger.debug?.({ url: att.url, mimeType: att.mimeType, reason: "stt", durationMs }, "Audio attachment transcribed");
      return {
        textPrefix: `[Voice message transcription]: ${result.value.text}`,
        transcription: {
          attachmentUrl: att.url,
          text: result.value.text,
          language: result.value.language,
        },
      };
    } else {
      deps.logger.warn({ url: att.url, error: result.error.message, hint: "STT provider returned error; voice message will not be transcribed", errorKind: "dependency" as const }, "Transcription failed");
      deps.logger.debug?.({ url: att.url, reason: "stt-failed", err: result.error.message }, "Transcription failed");
    }
  } catch (e) {
    deps.logger.warn({ url: att.url, error: String(e), hint: "Unexpected STT error; voice message will not be transcribed", errorKind: "internal" as const }, "Transcription threw unexpectedly");
    deps.logger.debug?.({ url: att.url, reason: "stt-failed", err: String(e) }, "Transcription threw unexpectedly");
  }

  return {};
}
