// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  resolveInternalTurnIdentity,
  type InternalTurnIdentity,
  type InternalTurnIdentityError,
} from "@comis/orchestrator";
import type { Result } from "@comis/shared";

/**
 * Bind a webhook turn to its operator-configured mapping, never to payload-controlled
 * identity. A webhook action dispatches straight to the executor (it bypasses the
 * orchestrator inbound pipeline that resolves identity for real channels), so it must
 * resolve its own canonical turn scope — the executor fail-closes without one.
 *
 * The principal is the MAPPING (operator config), hashed so one mapping is never a
 * prefix of another, so a request body can never widen or forge the conversation's
 * authority. The rendered session key becomes the endpoint's conversation id, which
 * preserves per-mapping/per-subject isolation — two subjects never share one
 * partition, repeat events for one subject continue the same conversation — and
 * carries no delimiter risk: the conversation reference digests every field
 * length-delimited, so payload data cannot forge a field boundary.
 *
 * The endpoint keeps the webhook's own channel type, so the delivery origin the
 * caller derives from it agrees with this scope. Consumers that pair the two —
 * background-task promotion, the capability lease principal, the durable principal —
 * reject a turn whose origin and scope name different channels.
 */
export function resolveWebhookTurnIdentity(input: {
  tenantId: string;
  agentId: string;
  mappingId?: string;
  renderedSessionKey: string;
}): Result<InternalTurnIdentity, InternalTurnIdentityError> {
  const principalId = `webhook-${createHash("sha256")
    .update(input.mappingId ?? "unmapped")
    .digest("hex")}`;
  return resolveInternalTurnIdentity({
    tenantId: input.tenantId,
    agentId: input.agentId,
    originKind: "webhook",
    instanceId: "webhook",
    conversationId: input.renderedSessionKey,
    principalId,
  });
}

/** Bind a gateway conversation to the authenticated client, not caller-selected identity. */
export function resolveGatewayTurnIdentity(input: {
  tenantId: string;
  agentId: string;
  clientId?: string;
  sessionKey?: { userId?: string; channelId: string; peerId?: string };
}): Result<InternalTurnIdentity, InternalTurnIdentityError> {
  const principalId = input.clientId === undefined
    ? "gateway-anonymous"
    : `gateway-${createHash("sha256").update(input.clientId).digest("hex")}`;
  return resolveInternalTurnIdentity({
    tenantId: input.tenantId,
    agentId: input.agentId,
    originKind: "control-plane",
    instanceId: "gateway",
    conversationId: JSON.stringify([
      input.sessionKey?.channelId ?? "gateway",
      input.sessionKey?.peerId ?? null,
    ]),
    principalId,
  });
}
