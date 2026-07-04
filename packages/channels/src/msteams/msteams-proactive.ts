// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams proactive-send helpers — pure logic over injected ports.
 *
 * A reply rides the inbound activity's own serviceUrl; a PROACTIVE send (cron,
 * heartbeat, an unsolicited notice) has no inbound activity, so it recovers the
 * routing tuple from the conversation store keyed by the conversation id. This
 * file holds the pure pieces of that path — no SQLite, no transport — so the
 * adapter stays the controller:
 *
 *  - {@link rebuildConversationReference} maps a stored reference to the send
 *    inputs, RE-VALIDATING the stored serviceUrl through the caller's host guard
 *    on every send. A stored serviceUrl is untrusted at read (it could have been
 *    tampered), so a poisoned value is rejected before a token is ever minted —
 *    the freshly minted Connector bearer token can never be sent to a foreign
 *    host.
 *
 * @module
 */

import type { ConversationReference } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

/** The routing inputs a proactive Connector send needs, recovered from the store. */
export interface ProactiveSendTarget {
  /** The per-conversation service base URL to POST to (host-re-validated). */
  serviceUrl: string;
  /** The AAD tenant the conversation belongs to. */
  tenantId: string;
  /** The channel/group thread root to thread under, when present. */
  threadId?: string;
}

/**
 * Map a stored {@link ConversationReference} to a {@link ProactiveSendTarget},
 * re-validating the stored serviceUrl through the injected host guard. Returns
 * `err` when the stored serviceUrl fails the guard — the interim stored-reference
 * defense that keeps the bearer token from reaching a poisoned host.
 *
 * `isSafeServiceUrl` is injected (rather than imported) so this helper stays pure
 * and the adapter remains the single owner of the host allowlist.
 */
export function rebuildConversationReference(
  stored: ConversationReference,
  isSafeServiceUrl: (serviceUrl: string) => boolean,
): Result<ProactiveSendTarget, Error> {
  if (!isSafeServiceUrl(stored.serviceUrl)) {
    return err(new Error("stored service url failed the path-safety check"));
  }
  return ok({
    serviceUrl: stored.serviceUrl,
    tenantId: stored.tenantId,
    threadId: stored.threadId,
  });
}
