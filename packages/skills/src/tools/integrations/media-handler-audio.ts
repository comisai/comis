// SPDX-License-Identifier: Apache-2.0
/**
 * Audio attachment handler for media preprocessor.
 *
 * Extracts and processes audio attachments: preflight transcription check,
 * resolve attachment, transcribe via TranscriptionPort, logging.
 *
 * @module
 */

import type { Attachment, TranscriptionPort } from "@comis/core";
import { wrapExternalContent, type WrapExternalContentOptions, systemNowMs } from "@comis/core";
import type { MediaProcessorLogger } from "./media-preprocessor.js";
import { resolveMediaAttachment } from "./media-handler-factory.js";
import { redactErrorMessage } from "./media-adapter-shared.js";

/** Deps subset needed by the audio handler. */
export interface AudioHandlerDeps {
  readonly transcriber?: TranscriptionPort;
  readonly resolveAttachment: (attachment: Attachment) => Promise<Buffer | null>;
  readonly logger: MediaProcessorLogger;
  /** Optional callback for suspicious content detection. */
  readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
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
    const wrapped = wrapExternalContent(
      `[Voice message transcription]: ${att.transcription}`,
      { source: "voice_transcription", onSuspiciousContent: deps.onSuspiciousContent },
    );
    return {
      textPrefix: wrapped,
      transcription: { attachmentUrl: att.url, text: att.transcription },
    };
  }

  const buffer = await resolveMediaAttachment(att, deps.resolveAttachment, deps.logger, "Audio");
  if (!buffer) return {};

  const sttStart = systemNowMs();
  try {
    const result = await deps.transcriber.transcribe(buffer, {
      mimeType: att.mimeType ?? "audio/ogg",
    });

    if (result.ok) {
      const durationMs = systemNowMs() - sttStart;
      // OBS-01 §2.7 INFO completion: carry the voice fields THIS skills tier can
      // see — durationMs (wall-clock) + audioBytes (inbound buffer length) —
      // alongside the existing language. provider/keyless/model are NOT visible
      // here (the handler receives a bare TranscriptionPort, not its resolved
      // config); the daemon RPC path (Phase 196 Plan 03) owns the full field set
      // on the trajectory. Omit the unknown fields rather than log undefined.
      deps.logger.info(
        { url: att.url, language: result.value.language, durationMs, audioBytes: buffer.byteLength },
        "Audio attachment transcribed",
      );
      deps.logger.debug?.({ url: att.url, mimeType: att.mimeType, reason: "stt", durationMs }, "Audio attachment transcribed");
      const wrapped = wrapExternalContent(
        `[Voice message transcription]: ${result.value.text}`,
        { source: "voice_transcription", onSuspiciousContent: deps.onSuspiciousContent },
      );
      return {
        textPrefix: wrapped,
        transcription: {
          attachmentUrl: att.url,
          text: result.value.text,
          language: result.value.language,
        },
      };
    } else {
      // OBS-01: canonical `err:` (the Pino `err` serializer key — `error:` is
      // silently dropped). SEC-01: redact the message before it reaches any log
      // line (defense-in-depth — the adapter already sanitizes its Result.err,
      // but the handler must never re-introduce a credential/URL).
      const errMsg = redactErrorMessage(result.error.message);
      deps.logger.warn({ url: att.url, err: errMsg, hint: "STT provider returned error; voice message will not be transcribed", errorKind: "dependency" as const }, "Transcription failed");
      deps.logger.debug?.({ url: att.url, reason: "stt-failed", err: errMsg }, "Transcription failed");
    }
  } catch (e) {
    const errMsg = redactErrorMessage(String(e));
    deps.logger.warn({ url: att.url, err: errMsg, hint: "Unexpected STT error; voice message will not be transcribed", errorKind: "internal" as const }, "Transcription threw unexpectedly");
    deps.logger.debug?.({ url: att.url, reason: "stt-failed", err: errMsg }, "Transcription threw unexpectedly");
  }

  return { textPrefix: "[Voice message received but transcription failed — ask the user to send a text message instead]" };
}
