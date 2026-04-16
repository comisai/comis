/**
 * Shared helpers for TTS and STT adapters.
 *
 * Centralizes sanitizeApiError (previously duplicated across 6 adapters)
 * and mimeToExtension (previously duplicated across OpenAI STT and Groq STT).
 *
 * @module media-adapter-shared
 */

/** Truncate and sanitize an API error body for user-facing error messages. */
export function sanitizeApiError(status: number, body: string, provider: string): string {
  const truncated = body.length > 200 ? body.slice(0, 200) + "..." : body;
  const cleaned = truncated
    .replace(/https?:\/\/[^\s"')]+/g, "[URL]")
    .replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
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
