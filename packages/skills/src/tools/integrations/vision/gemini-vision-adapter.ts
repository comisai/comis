// SPDX-License-Identifier: Apache-2.0
/**
 * Gemini vision adapter: Google Generative AI API integration for image and video analysis.
 *
 * Supports both image and video via the Gemini generateContent endpoint.
 * Uses inline_data parts with base64-encoded media.
 *
 * @module
 */

import type { VisionProvider, VisionRequest, VideoRequest, VisionResult } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { encodeVideoForApi } from "./video-handler.js";

/** Default Gemini model for vision tasks. */
const DEFAULT_MODEL = "gemini-2.5-flash";

/** Default Gemini API base URL. */
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Default max tokens for Gemini responses. */
const DEFAULT_MAX_TOKENS = 1024;

/** Default request timeout in milliseconds (120s for video). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Default video size limits (50MB raw, 70MB base64). */
const DEFAULT_VIDEO_MAX_RAW_BYTES = 50_000_000;
const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70_000_000;

/**
 * Configuration for the Gemini vision provider.
 */
export interface GeminiVisionConfig {
  /** Google API key. */
  readonly apiKey: string;
  /** Model to use (default: "gemini-2.5-flash"). */
  readonly model?: string;
  /** API base URL override. */
  readonly baseUrl?: string;
  /** Maximum raw video size in bytes (default: 50MB). */
  readonly videoMaxRawBytes?: number;
  /** Maximum base64-encoded video size in bytes (default: 70MB). */
  readonly videoMaxBase64Bytes?: number;
  /** Request timeout in milliseconds (default: 120000). */
  readonly timeoutMs?: number;
}

/**
 * Gemini API response shape (subset we care about).
 */
interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  usageMetadata?: {
    totalTokenCount?: number;
  };
}

/**
 * Build the Gemini generateContent endpoint URL.
 */
function buildEndpoint(baseUrl: string, model: string): string {
  return `${baseUrl}/models/${model}:generateContent`;
}

/**
 * Parse a Gemini API response into a VisionResult.
 */
function parseGeminiResponse(
  data: GeminiResponse,
  model: string,
): Result<VisionResult, Error> {
  const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!text) {
    return err(new Error("Gemini response contained no text content"));
  }

  return ok({
    text,
    provider: "google",
    model,
    tokensUsed: data.usageMetadata?.totalTokenCount,
  });
}

/**
 * Create a Gemini vision provider supporting both image and video analysis.
 *
 * Uses the Google Generative AI REST API with inline base64 data.
 *
 * @param config - API key and optional model/URL overrides
 * @returns VisionProvider with image and video capabilities
 */
export function createGeminiVisionProvider(config: GeminiVisionConfig): VisionProvider {
  const model = config.model ?? DEFAULT_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const videoMaxRawBytes = config.videoMaxRawBytes ?? DEFAULT_VIDEO_MAX_RAW_BYTES;
  const videoMaxBase64Bytes = config.videoMaxBase64Bytes ?? DEFAULT_VIDEO_MAX_BASE64_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "google",
    capabilities: ["image", "video"],

    async describeImage(req: VisionRequest): Promise<Result<VisionResult, Error>> {
      if (req.image.byteLength === 0) {
        return err(new Error("Image buffer is empty"));
      }

      const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
      const base64 = req.image.toString("base64");
      const endpoint = buildEndpoint(baseUrl, model);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inline_data: {
                      mime_type: req.mimeType,
                      data: base64,
                    },
                  },
                  { text: req.prompt },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: maxTokens,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const body = await response.text();
          return err(new Error(`Gemini API error (${response.status}): ${body}`));
        }

        const data = (await response.json()) as GeminiResponse;
        return parseGeminiResponse(data, model);
      } catch (error: unknown) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async describeVideo(req: VideoRequest): Promise<Result<VisionResult, Error>> {
      if (req.video.byteLength === 0) {
        return err(new Error("Video buffer is empty"));
      }

      const encoded = encodeVideoForApi(req.video, videoMaxBase64Bytes, videoMaxRawBytes);
      if (!encoded.ok) {
        return err(encoded.error);
      }

      const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
      const endpoint = buildEndpoint(baseUrl, model);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inline_data: {
                      mime_type: req.mimeType,
                      data: encoded.value.base64,
                    },
                  },
                  { text: req.prompt },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: maxTokens,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const body = await response.text();
          return err(new Error(`Gemini API error (${response.status}): ${body}`));
        }

        const data = (await response.json()) as GeminiResponse;
        return parseGeminiResponse(data, model);
      } catch (error: unknown) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
