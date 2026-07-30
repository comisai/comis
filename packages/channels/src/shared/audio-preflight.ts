// SPDX-License-Identifier: Apache-2.0
/**
 * Audio Preflight: Pre-mention-gate voice transcription for group chats.
 *
 * Transcribes the first audio attachment BEFORE the auto-reply engine
 * evaluates mentions, enabling voice messages that verbally mention the
 * bot name to trigger agent processing in mention-gated group chats.
 *
 * Flow: receive -> audio preflight -> preprocessMessage -> compression -> auto-reply gate
 *
 * Detects voice mentions via STT before the mention gate.
 * Sets att.transcription so preprocessMessage skips re-transcription.
 *
 * @module
 */

import type {
  Attachment,
  ClockPort,
  NormalizedMessage,
  SttPreprocessReceipt,
  SttPreprocessSelection,
  TranscriptionPort,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightDeps {
  /** STT transcriber for audio content. */
  transcriber: TranscriptionPort;
  /** Resolve attachment URI to buffer. */
  resolveAttachment: (att: Attachment) => Promise<Buffer | null>;
  /** Bot name(s) to search for in transcript. */
  botNames: string[];
  /** Clock used for deterministic preflight boundary timing. */
  clock: ClockPort;
  /** Boot-resolved STT provider selection for content-free evidence. */
  sttSelection?: SttPreprocessSelection;
  /** Logger for preflight operations. */
  logger: PreflightLogger;
}

interface PreflightLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PreflightResult {
  /** The message, potentially enriched with transcript text. */
  message: NormalizedMessage;
  /** Whether transcription occurred. */
  transcribed: boolean;
  /** Trusted content-free evidence for the pre-mention STT boundary. */
  sttReceipt?: SttPreprocessReceipt;
}

function mentionVariants(name: string): string[] {
  const canonical = name
    .normalize("NFKC")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  const spaced = canonical
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compact = spaced.replace(/\s+/g, "");
  return [...new Set([canonical, spaced, compact])]
    .filter((variant) => variant.length > 0);
}

function containsBoundedPhrase(text: string, phrase: string): boolean {
  const textChars = [...text];
  const phraseChars = [...phrase];
  if (phraseChars.length === 0 || phraseChars.length > textChars.length) return false;

  for (let start = 0; start <= textChars.length - phraseChars.length; start += 1) {
    const matches = phraseChars.every(
      (character, offset) => textChars[start + offset] === character,
    );
    if (!matches) continue;
    const before = textChars[start - 1];
    const after = textChars[start + phraseChars.length];
    const startsAtBoundary = before === undefined || !/[\p{L}\p{N}]/u.test(before);
    const endsAtBoundary = after === undefined || !/[\p{L}\p{N}]/u.test(after);
    if (startsAtBoundary && endsAtBoundary) return true;
  }
  return false;
}

function transcriptMentionsBot(transcript: string, botNames: readonly string[]): boolean {
  const normalizedTranscript = transcript
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ");
  return botNames.some((name) =>
    mentionVariants(name).some((variant) =>
      containsBoundedPhrase(normalizedTranscript, variant),
    ));
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Transcribe the first untranscribed audio attachment and enrich the message.
 *
 * Sets `att.transcription` on the audio attachment (dedup marker to skip re-transcription),
 * appends transcript text to `msg.text` for mention detection, and sets
 * `metadata.isBotMentioned = true` if the transcript contains any of the
 * configured bot names.
 *
 * @param deps - Transcriber, resolver, bot names, and logger
 * @param msg - The incoming normalized message
 * @returns PreflightResult with enriched message and transcription flag
 */
export async function audioPreflight(
  deps: PreflightDeps,
  msg: NormalizedMessage,
): Promise<PreflightResult> {
  // Find first audio attachment without existing transcription
  const audioAtt = msg.attachments?.find(
    (a) =>
      (a.type === "audio" || a.mimeType?.startsWith("audio/")) && !a.transcription,
  );
  if (!audioAtt) return { message: msg, transcribed: false };

  // Resolve audio data
  let buffer: Buffer | null;
  try {
    buffer = await deps.resolveAttachment(audioAtt);
  } catch (e) {
    deps.logger.warn(
      { url: audioAtt.url, err: String(e), hint: "Audio preflight check failed; voice processing will be skipped", errorKind: "network" as const },
      "Preflight resolve failed",
    );
    return { message: msg, transcribed: false };
  }
  if (!buffer) return { message: msg, transcribed: false };

  // Transcribe
  const startedAt = deps.clock.now();
  const result = await deps.transcriber.transcribe(buffer, {
    mimeType: audioAtt.mimeType ?? "audio/ogg",
  });
  const durationMs = Math.max(0, deps.clock.now() - startedAt);
  if (!result.ok) {
    deps.logger.warn(
      {
        url: audioAtt.url,
        err: result.error.message,
        durationMs,
        audioBytes: buffer.byteLength,
        hint: "Audio preflight resolution failed; voice processing will be skipped",
        errorKind: "dependency" as const,
      },
      "Preflight transcription failed",
    );
    return { message: msg, transcribed: false };
  }

  const transcript = result.value.text;
  const sttReceipt: SttPreprocessReceipt | undefined =
    deps.sttSelection === undefined
      ? undefined
      : {
          provider: deps.sttSelection.provider,
          keyless: deps.sttSelection.keyless,
          ...(deps.sttSelection.model !== undefined
            ? { model: deps.sttSelection.model }
            : {}),
          source: deps.sttSelection.source,
          ...(deps.sttSelection.onSkip !== undefined
            ? { onSkip: deps.sttSelection.onSkip }
            : {}),
          outcome: "ok",
          durationMs,
          audioBytes: buffer.byteLength,
        };
  deps.logger.info(
    {
      step: "audio-preflight",
      durationMs,
      audioBytes: buffer.byteLength,
      transcriptChars: transcript.length,
      ...(deps.sttSelection !== undefined
        ? {
            provider: deps.sttSelection.provider,
            keyless: deps.sttSelection.keyless,
            source: deps.sttSelection.source,
          }
        : {}),
    },
    "Audio preflight transcription complete",
  );
  deps.logger.debug(
    { url: audioAtt.url, transcriptLen: transcript.length },
    "Preflight transcription complete",
  );

  // Mark attachment as already transcribed to skip re-transcription
  const updatedAttachments = (msg.attachments ?? []).map((a) =>
    a === audioAtt ? { ...a, transcription: transcript } : a,
  );

  // Inject transcript into message text for mention detection
  const enrichedText = msg.text ? `${msg.text}\n${transcript}` : transcript;

  // Check if transcript contains bot name -> set metadata.isBotMentioned
  const mentionedByVoice = transcriptMentionsBot(transcript, deps.botNames);

  const updatedMetadata = { ...(msg.metadata ?? {}) };
  if (mentionedByVoice) {
    updatedMetadata.isBotMentioned = true;
    deps.logger.debug(
      { botNameCount: deps.botNames.length },
      "Bot name detected in voice transcript",
    );
  }

  return {
    message: {
      ...msg,
      text: enrichedText,
      attachments: updatedAttachments,
      metadata: updatedMetadata,
    },
    transcribed: true,
    ...(sttReceipt !== undefined ? { sttReceipt } : {}),
  };
}
