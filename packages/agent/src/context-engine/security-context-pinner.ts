// SPDX-License-Identifier: Apache-2.0
/**
 * Security context pinning for eviction/compaction passes.
 *
 * S4: identifies stored messages that contain security-critical markers
 * (canary token, wrapExternalContent delimiters, sender-trust prefixes,
 * safety reinforcement text) and marks them as ineligible for eviction.
 * Fail-closed: uncertain → treat as security-relevant (pin it).
 *
 * @module
 */

/** Markers injected at session setup. Pass to isSecurityRelevantMessage. */
export interface SecurityPinMarkers {
  /** The per-session canary token (HMAC output from generateCanaryToken()). */
  canaryToken: string;
  /** The per-session random hex content-delimiter from RequestContext.contentDelimiter. */
  contentDelimiter: string;
  /** Safety reinforcement text snippet (first 40 chars; substring match). */
  safetyReinforcementSnippet?: string;
  /**
   * Sender-trust section prefix for messages injected by buildSenderTrustSection
   * (canonical value: "## Authorized Senders"). When set, messages containing
   * this prefix are pinned — the trust table must survive compaction so the model
   * always knows which senders are authorized. S4: one of the four pinned categories.
   */
  senderTrustPrefix?: string;
}

/**
 * Returns true if the message text contains any security-critical marker.
 * Fail-closed: empty/undefined message text → true (pin it).
 *
 * S4: pinned messages are excluded from eviction/summarization chunk selection
 * in BOTH the pipeline llm-compaction layer AND the LCD leaf-summarizer.
 */
export function isSecurityRelevantMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: { content?: unknown; role?: string },
  markers: SecurityPinMarkers,
): boolean {
  // Fail-closed: no content → treat as security-relevant
  if (msg.content === undefined || msg.content === null) return true;

  const text = extractText(msg.content);

  // Fail-closed: empty text → pin
  if (text.length === 0) return true;

  // Check each marker
  if (markers.canaryToken.length > 0 && text.includes(markers.canaryToken)) return true;
  if (markers.contentDelimiter.length > 0 && text.includes(markers.contentDelimiter)) return true;
  if (
    markers.safetyReinforcementSnippet &&
    markers.safetyReinforcementSnippet.length > 0 &&
    text.includes(markers.safetyReinforcementSnippet)
  ) return true;
  if (
    markers.senderTrustPrefix &&
    markers.senderTrustPrefix.length > 0 &&
    text.includes(markers.senderTrustPrefix)
  ) return true;

  return false;
}

/** Extract plain text from various message content shapes (string, array of blocks). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block !== null && typeof block === "object") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const b = block as any;
          if (typeof b.text === "string") return b.text;
          if (typeof b.content === "string") return b.content;
        }
        return "";
      })
      .join(" ");
  }
  return String(content);
}
