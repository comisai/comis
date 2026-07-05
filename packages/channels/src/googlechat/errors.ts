// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat error taxonomy: a pure classifier that maps a Chat / Pub/Sub REST
 * or token-endpoint HTTP status (or a transport-level failure) onto the closed
 * observability errorKind union and an operator-actionable, origin-free hint.
 *
 * Deliberately minimal — the token mint, the pull loop, and the outbound send
 * path consult it to attach `errorKind` / `hint` on their failure branches. It
 * reads only the numeric status; an optional cause is accepted for context but
 * never rendered into the hint (a cause may carry secret-bearing text).
 *
 * @module
 */

/** The subset of the observability errorKind union this taxonomy emits. */
export type GoogleChatErrorKind =
  | "auth"
  | "platform"
  | "network"
  | "precondition"
  | "internal";

/** A classified platform failure: kind, status, and hint. */
export interface ClassifiedGoogleChatError {
  /** The observability error kind. */
  errorKind: GoogleChatErrorKind;
  /** The HTTP status, when a response was received. */
  status?: number;
  /** An operator-actionable next step. Never carries a secret. */
  hint: string;
}

/**
 * Classify a platform failure by its HTTP status.
 *
 * - `401` / `403` → `auth` — bad credentials, missing scope, or the service
 *   account is not authorized for the space/subscription; retrying without
 *   fixing the grant will not help.
 * - `429` → `platform` — rate limited; back off then retry.
 * - `>= 500` → `platform` — transient upstream error.
 * - `undefined` → `network` — no response reached us (transport fault).
 * - any other status (e.g. an unexpected 4xx) → `internal` — a malformed
 *   request is our own defect, not a transient condition.
 *
 * @param status - The HTTP status of the response, or undefined for a
 *   transport-level failure where no response was received.
 * @param cause - The originating error, accepted for context but never
 *   interpolated into the hint (it may carry secret-bearing text).
 */
export function classifyGoogleChatError(
  status: number | undefined,
  cause?: unknown,
): ClassifiedGoogleChatError {
  // `cause` is intentionally not read into the hint: it may carry secrets.
  void cause;

  if (status === undefined) {
    return {
      errorKind: "network",
      hint: "Check outbound connectivity to oauth2.googleapis.com / chat.googleapis.com / pubsub.googleapis.com, then retry",
    };
  }
  if (status === 401 || status === 403) {
    return {
      errorKind: "auth",
      status,
      hint: "Verify the service-account key, its scopes (chat.bot / pubsub), and that the SA has roles/pubsub.subscriber on the subscription",
    };
  }
  if (status === 429) {
    return {
      errorKind: "platform",
      status,
      hint: "Rate limited — back off and retry after the indicated window",
    };
  }
  if (status >= 500) {
    return {
      errorKind: "platform",
      status,
      hint: "Upstream Google service error — retry with backoff",
    };
  }
  return {
    errorKind: "internal",
    status,
    hint: "Unexpected response status — inspect the request shape and payload",
  };
}
