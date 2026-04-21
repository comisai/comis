// SPDX-License-Identifier: Apache-2.0
/**
 * Classifies raw API/provider errors into user-friendly categories.
 *
 * requires that raw error internals (API keys, URLs, stack traces)
 * never reach the user. This module bridges the gap by parsing known error
 * patterns and returning safe, actionable messages while keeping
 * operator-level detail in the logs.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "credit_exhausted"
  | "rate_limited"
  | "auth_invalid"
  | "overloaded"
  | "context_too_long"
  | "content_filtered"
  | "client_request"
  | "prompt_timeout"
  /**
   * Model produced an empty response (no text, no tool call). Almost always
   * caused by a malformed toolResult poisoning the next turn. Retryable once
   * the upstream data integrity issue is understood.
   */
  | "empty_response"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  /** Safe message to show the end user (no secrets, no internals). */
  userMessage: string;
  /** Whether the user should reasonably retry. */
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Pattern table — order matters: first match wins
// ---------------------------------------------------------------------------

interface ErrorPattern {
  /** Regex tested against the stringified error message. */
  test: RegExp;
  category: ErrorCategory;
  userMessage: string;
  retryable: boolean;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // Billing / credits
  {
    test: /credit balance is too low|billing|purchase credits|insufficient.?funds|payment.?required/i,
    category: "credit_exhausted",
    userMessage:
      "The AI service is currently unavailable due to a billing issue. Please notify the system administrator.",
    retryable: false,
  },
  // Rate limiting (429)
  {
    test: /rate.?limit|too many requests|429|throttl/i,
    category: "rate_limited",
    userMessage:
      "Too many requests — please wait a moment and try again.",
    retryable: true,
  },
  // Auth / API key errors
  {
    test: /invalid.?api.?key|authentication|unauthorized|401|403|invalid x-api-key|permission.?denied/i,
    category: "auth_invalid",
    userMessage:
      "The AI service could not authenticate. Please notify the system administrator.",
    retryable: false,
  },
  // Provider overloaded (529 / 503)
  {
    test: /overloaded|503|529|service.?unavailable|capacity/i,
    category: "overloaded",
    userMessage:
      "The AI service is temporarily overloaded. Please try again in a few minutes.",
    retryable: true,
  },
  // Context window exceeded
  {
    test: /context.?length|too many tokens|maximum.?context|token limit|max_tokens/i,
    category: "context_too_long",
    userMessage:
      "The conversation has grown too long. Please start a new conversation.",
    retryable: false,
  },
  // Client-side validation (Anthropic 400 invalid_request_error, 422, malformed)
  // Placed BEFORE content_filtered so /refus|blocked/ in that rule cannot steal
  // matches. Placed AFTER billing/auth/rate/overloaded/context so those specific
  // categories remain authoritative when their keywords are present (e.g. a
  // credit-exhausted billing error is also shaped as invalid_request_error).
  // Deterministic: retrying reproduces the same failure, so retryable=false.
  {
    test: /invalid_request_error|unprocessable_entity|\b422\b|cannot be modified|malformed.?request|\b400\b.*invalid/i,
    category: "client_request",
    userMessage:
      "Your request couldn't be processed due to a formatting issue. This conversation may need to be reset.",
    retryable: false,
  },
  // Content filtering / safety
  {
    test: /content.?filter|safety|blocked|harmful|refus/i,
    category: "content_filtered",
    userMessage:
      "Your message could not be processed due to content restrictions. Please rephrase and try again.",
    retryable: true,
  },
  // Silent LLM failure: model produced empty output after retry. Almost always
  // caused by a malformed toolResult (empty content, wrong shape) poisoning the
  // next turn — the microcompaction guard now normalizes that case, but
  // retaining a classifier pattern here means any future regression surfaces an
  // actionable message instead of the generic UNKNOWN_ERROR.
  {
    test: /silent LLM failure|empty response after retry|produced empty response/i,
    category: "empty_response",
    userMessage:
      "The AI didn't produce a response. This usually means a tool call returned no output — please try again.",
    retryable: true,
  },
];

// ---------------------------------------------------------------------------
// Default fallback
// ---------------------------------------------------------------------------

const UNKNOWN_ERROR: ClassifiedError = {
  category: "unknown",
  userMessage: "An error occurred while processing your request. Please try again.",
  retryable: false,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a raw error into a user-safe category with an actionable message.
 *
 * The function stringifies the error once and tests it against known API
 * error patterns. It never leaks the raw error string to the user.
 */
export function classifyError(error: unknown): ClassifiedError {
  const msg = errorToString(error);

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test.test(msg)) {
      return {
        category: pattern.category,
        userMessage: pattern.userMessage,
        retryable: pattern.retryable,
      };
    }
  }

  return UNKNOWN_ERROR;
}

/**
 * Classify specifically for prompt timeout errors.
 * Separated because PromptTimeoutError is identified by instanceof,
 * not by message content.
 */
export function classifyPromptTimeout(_timeoutMs: number): ClassifiedError {
  return {
    category: "prompt_timeout",
    userMessage:
      "The request took too long to process. Please try again with a simpler message.",
    retryable: true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    // Include both message and cause chain
    let msg = error.message;
    if (error.cause) {
      msg += " " + errorToString(error.cause);
    }
    return msg;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
