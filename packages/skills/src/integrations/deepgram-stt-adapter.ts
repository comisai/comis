import type { TranscriptionPort, TranscriptionOptions, TranscriptionResult } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { sanitizeApiError } from "./media-adapter-shared.js";

/**
 * Configuration for the Deepgram STT adapter.
 */
export interface DeepgramSttConfig {
  /** Deepgram API key. */
  readonly apiKey: string;
  /** Model to use (default: "nova-3"). */
  readonly model?: string;
  /** Deepgram API base URL (default: "https://api.deepgram.com/v1"). */
  readonly baseUrl?: string;
  /** Request timeout in milliseconds (default: 60000). */
  readonly timeoutMs?: number;
  /** Maximum file size in megabytes (default: 25). */
  readonly maxFileSizeMb?: number;
}

const DEFAULT_MODEL = "nova-3";
const DEFAULT_BASE_URL = "https://api.deepgram.com/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FILE_SIZE_MB = 25;

/**
 * Deepgram API response structure for pre-recorded audio transcription.
 */
interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string; confidence?: number }>;
    }>;
  };
}

/**
 * Create a Deepgram STT adapter using nova-3.
 *
 * Deepgram uses a completely different API format from OpenAI/Groq:
 * - Auth: Token (not Bearer)
 * - Body: Raw binary audio (not FormData)
 * - Content-Type: Audio MIME type (not multipart/form-data)
 * - Config: Query parameters (not form fields)
 * - Response: Deeply nested JSON with channels/alternatives
 */
export function createDeepgramSttAdapter(config: DeepgramSttConfig): TranscriptionPort {
  const model = config.model ?? DEFAULT_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFileSizeMb = config.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB;

  return {
    async transcribe(
      audio: Buffer,
      options: TranscriptionOptions,
    ): Promise<Result<TranscriptionResult, Error>> {
      if (audio.byteLength === 0) {
        return err(new Error("Audio buffer is empty"));
      }

      const fileSizeMb = audio.byteLength / (1024 * 1024);
      if (fileSizeMb > maxFileSizeMb) {
        return err(
          new Error(
            `Audio file size ${fileSizeMb.toFixed(1)}MB exceeds limit of ${maxFileSizeMb}MB`,
          ),
        );
      }

      try {
        const params = new URLSearchParams({
          model,
          smart_format: "true",
        });

        if (options.language) {
          params.set("language", options.language);
        } else {
          params.set("detect_language", "true");
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${baseUrl}/listen?${params.toString()}`, {
            method: "POST",
            headers: {
              Authorization: `Token ${config.apiKey}`,
              "Content-Type": options.mimeType,
            },
            body: new Uint8Array(audio),
            signal: controller.signal,
          });

          if (!response.ok) {
            const body = await response.text();
            return err(new Error(sanitizeApiError(response.status, body, "Deepgram STT")));
          }

          const data = (await response.json()) as DeepgramResponse;
          const channel = data.results?.channels?.[0];
          const alt = channel?.alternatives?.[0];

          return ok({
            text: alt?.transcript ?? "",
            language: channel?.detected_language,
            durationMs: data.metadata?.duration != null
              ? Math.round(data.metadata.duration * 1000)
              : undefined,
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return err(new Error(`Deepgram STT timeout after ${timeoutMs}ms`));
        }
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
