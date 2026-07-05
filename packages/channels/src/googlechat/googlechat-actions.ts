// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat card-action normalizer.
 *
 * Turns a verified CARD_CLICKED interaction event into a button-callback
 * NormalizedMessage the inbound approval path already understands — or drops it
 * (returning the reason) when the event is not a well-formed, rendered card
 * click, so the adapter can make the security-relevant rejects observable.
 *
 * Two trust decisions live here, and only these two:
 *
 *  - the clicker identity is sourced ONLY from the verified event envelope
 *    (`user.name`, established when the transport verified the Pub/Sub
 *    subscription or the webhook JWT) — never from the client-controllable
 *    `action.parameters` / `common.parameters` body; and
 *  - the invoked function must be one this bot actually renders
 *    ({@link RENDERED_FUNCTIONS}) — a click naming any other method never
 *    becomes a message.
 *
 * What this module deliberately does NOT do: it never authorizes the clicker
 * (that is the adapter's allowlist gate on the verified senderId) and never
 * verifies the callback signature (the downstream router's constant-time HMAC /
 * session / expiry / replay checks own that). The opaque callback is passed
 * through unparsed as `metadata.callbackData`.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";

/**
 * The action-method name the approval card renders on its buttons. Shared by the
 * renderer that stamps it onto the card and the validator here, so the rendered
 * set and the validated set are one source of truth and cannot drift.
 */
export const GOOGLECHAT_APPROVAL_FUNCTION = "comis.approval.resolve";

/**
 * The CLOSED set of action-method names this bot actually renders onto cards. A
 * click carrying any other method is dropped before it becomes a message — a
 * click cannot invoke a method that was never rendered.
 */
export const RENDERED_FUNCTIONS: readonly string[] = [GOOGLECHAT_APPROVAL_FUNCTION];

/**
 * Why a card click did not become a message.
 *
 *  - `ignored`: not a CARD_CLICKED event (a message or a lifecycle event) — a
 *    benign, expected drop the caller logs nowhere.
 *  - `unrendered-method`: the invoked function is outside {@link RENDERED_FUNCTIONS}
 *    — an arbitrary method a click could never have rendered (a crafted probe).
 *  - `missing-callback`: no opaque callback parameter — a malformed card click.
 *  - `missing-clicker`: no verified `user.name` — the clicker cannot be
 *    authorized downstream.
 *
 * The last three are security-relevant rejects the caller must make observable;
 * `ignored` is not. The normalizer stays pure — it names the reason, and the
 * adapter owns the logging.
 */
export type CardActionDropReason =
  | "ignored"
  | "unrendered-method"
  | "missing-callback"
  | "missing-clicker";

/**
 * The outcome of normalizing a card click: either the button-callback message,
 * or a drop carrying the {@link CardActionDropReason} so the caller can log the
 * specific reject class. Discriminate on `message === null`.
 */
export type CardActionResult =
  | { readonly message: NormalizedMessage; readonly reason?: undefined }
  | { readonly message: null; readonly reason: CardActionDropReason };

/**
 * Minimal CARD_CLICKED interaction-event shape — only the fields the normalizer
 * reads. Deliberately loose: the platform sends many more fields we ignore. The
 * invoked function and the opaque callback are each carried in two places (the
 * classic `action` object and the newer `common` object); both are read so the
 * normalizer is robust across delivery variants.
 */
export interface GoogleChatCardClickEvent {
  /** Event kind: "CARD_CLICKED" for a button click; anything else is ignored. */
  type?: string;
  /** The acting user; the ONLY source of the clicker id. */
  user?: { name?: string };
  /** The space the click happened in ("spaces/AAAA"). */
  space?: { name?: string };
  /** The clicked card message ("spaces/AAAA/messages/CCCC") — the edit target. */
  message?: { name?: string };
  /** Classic click payload: the invoked method plus a `{key,value}` parameter list. */
  action?: {
    actionMethodName?: string;
    parameters?: Array<{ key?: string; value?: string }>;
  };
  /** Newer click payload: the same invoked method plus a keyed parameter map. */
  common?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
  };
}
