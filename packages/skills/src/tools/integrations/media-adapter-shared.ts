// SPDX-License-Identifier: Apache-2.0
/**
 * Shared helpers for TTS and STT adapters.
 *
 * Centralizes sanitizeApiError (shared across 6 adapters) and mimeToExtension
 * (shared by the OpenAI STT and Groq STT adapters) so there is a single definition.
 *
 * @module media-adapter-shared
 */

import { redactErrorMessage } from "@comis/core";

/**
 * Re-export of the free-text error scrubber, which lives in
 * `@comis/core/security` so `@comis/channels` (the voice-OUT
 * pipeline, which deliberately does NOT import `@comis/skills`) can share the
 * SINGLE definition. This re-export keeps the ~6 existing adapter callers
 * (`media-handler-audio.ts`) and {@link sanitizeApiError} below importing it
 * from this module unchanged — there is no second copy of the regex.
 */
export { redactErrorMessage } from "@comis/core";

/** Truncate and sanitize an API error body for user-facing error messages. */
export function sanitizeApiError(status: number, body: string, provider: string): string {
  const truncated = body.length > 200 ? body.slice(0, 200) + "..." : body;
  const cleaned = redactErrorMessage(truncated);
  return `${provider} error (${status}): ${cleaned}`;
}

/**
 * Map MIME type to file extension for form-data filenames.
 * Used by OpenAI STT and Groq STT adapters where the API infers
 * audio format from the filename extension.
 */
export function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
  };
  return map[mimeType] ?? "ogg";
}
