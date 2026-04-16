/**
 * Response processor for heartbeat LLM responses.
 *
 * Pure functions that classify LLM heartbeat responses into a discriminated
 * union outcome (heartbeat_ok vs deliver). Handles:
 * - HEARTBEAT_OK token detection with HTML/Markdown stripping
 * - ackMaxChars threshold for soft acknowledgments
 * - Response prefix removal
 * - Media bypass
 * - Empty reply handling
 *
 * Session side-effects (transcript pruning, updatedAt preservation, dedup state)
 * are handled by the caller based on the returned outcome.
 */

import { HEARTBEAT_OK_TOKEN } from "./relevance-filter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Discriminated union result of heartbeat response classification. */
export type HeartbeatResponseOutcome =
  | { kind: "heartbeat_ok"; reason: "token" | "ack_under_threshold" | "empty_reply"; cleanedText: string }
  | { kind: "deliver"; text: string; hasMedia: boolean };

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
// Regex constants
// ---------------------------------------------------------------------------

/** Matches HTML tags (not a full parser -- sufficient for token exposure). */
const HTML_TAG_RE = /<[^>]+>/g;

/** Matches leading/trailing Markdown wrapper characters (backticks, bold, italic, strikethrough). */
const MARKDOWN_WRAPPER_RE = /^[`*_~]+|[`*_~]+$/g;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and common Markdown wrappers to expose tokens.
 * Not a full parser -- just enough to find HEARTBEAT_OK in LLM output.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(HTML_TAG_RE, "")
    .replace(MARKDOWN_WRAPPER_RE, "")
    .trim();
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
 * 1. Media bypass -- always deliver
 * 2. Empty/null reply -- treated as HEARTBEAT_OK
 * 3. Token detection + ackMaxChars threshold
 */
export function classifyHeartbeatResponse(input: ClassifyHeartbeatInput): HeartbeatResponseOutcome {
  const { text, hasMedia, ackMaxChars } = input;

  // Media bypass -- always deliver
  if (hasMedia) {
    return { kind: "deliver", text: text?.trim() ?? "", hasMedia: true };
  }

  // Empty/null reply treated as HEARTBEAT_OK
  if (!text || !text.trim()) {
    return { kind: "heartbeat_ok", reason: "empty_reply", cleanedText: "" };
  }

  const { stripped, hadToken } = stripHeartbeatToken(text);

  if (hadToken) {
    // Token found -- check if remaining text is under threshold
    if (stripped.length <= ackMaxChars) {
      return { kind: "heartbeat_ok", reason: "token", cleanedText: stripped };
    }
    // Token found but substantial remaining text -- deliver the stripped text
    return { kind: "deliver", text: stripped, hasMedia: false };
  }

  // No token, no media, non-empty -- deliver as-is
  return { kind: "deliver", text: text.trim(), hasMedia: false };
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
