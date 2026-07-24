// SPDX-License-Identifier: Apache-2.0
import type { ApiClient } from "../../api/api-client.js";
import type { RpcClient } from "../../api/rpc-client.js";
import {
  resolveSessionAuthorities,
  type SessionTarget,
} from "../../api/session-scope.js";
import { stripSilentTokens, stripUserSystemContext } from "../../utils/message-content.js";
import type {
  ChatAgentOption,
  ChatBudget,
  ChatHistoryMessage,
  ChatSessionInfo,
} from "./session-data.js";

export async function loadChatSessions(
  rpcClient: RpcClient,
  selectedAgent: string,
): Promise<ChatSessionInfo[]> {
  const authorities = await resolveSessionAuthorities(rpcClient);
  const authority = authorities.find((candidate) => candidate.agentId === selectedAgent);
  if (!authority) return [];
  const result = await rpcClient.call("session.list", {
    tenant_id: authority.tenantId,
    agent_id: authority.agentId,
    kind: "dm",
  });
  return result.sessions.map((session) => ({
    key: session.conversationRef,
    agentId: session.agentId,
    tenantId: authority.tenantId,
    conversationRef: session.conversationRef,
    channelType: session.kind,
    messageCount: session.messageCount,
    lastActivity: session.updatedAt,
  }));
}

export async function loadChatHistory(
  rpcClient: RpcClient,
  target: SessionTarget,
): Promise<{ sessionKey: string; messages: ChatHistoryMessage[] }> {
  const result = await rpcClient.call("session.history", {
    tenant_id: target.tenantId,
    agent_id: target.agentId,
    conversation_ref: target.conversationRef,
  });
  const messages = result.messages
    .map((message): ChatHistoryMessage => ({
      id: crypto.randomUUID(),
      role: message.role === "user"
        || message.role === "assistant"
        || message.role === "system"
        || message.role === "tool"
        ? message.role
        : "system",
      content: message.role === "assistant"
        ? stripSilentTokens(message.content)
        : message.role === "user"
          ? stripUserSystemContext(message.content)
          : message.content,
      timestamp: message.timestamp,
    }))
    .filter((message) => message.content !== "" || message.role !== "assistant");
  return { sessionKey: result.session.key, messages };
}

export async function loadChatAgents(apiClient: ApiClient): Promise<ChatAgentOption[]> {
  const agents = await apiClient.getAgents();
  return agents.length > 0
    ? agents.map((agent) => ({
        id: agent.id,
        name: agent.name ?? agent.id,
        model: agent.model,
      }))
    : [{ id: "default", name: "Default", model: "unknown" }];
}

export async function loadChatBudget(
  rpcClient: RpcClient,
  agentId: string,
): Promise<ChatBudget> {
  const result = await rpcClient.call("obs.context.pipeline", { agentId, limit: 1 })
    .catch(() => ({ snapshots: [] }));
  const snapshot = result.snapshots?.[0];
  if (!snapshot) return { segments: [], total: 0 };
  const tokensLoaded = snapshot.tokensLoaded ?? 0;
  const tokensEvicted = snapshot.tokensEvicted ?? 0;
  const tokensMasked = snapshot.tokensMasked ?? 0;
  const budgetUtilization = snapshot.budgetUtilization ?? 0;
  const total = budgetUtilization > 0 ? Math.round(tokensLoaded / budgetUtilization) : 0;
  const available = Math.max(0, total - tokensLoaded);
  const segments: ChatBudget["segments"] = [];
  if (tokensLoaded > 0) {
    segments.push({ label: "Loaded", tokens: tokensLoaded, color: "var(--ic-accent)" });
  }
  if (tokensEvicted > 0) {
    segments.push({ label: "Evicted", tokens: tokensEvicted, color: "var(--ic-warning)" });
  }
  if (tokensMasked > 0) {
    segments.push({ label: "Masked", tokens: tokensMasked, color: "var(--ic-text-dim)" });
  }
  if (available > 0) {
    segments.push({ label: "Available", tokens: available, color: "var(--ic-surface-2)" });
  }
  return { segments, total };
}
