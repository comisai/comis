// SPDX-License-Identifier: Apache-2.0
import type { SessionTarget } from "../../api/session-scope.js";

export {
  loadChatAgents,
  loadChatBudget,
  loadChatHistory,
  loadChatSessionSelection,
  loadChatSessions,
  sendChatMessage,
} from "./session-data-controller.js";

export interface ChatSessionInfo {
  key: string;
  agentId: string;
  tenantId?: string;
  conversationRef?: string;
  sessionKey?: string;
  channelType: string;
  messageCount: number;
  lastActivity: number;
  label?: string;
}

export interface ChatAgentOption {
  id: string;
  name: string;
  model: string;
}

export interface ChatHistoryMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
}

export interface ChatBudget {
  segments: Array<{ label: string; tokens: number; color: string }>;
  total: number;
}

export function createLocalChatSession(agentId: string, now: number): ChatSessionInfo {
  const sessionKey = `web:agent:${agentId}:${agentId}:${crypto.randomUUID()}`;
  return {
    key: sessionKey,
    sessionKey,
    agentId,
    channelType: "web",
    messageCount: 0,
    lastActivity: now,
  };
}

export function filterChatSessions(
  sessions: readonly ChatSessionInfo[],
  query: string,
): ChatSessionInfo[] {
  if (!query) return [...sessions];
  const normalized = query.toLowerCase();
  return sessions.filter((session) =>
    session.key.toLowerCase().includes(normalized)
    || (session.label?.toLowerCase().includes(normalized) ?? false)
  );
}

export function resolveTransportSessionKey(
  sessions: readonly ChatSessionInfo[],
  activeSession: string,
): string {
  const session = sessions.find((candidate) => candidate.key === activeSession);
  return session?.sessionKey ?? "";
}

export function resolveActiveSessionTarget(
  sessions: readonly ChatSessionInfo[],
  activeSession: string,
): SessionTarget | undefined {
  const session = sessions.find((candidate) => candidate.key === activeSession);
  if (!session?.tenantId || !session.conversationRef) return undefined;
  return {
    tenantId: session.tenantId,
    agentId: session.agentId,
    conversationRef: session.conversationRef,
  };
}
