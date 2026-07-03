// SPDX-License-Identifier: Apache-2.0
/**
 * ConversationReference: the routing tuple a proactive send resolves from a
 * conversation id.
 *
 * A reply rides the inbound activity's own `serviceUrl`/tenant; a PROACTIVE send
 * (cron, heartbeat, an unsolicited notice) has no inbound activity, so it must
 * recover `{serviceUrl, tenantId, threadId}` from a durable store keyed by the
 * conversation id. This record is what that store (behind
 * {@link MsTeamsConversationStorePort}) round-trips.
 *
 * Content-free: routing fields ONLY — there is deliberately no credential field
 * and no message-content field. A persisted `serviceUrl` stays untrusted at read;
 * the send path re-validates it against the host allowlist before use.
 *
 * SECURITY: the tampering control that is actually ENGAGED on the store path is the
 * ROW schema (`MsTeamsConversationRowSchema`, also a `z.strictObject`) that the
 * memory store's row mapper applies when a reference is read back — it rejects a
 * smuggled column and degrades a corrupt row to `err`. The `z.strictObject` here
 * is the same shape guard for any caller that validates an untrusted reference
 * through {@link parseConversationReference}, but it is interface-first: no
 * production caller invokes it yet (the inbound capture builds a fixed-shape
 * literal from typed extractions), so treat it as available validation rather than
 * the live guard.
 */

import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * The routing tuple a proactive send resolves from a conversation id. `updatedAt`
 * is the wall-clock (ms) the reference was last captured; it drives the store's TTL
 * prune + cap eviction.
 */
export interface ConversationReference {
  /** The platform conversation id — the lookup key (hashed to the store's PK). */
  readonly conversationId: string;
  /** The per-conversation service base URL a send POSTs to. */
  readonly serviceUrl: string;
  /** The AAD tenant the conversation belongs to — required so a channel-originated proactive send authorizes. */
  readonly tenantId: string;
  /** The thread root (channel/group threads only); absent for a 1:1 or unthreaded chat. */
  readonly threadId?: string;
  /** Wall-clock (ms) of the last capture — drives TTL prune + cap eviction. */
  readonly updatedAt: number;
}

/**
 * The `z.strictObject` schema for {@link ConversationReference}. `strictObject`
 * REJECTS a smuggled field (e.g. a `trustLevel`/`source` promotion claim) for any
 * caller that validates through it. Ids are `z.string().min(1)` (an empty routing
 * id is never valid); `threadId` is optional; `updatedAt` is a number (ms). The
 * live tampering control on the store path is the memory store's row schema
 * (`MsTeamsConversationRowSchema`); this domain schema is interface-first — see the
 * module note above.
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
 * Interface-first: exported for callers that need to validate an untrusted
 * reference, but no production path invokes it yet (the store's read-side row
 * mapper is the engaged guard).
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
