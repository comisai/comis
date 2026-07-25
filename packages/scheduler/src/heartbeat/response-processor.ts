// SPDX-License-Identifier: Apache-2.0
/**
 * Response processor for heartbeat LLM responses.
 *
 * Pure functions that classify LLM heartbeat responses into a discriminated
 * union outcome (heartbeat_ok vs deliver). Handles:
 * - Shared silent-response suppression with HTML/Markdown stripping
 * - HEARTBEAT_OK acknowledgement detection
 * - ackMaxChars threshold for soft acknowledgments
 * - Response prefix removal
 * - Media bypass
 * - Empty reply handling
 *
 * Session side-effects (transcript pruning, updatedAt preservation, dedup state)
 * are handled by the caller based on the returned outcome.
 */

import { HEARTBEAT_OK_TOKEN, isSilentResponse } from "@comis/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Closed visibility classification after response-prefix and markup normalization. */
export type HeartbeatResponseOutcome =
  | { kind: "empty" }
  | { kind: "acknowledged_ok"; reason: "heartbeat_token" | "ack_under_threshold"; text: string }
  | { kind: "alert"; level: "alert" | "critical"; text: string; hasMedia: boolean };

/** Input to classifyHeartbeatResponse. */
export interface ClassifyHeartbeatInput {
  text: string | null | undefined;
  hasMedia: boolean;
  ackMaxChars: number;
}

/** Input to the processHeartbeatResponse orchestrator. */
export interface ProcessHeartbeatInput {
  responseText: string | null | undefined;
  responsePrefix: string | undefined;
  ackMaxChars: number;
  hasMedia: boolean;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

function isMarkdownWrapperCharacter(character: string): boolean {
  return character === "`" || character === "*" || character === "_" || character === "~";
}

function stripMarkdownWrappers(text: string): string {
  let start = 0;
  while (start < text.length && isMarkdownWrapperCharacter(text.charAt(start))) start += 1;

  let end = text.length;
  while (end > start && isMarkdownWrapperCharacter(text.charAt(end - 1))) end -= 1;

  return text.slice(start, end);
}

/**
 * Strip HTML tags and common Markdown wrappers to expose tokens.
 * Not a full parser -- just enough to find HEARTBEAT_OK in LLM output.
 */
export function stripMarkup(text: string): string {
  return stripMarkdownWrappers(stripHtmlTags(text)).trim();
}

function stripHtmlTags(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, start));
    const end = text.indexOf(">", start + 1);
    if (end === -1) {
      parts.push(text.slice(start));
      break;
    }
    cursor = end + 1;
  }
  return parts.join("");
}

/**
 * Detect and strip HEARTBEAT_OK from text.
 *
 * Token is recognized at leading/trailing positions only.
 * Handles up to 4 trailing non-word characters (e.g., "HEARTBEAT_OK!!!").
 * Token embedded mid-sentence is NOT detected (prevents false positives).
 */
export function stripHeartbeatToken(text: string): {
  stripped: string;
  hadToken: boolean;
} {
  const cleaned = stripMarkup(text);

  // Exact match: entire text is the token with optional trailing punctuation
  const exactRe = new RegExp(`^${HEARTBEAT_OK_TOKEN}\\W{0,4}$`);
  if (exactRe.test(cleaned)) {
    return { stripped: "", hadToken: true };
  }

  // Leading token: token at start followed by whitespace and remaining text
  const leadingRe = new RegExp(`^${HEARTBEAT_OK_TOKEN}\\W{0,4}\\s+`);
  if (leadingRe.test(cleaned)) {
    return { stripped: cleaned.replace(leadingRe, "").trim(), hadToken: true };
  }

  // Trailing token: text followed by whitespace and token at end
  const trailingRe = new RegExp(`\\s+${HEARTBEAT_OK_TOKEN}\\W{0,4}$`);
  if (trailingRe.test(cleaned)) {
    return { stripped: cleaned.replace(trailingRe, "").trim(), hadToken: true };
  }

  return { stripped: cleaned, hadToken: false };
}

/**
 * Strip a configurable response prefix from the beginning of text.
 * Case-sensitive. Returns text unchanged if prefix does not match or is absent.
 */
export function stripResponsePrefix(text: string, prefix: string | undefined): string {
  if (!prefix) return text;
  if (text.startsWith(prefix)) {
    return text.slice(prefix.length);
  }
  return text;
}

/**
 * Classify a heartbeat LLM response into an outcome.
 *
 * Check order:
 * 1. Empty/null reply -- suppress when text-only, preserve media
 * 2. Media bypass -- always deliver
 * 3. Shared non-heartbeat silent marker -- suppress
 * 4. HEARTBEAT_OK detection + ackMaxChars threshold
 */
export function classifyHeartbeatResponse(input: ClassifyHeartbeatInput): HeartbeatResponseOutcome {
  const { text, hasMedia, ackMaxChars } = input;

  // Empty model text never manufactures a user-visible acknowledgement.
  if (!text || !text.trim()) {
    return hasMedia
      ? { kind: "alert", level: "alert", text: "", hasMedia: true }
      : { kind: "empty" };
  }

  const normalized = stripMarkup(text);
  if (hasMedia) {
    return {
      kind: "alert",
      level: isCritical(normalized) ? "critical" : "alert",
      text: normalized,
      hasMedia: true,
    };
  }

  // The shared helper is the runtime-wide source of truth for NO_REPLY and
  // [SILENT] wrappers. HEARTBEAT_OK deliberately continues through the
  // acknowledgement path below so showOk and transcript pruning retain their
  // existing semantics.
  if (normalized !== HEARTBEAT_OK_TOKEN && isSilentResponse(normalized)) {
    return { kind: "empty" };
  }

  const { stripped, hadToken } = stripHeartbeatToken(normalized);
  if (isCritical(stripped)) {
    return { kind: "alert", level: "critical", text: stripped, hasMedia: false };
  }

  if (hadToken) {
    if (stripped.length === 0) {
      return { kind: "acknowledged_ok", reason: "heartbeat_token", text: HEARTBEAT_OK_TOKEN };
    }
    if (stripped.length <= ackMaxChars) {
      return { kind: "acknowledged_ok", reason: "ack_under_threshold", text: stripped };
    }
    return { kind: "alert", level: "alert", text: stripped, hasMedia: false };
  }

  return {
    kind: "alert",
    level: isCritical(normalized) ? "critical" : "alert",
    text: normalized,
    hasMedia: false,
  };
}

/**
 * Orchestrator: applies response prefix stripping then classifies.
 *
 * This is the main entry point called from agent-heartbeat-source.ts
 * between execution (step 10) and delivery (step 11).
 */
export function processHeartbeatResponse(input: ProcessHeartbeatInput): HeartbeatResponseOutcome {
  const { responseText, responsePrefix, ackMaxChars, hasMedia } = input;

  // Handle null/undefined before prefix stripping
  if (responseText == null) {
    return classifyHeartbeatResponse({ text: null, hasMedia, ackMaxChars });
  }

  // Strip configurable response prefix
  const prefixStripped = stripResponsePrefix(responseText, responsePrefix);

  return classifyHeartbeatResponse({ text: prefixStripped, hasMedia, ackMaxChars });
}

function isCritical(text: string): boolean {
  const upper = text.toUpperCase();
  return upper.includes("CRITICAL") || upper.includes("EMERGENCY");
}
