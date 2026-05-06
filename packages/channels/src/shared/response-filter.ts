// SPDX-License-Identifier: Apache-2.0
/**
 * Response Filter: Suppresses silent tokens and strips reply tags from
 * channel delivery.
 *
 * Delegates the silent-token check to `isSilentResponse` from `@comis/shared`
 * (B41 + B44 + B46) — the helper is documented as idempotent under
 * `stripReplyTags + trim` (see `packages/shared/src/silent-tokens.ts` JSDoc
 * contract). T0.36 enforces NO_REPLY_TOKEN re-export `===` identity;
 * T0.37 enforces idempotence.
 *
 * @module
 */

import {
  isSilentResponse, stripReplyTags,
  NO_REPLY_TOKEN, HEARTBEAT_OK_TOKEN,
} from "@comis/shared";

// B41: preserve existing public exports for downstream @comis/channels consumers.
export { NO_REPLY_TOKEN, HEARTBEAT_OK_TOKEN };

/** Regex retained for backward compatibility with downstream re-exports. */
export const REPLY_TAG_RE = /<\/?reply(?:\s[^>]*)?>|<reply>/gi;

export interface FilterResult {
  shouldDeliver: boolean;
  cleanedText: string;
  suppressedBy?: "NO_REPLY" | "HEARTBEAT_OK" | "SILENT" | "empty";
}

/**
 * Check if an agent response should be delivered to the user.
 *
 * Behavior identical to pre-Phase-15 implementation; the silent-token check
 * delegates to `isSilentResponse(trimmed)` for self-documentation at the call
 * site (B46). The helper is idempotent under `stripReplyTags + trim`, so passing
 * the already-stripped value is safe and explicit.
 */
export function filterResponse(response: string): FilterResult {
  if (!response || !response.trim()) {
    return { shouldDeliver: false, cleanedText: "", suppressedBy: "empty" };
  }
  const trimmed = stripReplyTags(response);
  if (!trimmed) return { shouldDeliver: false, cleanedText: "", suppressedBy: "empty" };

  // [SILENT] prefix branch — preserved verbatim from existing behavior.
  // Resolves before the helper so we can return suppressedBy: "SILENT" cleanly.
  if (trimmed.toUpperCase().startsWith("[SILENT]")) {
    return { shouldDeliver: false, cleanedText: "", suppressedBy: "SILENT" };
  }

  // B46: pass the already-stripped value. isSilentResponse is documented as
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
