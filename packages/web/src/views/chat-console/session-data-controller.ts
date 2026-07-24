// SPDX-License-Identifier: Apache-2.0
import type { ApiClient } from "../../api/api-client.js";
import type { RpcClient } from "../../api/rpc-client.js";
import {
  listSessionsAcrossAgents,
  resolveSessionAuthorities,
  type ScopedSessionListItem,
  type SessionTarget,
} from "../../api/session-scope.js";
import { stripSilentTokens, stripUserSystemContext } from "../../utils/message-content.js";
import type {
  ChatAgentOption,
  ChatBudget,
  ChatHistoryMessage,
  ChatSessionInfo,
} from "./session-data.js";
import type { PipelineSnapshot } from "../../api/types/index.js";

function toChatSession(session: ScopedSessionListItem): ChatSessionInfo {
  return {
    key: session.conversationRef,
    agentId: session.agentId,
    tenantId: session.tenantId,
    conversationRef: session.conversationRef,
    channelType: session.kind,
    messageCount: session.messageCount,
    lastActivity: session.updatedAt,
  };
}

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
  return result.sessions.map((session) => toChatSession({
    ...session,
    tenantId: authority.tenantId,
  }));
}

export async function loadChatSessionSelection(
  rpcClient: RpcClient,
  selectedAgent: string,
  conversationRef: string,
): Promise<{
  readonly selectedAgent: string;
  readonly sessions: ChatSessionInfo[];
  readonly routeResolved: boolean;
}> {
  if (!conversationRef) {
    return {
      selectedAgent,
      sessions: await loadChatSessions(rpcClient, selectedAgent),
      routeResolved: true,
    };
  }
  const sessions = await listSessionsAcrossAgents(rpcClient, { kind: "dm" });
  const routed = sessions.find((session) => session.conversationRef === conversationRef);
  if (!routed) return { selectedAgent, sessions: [], routeResolved: false };
  return {
    selectedAgent: routed.agentId,
    sessions: sessions
      .filter((session) => session.tenantId === routed.tenantId && session.agentId === routed.agentId)
      .map(toChatSession),
    routeResolved: true,
  };
}

export async function loadChatHistory(
  rpcClient: RpcClient,
  target: SessionTarget,
): Promise<{ messages: ChatHistoryMessage[] }> {
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
  return { messages };
}

export async function sendChatMessage(
  rpcClient: RpcClient,
  target: SessionTarget,
  text: string,
): Promise<string> {
  const result = await rpcClient.call("session.send", {
    tenant_id: target.tenantId,
    agent_id: target.agentId,
    conversation_ref: target.conversationRef,
    text,
    mode: "wait",
  });
  return typeof result["response"] === "string" ? result["response"] : "";
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
  const snapshots = await rpcClient.call<PipelineSnapshot[]>(
    "obs.context.pipeline",
    { agentId, limit: 1 },
  ).catch(() => []);
  const snapshot = snapshots[0];
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
