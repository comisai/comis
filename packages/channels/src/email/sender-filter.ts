/**
 * Email sender filtering — allowlist gating and automated sender detection.
 *
 * Implements sender allowlist gating (default closed) and automated sender
 * detection via RFC 3834 headers and noreply address patterns.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Automated sender address patterns
// ---------------------------------------------------------------------------

/** Patterns matching automated/system sender addresses. */
const AUTOMATED_ADDRESS_PATTERNS: RegExp[] = [
  /^no[-_]?reply@/i,
  /^donotreply@/i,
  /^mailer[-_]?daemon@/i,
  /^postmaster@/i,
  /^bounces?@/i,
];

/** Precedence header values indicating automated messages. */
const AUTOMATED_PRECEDENCE = new Set(["bulk", "junk", "list"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a sender is allowed to deliver messages to this channel.
 *
 * - "allowlist" mode: sender must be in `allowFrom` (empty list = block all)
 * - "open" mode: all senders allowed
 *
 * @param from - Sender email address
 * @param allowFrom - List of allowed sender addresses
 * @param allowMode - Gating mode: "allowlist" or "open"
 */
export function isAllowedSender(
  from: string,
  allowFrom: string[],
  allowMode: "allowlist" | "open",
): boolean {
  if (allowMode === "open") return true;

  // Allowlist mode: empty list blocks all (default closed)
  if (allowFrom.length === 0) return false;

  const normalized = from.toLowerCase();
  return allowFrom.some((allowed) => allowed.toLowerCase() === normalized);
}

/**
 * Detect whether an email is from an automated system.
 *
 * Checks RFC 3834 Auto-Submitted header, Precedence header, List-Unsubscribe,
 * X-Auto-Response-Suppress, and common noreply address patterns.
 *
 * All header key lookups are case-insensitive (email headers are case-insensitive).
 *
 * @param headers - Lowercase-keyed email headers
 * @param fromAddress - Sender email address
 */
export function isAutomatedSender(
  headers: Record<string, string>,
  fromAddress: string,
): boolean {
  // RFC 3834: Auto-Submitted header (present and not "no" means automated)
  const autoSubmitted = headers["auto-submitted"];
  if (autoSubmitted !== undefined && autoSubmitted.toLowerCase() !== "no") {
    return true;
  }

  // Precedence header: bulk, junk, or list
  const precedence = headers["precedence"];
  if (precedence !== undefined && AUTOMATED_PRECEDENCE.has(precedence.toLowerCase())) {
    return true;
  }

  // List-Unsubscribe header presence indicates mailing list
  if (headers["list-unsubscribe"] !== undefined) {
    return true;
  }

  // X-Auto-Response-Suppress header (Microsoft)
  if (headers["x-auto-response-suppress"] !== undefined) {
    return true;
  }

  // Check sender address patterns
  for (const pattern of AUTOMATED_ADDRESS_PATTERNS) {
    if (pattern.test(fromAddress)) {
      return true;
    }
  }

  return false;
}
