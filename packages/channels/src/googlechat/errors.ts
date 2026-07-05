// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat error taxonomy: a pure classifier that maps a Chat / Pub/Sub REST
 * or token-endpoint HTTP status (or a transport-level failure) onto the closed
 * observability errorKind union, a retry disposition, and an operator-actionable,
 * origin-free hint. A defensive `Retry-After` reader lives alongside it.
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
  | "config"
  | "internal";

/** A classified platform failure: kind, retry disposition, status, and hint. */
export interface ClassifiedGoogleChatError {
  /** The observability error kind. */
  errorKind: GoogleChatErrorKind;
  /** Whether retrying the same request could plausibly succeed. */
  retryable: boolean;
  /** The HTTP status, when a response was received. */
  status?: number;
  /** An operator-actionable next step. Never carries a secret. */
  hint: string;
}

/**
 * Classify a platform failure by its HTTP status. The `retryable` disposition is
 * the transience axis — whether retrying the same request could plausibly
 * succeed — and is deliberately broader than the send path's own send-safety
 * decision (a non-idempotent create resends only on the statuses that reject
 * before the message lands).
 *
 * - `401` / `403` → `auth`, non-retryable — bad credentials, missing scope, or
 *   the service account is not authorized for the space/subscription; retrying
 *   without fixing the grant will not help.
 * - `429` → `platform`, retryable — rate limited; back off then retry.
 * - `>= 500` → `platform`, retryable — transient upstream error.
 * - `undefined` → `network`, retryable — no response reached us (transport fault).
 * - `400` / `404` → `config`, non-retryable — a missing/malformed subscription is
 *   an operator config error (wrong `subscriptionName`), not our own defect; the
 *   hint names the knob.
 * - any other status → `internal`, non-retryable — a genuinely unexpected
 *   response is our own defect, not a transient condition.
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
      retryable: true,
      hint: "Check outbound connectivity to oauth2.googleapis.com / chat.googleapis.com / pubsub.googleapis.com, then retry",
    };
  }
  if (status === 401 || status === 403) {
    return {
      errorKind: "auth",
      retryable: false,
      status,
      hint: "Verify the service-account key, its scopes (chat.bot / pubsub), and that the SA has roles/pubsub.subscriber on the subscription",
    };
  }
  if (status === 429) {
    return {
      errorKind: "platform",
      retryable: true,
      status,
      hint: "Rate limited — back off and retry after the indicated window",
    };
  }
  if (status >= 500) {
    return {
      errorKind: "platform",
      retryable: true,
      status,
      hint: "Upstream Google service error — retry with backoff",
    };
  }
  if (status === 404 || status === 400) {
    return {
      errorKind: "config",
      retryable: false,
      status,
      hint: "Verify channels.googlechat.subscriptionName (projects/{project}/subscriptions/{sub}) exists and the service account holds roles/pubsub.subscriber on it",
    };
  }
  return {
    errorKind: "internal",
    retryable: false,
    status,
    hint: "Unexpected response status — inspect the request shape and payload",
  };
}

/**
 * Read a `Retry-After` header defensively off a rate-limit response.
 *
 * The header is operator-untrusted input that would drive a wait, so this reader
 * never yields a NaN or a negative delay: an absent, unreadable, non-numeric, or
 * negative value returns `undefined` so the caller falls back to bounded backoff.
 * It resolves both header forms:
 *
 * - delta-seconds: a bare non-negative integer count of seconds.
 * - HTTP-date: an absolute instant, resolved to whole seconds from `nowMs`
 *   (clamped at 0 for a past date). A date needs an explicit reference clock —
 *   this pure reader never reads an ambient clock — so when `nowMs` is omitted a
 *   date value returns `undefined`.
 *
 * The returned value is a raw second count; the send path clamps it to its own
 * ceiling before awaiting, so a large-but-finite value is never awaited verbatim.
 *
 * @param res - The response, accessed only through an optional `headers.get`.
 * @param nowMs - Reference epoch-ms for resolving an HTTP-date form.
 */
export function parseRetryAfterSeconds(
  res: { headers?: { get?: (name: string) => string | null } },
  nowMs?: number,
): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // Delta-seconds form: a numeric lead means this is a second count. A negative
  // value is hostile/invalid — reject it rather than fall through to a date parse.
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds : undefined;
  }

  // HTTP-date form: resolve to a non-negative whole-second delay from the
  // supplied reference. Without a reference clock a date cannot be resolved.
  if (typeof nowMs !== "number") return undefined;
  const whenMs = Date.parse(trimmed);
  if (!Number.isFinite(whenMs)) return undefined;
  return Math.max(0, Math.round((whenMs - nowMs) / 1000));
}
