// SPDX-License-Identifier: Apache-2.0
/**
 * Classifies raw API/provider errors into user-friendly categories.
 *
 * Raw error internals (API keys, URLs, stack traces) must
 * never reach the user. This module bridges the gap by parsing known error
 * patterns and returning safe, actionable messages while keeping
 * operator-level detail in the logs.
 *
 * @module
 */

import { isSignedReplayError } from "./signed-replay-detector.js";
import { describeTimeoutKnob, describeRetryTimeoutKnob } from "./timeout-knob.js";

import type { PromptTimeoutError } from "./prompt-timeout.js";
import type { TimeoutSource } from "../model/operation-model-resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "credit_exhausted"
  | "rate_limited"
  | "auth_invalid"
  | "aws_auth_invalid"
  | "aws_auth_expired"
  | "aws_model_access"
  | "aws_region_or_model"
  | "overloaded"
  | "context_too_long"
  | "content_filtered"
  /**
   * Provider-agnostic signed-replay rejection: the model rejected stored
   * signed thinking / reasoning state on the latest assistant turn during
   * replay (Anthropic `cannot be modified`, Gemini `thought_signature
   * mismatch`, OpenAI Responses `reasoning_item not found`, OpenAI
   * Completions `reasoning_id expired`, Mistral `encrypted_content
   * verification failed`, etc.). Self-healable: the runner scrubs the
   * stored signed state in place and re-enters the model retry chain.
   */
  | "client_request_signed_replay"
  /**
   * Provider rejected the tool JSON Schema at grammar-compile/unmarshal time
   * (llama.cpp "JSON schema conversion failed"/"Unrecognized schema"/
   * grammar-parse, Ollama Go-side tools unmarshal). Deterministic
   * schema-shape problem, NOT a model failure: self-healable once — the
   * runner strips pattern/format from the offending toolset and retries a
   * single time (see silent-failure-handlers.ts), then fails honestly. The
   * model-retry ladder must never burn fallback models on it.
   */
  | "tool_schema_unsupported"
  | "client_request"
  | "prompt_timeout"
  /**
   * Model produced an empty response (no text, no tool call). Almost always
   * caused by a malformed toolResult poisoning the next turn. Retryable once
   * the upstream data integrity issue is understood.
   */
  | "empty_response"
  /**
   * Provider returned 404/not_found for the requested model — gated, renamed,
   * or not enabled on this API plan (e.g. Anthropic "Claude Fable 5 is not
   * available. Please use Opus 4.8."). Deterministic: the same model keeps
   * 404-ing, so not retryable. Distinct from empty_response so the user is told
   * the real, actionable cause instead of "a tool call returned no output".
   */
  | "model_not_available"
  /**
   * Couldn't reach the provider — DNS/socket/connection failure (ECONNREFUSED,
   * ETIMEDOUT, fetch failed, …). Transient, so retryable. Distinct from
   * content_filtered (whose /refus/ pattern would otherwise steal ECONNREFUSED)
   * and from empty_response (the silent-failure handler wraps it as an empty
   * response after retry).
   */
  | "provider_unreachable"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  /** Safe message to show the end user (no secrets, no internals). */
  userMessage: string;
  /** Whether the user should reasonably retry. */
  retryable: boolean;
  /** Operator-facing detail: binding knob + numbers. Rides WARN
   *  logs/explain — NEVER the user reply. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Pattern table — order matters: first match wins
// ---------------------------------------------------------------------------

interface ErrorPattern {
  /** Regex (or any object exposing `.test(s) => boolean`) tested against the
   *  stringified error message. Widened from `RegExp` to `RegExp | { test }`
   *  so provider-agnostic detectors (e.g. `isSignedReplayError`) can plug in
   *  without forcing a single mega-regex. Both shapes share the same call
   *  shape `.test(s) -> boolean` so the dispatch loop is unchanged. */
  test: RegExp | { test(s: string): boolean };
  category: ErrorCategory;
  userMessage: string;
  retryable: boolean;
  /** Operator-facing remediation. Never included in the user reply. */
  hint?: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // AWS Bedrock authentication and model-routing failures. These provider-
  // specific names must precede the generic auth/network patterns: for
  // example ResourceNotFoundException contains "ENOTFOUND" as a substring.
  {
    test: /UnrecognizedClientException|InvalidSignatureException/i,
    category: "aws_auth_invalid",
    userMessage:
      "The AI service could not authenticate with Amazon Bedrock. Please notify the system administrator.",
    retryable: false,
    hint: "Set AWS_BEARER_TOKEN_BEDROCK to a valid Bedrock API key, or verify the configured AWS access keys.",
  },
  {
    test: /ExpiredTokenException/i,
    category: "aws_auth_expired",
    userMessage:
      "The Amazon Bedrock authentication session has expired. Please notify the system administrator.",
    retryable: false,
    hint: "Run `aws sso login` again or refresh the configured AWS access keys.",
  },
  {
    test: /AccessDeniedException/i,
    category: "aws_model_access",
    userMessage:
      "The requested Amazon Bedrock model is not available to this deployment. Please notify the system administrator.",
    retryable: false,
    hint: "Verify Bedrock model access in the resolved AWS_REGION or AWS_DEFAULT_REGION for the configured model id.",
  },
  {
    test: /ResourceNotFoundException|model identifier is invalid/i,
    category: "aws_region_or_model",
    userMessage:
      "The requested Amazon Bedrock model could not be resolved. Please notify the system administrator.",
    retryable: false,
    hint: "Verify the resolved AWS_REGION or AWS_DEFAULT_REGION and configured model id; this error commonly means the model is unavailable or access is not granted in that region.",
  },
  // Billing / credits
  {
    test: /credit balance is too low|billing|purchase credits|insufficient.?funds|payment.?required|usage.?limits?|regain.?access|spend.?(cap|limit)/i,
    category: "credit_exhausted",
    userMessage:
      "The AI service is currently unavailable due to a billing or usage-cap issue. Please notify the system administrator.",
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
  // Provider-agnostic signed-replay rejection: must be tested BEFORE the
  // plain client_request pattern because every signed-replay error string
  // also matches `invalid_request_error` / `cannot be modified`. First match
  // wins, so this more-specific subcategory has to be checked first.
  // Retryable=true because the runner scrubs signed thinking state in place
  // and re-enters the model retry chain (see executor-prompt-runner.ts).
  {
    test: { test: (s: string) => isSignedReplayError(s) },
    category: "client_request_signed_replay",
    userMessage:
      "Your request couldn't be processed due to a formatting issue. The AI agent will try again automatically.",
    retryable: true,
  },
  // llama.cpp-family grammar-compile + Ollama tools-unmarshal failures: must be
  // tested BEFORE the plain client_request pattern because llama-server wraps
  // grammar bodies in `"type":"invalid_request_error"` — first match wins, so
  // this more-specific subcategory has to be checked first (same rationale as
  // the signed-replay entry above). Scope guard: the Go-unmarshal alternative
  // only matches under `tools.function.parameters` so unrelated unmarshal
  // errors keep their current classification — the optional `(?:\w+\.)?`
  // accepts Go's standard `Go struct field <StructTypeName>.<path>` form
  // (e.g. `ChatRequest.tools.function.parameters...`) alongside the
  // empty-type-name variant from ollama#10164.
  // Retryable=true because the runner performs exactly one
  // strip-pattern/format-and-retry per session.
  {
    test: /json schema conversion failed|unrecognized schema|error parsing grammar|json-schema-to-grammar|unable to generate parser|cannot unmarshal \S+ into Go struct field (?:\w+\.)?\.?tools\.function\.parameters/i,
    category: "tool_schema_unsupported",
    userMessage:
      "The AI provider couldn't compile one of the available tools. The agent will simplify the tool definition and try again automatically.",
    retryable: true,
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
  // Provider unreachable: DNS/socket/connection failure reaching the API.
  // Tested BEFORE content_filtered because ECONNREFUSED contains the literal
  // "REFUSED" that the /refus/ content-filter pattern would otherwise steal
  // (mislabelling a network outage as a "content restriction"), and BEFORE
  // empty_response because the silent-failure handler wraps a connection error
  // as "…produced empty response after retry … — <providerError>".
  // The `…|error` arm catches the OpenAI-compat SDK's APIConnectionError, whose
  // message is the BARE phrase "Connection error." (no errno token) — the
  // provider-down case (Ollama unreachable): without it the wrapper
  // falls through to empty_response and the user sees "a tool call returned no
  // output" for a network outage. Transient → retryable.
  {
    test: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang ?up|fetch failed|getaddrinfo|network error|connect(?:ion)?[ _](?:refused|reset|timed out|failure|error)/i,
    category: "provider_unreachable",
    userMessage:
      "Couldn't reach the AI provider due to a network or connection problem. Please try again in a moment.",
    retryable: true,
  },
  // Model unavailable: provider 404 / not_found for the requested model (gated,
  // renamed, or not enabled on this API plan). Tested BEFORE empty_response
  // because the silent-failure handler wraps it as "…produced empty response
  // after retry … — 404 {…not_found_error… is not available…}", which would
  // otherwise be misreported to the user as "a tool call returned no output"
  // (e.g. claude-fable-5 → 404 "Claude Fable 5 is
  // not available. Please use Opus 4.8."). Deterministic (same model keeps
  // 404-ing) → not retryable. Scoped to model/not_found semantics so it never
  // steals the OpenAI reasoning_item "not found" case (signed-replay, tested
  // above) nor a 503 "service unavailable" (overloaded, tested above).
  {
    test: /not_found_error|model_not_found|no such model|\bis not available\b|requested model.{0,30}(?:unavailable|not found|does not exist)/i,
    category: "model_not_available",
    userMessage:
      "The requested AI model is unavailable from the provider — it may not exist, be renamed, or not be enabled on this API plan. Check the agent's configured model or notify the system administrator.",
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
        ...(pattern.hint !== undefined ? { hint: pattern.hint } : {}),
      };
    }
  }

  return UNKNOWN_ERROR;
}

/**
 * The effective-timeout binding provenance a classify consumer threads
 * in: which resolution level bound the timeout (`source`), whose
 * config owns the knob, and the configured numbers. Every field optional —
 * absent fields degrade gracefully to placeholders / the error's own numbers,
 * so callers that pass no provenance never break the call shape.
 */
export interface PromptTimeoutBinding {
  source?: TimeoutSource;
  operationType?: string;
  agentId?: string;
  promptTimeoutMs?: number;
  retryPromptTimeoutMs?: number;
  stallCeilingMultiplier?: number;
}

/**
 * Classify specifically for prompt timeout errors.
 * Separated because PromptTimeoutError is identified by instanceof,
 * not by message content.
 *
 * Renders the operator-facing `hint` — the BINDING knob
 * (via the timeout-knob table), the configured value, the elapsed time, and
 * WHICH limit fired (stall / makespan / whole-turn retry). The `userMessage`
 * stays generic/user-safe: config-key detail rides logs + obs.explain only,
 * never the user reply. A `graph_constant` binding renders honest
 * prose instead of a fake `agents.*` key.
 *
 * @param error - The PromptTimeoutError (carries `limit` + the configured
 *                numbers).
 * @param binding - The effective-timeout binding provenance; absent
 *                  ⇒ no provenance from the caller ⇒ the placeholder agent knob (graceful).
 * @param elapsedMs - Wall-clock elapsed since execution start, when known.
 */
export function classifyPromptTimeout(
  error: PromptTimeoutError,
  binding?: PromptTimeoutBinding,
  elapsedMs?: number,
): ClassifiedError {
  const knob = describeTimeoutKnob(
    binding?.source ?? "agent_config",
    binding?.agentId,
    binding?.operationType,
  );
  const elapsed = elapsedMs !== undefined ? ` after ${String(elapsedMs)}ms` : "";
  let hint: string;
  if (error.limit === "makespan") {
    hint =
      `makespan ceiling ${String(error.makespanMs ?? error.timeoutMs)}ms` +
      ` (stall budget ${String(error.stallBudgetMs ?? binding?.promptTimeoutMs ?? 0)} × stallCeilingMultiplier` +
      `${binding?.stallCeilingMultiplier !== undefined ? ` ${String(binding.stallCeilingMultiplier)}` : ""}) exceeded${elapsed}` +
      ` — streaming runaway; raise agents.${binding?.agentId ?? "<id>"}.promptTimeout.stallCeilingMultiplier or investigate model output`;
  } else if (error.limit === "stall") {
    hint =
      `stall budget ${String(error.stallBudgetMs ?? error.timeoutMs)}ms exceeded${elapsed} with no stream/tool activity` +
      (binding?.source === "graph_constant"
        ? // Honest prose for a non-knob — never a raise-suggestion that names
          // a config key the operator cannot set.
          ` — ${knob}`
        : ` — raise ${knob} (currently ${String(binding?.promptTimeoutMs ?? error.timeoutMs)});` +
          ` local prefill on consumer hardware can exceed it`);
  } else {
    // limit undefined ⇒ the non-resettable whole-turn path (retry/fallback
    // prompts keep retryPromptTimeoutMs semantics; never
    // present it as a stall-budget kill).
    hint =
      `whole-turn retry timeout ${String(error.timeoutMs)}ms exceeded${elapsed}` +
      ` — retry/fallback prompts use ${describeRetryTimeoutKnob(binding?.agentId)}` +
      ` (currently ${String(binding?.retryPromptTimeoutMs ?? error.timeoutMs)}), not the stall budget`;
  }
  return {
    category: "prompt_timeout",
    userMessage:
      "The request took too long to process. Please try again with a simpler message.",
    retryable: true,
    hint,
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
