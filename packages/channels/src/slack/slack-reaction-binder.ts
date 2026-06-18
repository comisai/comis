// SPDX-License-Identifier: Apache-2.0
/**
 * Slack reaction-add binder (REACT-01, Verified Learning WS1).
 *
 * Co-located out of slack-adapter.ts (which keeps only the `reactionHandlers`
 * array + the bind call + the `onReaction` registration). Registers
 * `app.event("reaction_added")` and mints a NormalizedReaction from the Slack
 * payload, filtering the bot's own-user reactions (mirror the own-user filter
 * on the message binder at slack-adapter.ts:174).
 *
 * SHORT-NAME vs UNICODE: Slack delivers `event.reaction` as a short name
 * (e.g. "thumbsup"), NOT the Unicode `👍` that the default `reactionMap` holds.
 * The binder passes the RAW short name through unchanged — the daemon-side
 * reactionMap match (Plan 04) owns reconciling Slack short names against the
 * map (DECISION deferred to Plan 04 where the map lives). Do not normalize here.
 *
 * The reactorId is UNTRUSTED inbound; no trust is assigned here. Fanout is
 * fire-and-forget so one throwing handler cannot crash the Bolt event loop.
 *
 * OPERATOR SETUP (DOC-01): Slack delivers nothing unless the app holds the
 * `reactions:read` scope + a `reaction_added` event subscription (silent like
 * Telegram's allowed_updates) — documented as operator setup, not a code gate.
 *
 * @module
 */

import type { ComisLogger, NormalizedReaction, ReactionHandler } from "@comis/core";

/**
 * Minimal structural shape of the Slack `reaction_added` event payload —
 * mirrors how {@link SlackMessageEvent} types the message binder (no `as any`).
 * Only the fields the binder reads are declared.
 */
export interface SlackReactionAddedEvent {
  /** The reacting user's Slack id (Uxxxx). */
  user: string;
  /** The reaction SHORT NAME (e.g. "thumbsup") — NOT Unicode (mapped at Plan 04). */
  reaction: string;
  /** The reacted-to item: a message identified by its ts + channel. */
  item: { ts: string; channel: string };
}

/**
 * Minimal structural shape of the @slack/bolt App surface the binder uses —
 * just the `event(name, handler)` registration. The adapter passes its
 * dynamically-imported `App` instance (typed `any` at the call site to keep
 * `@slack/bolt` optional at module level).
 */
export interface SlackReactionApp {
  event(
    name: "reaction_added",
    handler: (args: { event: SlackReactionAddedEvent }) => Promise<void> | void,
  ): void;
}

/** Log a non-fatal reaction-handler failure (sync throw or rejected promise). */
function warnHandlerFailed(logger: ComisLogger, handlerErr: unknown): void {
  logger.warn(
    {
      channelType: "slack",
      errorKind: "platform" as const,
      err: handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)),
      hint: "Slack reaction handler threw; reaction dropped (non-fatal)",
    },
    "Reaction handler failed",
  );
}

/**
 * Register the `reaction_added` listener on the Bolt `app`. Each non-own-user
 * reaction mints a NormalizedReaction and is dispatched to every handler.
 *
 * @param app - the @slack/bolt App (post-start; `event()` is available)
 * @param getOwnUserId - lazily resolves the bot's own user id (set post-auth in start())
 * @param reactionHandlers - the live handler array the adapter pushes onReaction handlers onto
 * @param logger - adapter logger for the non-fatal handler-failure WARN branch
 */
export function bindSlackReactions(
  app: SlackReactionApp,
  getOwnUserId: () => string,
  reactionHandlers: ReactionHandler[],
  logger: ComisLogger,
): void {
  app.event("reaction_added", ({ event }: { event: SlackReactionAddedEvent }) => {
    // Own-user filter — never count the bot's own reactions.
    if (event.user === getOwnUserId()) {
      return;
    }

    const normalized: NormalizedReaction = {
      messageId: event.item.ts,
      reactorId: event.user,
      // RAW Slack short name — the daemon reactionMap match (Plan 04) reconciles it.
      emoji: event.reaction,
      channelType: "slack",
      channelId: event.item.channel,
    };

    for (const handler of reactionHandlers) {
      // try/catch in addition to .catch so a SYNCHRONOUS handler throw is also
      // non-fatal (a sync throw escapes Promise.resolve()).
      try {
        void Promise.resolve(handler(normalized)).catch((handlerErr: unknown) =>
          warnHandlerFailed(logger, handlerErr),
        );
      } catch (handlerErr) {
        warnHandlerFailed(logger, handlerErr);
      }
    }
  });
}
