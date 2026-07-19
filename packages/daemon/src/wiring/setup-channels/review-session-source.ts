// SPDX-License-Identifier: Apache-2.0
/** LCD-enriched, authority-scoped session source for background review jobs. */

import {
  SessionStoreError,
  conversationScopeToSessionKey,
  formatSessionKey,
  type ContextBrowsePort,
  type ContextStorePort,
  type ConversationRef,
  type ConversationScope,
  type SessionQueryScope,
  type SessionStorePort,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

export interface ReviewSessionSource {
  listDetailed(scope: SessionQueryScope): Result<ReviewSessionEntry[], SessionStoreError>;
  loadByRef(
    scope: SessionQueryScope,
    conversationRef: ConversationRef,
  ): Result<ReviewSessionData | undefined, SessionStoreError>;
}

export interface ReviewSessionEntry {
  conversationRef: ConversationRef;
  sessionKey: string;
  principalId?: string;
  tenantId: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ReviewSessionData {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewSessionSourceDeps {
  sessionStore: Pick<SessionStorePort, "listDetailed" | "loadByRef">;
  lcdStore?: Pick<ContextStorePort, "getMessages">;
  contextBrowse?: ContextBrowsePort;
  maxConversations?: number;
}

const DEFAULT_MAX_CONVERSATIONS = 200;

function displayKey(scope: ConversationScope): Result<string, SessionStoreError> {
  const projected = conversationScopeToSessionKey(scope);
  return projected.ok
    ? ok(formatSessionKey(projected.value))
    : err(new SessionStoreError("Stored session scope cannot be projected for LCD lookup", "internal"));
}

function principalId(scope: ConversationScope): string | undefined {
  const partition = scope.partition;
  return partition.kind === "principal"
    || partition.kind === "channel-principal"
    || partition.kind === "endpoint-conversation-principal"
    ? partition.principalId
    : undefined;
}

export function buildReviewSessionSource(deps: ReviewSessionSourceDeps): ReviewSessionSource {
  const { sessionStore, lcdStore, contextBrowse } = deps;
  const maxConversations = deps.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;

  function lcdPage(scope: SessionQueryScope) {
    return contextBrowse?.listConversations(scope, { limit: maxConversations, offset: 0 });
  }

  return {
    listDetailed(scope) {
      const base = sessionStore.listDetailed(scope);
      if (!base.ok) return base;
      const page = lcdPage(scope);
      const lcdByRef = new Map(
        (page?.conversations ?? []).map((entry) => [entry.conversationRef, entry]),
      );
      const enriched: ReviewSessionEntry[] = [];
      for (const entry of base.value) {
        const key = displayKey(entry.conversationScope);
        if (!key.ok) return key;
        const lcd = lcdByRef.get(entry.conversationRef);
        enriched.push({
          conversationRef: entry.conversationRef,
          sessionKey: key.value,
          ...(principalId(entry.conversationScope) === undefined
            ? {}
            : { principalId: principalId(entry.conversationScope) }),
          tenantId: entry.tenantId,
          agentId: entry.agentId,
          metadata: entry.metadata,
          createdAt: lcd ? Math.min(entry.createdAt, lcd.createdAt) : entry.createdAt,
          updatedAt: lcd ? Math.max(entry.updatedAt, lcd.updatedAt) : entry.updatedAt,
          messageCount: lcd ? Math.max(entry.messageCount, lcd.messageCount) : entry.messageCount,
        });
        lcdByRef.delete(entry.conversationRef);
      }
      for (const lcd of lcdByRef.values()) {
        enriched.push({
          conversationRef: lcd.conversationRef,
          sessionKey: lcd.sessionKey,
          tenantId: lcd.tenantId,
          agentId: lcd.agentId,
          metadata: {},
          createdAt: lcd.createdAt,
          updatedAt: lcd.updatedAt,
          messageCount: lcd.messageCount,
        });
      }
      return ok(enriched.sort((left, right) => right.updatedAt - left.updatedAt));
    },

    loadByRef(scope, conversationRef) {
      const fromStore = sessionStore.loadByRef(scope, conversationRef);
      if (!fromStore.ok || fromStore.value?.messages.length || !lcdStore || !contextBrowse) {
        return fromStore;
      }
      const lcd = lcdPage(scope)?.conversations.find((entry) => entry.conversationRef === conversationRef);
      if (!lcd) return fromStore;
      const lcdMessages = lcdStore.getMessages({
        conversationRef,
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        sessionKey: lcd.sessionKey,
      });
      const messages = lcdMessages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          role: message.role,
          content: message.parts
            .filter((part) => part.kind === "text")
            .map((part) => {
              const raw = part.metadata?.raw as { text?: unknown } | undefined;
              return typeof raw?.text === "string" ? raw.text : "";
            })
            .filter((text) => text.length > 0)
            .join(" "),
          createdAt: message.createdAt,
        }))
        .filter((message) => message.content.length > 0);
      if (messages.length === 0) return fromStore;
      return ok({
        messages,
        metadata: fromStore.value?.metadata ?? {},
        createdAt: lcdMessages[0]?.createdAt ?? lcd.createdAt,
        updatedAt: lcdMessages[lcdMessages.length - 1]?.createdAt ?? lcd.updatedAt,
      });
    },
  };
}
