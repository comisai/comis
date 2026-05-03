// SPDX-License-Identifier: Apache-2.0
/**
 * Error catalogue for OpenAI Codex OAuth flows.
 *
 * Pure classification: maps an unknown error (typically thrown by pi-ai's
 * loginOpenAICodex / refreshOpenAICodexToken or our own wrappers) into a
 * discriminated record used by both the login runner (Phase 8 D-02) and
 * the doctor's refresh-test (Phase 10 SC-10-2 / SC-10-3).
 *
 * Phase 10 expansion: adds `invalid_grant` and `refresh_token_reused` to
 * the 3 cases (+ default) Phase 8 shipped inline. The substring matchers
 * for `refresh_token_reused` are lifted from OpenClaw's auth-profiles/
 * oauth.ts:117-123 (battle-tested in production for ~6 months).
 *
 * CRITICAL ORDERING (RESEARCH §Q3): refresh_token_reused MUST be tested
 * BEFORE invalid_grant — refresh_token_reused is a SPECIFIC kind of
 * invalid_grant; the more-specific matcher must win.
 *
 * Field convention (CLAUDE.md): `errorKind` mirrors `code` 1:1 so Pino
 * log calls can use `{ errorKind: result.errorKind, hint: result.hint }`
 * directly without remapping.
 *
 * @module
 */

/** Discriminator union for the 6 classifiable OAuth error cases. */
export type OAuthErrorCode =
  | "unsupported_region"
  | "callback_validation_failed"
  | "invalid_grant"
  | "refresh_token_reused"
  | "identity_decode_failed"
  | "callback_timeout";

/** Output record carrying both UX-facing text and Pino-log-field values. */
export interface RewrittenOAuthError {
  /** Discriminator. Also the `errorKind` value used in Pino logs + event payloads. */
  code: OAuthErrorCode;
  /** Mirror of `code` so logs can use `errorKind:` consistently per CLAUDE.md. */
  errorKind: string;
  /** Concrete, paste-ready message for CLI stderr. */
  userMessage: string;
  /** Shorter operator-action recommendation. Goes into Pino `hint` field. */
  hint: string;
}

/**
 * Classify an unknown error into a `RewrittenOAuthError`. Pure; never throws.
 * Non-Error inputs are coerced via `String(err)` (defensive — covers
 * primitives, null, undefined, and objects without a `.message` field).
 */
export function rewriteOAuthError(err: unknown): RewrittenOAuthError {
  const message = err instanceof Error ? err.message : String(err);

  // CRITICAL ORDERING: refresh_token_reused FIRST — it is a SPECIFIC kind
  // of invalid_grant. Match the more specific pattern before the generic.
  // Substring set verbatim from OpenClaw auth-profiles/oauth.ts:117-123.
  if (
    /refresh_token_reused/i.test(message) ||
    /refresh token has already been used/i.test(message) ||
    /already been used to generate a new access token/i.test(message)
  ) {
    return {
      code: "refresh_token_reused",
      errorKind: "refresh_token_reused",
      userMessage:
        "Refresh token was reused. The OpenAI account has been auto-locked for security. " +
        "Re-authenticate with: comis auth login --provider openai-codex",
      hint: "refresh_token_reused — re-login required",
    };
  }

  if (/invalid_grant/i.test(message)) {
    return {
      code: "invalid_grant",
      errorKind: "invalid_grant",
      userMessage:
        "Refresh token was rejected by OpenAI (invalid_grant). " +
        "Re-authenticate with: comis auth login --provider openai-codex",
      hint: "invalid_grant — re-login required",
    };
  }

  if (/unsupported_country_region_territory/i.test(message)) {
    return {
      code: "unsupported_region",
      errorKind: "unsupported_region",
      userMessage:
        "OpenAI rejected the request for this country, region, or network route. " +
        "If you normally use a proxy, verify HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY is set " +
        "for the Comis process. NOTE: Node's built-in fetch does NOT honor HTTPS_PROXY " +
        "by default (see docs/operations/proxy.md, shipped Phase 12).",
      hint: "Set HTTPS_PROXY to a US-region proxy and retry",
    };
  }

  if (/state mismatch|missing authorization code/i.test(message)) {
    return {
      code: "callback_validation_failed",
      errorKind: "callback_validation_failed",
      userMessage:
        "Browser callback validation failed (likely a stale browser tab). Retry the login flow.",
      hint: "Browser callback validation failed — retry",
    };
  }

  if (/Failed to extract accountId/i.test(message)) {
    return {
      code: "identity_decode_failed",
      errorKind: "identity_decode_failed",
      userMessage:
        "The OAuth response did not contain a parseable identity claim. " +
        "Re-run login or open an issue if the problem persists.",
      hint: "JWT had no identity claim",
    };
  }

  return {
    code: "callback_timeout",
    errorKind: "callback_timeout",
    userMessage: message,
    hint: "Restart the login flow",
  };
}
