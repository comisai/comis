// SPDX-License-Identifier: Apache-2.0
import type { TranscriptionPort, TranscriptionOptions, TranscriptionResult } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { sanitizeApiError, mimeToExtension } from "./media-adapter-shared.js";
import { systemClearTimeout, systemSetTimeout, validateLocalServerUrl } from "@comis/core";
import { fetchPinned } from "./pinned-fetch.js";

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
  /**
   * SSRF guard (Surface B): when `true`, the `baseUrl` is validated by
   * `validateLocalServerUrl` (the inverse SSRF guard — ALLOW loopback + an
   * explicit allowlist, DENY public/private egress, keep the cloud-metadata
   * deny) INSIDE `transcribe`, BEFORE the runtime fetch. Set ONLY by the
   * stt-factory `local.baseUrl` branch — an explicit `transcription.provider:
   * "local"` bypasses the boot probe (resolve-transcription-provider.ts:100), so
   * this validate-then-fetch is the SSRF guard for the explicit-local runtime
   * path. This adapter is SHARED with the cloud OpenAI path; the flag is UNSET
   * there so `api.openai.com` is never blocked by the local guard.
   */
  readonly localServerGuard?: boolean;
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

      // SSRF guard (Surface B): validate-then-PINNED-fetch. When this adapter is
      // built for a local whisper server (the stt-factory local.baseUrl branch
      // sets `localServerGuard`), the `baseUrl` is SSRF-validated BEFORE the
      // runtime fetch — an explicit transcription.provider:"local" bypasses the
      // boot probe, so this is the guard for that runtime path. Loopback + an
      // explicitly-allowed host pass; a non-loopback/metadata host is rejected
      // here, BEFORE the fetch fires. The cloud OpenAI path leaves the flag
      // unset, so api.openai.com is never validated by the local guard.
      //
      // Capture the resolved IP and PIN the connection to it (below) so a
      // hostname that resolves to loopback HERE cannot be rebound to a different
      // IP at connect time (the DNS-rebinding/TOCTOU gap a plain re-resolving
      // fetch leaves open). `validatedIp` stays undefined on the cloud path → the
      // cloud fetch is the unmodified global fetch (api.openai.com is a public IP
      // that pinning is neither needed for nor correct on).
      let validatedIp: string | undefined;
      if (config.localServerGuard) {
        const guard = await validateLocalServerUrl(baseUrl);
        if (!guard.ok) {
          return err(
            new Error(`Blocked local STT server URL: ${guard.error.message}`),
          );
        }
        validatedIp = guard.value.ip;
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
        const timeout = systemSetTimeout(() => controller.abort(), timeoutMs);
        try {
          const url = `${baseUrl}/audio/transcriptions`;
          const init = {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: formData,
            signal: controller.signal,
          };
          // The local-server path fetches through an undici dispatcher
          // PINNED to the IP `validateLocalServerUrl` already resolved (no DNS
          // rebind window; TLS SNI preserved by keeping the hostname in `url`).
          // The cloud path (validatedIp undefined) uses the unmodified global
          // fetch — the local pin must never touch api.openai.com.
          const response = validatedIp !== undefined
            ? await fetchPinned(url, validatedIp, init as Parameters<typeof fetchPinned>[2])
            : await fetch(url, init);

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
          systemClearTimeout(timeout);
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
