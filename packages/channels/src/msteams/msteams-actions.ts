// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams card-action normalizer.
 *
 * Turns a Bot Framework "adaptiveCard/action" invoke into a button-callback
 * NormalizedMessage the inbound approval path already understands — or drops it
 * (returns null) when the activity is not a well-formed, rendered card action.
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
 * Normalize a Bot Framework card-action invoke into a button-callback message.
 *
 * Returns null (dropped, no message emitted) when the activity is not an
 * adaptiveCard/action invoke, the verb is not in {@link RENDERED_VERBS}, the
 * signed callback is missing, or `from.aadObjectId` is absent.
 *
 * @param activity - A Bot Framework invoke activity (already JWT-validated)
 * @returns A button-callback NormalizedMessage, or null when dropped
 */
export function normalizeCardAction(
  activity: TeamsActivity,
): NormalizedMessage | null {
  if (activity.type !== "invoke" || activity.name !== CARD_ACTION_INVOKE_NAME) {
    return null;
  }

  // APPROVE-02: the verb must be one the bot rendered; an unknown/absent verb
  // never becomes a message.
  const verb = activity.value?.action?.verb;
  if (verb === undefined || !RENDERED_VERBS.includes(verb)) {
    return null;
  }

  // The signed wire string, passed through opaquely — verified downstream.
  const cb = activity.value?.action?.data?.cb;
  if (typeof cb !== "string" || cb.length === 0) {
    return null;
  }

  // APPROVE-01: the clicker id is the verified directory id off the validated
  // activity — never anything under `value.action.data` (client-controllable).
  const senderId = activity.from?.aadObjectId;
  if (senderId === undefined || senderId.length === 0) {
    return null;
  }

  return {
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
  };
}
