import type { TranscriptionPort, TranscriptionOptions, TranscriptionResult } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { sanitizeApiError, mimeToExtension } from "./media-adapter-shared.js";

/**
 * Configuration for the Groq STT adapter.
 */
export interface GroqSttConfig {
  /** Groq API key. */
  readonly apiKey: string;
  /** Model to use (default: "whisper-large-v3-turbo"). */
  readonly model?: string;
  /** Groq API base URL (default: "https://api.groq.com/openai/v1"). */
  readonly baseUrl?: string;
  /** Request timeout in milliseconds (default: 60000). */
  readonly timeoutMs?: number;
  /** Maximum file size in megabytes (default: 25). */
  readonly maxFileSizeMb?: number;
}

const DEFAULT_MODEL = "whisper-large-v3-turbo";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FILE_SIZE_MB = 25;

/**
 * Create a Groq STT adapter using whisper-large-v3-turbo.
 *
 * Groq's API is OpenAI-compatible but uses verbose_json response format,
 * which returns language detection and duration in addition to text.
 */
export function createGroqSttAdapter(config: GroqSttConfig): TranscriptionPort {
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
        const ext = mimeToExtension(options.mimeType);
        const uint8 = new Uint8Array(audio.byteLength);
        uint8.set(audio);
        const blob = new Blob([uint8], { type: options.mimeType });

        const formData = new FormData();
        formData.append("file", blob, `audio.${ext}`);
        formData.append("model", model);
        formData.append("response_format", "verbose_json");

        if (options.language) {
          formData.append("language", options.language);
        }
        if (options.prompt) {
          formData.append("prompt", options.prompt);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: formData,
            signal: controller.signal,
          });

          if (!response.ok) {
            const body = await response.text();
            return err(new Error(sanitizeApiError(response.status, body, "Groq STT")));
          }

          const data = (await response.json()) as {
            text: string;
            language?: string;
            duration?: number;
          };

          return ok({
            text: data.text,
            language: data.language,
            durationMs: data.duration != null ? Math.round(data.duration * 1000) : undefined,
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return err(new Error(`Groq STT timeout after ${timeoutMs}ms`));
        }
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
