// SPDX-License-Identifier: Apache-2.0
// @allow-throw: operator-console authority resolution failures are handled by each Lit view boundary.
import type { RpcClient } from "./rpc-client.js";
import type { SessionListItem } from "./types/index.js";

export interface SessionAuthority {
  readonly tenantId: string;
  readonly agentId: string;
}

export interface SessionTarget extends SessionAuthority {
  readonly conversationRef: string;
}

export interface ScopedSessionListItem extends SessionListItem {
  readonly tenantId: string;
}

export async function resolveSessionAuthorities(
  rpcClient: RpcClient,
): Promise<SessionAuthority[]> {
  const [configResult, agentsResult] = await Promise.all([
    rpcClient.call("config.read", {}),
    rpcClient.call("agents.list", {}),
  ]);
  const config = configResult["config"];
  const tenantId = config !== null && typeof config === "object"
    ? (config as Record<string, unknown>)["tenantId"]
    : undefined;
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("Deployment tenant could not be resolved");
  }
  return agentsResult.agents.map((agentId) => ({ tenantId, agentId }));
}

export async function listSessionsAcrossAgents(
  rpcClient: RpcClient,
  filters: { readonly kind?: string; readonly sinceMinutes?: number } = {},
): Promise<ScopedSessionListItem[]> {
  const authorities = await resolveSessionAuthorities(rpcClient);
  const results = await Promise.all(authorities.map(async (authority) => {
    const result = await rpcClient.call("session.list", {
      tenant_id: authority.tenantId,
      agent_id: authority.agentId,
      ...(filters.kind !== undefined ? { kind: filters.kind } : {}),
      ...(filters.sinceMinutes !== undefined
        ? { since_minutes: filters.sinceMinutes }
        : {}),
    });
    return result.sessions.map((session) => ({
      ...session,
      tenantId: authority.tenantId,
    }));
  }));
  return results.flat();
}

export async function resolveSessionTarget(
  rpcClient: RpcClient,
  conversationRef: string,
): Promise<SessionTarget> {
  const sessions = await listSessionsAcrossAgents(rpcClient);
  const session = sessions.find((candidate) => candidate.conversationRef === conversationRef);
  if (!session) throw new Error(`Conversation not found: ${conversationRef}`);
  return {
    tenantId: session.tenantId,
    agentId: session.agentId,
    conversationRef: session.conversationRef,
  };
}
