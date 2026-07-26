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
 * The principal is the MAPPING (operator config), hashed for delimiter safety, so a
 * request body can never widen or forge the conversation's authority. The rendered
 * session key becomes the conversation id via `JSON.stringify` (delimiter-safe by
 * construction), preserving per-mapping/per-subject conversation isolation: two
 * subjects never share one partition, and repeat events for one subject continue
 * the same conversation.
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
    originKind: "control-plane",
    instanceId: "webhook",
    conversationId: JSON.stringify([input.renderedSessionKey]),
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
