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
      const text = result.value.text ?? "";
      const transcriptChars = text.trim().length;

      // Empty transcript despite ok:true — a silent gap the operator MUST see
      // (comis-daniel 2026-07-09: an 18KB ogg logged "transcribed" success but
      // produced no text, so the agent had nothing and the incident was invisible
      // in the logs — no transcriptChars/empty marker anywhere). Surface it as a
      // WARN carrying transcriptChars:0 + audioBytes, and hand the agent an HONEST
      // hint instead of an empty [Voice message transcription]: block (which would
      // also cross-contaminate paired memory with a blank transcription row).
      if (transcriptChars === 0) {
        deps.logger.warn(
          {
            url: att.url,
            language: result.value.language,
            durationMs,
            audioBytes: buffer.byteLength,
            transcriptChars: 0,
            hint: "STT returned success but the transcript was empty — the audio may be too short/quiet or its language unsupported by the configured provider; the voice message will not be transcribed",
            errorKind: "dependency" as const,
          },
          "Audio transcription empty",
        );
        return {
          textPrefix:
            "[Voice message received but the transcription came back empty — ask the user to resend it more clearly or to type the message]",
        };
      }

      // INFO completion: carry the voice fields THIS skills tier can
      // see — durationMs (wall-clock) + audioBytes (inbound buffer length) +
      // transcriptChars (output length) — alongside the existing language.
      // provider/keyless/model are NOT visible here (the handler receives a bare
      // TranscriptionPort, not its resolved config); the daemon RPC path owns the
      // full field set on the trajectory. Omit the unknown fields rather than log undefined.
      deps.logger.info(
        { url: att.url, language: result.value.language, durationMs, audioBytes: buffer.byteLength, transcriptChars },
        "Audio attachment transcribed",
      );
      deps.logger.debug?.({ url: att.url, mimeType: att.mimeType, reason: "stt", durationMs }, "Audio attachment transcribed");
      const wrapped = wrapExternalContent(
        `[Voice message transcription]: ${text}`,
        { source: "voice_transcription", onSuspiciousContent: deps.onSuspiciousContent },
      );
      return {
        textPrefix: wrapped,
        transcription: {
          attachmentUrl: att.url,
          text,
          language: result.value.language,
        },
      };
    } else {
      // Canonical `err:` (the Pino `err` serializer key — `error:` is
      // silently dropped). Redact the message before it reaches any log
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
