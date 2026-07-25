// SPDX-License-Identifier: Apache-2.0
/**
 * Background task origin: captures the originating session attribution
 * (agent + session + channel + trace + hop count) at the moment a tool
 * execution is promoted to a background task. Persisted on the task so
 * completion can route a re-entry announcement back to the right session
 * even after a daemon restart.
 *
 * Lives in @comis/core (not @comis/agent) so the event-bus payload type
 * in core/src/event-bus/events-infra.ts can carry it without violating
 * the inward-only dependency direction.
 *
 * @module
 */

import { z } from "zod";
import { DeliveryOriginSchema } from "./delivery-origin.js";
import { ConversationRefSchema, ResolvedTurnScopeSchema, createConversationRef } from "./conversation-scope.js";
import { ResponseLocalePolicySchema } from "./response-locale-policy.js";

/**
 * Origin context captured at promote() time. All string fields are
 * non-empty so the runner can dispatch executor.execute() with the exact
 * canonical conversation authority.
 */
export const BackgroundTaskOriginSchema = z.strictObject({
  turnScope: ResolvedTurnScopeSchema,
  conversationRef: ConversationRefSchema,
  deliveryOrigin: DeliveryOriginSchema,
  /** Per-execution trace identifier; null when no trace was active. */
  traceId: z.string().nullable(),
  /** Exact locale decision captured before promotion. Delayed re-entry must
   *  not infer a locale from the internal completion envelope. */
  responseLocalePolicy: ResponseLocalePolicySchema,
  /** Recursion-bound counter. Captured at promote-time from the inbound
   *  NormalizedMessage's metadata.backgroundHopCount (defaults to 0 for
   *  top-level user messages). The completion runner increments this
   *  when constructing the outgoing synthetic message, and falls back to
   *  fallbackNotifyFn when (incomingHopCount + 1) >= maxBackgroundHops. */
  backgroundHopCount: z.number().int().nonnegative().default(0),
}).superRefine((value, ctx) => {
  const expected = createConversationRef(value.turnScope.conversation);
  if (!expected.ok || expected.value !== value.conversationRef) {
    ctx.addIssue({
      code: "custom",
      path: ["conversationRef"],
      message: "conversationRef must identify the persisted conversation scope",
    });
  }
  if (
    value.deliveryOrigin.tenantId !== value.turnScope.conversation.tenantId
    || value.deliveryOrigin.channelType !== value.turnScope.endpoint.channelType
    || value.deliveryOrigin.channelId !== value.turnScope.endpoint.conversationId
    || value.deliveryOrigin.userId !== value.turnScope.principal.principalId
    || value.deliveryOrigin.threadId !== value.turnScope.endpoint.threadId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["deliveryOrigin"],
      message: "delivery origin must agree with the resolved turn authority",
    });
  }
});

export type BackgroundTaskOrigin = z.infer<typeof BackgroundTaskOriginSchema>;
