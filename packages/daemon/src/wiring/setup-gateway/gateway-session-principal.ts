// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { SessionKey } from "@comis/core";
import type { Result } from "@comis/shared";

interface StoredGatewaySession {
  metadata: Record<string, unknown>;
}

/** Bind a gateway conversation to the authenticated client, not caller-selected identity. */
export function resolveGatewaySessionKey(input: {
  tenantId: string;
  clientId?: string;
  sessionKey?: { userId?: string; channelId: string; peerId?: string };
}): SessionKey {
  const clientUserId = input.clientId === undefined
    ? input.sessionKey?.userId ?? "rpc-client"
    : `gateway-${createHash("sha256").update(input.clientId).digest("hex")}`;
  return {
    tenantId: input.tenantId,
    userId: clientUserId,
    channelId: input.sessionKey?.channelId ?? "gateway",
    ...(input.sessionKey?.peerId === undefined ? {} : { peerId: input.sessionKey.peerId }),
  };
}

/** Return the exact ownership rejection for a loaded gateway session, if any. */
export function gatewaySessionOwnershipError(
  loaded: Result<StoredGatewaySession | undefined, Error>,
  expectedAgentId: string,
  expectedClientId: string | undefined,
): Error | undefined {
  if (!loaded.ok) return new Error("Gateway session ownership could not be verified");
  if (loaded.value === undefined) return undefined;
  if (loaded.value.metadata.agentId !== expectedAgentId) {
    return new Error("Gateway session is owned by a different agent");
  }
  if (loaded.value.metadata.gatewayClientId !== expectedClientId) {
    return new Error("Gateway session is owned by a different gateway client");
  }
  return undefined;
}
