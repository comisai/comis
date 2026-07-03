// SPDX-License-Identifier: Apache-2.0
/**
 * MsTeamsConversationStorePort — the persisted map from a conversation id to the
 * routing tuple a proactive send needs. A reply rides the inbound activity's own
 * `serviceUrl`/tenant; a PROACTIVE send (cron, heartbeat, an unsolicited notice)
 * has no inbound activity, so it must recover `{serviceUrl, tenantId, threadId}`
 * from somewhere durable — this store is that source of truth. The reference is
 * captured (upserted) on EVERY inbound activity so the freshest routing tuple is
 * always on hand.
 *
 * The domain record {@link ConversationReference}, its `z.strictObject` parser
 * {@link parseConversationReference}, and the port interface are co-located here:
 * the record is what the store round-trips and the parser is the tampering control
 * (a smuggled field — e.g. a `trustLevel` promotion claim — fails the parse).
 *
 * SECURITY: the reference carries ROUTING only — `serviceUrl`, `tenantId`,
 * `threadId`, `conversationId`. There is deliberately no token / bearer / body
 * field on {@link ConversationReference}, so the store is content-free by
 * interface design. A persisted `serviceUrl` remains untrusted at read: the send
 * path re-validates it against the host allowlist before it is used.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * The routing tuple a proactive send resolves from a conversation id. Content-free:
 * routing fields ONLY — there is deliberately no token / bearer / message-body
 * field. `updatedAt` is the wall-clock (ms) the reference was last captured; it
 * drives the store's TTL prune + cap eviction.
 */
export interface ConversationReference {
  /** The platform conversation id — the lookup key (hashed to the store's PK). */
  readonly conversationId: string;
  /** The per-conversation Bot Framework service base URL a send POSTs to. */
  readonly serviceUrl: string;
  /** The AAD tenant the conversation belongs to — required so a channel-originated proactive send authorizes. */
  readonly tenantId: string;
  /** The thread root (channel/group threads only); absent for a 1:1 or unthreaded chat. */
  readonly threadId?: string;
  /** Wall-clock (ms) of the last capture — drives TTL prune + cap eviction. */
  readonly updatedAt: number;
}

/**
 * The `z.strictObject` schema for {@link ConversationReference}. `strictObject` is
 * load-bearing — it REJECTS a smuggled field (e.g. a `trustLevel`/`source`
 * promotion claim) at {@link parseConversationReference}. Ids are
 * `z.string().min(1)` (an empty routing id is never valid); `threadId` is optional;
 * `updatedAt` is a number (ms).
 */
export const ConversationReferenceSchema = z.strictObject({
  conversationId: z.string().min(1),
  serviceUrl: z.string().min(1),
  tenantId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  updatedAt: z.number(),
});

/**
 * Parse unknown input into a {@link ConversationReference}, returning
 * `Result<T, ZodError>` (never throws). The `z.strictObject` rejects any smuggled
 * field, so a caller cannot promote trust or route through an unexpected column.
 */
export function parseConversationReference(
  raw: unknown,
): Result<ConversationReference, z.ZodError> {
  const result = ConversationReferenceSchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}

/**
 * The conversation-reference store. Both methods are `Result`-returning and never
 * throw (a corrupt row degrades to `err`). `capture` is an upsert refreshed on
 * every inbound activity; `get` recovers the freshest reference for a proactive
 * send, or `ok(undefined)` when the conversation was never captured.
 */
export interface MsTeamsConversationStorePort {
  /**
   * Persist (upsert) the reference keyed by the conversation id, refreshing the
   * routing tuple + `updatedAt`. Called on every inbound activity. The
   * implementation also prunes expired rows and caps table growth on capture.
   */
  capture(reference: ConversationReference): Promise<Result<void, Error>>;

  /**
   * Return the freshest stored reference for a conversation id, or
   * `ok(undefined)` when none has been captured. The send path consults this when
   * the caller supplies no inbound `serviceUrl` (the proactive case).
   */
  get(conversationId: string): Promise<Result<ConversationReference | undefined, Error>>;
}
