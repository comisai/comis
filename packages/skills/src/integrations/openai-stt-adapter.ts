import type { TranscriptionPort, TranscriptionOptions, TranscriptionResult } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { sanitizeApiError, mimeToExtension } from "./media-adapter-shared.js";

/**
 * Configuration for the OpenAI STT adapter.
 */
export interface OpenAISttConfig {
  /** OpenAI API key. */
  readonly apiKey: string;
  /** Model to use (default: "gpt-4o-mini-transcribe"). */
  readonly model?: string;
  /** OpenAI API base URL (default: "https://api.openai.com/v1"). */
  readonly baseUrl?: string;
  /** Request timeout in milliseconds (default: 60000). */
  readonly timeoutMs?: number;
  /** Maximum file size in megabytes (default: 25). */
  readonly maxFileSizeMb?: number;
}

const DEFAULT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FILE_SIZE_MB = 25;

/**
 * Create an OpenAI STT adapter using gpt-4o-mini-transcribe.
 *
 * Uses json response format (NOT verbose_json -- gpt-4o-mini-transcribe
 * only supports json). Returns text only; language and durationMs are
 * undefined because the json format does not include them.
 */
export function createOpenAISttAdapter(config: OpenAISttConfig): TranscriptionPort {
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
        formData.append("response_format", "json");

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
            return err(new Error(sanitizeApiError(response.status, body, "OpenAI STT")));
          }

          const data = (await response.json()) as { text: string };

          return ok({
            text: data.text,
            // gpt-4o-mini-transcribe json format does NOT return language or duration
            language: undefined,
            durationMs: undefined,
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return err(new Error(`OpenAI STT timeout after ${timeoutMs}ms`));
        }
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
