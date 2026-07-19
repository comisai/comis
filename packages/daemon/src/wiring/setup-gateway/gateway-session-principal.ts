// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  resolveInternalTurnIdentity,
  type InternalTurnIdentity,
  type InternalTurnIdentityError,
} from "@comis/orchestrator";
import type { Result } from "@comis/shared";

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
