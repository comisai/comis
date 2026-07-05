// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams card-action normalizer.
 *
 * Turns a Bot Framework "adaptiveCard/action" invoke into a button-callback
 * NormalizedMessage the inbound approval path already understands — or drops it
 * (returning the reason) when the activity is not a well-formed, rendered card
 * action, so the adapter can make the security-relevant rejects observable.
 *
 * Two trust decisions live here, and only these two:
 *
 *  - the clicker identity is sourced ONLY from the verified activity
 *    (`from.aadObjectId`, established when the ingress validated the Bot
 *    Framework JWT) — never from the client-controllable `value.action.data`; and
 *  - the incoming `verb` must be one this bot actually renders
 *    (`RENDERED_VERBS`) — an unknown verb never becomes a message.
 *
 * What this module deliberately does NOT do: it never authorizes the clicker
 * (default-deny is the existing allowFrom gate on the verified senderId) and
 * never verifies the callback signature (the downstream router's constant-time
 * HMAC / session / expiry / replay checks own that). The signed `data.cb` is
 * passed through opaquely as `metadata.callbackData`.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { randomUUID } from "node:crypto";
import { stripMessageIdSuffix, type TeamsActivity } from "./message-mapper.js";

/** The invoke `name` a card-action click carries. */
const CARD_ACTION_INVOKE_NAME = "adaptiveCard/action";

/**
 * The verb the approval card renders on its buttons. Shared by the renderer
 * that stamps it onto the card and the validator here, so the two never drift.
 */
export const MSTEAMS_APPROVAL_VERB = "comis.approval.resolve";

/**
 * The CLOSED set of verbs this bot actually renders onto cards. A card-action
 * invoke carrying any other verb is dropped before it becomes a message — a
 * click cannot invoke a method that was never rendered.
 */
export const RENDERED_VERBS: readonly string[] = [MSTEAMS_APPROVAL_VERB];

/**
 * Why a card-action invoke did not become a message.
 *
 *  - `ignored`: not an adaptiveCard/action invoke (a ping or a non-card invoke)
 *    — a benign, expected drop the caller logs nowhere.
 *  - `unrendered-verb`: the verb is outside {@link RENDERED_VERBS} — an arbitrary
 *    method a click could never have rendered (an attacker-crafted probe).
 *  - `missing-callback`: no signed `data.cb` — a malformed card action.
 *  - `missing-clicker`: no verified `from.aadObjectId` — the clicker cannot be
 *    authorized (e.g. a guest/federated identity the tenant did not populate).
 *
 * The last three are security-relevant rejects the caller must make observable;
 * `ignored` is not. The normalizer stays pure — it names the reason, and the
 * adapter owns the §2.7 logging (as it does for the message and reaction drops).
 */
export type CardActionDropReason =
  | "ignored"
  | "unrendered-verb"
  | "missing-callback"
  | "missing-clicker";

/**
 * The outcome of normalizing a card-action invoke: either the button-callback
 * message, or a drop carrying the {@link CardActionDropReason} so the caller can
 * log the specific reject class. Discriminate on `message === null`.
 */
export type CardActionResult =
  | { readonly message: NormalizedMessage; readonly reason?: undefined }
  | { readonly message: null; readonly reason: CardActionDropReason };

/**
 * Normalize a Bot Framework card-action invoke into a button-callback message.
 *
 * Returns `{ message }` on success, or `{ message: null, reason }` when the
 * activity is not an adaptiveCard/action invoke (`ignored`), the verb is not in
 * {@link RENDERED_VERBS} (`unrendered-verb`), the signed callback is missing
 * (`missing-callback`), or `from.aadObjectId` is absent (`missing-clicker`).
 * The reason lets the caller log the security-relevant rejects per §2.7 while
 * this function stays a pure mapper.
 *
 * @param activity - A Bot Framework invoke activity (already JWT-validated)
 * @returns A button-callback message, or a drop carrying its reason
 */
export function normalizeCardAction(activity: TeamsActivity): CardActionResult {
  if (activity.type !== "invoke" || activity.name !== CARD_ACTION_INVOKE_NAME) {
    return { message: null, reason: "ignored" };
  }

  // The verb must be one the bot rendered; an unknown or absent verb never
  // becomes a message.
  const verb = activity.value?.action?.verb;
  if (verb === undefined || !RENDERED_VERBS.includes(verb)) {
    return { message: null, reason: "unrendered-verb" };
  }

  // The signed wire string, passed through opaquely — verified downstream.
  const cb = activity.value?.action?.data?.cb;
  if (typeof cb !== "string" || cb.length === 0) {
    return { message: null, reason: "missing-callback" };
  }

  // The clicker id is the verified directory id off the validated activity —
  // never anything under `value.action.data` (client-controllable).
  const senderId = activity.from?.aadObjectId;
  if (senderId === undefined || senderId.length === 0) {
    return { message: null, reason: "missing-clicker" };
  }

  return {
    message: {
      id: randomUUID(),
      channelType: "msteams",
      channelId: stripMessageIdSuffix(activity.conversation.id),
      senderId,
      text: cb,
      timestamp: systemNowMs(),
      attachments: [],
      metadata: {
        isButtonCallback: true,
        callbackData: cb,
        messageId: activity.id,
      },
    },
  };
}
