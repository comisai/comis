// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

// ─── Transcription ───────────────────────────────────────────────────

/**
 * Options for audio transcription.
 */
export interface TranscriptionOptions {
  /** MIME type of the audio buffer (e.g. "audio/ogg", "audio/mp3") */
  readonly mimeType: string;
  /** BCP-47 language hint (e.g. "en", "es"). Provider may auto-detect if omitted. */
  readonly language?: string;
  /** Optional prompt/context to guide transcription accuracy. */
  readonly prompt?: string;
}

/**
 * Result of a successful transcription.
 */
export interface TranscriptionResult {
  /** Transcribed text. */
  readonly text: string;
  /** Detected or confirmed language (BCP-47). */
  readonly language?: string;
  /** Duration of the audio in milliseconds. */
  readonly durationMs?: number;
}

/**
 * TranscriptionPort: Hexagonal boundary for speech-to-text services.
 *
 * Adapters (OpenAI Whisper, local whisper.cpp, etc.) implement this
 * interface to convert audio buffers into text.
 */
export interface TranscriptionPort {
  /**
   * Transcribe an audio buffer to text.
   *
   * @param audio - Raw audio data
   * @param options - MIME type, language hint, optional prompt
   * @returns Transcription result or an error (e.g. file too large, API failure)
   */
  transcribe(
    audio: Buffer,
    options: TranscriptionOptions,
  ): Promise<Result<TranscriptionResult, Error>>;
}
