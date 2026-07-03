// SPDX-License-Identifier: Apache-2.0
/**
 * Response Filter: Suppresses silent tokens and strips reply tags from
 * channel delivery.
 *
 * Delegates the silent-token check to `isSilentResponse` from `@comis/shared` —
 * the helper is documented as idempotent under `stripReplyTags + trim` (see
 * `packages/shared/src/silent-tokens.ts` JSDoc contract).
 *
 * @module
 */

import {
  isSilentResponse, stripReplyTags,
  NO_REPLY_TOKEN, HEARTBEAT_OK_TOKEN,
} from "@comis/shared";

// Re-exported as part of the @comis/channels public surface for downstream consumers.
export { NO_REPLY_TOKEN, HEARTBEAT_OK_TOKEN };

export interface FilterResult {
  shouldDeliver: boolean;
  cleanedText: string;
  suppressedBy?: "NO_REPLY" | "HEARTBEAT_OK" | "SILENT" | "empty";
}

/**
 * Check if an agent response should be delivered to the user.
 *
 * The silent-token check delegates to `isSilentResponse(trimmed)` for
 * self-documentation at the call site. The helper is idempotent under
 * `stripReplyTags + trim`, so passing the already-stripped value is safe
 * and explicit.
 */
export function filterResponse(response: string): FilterResult {
  if (!response || !response.trim()) {
    return { shouldDeliver: false, cleanedText: "", suppressedBy: "empty" };
  }
  const trimmed = stripReplyTags(response);
  if (!trimmed) return { shouldDeliver: false, cleanedText: "", suppressedBy: "empty" };

  // [SILENT] prefix branch.
  // Resolves before the helper so we can return suppressedBy: "SILENT" cleanly.
  if (trimmed.toUpperCase().startsWith("[SILENT]")) {
    return { shouldDeliver: false, cleanedText: "", suppressedBy: "SILENT" };
  }

  // Pass the already-stripped value. isSilentResponse is documented as
  // idempotent under stripReplyTags + trim (see silent-tokens.ts JSDoc).
  // Self-documenting at the call site.
  if (isSilentResponse(trimmed)) {
    const tokenMatch: FilterResult["suppressedBy"] =
      trimmed === NO_REPLY_TOKEN ? "NO_REPLY"
        : trimmed === HEARTBEAT_OK_TOKEN ? "HEARTBEAT_OK"
        : "SILENT";
    return { shouldDeliver: false, cleanedText: "", suppressedBy: tokenMatch };
  }

  return { shouldDeliver: true, cleanedText: trimmed };
}
