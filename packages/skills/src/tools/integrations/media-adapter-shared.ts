// SPDX-License-Identifier: Apache-2.0
/**
 * Shared helpers for TTS and STT adapters.
 *
 * Centralizes sanitizeApiError (previously duplicated across 6 adapters)
 * and mimeToExtension (previously duplicated across OpenAI STT and Groq STT).
 *
 * @module media-adapter-shared
 */

/**
 * Redact a free-text error/diagnostic string: strip URLs (`[URL]`) and long
 * tokens (`[REDACTED]`). The single source of truth for the SEC-01 redaction
 * regex — reused by {@link sanitizeApiError} (adapter API-error bodies) and by
 * the inbound voice handler's structured-log lines (so a credential can never
 * reach a log line even if an upstream message was not pre-sanitized; the
 * §2.7 "never log a secret at any level" floor / defense-in-depth).
 */
export function redactErrorMessage(body: string): string {
  return (
    body
      .replace(/https?:\/\/[^\s"')]+/g, "[URL]")
      // Drop the bare `Authorization:`/`Bearer` credential-scheme markers (the
      // token that follows is already caught by the long-token rule below) so
      // the line carries no credential context at all.
      .replace(/\bAuthorization:/gi, "")
      .replace(/\bBearer\b/gi, "")
      // eslint-disable-next-line no-restricted-syntax -- media adapter API-error sanitization (not the Pino censor literal)
      .replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
  );
}

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
