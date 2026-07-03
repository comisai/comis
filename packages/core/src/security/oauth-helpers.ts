// SPDX-License-Identifier: Apache-2.0
/**
 * Consolidated OAuth helpers for OpenAI Codex.
 *
 * Combines:
 *   - JWT decode + identity resolution (including the email-redaction helper).
 *   - Error catalogue / classifier. The `refresh_token_reused` substring
 *     matchers cover every error phrasing OpenAI has been observed to emit
 *     for that condition. Derived from third-party code; see NOTICE.
 *
 * CRITICAL ORDERING: refresh_token_reused MUST be tested BEFORE
 * invalid_grant — refresh_token_reused is a SPECIFIC kind of
 * invalid_grant; the more-specific matcher must win.
 *
 * Field convention: `code` is the OAuth domain discriminator (consumed by
 * CLI, events, tests via switch on the 6 OAuthErrorCode values).
 * `logErrorKind` is the closed-Pino-ErrorKind mirror (always "auth"); logger
 * payloads use `errorKind: "auth"` directly OR destructure `logErrorKind`. The
 * closed ErrorKind union prevents domain values from leaking into
 * Pino log streams. Consumers carrying the discriminator into downstream
 * shapes (OAuthError.errorKind, auth:refresh_failed event payload) read
 * `rewritten.code` directly.
 *
 * @module
 */

import type { ErrorKind } from "../logging/log-fields.js";

const PROFILE_CLAIM_NS = "https://api.openai.com/profile";

// ============================================================================
// JWT helpers
// ============================================================================

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Decode the payload segment of a JWT.
 * Returns null on any malformed input (wrong segment count, bad base64url,
 * invalid JSON, non-object payload). Returning null is a sentinel, not
 * silent error swallowing.
 */
export function decodeCodexJwtPayload(accessToken: string): Record<string, unknown> | null {
  if (typeof accessToken !== "string") return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoded = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical stable subject for fallback profile naming.
 * Priority: chatgpt_account_user_id > chatgpt_user_id > user_id > iss|sub > sub.
 */
export function resolveCodexStableSubject(payload: Record<string, unknown>): string | undefined {
  const candidates: Array<string | undefined> = [
    trimNonEmptyString(payload.chatgpt_account_user_id),
    trimNonEmptyString(payload.chatgpt_user_id),
    trimNonEmptyString(payload.user_id),
    (() => {
      const iss = trimNonEmptyString(payload.iss);
      const sub = trimNonEmptyString(payload.sub);
      if (iss && sub) return iss + "|" + sub;
      return undefined;
    })(),
    trimNonEmptyString(payload.sub),
  ];
  for (const c of candidates) if (c) return c;
  return undefined;
}

/**
 * Resolve the canonical email + profileName for a Codex identity.
 * Priority for email: explicit `opts.email` > JWT `https://api.openai.com/profile.email`.
 * profileName = email when available, else `id-<base64url(stableSubject)>`.
 */
export function resolveCodexAuthIdentity(opts: {
  accessToken: string;
  email?: string;
}): { email?: string; profileName?: string } {
  const explicit = trimNonEmptyString(opts.email);
  const payload = decodeCodexJwtPayload(opts.accessToken);

  let email: string | undefined = explicit;
  if (!email && payload) {
    // eslint-disable-next-line security/detect-object-injection -- PROFILE_CLAIM_NS is a literal module constant, not user input
    const profile = payload[PROFILE_CLAIM_NS];
    if (profile !== null && typeof profile === "object" && !Array.isArray(profile)) {
      email = trimNonEmptyString((profile as Record<string, unknown>).email);
    }
  }

  if (email) return { email, profileName: email };

  if (payload) {
    const subject = resolveCodexStableSubject(payload);
    if (subject) {
      const subjectB64 = Buffer.from(subject, "utf8").toString("base64url");
      return { email: undefined, profileName: "id-" + subjectB64 };
    }
  }

  return { email: undefined, profileName: undefined };
}

/**
 * Extract the access-token expiry as milliseconds since epoch.
 * The JWT exp claim is in seconds (RFC 7519); we multiply by 1000 to match
 * pi-ai's OAuthCredentials.expires unit (ms).
 * Accepts numeric `exp` and digit-only string `exp`.
 */
export function resolveCodexAccessTokenExpiry(accessToken: string): number | undefined {
  const payload = decodeCodexJwtPayload(accessToken);
  if (!payload) return undefined;
  const expRaw = payload.exp;
  let expSec: number | undefined;
  if (typeof expRaw === "number" && Number.isFinite(expRaw)) {
    expSec = expRaw;
  } else if (typeof expRaw === "string" && /^\d+$/.test(expRaw)) {
    expSec = Number(expRaw);
  }
  if (expSec === undefined) return undefined;
  return expSec * 1000;
}

/**
 * Semi-redact an email for safe inclusion in logs.
 * Format: first 2 chars + ellipsis + last char of local-part, then "@" + full domain.
 * Edge cases:
 *  - undefined input → undefined
 *  - input without "@" → returned unchanged
 *  - 1-char local-part → "…@<domain>"
 *  - 2-char local-part → "<first>…<last>@<domain>" (single char on each side)
 */
export function redactEmailForLog(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const atIdx = email.indexOf("@");
  if (atIdx < 0) return email;
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  if (local.length === 0) return email;
  if (local.length === 1) return "…@" + domain;
  if (local.length === 2) return local.charAt(0) + "…" + local.charAt(1) + "@" + domain;
  return local.slice(0, 2) + "…" + local.charAt(local.length - 1) + "@" + domain;
}

// ============================================================================
// Error catalogue / classifier (lifted verbatim from agent/src/model/oauth-errors.ts)
// ============================================================================

/** Discriminator union for the 6 classifiable OAuth error cases. */
export type OAuthErrorCode =
  | "unsupported_region"
  | "callback_validation_failed"
  | "invalid_grant"
  | "refresh_token_reused"
  | "identity_decode_failed"
  | "callback_timeout";

/**
 * Output record carrying both UX-facing text and Pino-log-field values.
 *
 * Domain consumers switch on `code` (the OAuth discriminator); logger
 * payloads use `logErrorKind` (the closed-union mirror for Pino log fields).
 *
 * `rewritten.code` carries the OAuth-domain discriminator value (one of
 * "refresh_token_reused" | "invalid_grant" | …) into the OAuthError + event
 * payload contracts.
 */
export interface RewrittenOAuthError {
  /** Domain discriminator. NOT a logger-payload value. */
  code: OAuthErrorCode;
  /** Always "auth" — closed-union mirror for Pino logs. */
  logErrorKind: ErrorKind;
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
  // The substring set covers every phrasing OpenAI has been observed to
  // emit for a reused refresh token — do not narrow it.
  if (
    /refresh_token_reused/i.test(message) ||
    /refresh token has already been used/i.test(message) ||
    /already been used to generate a new access token/i.test(message)
  ) {
    return {
      code: "refresh_token_reused",
      logErrorKind: "auth",
      userMessage:
        "Refresh token was reused. The OpenAI account has been auto-locked for security. " +
        "Re-authenticate with: comis auth login --provider openai-codex",
      hint: "refresh_token_reused — re-login required",
    };
  }

  if (/invalid_grant/i.test(message)) {
    return {
      code: "invalid_grant",
      logErrorKind: "auth",
      userMessage:
        "Refresh token was rejected by OpenAI (invalid_grant). " +
        "Re-authenticate with: comis auth login --provider openai-codex",
      hint: "invalid_grant — re-login required",
    };
  }

  if (/unsupported_country_region_territory/i.test(message)) {
    return {
      code: "unsupported_region",
      logErrorKind: "auth",
      userMessage:
        "OpenAI rejected the request for this country, region, or network route. " +
        "If you normally use a proxy, verify HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY is set " +
        "for the Comis process. NOTE: Node's built-in fetch does NOT honor HTTPS_PROXY " +
        "by default (see docs/operations/proxy.mdx).",
      hint: "Set HTTPS_PROXY to a US-region proxy and retry",
    };
  }

  if (/state mismatch|missing authorization code/i.test(message)) {
    return {
      code: "callback_validation_failed",
      logErrorKind: "auth",
      userMessage:
        "Browser callback validation failed (likely a stale browser tab). Retry the login flow.",
      hint: "Browser callback validation failed — retry",
    };
  }

  if (/Failed to extract accountId/i.test(message)) {
    return {
      code: "identity_decode_failed",
      logErrorKind: "auth",
      userMessage:
        "The OAuth response did not contain a parseable identity claim. " +
        "Re-run login or open an issue if the problem persists.",
      hint: "JWT had no identity claim",
    };
  }

  return {
    code: "callback_timeout",
    logErrorKind: "auth",
    userMessage: message,
    hint: "Restart the login flow",
  };
}
