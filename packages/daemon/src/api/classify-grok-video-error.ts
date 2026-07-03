// SPDX-License-Identifier: Apache-2.0
/**
 * Pure classifier for xAI Grok Imagine video-generation failures.
 *
 * Grok signals failure FOUR ways — a
 * RICHER union than FAL (which has NO terminal failed status — a failure is a
 * THROW) and slightly richer than Veo (which has only `operation.error`):
 *   1. a thrown SDK/HTTP error from the REST `fetch` (a non-2xx submit/poll), or
 *   2. a terminal `status:"failed"` with an `error: { code?, message? }` payload, or
 *   3. a terminal `status:"expired"` (the render expired before download — the
 *      output URL is gone), or
 *   4. a `done`-with-no-`video.url` (the `emptyResult` case).
 *
 * This mapper turns any of those into a typed `{ videoErrorKind, hint }`. It
 * mirrors `classify-veo-video-error.ts` / `classify-fal-video-error.ts` and is
 * the ONLY place ad-hoc 401/moderation substring matching is allowed ("Don't
 * Hand-Roll"). Because the Grok `error` is a plain `{ code?, message? }` object
 * (NOT an Error), the classifier stringifies a non-Error input (the `message`
 * field if present, else JSON, else String) so the substring match still works.
 *
 * STATUS UNION (DIFFERS from FAL): a `status:"expired"` with no error payload
 * defaults to `empty_response` (the render is gone — retry); a `status:"failed"`
 * is classified by its error-payload substring (a moderation `failed` →
 * content_blocked; a generic `failed` → empty_response). In BOTH cases, an error
 * payload that substring-matches auth/quota/content still takes precedence over
 * the bare expired default (so an `expired`-with-an-auth-error classifies as
 * auth_required, not empty_response).
 *
 * SECURITY: the raw provider message is inspected ONLY for classification. For
 * `auth_required` the hint is a FIXED `XAI_API_KEY`/SuperGrok string (NOT the
 * message), so a credential — or a fake `Bearer xai-…` — echoed into an auth
 * error never round-trips into the hint (the SEC test pins the embedded-fake-
 * bearer absence). The quota/content hints are also fixed. The generic fallback
 * echoes the message text (a 5xx/transport string), which the adapter never logs
 * — but it carries no key because Grok auth errors classify as `auth_required`
 * above before reaching the fallback.
 *
 * @module
 */
import type { VideoErrorKind } from "@comis/core";

export function classifyGrokVideoError(
  error: unknown,
  opts?: { emptyResult?: boolean; status?: "failed" | "expired" },
): { videoErrorKind: VideoErrorKind; hint: string } {
  // done-but-no-video.url — the explicit empty-result signal from fetchResult.
  if (opts?.emptyResult) {
    return {
      videoErrorKind: "empty_response",
      hint: "xAI reported the render done but returned no video URL. Retry; no downloadable clip was produced.",
    };
  }

  const msg = stringifyError(error);
  const lower = msg.toLowerCase();

  // AUTH first — inspect ONLY for classification; emit a FIXED hint (NEVER echo
  // the message → no key/bearer leak). xAI rejects a bad key with a 401/403; an
  // embedded credential (or a fake `Bearer xai-…`) in that message must not
  // survive into the hint.
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("api key") ||
    lower.includes("api_key") ||
    lower.includes("invalid key") ||
    lower.includes("authentication")
  ) {
    return {
      videoErrorKind: "auth_required",
      hint: "xAI rejected the credentials. Check the XAI_API_KEY secret (or your SuperGrok login).",
    };
  }

  if (
    lower.includes("moderation") ||
    lower.includes("safety") ||
    lower.includes("content policy") ||
    lower.includes("content_policy") ||
    lower.includes("blocked") ||
    lower.includes("nsfw") ||
    lower.includes("rejected")
  ) {
    return {
      videoErrorKind: "content_blocked",
      hint: "xAI blocked the prompt by moderation. Revise the prompt and retry.",
    };
  }

  if (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("insufficient credits") ||
    lower.includes("billing")
  ) {
    return {
      videoErrorKind: "quota_exceeded",
      hint: "xAI reported a quota/rate/credits limit. Reduce frequency or check billing, then retry.",
    };
  }

  // Expired branch — a terminal `status:"expired"` with no auth/quota/
  // content substring match: the render expired before it could be downloaded.
  // (An expired-with-an-auth/quota/content error classifies above and never
  // reaches here; this is the bare-expired default.)
  if (opts?.status === "expired") {
    return {
      videoErrorKind: "empty_response",
      hint: "The xAI video render expired before it could be downloaded. Retry the generation.",
    };
  }

  // Generic dependency failure (a `status:"failed"` generic message, or a
  // 5xx/transport string). The message text here is a provider/HTTP string, not
  // a credential (auth errors classify above before reaching the fallback).
  return { videoErrorKind: "empty_response", hint: `xAI request failed: ${msg}` };
}

/**
 * Coerce an unknown error to a string for substring matching. The Grok `error`
 * is a plain `{ code?, message? }` object — prefer its `message` field, else
 * JSON-stringify it (so a `code`/`status` field is matchable), else fall back to
 * `String(...)` for an Error (uses its `message`) or a non-serializable value.
 */
function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object") {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
