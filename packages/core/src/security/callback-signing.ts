// SPDX-License-Identifier: Apache-2.0
import { createHmac, timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "@comis/shared";

/**
 * Signed interactive-approval callback primitive.
 *
 * Wire format: `v1.<choice>.<shortId>.<hmac>` where
 * - `choice` ∈ {approve|deny|details}
 * - `shortId` = 12 base62 chars (minted by `mintApprovalShortId`)
 * - `hmac` = first 16 base64url chars of `HMAC-SHA256(secret, "<choice>.<shortId>")`
 *
 * The HMAC is computed over `(choice, shortId)` ONLY — never `sessionKey`. The
 * verifier has the choice and shortId from the wire string and the secret from
 * the daemon, so it can recompute and compare; signing the (un-transmitted)
 * sessionKey would make verification impossible.
 *
 * Worst case `v1.approve.<12>.<16>` = 40 bytes, under the 64-byte Telegram
 * callback_data budget.
 *
 * SECURITY: this module is pure — it imports no logger and never stringifies,
 * returns, or embeds the secret. The secret is only passed to `createHmac`.
 * `verifyCallbackData` compares in constant time via `crypto.timingSafeEqual`
 * with a length-guard FIRST (timingSafeEqual throws on a length mismatch).
 */

/** Length, in base64url chars, of the truncated HMAC tag on the wire. */
const HMAC_LEN = 16;

/** The closed set of approval choices a callback may carry. */
export type CallbackChoice = "approve" | "deny" | "details";

/** 12 base62 chars — the shortId alphabet/length minted by the approval gate. */
const SHORT_ID_RE = /^[0-9A-Za-z]{12}$/;

/** Strict wire-format matcher: `v1.<choice>.<shortId(12 base62)>.<hmac(16 base64url)>`. */
const CALLBACK_RE = /^v1\.(approve|deny|details)\.([0-9A-Za-z]{12})\.([A-Za-z0-9_-]{16})$/;

/** Fallible render outcomes (closed union). */
export type CallbackRenderError = { kind: "invalid_choice" } | { kind: "invalid_short_id" };

/** A successfully-parsed callback string, pre-verification. */
export type ParsedCallback = {
  choice: CallbackChoice;
  shortId: string;
  hmac: string;
};

function isCallbackChoice(value: string): value is CallbackChoice {
  return value === "approve" || value === "deny" || value === "details";
}

/**
 * Compute the 16-char base64url HMAC tag over `(choice, shortId)`.
 *
 * Signs the pair ONLY — never the sessionKey (the verifier never receives it).
 */
export function signCallbackData(secret: string, choice: string, shortId: string): string {
  return createHmac("sha256", secret)
    .update(`${choice}.${shortId}`)
    .digest("base64url")
    .slice(0, HMAC_LEN);
}

/**
 * Constant-time verify of a provided HMAC tag against the expected tag for
 * `(choice, shortId)`.
 *
 * The length-guard runs BEFORE `timingSafeEqual` because `timingSafeEqual`
 * throws when the two buffers differ in length — a wrong-length (or tampered)
 * tag must return `false`, never throw. Never uses `===` on the secret-derived
 * tag (timing side-channel).
 */
export function verifyCallbackData(
  secret: string,
  choice: string,
  shortId: string,
  provided: string,
): boolean {
  const expected = signCallbackData(secret, choice, shortId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false; // length-guard FIRST — avoids timingSafeEqual throw
  return timingSafeEqual(a, b);
}

/**
 * Render a signed callback string for a valid `(choice, shortId)`.
 *
 * Validates the choice against the closed union and the shortId against the
 * base62/12 shape before signing; returns `err` rather than emitting a
 * malformed or unsigned payload.
 */
export function renderCallbackData(
  secret: string,
  choice: CallbackChoice,
  shortId: string,
): Result<string, CallbackRenderError> {
  if (!isCallbackChoice(choice)) return err({ kind: "invalid_choice" });
  if (!SHORT_ID_RE.test(shortId)) return err({ kind: "invalid_short_id" });
  return ok(`v1.${choice}.${shortId}.${signCallbackData(secret, choice, shortId)}`);
}

/**
 * Strictly parse a wire callback string into its components.
 *
 * The regex pins the version, the choice union, the base62 shortId, the
 * base64url hmac, and the exact segment count — any malformed or extended
 * payload is rejected as `malformed` BEFORE any verification is attempted.
 */
export function parseCallbackData(raw: string): Result<ParsedCallback, { kind: "malformed" }> {
  const match = CALLBACK_RE.exec(raw);
  if (match === null) return err({ kind: "malformed" });
  const [, choice, shortId, hmac] = match;
  // The regex guarantees `choice` is one of the union members.
  return ok({ choice: choice as CallbackChoice, shortId, hmac });
}
