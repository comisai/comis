// SPDX-License-Identifier: Apache-2.0
import type { TTSPort, TTSOptions, TTSResult } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { sanitizeApiError } from "./media-adapter-shared.js";

/**
 * Configuration for the OpenAI TTS adapter.
 */
export interface OpenAITTSAdapterConfig {
  /** OpenAI API key. */
  readonly apiKey: string;
  /** TTS model to use (default: "tts-1"). */
  readonly model?: string;
  /** OpenAI API base URL (default: "https://api.openai.com/v1"). */
  readonly baseUrl?: string;
}

const DEFAULT_MODEL = "tts-1";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_VOICE = "alloy";
const DEFAULT_FORMAT = "mp3";
const MAX_TEXT_LENGTH = 4096;

/**
 * Map audio format to MIME type.
 */
function formatToMimeType(format: string): string {
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    opus: "audio/opus",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/pcm",
  };
  return map[format] ?? "audio/mpeg";
}

/**
 * Create an OpenAI TTS adapter.
 *
 * Uses direct fetch() to OpenAI /v1/audio/speech endpoint.
 * Validates text length before making the API call.
 */
export function createOpenAITTSAdapter(config: OpenAITTSAdapterConfig): TTSPort {
  const model = config.model ?? DEFAULT_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  return {
    async synthesize(text: string, options?: TTSOptions): Promise<Result<TTSResult, Error>> {
      // Validate text length before processing
      if (text.length === 0) {
        return err(new Error("Text is empty"));
      }

      if (text.length > MAX_TEXT_LENGTH) {
        return err(
          new Error(`Text length ${text.length} exceeds maximum of ${MAX_TEXT_LENGTH} characters`),
        );
      }

      const voice = options?.voice ?? DEFAULT_VOICE;
      const format = options?.format ?? DEFAULT_FORMAT;
      const speed = options?.speed ?? 1.0;

      // Validate speed range
      if (speed < 0.25 || speed > 4.0) {
        return err(new Error(`Speed ${speed} is out of range (0.25 to 4.0)`));
      }

      try {
        const response = await fetch(`${baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: text,
            voice,
            response_format: format,
            speed,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          return err(new Error(sanitizeApiError(response.status, body, "OpenAI TTS")));
        }

        const arrayBuffer = await response.arrayBuffer();
        const audio = Buffer.from(arrayBuffer);

        return ok({
          audio,
          mimeType: formatToMimeType(format),
        });
      } catch (error: unknown) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
