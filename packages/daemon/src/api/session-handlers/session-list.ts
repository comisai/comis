// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module converts storage and validation failures at rpc-dispatch.
/** Explicit-authority session list and search handlers. */

import {
  SessionListContract,
  SessionSearchContract,
  stripInternalFields,
  systemNowMs,
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

function sessionKind(session: SessionDetailedEntry): "sub-agent" | "group" | "dm" {
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

function listSessions(deps: SessionHandlerDeps, scope: SessionQueryScope): SessionDetailedEntry[] {
  const listed = deps.sessionStore.listDetailed(scope);
  if (!listed.ok) throw listed.error;
  return listed.value;
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
): SessionDetailedEntry[] {
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
      if (kind !== "all") sessions = sessions.filter((session) => sessionKind(session) === kind);
      const result = {
        sessions: sessions.map((session) => ({
          conversationRef: session.conversationRef,
          agentId: session.agentId,
          kind: sessionKind(session),
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
          channelType: sessionKind(session),
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
        if (!loaded.value) continue;
        for (const message of loaded.value.messages) {
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
            channelType: sessionKind(session),
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
          if (!loaded.ok || !loaded.value) return null;
          return deps.summarizeSession!(loaded.value.messages, params.query!);
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
