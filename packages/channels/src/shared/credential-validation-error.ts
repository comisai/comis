// SPDX-License-Identifier: Apache-2.0
/**
 * Shared credential-validation failure classification.
 *
 * Channel credential validators (Telegram getMe, Slack auth.test, Email IMAP
 * connect, …) fail for two very different reasons that demand opposite operator
 * actions:
 *   - `network`  — the API host is UNREACHABLE (DNS/connect/timeout/TLS/proxy).
 *                  The token may be perfectly valid; the fix is connectivity /
 *                  egress-proxy configuration, NOT the credential.
 *   - `auth`     — the host was reached and REJECTED the credential (401/403/
 *                  invalid_auth/Not Found). The fix IS the credential.
 *
 * Before this split, a proxy/connectivity failure surfaced the misleading
 * "verify your token via @BotFather" hint (see the egress-proxy incident: a
 * valid Telegram bot looked invalid because getMe() couldn't reach
 * api.telegram.org through the proxy). Classifying lets each call site emit the
 * hint that fits the actual failure class.
 *
 * @module
 */

import { err, type Result } from "@comis/shared";

/** Failure class for a channel credential-validation attempt. */
export type ValidationFailureKind = "network" | "auth" | "unknown";

/**
 * Error carrying a `kind` discriminator so the daemon wiring can branch the
 * operator hint (and `errorKind` log field) on the failure class. Returned via
 * `err()` — never thrown.
 */
export class CredentialValidationError extends Error {
  readonly kind: ValidationFailureKind;

  constructor(message: string, kind: ValidationFailureKind, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialValidationError";
    this.kind = kind;
  }
}

// Network/connectivity/TLS/proxy reachability signatures. Checked FIRST so a
// transport failure is never misread as an auth rejection.
const NETWORK_PATTERN =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNABORTED|socket hang up|connection (refused|reset|closed|timed out)|network (request|error)|fetch failed|timed? ?out|timeout|getaddrinfo|tunnel|proxy|certificate|self.signed|CERT_|DEPTH_ZERO|unable to (verify|get)|TLS|SSL/i;

// Credential-rejection signatures — host reached, credential refused.
const AUTH_PATTERN =
  /\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]auth|invalid token|bad credentials|authentication failed|not_authed|account_inactive|token_revoked|not found: bot/i;

/**
 * Classify a caught validation error as `network`, `auth`, or `unknown`.
 * Inspects the error message AND its `cause` chain (undici/fetch nest the real
 * transport error under `error.cause`).
 */
export function classifyValidationError(error: unknown): ValidationFailureKind {
  const parts: string[] = [];
  let cur: unknown = error;
  // Walk up to a few cause links so a wrapped transport error is seen.
  for (let i = 0; i < 4 && cur != null; i++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur.cause as unknown) : undefined;
  }
  const hay = parts.join(" :: ");
  if (NETWORK_PATTERN.test(hay)) {
    return "network";
  }
  if (AUTH_PATTERN.test(hay)) {
    return "auth";
  }
  return "unknown";
}

/**
 * Build a `CredentialValidationError` from a caught error, classifying it and
 * choosing a class-appropriate message prefix.
 *
 * @param error - the caught error
 * @param authPrefix - message prefix for an auth/unknown failure (e.g.
 *   "Invalid Telegram bot token")
 * @param networkPrefix - message prefix for a network failure (e.g.
 *   "Telegram getMe() unreachable (network/proxy)")
 */
export function classifiedValidationErr<T>(
  error: unknown,
  authPrefix: string,
  networkPrefix: string,
): Result<T, CredentialValidationError> {
  const kind = classifyValidationError(error);
  const detail = error instanceof Error ? error.message : String(error);
  const prefix = kind === "network" ? networkPrefix : authPrefix;
  return err(
    new CredentialValidationError(`${prefix}: ${detail}`, kind, {
      cause: error instanceof Error ? error : undefined,
    }),
  );
}
