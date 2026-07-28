// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module converts storage and validation failures at rpc-dispatch.
/** Explicit-authority session list and search handlers. */

import {
  SessionListContract,
  SessionSearchContract,
  parseFormattedSessionKey,
  partsToMessage,
  stripInternalFields,
  systemNowMs,
  type ChannelEndpoint,
  type ConversationRef,
  type SessionDetailedEntry,
  type SessionQueryScope,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type SessionHandlerDeps } from "./session-helpers.js";
import { AuthorizationError } from "../errors.js";

function requireQueryAuthority(
  params: { tenant_id: string; agent_id: string },
  rawParams: Record<string, unknown>,
): SessionQueryScope {
  const callerAgentId = rawParams._agentId as string | undefined;
  const callerTenantId = rawParams._tenantId as string | undefined;
  if (callerAgentId !== undefined && callerAgentId !== params.agent_id) {
    throw new AuthorizationError("Session query agent does not match the authenticated caller");
  }
  if (callerTenantId !== undefined && callerTenantId !== params.tenant_id) {
    throw new AuthorizationError("Session query tenant does not match the authenticated caller");
  }
  return { tenantId: params.tenant_id, agentId: params.agent_id };
}

type ListableSessionKind = "sub-agent" | "group" | "dm";

export interface ListableSession {
  conversationRef: ConversationRef;
  sessionKey: string;
  agentId: string;
  kind: ListableSessionKind;
  endpoint?: ChannelEndpoint;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

function sessionKind(session: SessionDetailedEntry): ListableSessionKind {
  if (session.metadata.parentConversationRef !== undefined || session.metadata.parentSessionKey !== undefined) {
    return "sub-agent";
  }
  const partition = session.conversationScope.partition;
  if (
    (partition.kind === "endpoint-conversation" || partition.kind === "endpoint-conversation-principal")
    && partition.endpoint.conversationKind === "shared"
  ) {
    return "group";
  }
  return "dm";
}

function detailedSession(session: SessionDetailedEntry): ListableSession {
  const partition = session.conversationScope.partition;
  return {
    conversationRef: session.conversationRef,
    sessionKey: parseFormattedSessionKey(
      typeof session.metadata.sessionKey === "string" ? session.metadata.sessionKey : "",
    ) === undefined
      ? session.conversationRef
      : session.metadata.sessionKey as string,
    agentId: session.agentId,
    kind: sessionKind(session),
    ...(
      partition.kind === "endpoint-conversation"
      || partition.kind === "endpoint-conversation-principal"
        ? { endpoint: partition.endpoint }
        : {}
    ),
    metadata: session.metadata,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
  };
}

const LCD_CONVERSATION_PAGE_SIZE = 200;
const LCD_CONVERSATION_LIMIT = 5_000;

function listSessions(deps: SessionHandlerDeps, scope: SessionQueryScope): ListableSession[] {
  const startedAt = systemNowMs();
  const listed = deps.sessionStore.listDetailed(scope);
  if (!listed.ok) throw listed.error;
  const sessions = new Map<ConversationRef, ListableSession>();
  for (const session of listed.value) {
    sessions.set(session.conversationRef, detailedSession(session));
  }

  let lcdConversationCount = 0;
  let lcdTotal = 0;
  if (deps.contextBrowse !== undefined) {
    let offset = 0;
    while (offset < LCD_CONVERSATION_LIMIT) {
      const page = deps.contextBrowse.listConversations(scope, {
        limit: LCD_CONVERSATION_PAGE_SIZE,
        offset,
      });
      lcdTotal = page.total;
      for (const conversation of page.conversations) {
        if (conversation.tenantId !== scope.tenantId || conversation.agentId !== scope.agentId) {
          continue;
        }
        const parsedKey = parseFormattedSessionKey(conversation.sessionKey);
        if (
          parsedKey === undefined
          || parsedKey.tenantId !== scope.tenantId
          || parsedKey.agentId !== scope.agentId
        ) {
          continue;
        }
        lcdConversationCount += 1;
        const existing = sessions.get(conversation.conversationRef);
        if (existing !== undefined) {
          existing.sessionKey = conversation.sessionKey;
          existing.createdAt = Math.min(existing.createdAt, conversation.createdAt);
          existing.updatedAt = Math.max(existing.updatedAt, conversation.updatedAt);
          existing.messageCount = Math.max(existing.messageCount, conversation.messageCount);
          continue;
        }
        sessions.set(conversation.conversationRef, {
          conversationRef: conversation.conversationRef,
          sessionKey: conversation.sessionKey,
          agentId: conversation.agentId,
          kind: parsedKey.guildId === undefined ? "dm" : "group",
          metadata: {},
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          messageCount: conversation.messageCount,
        });
      }
      offset += page.conversations.length;
      if (page.conversations.length === 0 || offset >= page.total) break;
    }
  }

  if (lcdTotal > LCD_CONVERSATION_LIMIT) {
    deps.logger.warn(
      {
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        errorKind: "resource" as const,
        hint: `Narrow session.list with since_minutes; LCD enumeration is capped at ${LCD_CONVERSATION_LIMIT} conversations`,
      },
      "Session enumeration reached the LCD conversation cap",
    );
  }
  const result = [...sessions.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt
      || left.conversationRef.localeCompare(right.conversationRef),
  );
  deps.logger.info(
    {
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      sessionStoreCount: listed.value.length,
      lcdConversationCount,
      sessionCount: result.length,
      durationMs: systemNowMs() - startedAt,
    },
    "Session enumeration complete",
  );
  return result;
}

function messageText(message: unknown): string {
  const candidate = message as Record<string, unknown>;
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return (candidate.content as Array<Record<string, unknown>>)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

export function enumerateListableSessions(
  deps: SessionHandlerDeps,
  scope: SessionQueryScope,
): ListableSession[] {
  return listSessions(deps, scope);
}

export function bindSessionListHandlers(deps: SessionHandlerDeps): Record<string, RpcHandler> {
  return {
    [SessionListContract.method]: async (rawParams) => {
      const params = SessionListContract.request.parse(stripInternalFields(rawParams));
      const scope = requireQueryAuthority(
        { tenant_id: params.tenant_id, agent_id: params.agent_id },
        rawParams,
      );
      const kind = params.kind ?? "all";
      let sessions = listSessions(deps, scope);
      if (params.since_minutes !== undefined) {
        const cutoff = systemNowMs() - params.since_minutes * 60_000;
        sessions = sessions.filter((session) => session.updatedAt >= cutoff);
      }
      if (kind !== "all") sessions = sessions.filter((session) => session.kind === kind);
      const result = {
        sessions: sessions.map((session) => ({
          conversationRef: session.conversationRef,
          agentId: session.agentId,
          kind: session.kind,
          ...(session.endpoint === undefined ? {} : { endpoint: session.endpoint }),
          messageCount: session.messageCount,
          totalTokens: session.messageCount * 500,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt,
        })),
        total: sessions.length,
      };
      if (IS_DEV) SessionListContract.response.parse(result);
      return result;
    },

    [SessionSearchContract.method]: async (rawParams) => {
      const params = SessionSearchContract.request.parse(stripInternalFields(rawParams));
      const authority = requireQueryAuthority(
        { tenant_id: params.tenant_id, agent_id: params.agent_id },
        rawParams,
      );
      const sessions = listSessions(deps, authority);
      if (!params.query) {
        const limit = Math.min(Math.max(params.limit ?? 10, 1), 30);
        const recent = sessions.slice(0, limit).map((session) => ({
          conversationRef: session.conversationRef,
          agentId: session.agentId,
          channelType: session.kind,
          messageCount: session.messageCount,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt,
        }));
        return { mode: "recent" as const, sessions: recent, total: recent.length };
      }

      const queryTokens = params.query.toLowerCase().split(/\s+/)
        .map((token) => token.replace(/^"+|"+$/g, ""))
        .filter((token) => token.length > 0);
      const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
      const results: Array<{
        conversationRef: string;
        agentId: string;
        channelType: string;
        snippet: string;
        rawSnippet?: string;
        summary?: string;
        score: number;
        timestamp: number;
      }> = [];

      for (const session of sessions) {
        if (results.length >= limit) break;
        const loaded = deps.sessionStore.loadByRef(authority, session.conversationRef);
        if (!loaded.ok) throw loaded.error;
        const messages = loaded.value?.messages
          ?? deps.lcdStore?.getMessages({
            conversationRef: session.conversationRef,
            tenantId: authority.tenantId,
            agentId: authority.agentId,
            sessionKey: session.sessionKey,
          }).map(partsToMessage)
          ?? [];
        for (const message of messages) {
          const candidate = message as Record<string, unknown>;
          const role = typeof candidate.role === "string" ? candidate.role : "";
          if (params.scope && params.scope !== "all") {
            const roleMatches = params.scope === "tool"
              ? role === "tool" || role === "toolResult"
              : role === params.scope;
            if (!roleMatches) continue;
          }
          const text = messageText(message);
          const lower = text.toLowerCase();
          const matches = queryTokens.map((token) => lower.indexOf(token));
          if (matches.some((index) => index < 0)) continue;
          const anchor = Math.min(...matches);
          const start = Math.max(0, anchor - 80);
          const end = Math.min(text.length, anchor + 120);
          results.push({
            conversationRef: session.conversationRef,
            agentId: session.agentId,
            channelType: session.kind,
            snippet: `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`,
            score: 1,
            timestamp: typeof candidate.timestamp === "number" ? candidate.timestamp : session.updatedAt,
          });
          break;
        }
      }

      if (params.summarize !== false && deps.summarizeSession) {
        const outcomes = await Promise.allSettled(results.slice(0, 5).map(async (result) => {
          const session = sessions.find((candidate) => candidate.conversationRef === result.conversationRef);
          if (!session) return null;
          const loaded = deps.sessionStore.loadByRef(authority, session.conversationRef);
          if (!loaded.ok) return null;
          const messages = loaded.value?.messages
            ?? deps.lcdStore?.getMessages({
              conversationRef: session.conversationRef,
              tenantId: authority.tenantId,
              agentId: authority.agentId,
              sessionKey: session.sessionKey,
            }).map(partsToMessage)
            ?? [];
          if (messages.length === 0) return null;
          return deps.summarizeSession!(messages, params.query!);
        }));
        outcomes.forEach((outcome, index) => {
          if (outcome.status === "fulfilled" && outcome.value) {
            results[index]!.rawSnippet = results[index]!.snippet;
            results[index]!.summary = outcome.value;
          }
        });
      }
      return { mode: "search" as const, results, total: results.length };
    },
  };
}
