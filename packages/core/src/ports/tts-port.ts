// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

// ─── Text-to-Speech ──────────────────────────────────────────────────

/**
 * Options for text-to-speech synthesis.
 */
export interface TTSOptions {
  /** Voice identifier (provider-specific, e.g. "alloy", "nova"). */
  readonly voice?: string;
  /** Output audio format (e.g. "mp3", "opus", "aac", "flac"). */
  readonly format?: string;
  /** Playback speed multiplier (0.25 to 4.0). */
  readonly speed?: number;
}

/**
 * Result of a successful TTS synthesis.
 */
export interface TTSResult {
  /** Raw audio data. */
  readonly audio: Buffer;
  /** MIME type of the audio (e.g. "audio/mpeg", "audio/opus"). */
  readonly mimeType: string;
}

/**
 * TTSPort: Hexagonal boundary for text-to-speech services.
 *
 * Adapters (OpenAI TTS, ElevenLabs, local Piper, etc.) implement this
 * interface to synthesize audio from text.
 */
export interface TTSPort {
  /**
   * Synthesize text into audio.
   *
   * @param text - Text content to convert to speech
   * @param options - Voice, format, and speed configuration
   * @returns Audio buffer with MIME type, or an error
   */
  synthesize(text: string, options?: TTSOptions): Promise<Result<TTSResult, Error>>;
}
