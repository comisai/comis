// SPDX-License-Identifier: Apache-2.0
/**
 * Pure classifier for FAL video-generation failures.
 *
 * The FAL queue status union has only IN_QUEUE / IN_PROGRESS / COMPLETED — there
 * is NO "FAILED" status. FAL signals failure two ways:
 *   1. it THROWS from `queue.status()` / `queue.result()` (an HTTP 4xx/5xx), or
 *   2. it returns COMPLETED with no `video.url` (the `emptyResult` case).
 *
 * This mapper turns either into a typed `{ videoErrorKind, hint }`. It mirrors
 * the `classifyImageError` concept (pi-image-adapter.ts) and is the ONLY place
 * ad-hoc 401/moderation substring matching is allowed ("Don't Hand-Roll").
 *
 * SECURITY: the raw provider message is inspected ONLY for classification. For
 * `auth_required` the hint is a FIXED FAL_KEY string (NOT the message), so a
 * credential echoed into an auth error never round-trips into the hint. The
 * generic fallback echoes the message text (a 5xx/transport string), which the
 * adapter never logs — but it carries no key because FAL auth errors classify
 * as `auth_required` above before reaching the fallback.
 *
 * @module
 */
import type { VideoErrorKind } from "@comis/core";

export function classifyFalVideoError(
  error: unknown,
  opts?: { emptyResult?: boolean },
): { videoErrorKind: VideoErrorKind; hint: string } {
  if (opts?.emptyResult) {
    return {
      videoErrorKind: "empty_response",
      hint: "FAL returned COMPLETED with no video.url. Retry; the render produced no downloadable clip.",
    };
  }

  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("credentials") ||
    lower.includes("invalid api key") ||
    lower.includes("api key")
  ) {
    return {
      videoErrorKind: "auth_required",
      hint: "FAL rejected the credentials. Check the FAL_KEY secret.",
    };
  }

  if (
    lower.includes("moderation") ||
    lower.includes("safety") ||
    lower.includes("content policy") ||
    lower.includes("blocked") ||
    lower.includes("nsfw")
  ) {
    return {
      videoErrorKind: "content_blocked",
      hint: "FAL blocked the prompt by moderation. Revise the prompt and retry.",
    };
  }

  // Generic dependency failure (e.g. a 5xx / transport error). The message text
  // here is a provider/HTTP string, not a credential (auth errors classify above).
  return { videoErrorKind: "empty_response", hint: `FAL request failed: ${msg}` };
}
