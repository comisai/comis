// SPDX-License-Identifier: Apache-2.0
/**
 * Projects a ConversationScope onto the ResolvedTurnScope an internally-initiated
 * turn runs under (announcements, cross-session relays) — turns with no inbound
 * channel message to derive an endpoint and principal from.
 *
 * @module
 */

import type { ConversationScope, ResolvedTurnScope } from "@comis/core";
import { createConversationRef } from "@comis/core";

/**
 * @param conversation - The conversation the internal turn targets.
 * @returns The turn scope: the partition's own endpoint/principal where it carries
 *   them, else a synthetic cross-session endpoint keyed by the conversation ref.
 */
export function createInternalTurnScope(conversation: ConversationScope): ResolvedTurnScope {
  const partition = conversation.partition;
  const reference = createConversationRef(conversation);
  const endpoint = partition.kind === "endpoint-conversation"
    || partition.kind === "endpoint-conversation-principal"
    ? partition.endpoint
    : {
        channelType: partition.kind === "channel-principal" ? partition.channelType : "cross-session",
        channelInstanceId: "runtime",
        conversationId: reference.ok
          ? reference.value
          : conversation.agentId,
        conversationKind: "direct" as const,
      };
  const principalId = partition.kind === "principal"
    || partition.kind === "channel-principal"
    || partition.kind === "endpoint-conversation-principal"
    ? partition.principalId
    : `cross-session:${conversation.agentId}`;
  return { conversation, endpoint, principal: { principalId } };
}
