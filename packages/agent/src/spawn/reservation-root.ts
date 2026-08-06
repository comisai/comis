/**
 * Resolves the outward-ledger tree root to stamp onto a parked decision
 * reservation.
 *
 * A reservation without a root is undrainable: `adjudicateReservations` recovers
 * the step a send WOULD have used via `allocateStep(rootRunId, operationId)`, so
 * with no root there is no way to ask the ledger whether the announcement ever
 * went out, and the entry stays parked forever.
 *
 * Every failure to resolve degrades to `undefined` rather than throwing — a
 * missing root costs drainability, never the parking itself.
 *
 * @module
 */

import type { ConversationScope, RootRunIdResolver } from "@comis/core";
import { conversationScopeToSessionKey } from "@comis/core";

/**
 * @param resolve - Ledger root resolver; absent when the caller wired none.
 * @param agentId - The agent whose ledger tree is being addressed.
 * @param scope - The caller conversation to project onto a session key.
 * @returns The tree root, or `undefined` when it cannot be resolved.
 */
export function resolveReservationRoot(
  resolve: RootRunIdResolver | undefined,
  agentId: string,
  scope: ConversationScope | undefined,
): string | undefined {
  if (!resolve || scope === undefined) return undefined;
  const projected = conversationScopeToSessionKey(scope);
  if (!projected.ok) return undefined;
  const resolved = resolve(agentId, projected.value);
  return resolved.ok && resolved.value.length > 0 ? resolved.value : undefined;
}
