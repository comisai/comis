// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix error taxonomy: a pure classifier that maps a Matrix Client-Server
 * API `M_*` errcode and/or an HTTP status onto the closed observability
 * errorKind union, a retry disposition, and an operator-actionable,
 * origin-free hint.
 *
 * One authoritative classifier so every failure branch (auth, client
 * lifecycle, adapter) keys on a consistent `errorKind` + `hint` instead of
 * inventing ad-hoc strings — the token-expiry recovery decision branches on
 * `errorKind === "auth"` (M_UNKNOWN_TOKEN) and the rate-limit backoff branches
 * on `retryable` (M_LIMIT_EXCEEDED / 429).
 *
 * The string `errcode` arm is evaluated first, then the numeric HTTP status.
 * An optional `cause` is accepted for context but never rendered into the
 * hint (a cause may echo a token, message body, or other secret-bearing text).
 *
 * @module
 */

import type { ErrorKind } from "@comis/core";

/**
 * The subset of the observability errorKind union this taxonomy emits.
 * Typed via `Extract` so each member is compiler-checked against the closed
 * `LogFields.ErrorKind` union.
 */
export type MatrixErrorKind = Extract<ErrorKind, "auth" | "platform" | "internal">;

/** A Matrix failure normalized to the fields the classifier reads. */
export interface MatrixErrorInput {
  /** The Matrix Client-Server API errcode (e.g. "M_UNKNOWN_TOKEN"), when present. */
  errcode?: string;
  /** The HTTP status of the response, when one was received. */
  status?: number;
  /**
   * The originating error, accepted for context but never interpolated into
   * the hint (it may carry secret-bearing text).
   */
  cause?: unknown;
}

/** A classified Matrix failure: kind, retry disposition, status, and hint. */
export interface ClassifiedMatrixError {
  /** The observability error kind. */
  errorKind: MatrixErrorKind;
  /** Whether retrying the same request could plausibly succeed. */
  retryable: boolean;
  /** The HTTP status, when a response was received. */
  status?: number;
  /** An operator-actionable next step. Never carries a secret. */
  hint: string;
}

/** Attach the HTTP status to a classification only when one is known. */
function withStatus(
  base: Omit<ClassifiedMatrixError, "status">,
  status: number | undefined,
): ClassifiedMatrixError {
  return status === undefined ? base : { ...base, status };
}

/**
 * Classify a Matrix failure by its errcode (evaluated first) then HTTP status.
 *
 * - errcode `M_UNKNOWN_TOKEN` → `auth`, non-retryable — the access token was
 *   rejected or expired; the token-expiry recovery branch keys on this kind.
 * - errcode `M_LIMIT_EXCEEDED` or status `429` → `platform`, retryable — rate
 *   limited; back off and retry after the server's retry-after window.
 * - errcode `M_FORBIDDEN` or status `403` → `auth`, non-retryable — not
 *   authorized (bad grant, not a room member, or insufficient power level).
 * - status `>= 500` → `platform`, retryable — transient homeserver error.
 * - no errcode and no status → `internal`, non-retryable — an unclassified
 *   failure with no signal to key on.
 *
 * @param input - The Matrix error, normalized to `{ errcode?, status?, cause? }`.
 */
export function classifyMatrixError(input: MatrixErrorInput): ClassifiedMatrixError {
  const { errcode, status, cause } = input;
  // `cause` is intentionally not read into the hint: it may carry secrets.
  void cause;

  // --- String errcode arm (evaluated before the HTTP status) ---
  if (errcode === "M_UNKNOWN_TOKEN") {
    return withStatus(
      {
        errorKind: "auth",
        retryable: false,
        hint: "Access token rejected or expired — replace `channels.matrix.accessToken` (or re-login to mint a fresh token), then restart the channel",
      },
      status,
    );
  }
  if (errcode === "M_LIMIT_EXCEEDED" || status === 429) {
    return withStatus(
      {
        errorKind: "platform",
        retryable: true,
        hint: "Rate limited by the homeserver — back off and retry after the server's retry-after window",
      },
      status,
    );
  }
  if (errcode === "M_FORBIDDEN" || status === 403) {
    return withStatus(
      {
        errorKind: "auth",
        retryable: false,
        hint: "Not authorized for this action — confirm the account has joined the room and holds sufficient power level, and that the access token grants this operation",
      },
      status,
    );
  }

  // --- HTTP status arm ---
  if (status !== undefined && status >= 500) {
    return withStatus(
      {
        errorKind: "platform",
        retryable: true,
        hint: "Homeserver error — retry with backoff",
      },
      status,
    );
  }

  // No errcode and no actionable status: nothing to key on.
  return withStatus(
    {
      errorKind: "internal",
      retryable: false,
      hint: "Unclassified Matrix failure — inspect the returned errcode and HTTP status against the homeserver response",
    },
    status,
  );
}
