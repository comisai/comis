// SPDX-License-Identifier: Apache-2.0
/**
 * Pure classifier for Google Veo video-generation failures (VEO-02).
 *
 * Veo signals failure two ways (RESEARCH §Veo operation → normalized status):
 *   1. a long-running `operation.error` (a `Record<string,unknown>`, NOT an
 *      Error) on a `.done` operation, or
 *   2. a thrown SDK error from `generateVideos`/`getVideosOperation` (HTTP 4xx/5xx),
 *      or a `.done` operation with no `generatedVideos` (the `emptyResult` case).
 *
 * This mapper turns any of those into a typed `{ videoErrorKind, hint }`. It
 * mirrors `classify-fal-video-error.ts` (the FAL classifier) and is the ONLY
 * place ad-hoc 401/moderation substring matching is allowed ("Don't Hand-Roll").
 * Because the Veo `operation.error` is a plain object, the classifier stringifies
 * a non-Error input (JSON when possible, else String) so the substring match
 * still works.
 *
 * SECURITY: the raw provider message is inspected ONLY for classification. For
 * `auth_required` the hint is a FIXED `GOOGLE_API_KEY` string (NOT the message),
 * so a credential echoed into an auth error never round-trips into the hint (the
 * SEC test pins the embedded-fake-key absence). The quota/content hints are also
 * fixed. The generic fallback echoes the message text (a 5xx/transport string),
 * which the adapter never logs — but it carries no key because Veo auth errors
 * classify as `auth_required` above before reaching the fallback.
 *
 * @module
 */
import type { VideoErrorKind } from "@comis/core";

export function classifyVeoVideoError(
  error: unknown,
  opts?: { emptyResult?: boolean },
): { videoErrorKind: VideoErrorKind; hint: string } {
  if (opts?.emptyResult) {
    return {
      videoErrorKind: "empty_response",
      hint: "Veo reported the operation done but returned no video. Retry; the render produced no downloadable clip.",
    };
  }

  const msg = stringifyError(error);
  const lower = msg.toLowerCase();

  // AUTH first — inspect ONLY for classification; emit a FIXED hint (NEVER echo
  // the message → no key leak). The Veo Dev-API rejects a bad key with a 401/403
  // PERMISSION_DENIED; an embedded credential in that message must not survive.
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("permission denied") ||
    lower.includes("permission") ||
    lower.includes("api key") ||
    lower.includes("api_key") ||
    lower.includes("credentials") ||
    lower.includes("invalid key")
  ) {
    return {
      videoErrorKind: "auth_required",
      hint: "Google rejected the credentials. Check the GOOGLE_API_KEY secret.",
    };
  }

  if (
    lower.includes("moderation") ||
    lower.includes("safety") ||
    lower.includes("content policy") ||
    lower.includes("content_policy") ||
    lower.includes("blocked") ||
    lower.includes("nsfw") ||
    lower.includes("responsible ai") ||
    lower.includes("rai")
  ) {
    return {
      videoErrorKind: "content_blocked",
      hint: "Veo blocked the prompt by safety/responsible-AI policy. Revise the prompt and retry.",
    };
  }

  if (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("resource exhausted") ||
    lower.includes("resource_exhausted")
  ) {
    return {
      videoErrorKind: "quota_exceeded",
      hint: "Google reported a quota/rate limit. Reduce request frequency and retry.",
    };
  }

  // Generic dependency failure (e.g. a 5xx / transport error). The message text
  // here is a provider/HTTP string, not a credential (auth errors classify above).
  return { videoErrorKind: "empty_response", hint: `Veo request failed: ${msg}` };
}

/**
 * Coerce an unknown error to a string for substring matching. The Veo
 * `operation.error` is a plain `Record<string,unknown>` — JSON-stringify it so
 * its `code`/`status`/`message` fields are matchable; fall back to `String(...)`
 * for an Error (uses its `message`) or a non-serializable value.
 */
function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
