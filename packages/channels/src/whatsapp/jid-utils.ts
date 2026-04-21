// SPDX-License-Identifier: Apache-2.0
/**
 * WhatsApp JID (Jabber ID) normalization utilities.
 *
 * Ported from legacy src/whatsapp/normalize.ts with clearer naming
 * and self-contained implementation (no external utility imports).
 *
 * WhatsApp JID formats:
 * - User: "41796666864:0@s.whatsapp.net" (phone with device suffix)
 * - Group: "120363025555555555@g.us" or "120363-555555@g.us" (hyphenated)
 * - LID: "123456@lid" (linked device ID)
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex for WhatsApp user JIDs: "41796666864:0@s.whatsapp.net" */
const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;

/** Regex for WhatsApp LID JIDs: "123456@lid" */
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal E.164 normalization: strip non-digit characters.
 * Returns raw digits (no "+" prefix -- callers use as identifier, not dial string).
 */
function normalizeE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length > 0 ? digits : "";
}

/**
 * Strip "whatsapp:" prefixes (case-insensitive, possibly repeated).
 */
function stripWhatsAppPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a JID is a WhatsApp group (format: digits[-digits]@g.us).
 */
export function isWhatsAppGroupJid(value: string): boolean {
  const candidate = stripWhatsAppPrefixes(value);
  const lower = candidate.toLowerCase();
  if (!lower.endsWith("@g.us")) {
    return false;
  }
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) {
    return false;
  }
  return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}

/**
 * Check if a JID is a WhatsApp user (s.whatsapp.net or @lid format).
 */
export function isWhatsAppUserJid(value: string): boolean {
  const candidate = stripWhatsAppPrefixes(value);
  return WHATSAPP_USER_JID_RE.test(candidate) || WHATSAPP_LID_RE.test(candidate);
}

/**
 * Extract the phone number (or LID number) from a WhatsApp user JID.
 *
 * "41796666864:0@s.whatsapp.net" -> "41796666864"
 * "123456@lid" -> "123456"
 * "notajid" -> null
 */
export function extractJidPhone(jid: string): string | null {
  const candidate = stripWhatsAppPrefixes(jid);
  const userMatch = candidate.match(WHATSAPP_USER_JID_RE);
  if (userMatch) {
    return userMatch[1];
  }
  const lidMatch = candidate.match(WHATSAPP_LID_RE);
  if (lidMatch) {
    return lidMatch[1];
  }
  return null;
}

/**
 * Normalize a WhatsApp JID to a canonical form.
 *
 * - User JID -> phone number (digits only)
 * - Group JID -> preserved as "localPart@g.us"
 * - LID JID -> LID number (digits only)
 * - Raw phone -> normalized digits
 * - Invalid -> null
 */
export function normalizeWhatsAppJid(value: string): string | null {
  const candidate = stripWhatsAppPrefixes(value);
  if (!candidate) {
    return null;
  }

  // Group JIDs: preserve as-is (normalized)
  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return `${localPart}@g.us`;
  }

  // User JIDs: extract phone number
  if (isWhatsAppUserJid(candidate)) {
    const phone = extractJidPhone(candidate);
    if (!phone) {
      return null;
    }
    const normalized = normalizeE164(phone);
    return normalized.length > 0 ? normalized : null;
  }

  // Unknown @-domain JIDs: reject to avoid misinterpretation
  if (candidate.includes("@")) {
    return null;
  }

  // Raw phone number: normalize digits
  const normalized = normalizeE164(candidate);
  return normalized.length > 0 ? normalized : null;
}
