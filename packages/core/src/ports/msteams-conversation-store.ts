// SPDX-License-Identifier: Apache-2.0
/**
 * MsTeamsConversationStorePort — the persisted map from a conversation id to the
 * {@link ConversationReference} routing tuple a proactive send needs. A reply rides
 * the inbound activity's own `serviceUrl`/tenant; a PROACTIVE send (cron,
 * heartbeat, an unsolicited notice) has no inbound activity, so it recovers
 * `{serviceUrl, tenantId, threadId}` from this store. The reference is captured
 * (upserted) on EVERY inbound activity so the freshest routing tuple is stored.
 *
 * The domain record {@link ConversationReference}, its `z.strictObject` schema, and
 * its parser live in `../domain/msteams-conversation-reference.ts` (ports are
 * type-only); this file declares the store contract over that record.
 *
 * SECURITY: the reference carries ROUTING only — there is no credential field and
 * no message-content field, so the store is content-free by interface design. A
 * persisted `serviceUrl` remains untrusted at read: the send path re-validates it
 * against the host allowlist before it is used.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { ConversationReference } from "../domain/msteams-conversation-reference.js";

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
