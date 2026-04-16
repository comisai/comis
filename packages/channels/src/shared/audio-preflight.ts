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

import type { NormalizedMessage, Attachment, TranscriptionPort } from "@comis/core";

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
  /** Logger for preflight operations. */
  logger: PreflightLogger;
}

interface PreflightLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PreflightResult {
  /** The message, potentially enriched with transcript text. */
  message: NormalizedMessage;
  /** Whether transcription occurred. */
  transcribed: boolean;
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
      { url: audioAtt.url, err: String(e), hint: "Audio preflight check failed; voice processing will be skipped", errorKind: "network" },
      "Preflight resolve failed",
    );
    return { message: msg, transcribed: false };
  }
  if (!buffer) return { message: msg, transcribed: false };

  // Transcribe
  const result = await deps.transcriber.transcribe(buffer, {
    mimeType: audioAtt.mimeType ?? "audio/ogg",
  });
  if (!result.ok) {
    deps.logger.warn(
      { url: audioAtt.url, err: result.error.message, hint: "Audio preflight resolution failed; voice processing will be skipped", errorKind: "dependency" },
      "Preflight transcription failed",
    );
    return { message: msg, transcribed: false };
  }

  const transcript = result.value.text;
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
  const transcriptLower = transcript.toLowerCase();
  const mentionedByVoice = deps.botNames.some(
    (name) => name.length > 0 && transcriptLower.includes(name.toLowerCase()),
  );

  const updatedMetadata = { ...(msg.metadata ?? {}) };
  if (mentionedByVoice) {
    updatedMetadata.isBotMentioned = true;
    deps.logger.debug(
      { botNames: deps.botNames },
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
  };
}
