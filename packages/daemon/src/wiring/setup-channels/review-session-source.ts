// SPDX-License-Identifier: Apache-2.0
/**
 * LCD-merged session source for the memory-review cron.
 *
 * `runMemoryReview` reads
 * `sessionStore.listDetailed` — the daemon session store — but in DAG mode
 * (the DEFAULT context engine) the real conversations live in the pi runtime
 * JSONLs and the LCD store; the daemon store holds only a handful of
 * near-empty rows. Without this adapter the nightly extraction (memories, entities, causal edges)
 * is a silent no-op on a default deployment — `memory_entities` and
 * `memory_causal_edges` stay at ZERO rows on a live daemon with days of
 * conversations.
 *
 * This adapter presents the union of BOTH stores through the exact
 * `{ listDetailed, loadByFormattedKey }` view the review job consumes:
 *   - listDetailed: daemon-store entries merged with LCD conversations
 *     (per-agent + per-tenant scoped via ContextBrowsePort), deduped by
 *     sessionKey preferring the richer (higher messageCount) row so the
 *     minMessages gate sees the real conversation size.
 *   - loadByFormattedKey: the daemon store when it has messages, else the
 *     LCD messages mapped to the `{ role, content }` shape the extractor
 *     reads (text parts only, user/assistant roles only — tool spam would
 *     blow the review batch budget without adding extractable facts).
 *
 * Absent LCD deps degrade to the daemon store view unchanged (pipeline-mode
 * deployments are byte-identical).
 *
 * @module
 */

import type { ContextStorePort, ContextBrowsePort } from "@comis/core";
import { parseFormattedSessionKey } from "@comis/core";

/** The session-entry shape `runMemoryReview.filterSessions` consumes. */
export interface ReviewSessionEntry {
  sessionKey: string;
  tenantId: string;
  userId: string;
  channelId: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** The loaded-session shape `runMemoryReview.buildSessionSummary` consumes. */
export interface ReviewSessionData {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** The view `runMemoryReview` consumes (its `sessionStore` dep). */
export interface ReviewSessionSource {
  listDetailed(tenantId?: string): ReviewSessionEntry[];
  loadByFormattedKey(sessionKey: string): ReviewSessionData | undefined;
}

export interface ReviewSessionSourceDeps {
  /** The daemon session store view (pipeline-mode sessions). */
  sessionStore: {
    listDetailed(tenantId?: string): ReviewSessionEntry[];
    loadByFormattedKey(sessionKey: string): ReviewSessionData | undefined;
  };
  /** LCD message read (DAG-mode conversations). Absent ⇒ daemon view only. */
  lcdStore?: Pick<ContextStorePort, "getMessages">;
  /** LCD conversation enumeration (R4 agent+tenant scoped). Absent ⇒ daemon view only. */
  contextBrowse?: ContextBrowsePort;
  agentId: string;
  tenantId: string;
  /** Page cap for the LCD conversation listing (most-recent-first). */
  maxConversations?: number;
}

/** Max LCD conversations enumerated per review run (most-recent-first). */
const DEFAULT_MAX_CONVERSATIONS = 200;

/**
 * Build the merged review session source. See module doc.
 */
export function buildReviewSessionSource(deps: ReviewSessionSourceDeps): ReviewSessionSource {
  const { sessionStore, lcdStore, contextBrowse, agentId, tenantId } = deps;
  const maxConversations = deps.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;

  function lcdEntries(): ReviewSessionEntry[] {
    if (!contextBrowse) return [];
    const page = contextBrowse.listConversations(
      { tenantId, agentId },
      { limit: maxConversations, offset: 0 },
    );
    return page.conversations.map((c) => {
      const parsed = parseFormattedSessionKey(c.sessionKey);
      return {
        sessionKey: c.sessionKey,
        tenantId: c.tenantId,
        userId: parsed?.userId ?? "",
        channelId: parsed?.channelId ?? "",
        metadata: null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messageCount,
      };
    });
  }

  return {
    listDetailed(filterTenantId?: string): ReviewSessionEntry[] {
      const base = sessionStore.listDetailed(filterTenantId);
      if (!contextBrowse || !lcdStore) return base;

      // Merge: dedup by sessionKey, preferring the row that reflects the real
      // conversation size (the daemon store can hold a stale near-empty row
      // for a conversation whose true transcript lives in LCD).
      const byKey = new Map<string, ReviewSessionEntry>();
      for (const e of base) byKey.set(e.sessionKey, e);
      for (const e of lcdEntries()) {
        if (filterTenantId !== undefined && e.tenantId !== filterTenantId) continue;
        const existing = byKey.get(e.sessionKey);
        if (existing === undefined || e.messageCount > existing.messageCount) {
          byKey.set(e.sessionKey, e);
        }
      }
      return [...byKey.values()];
    },

    loadByFormattedKey(sessionKey: string): ReviewSessionData | undefined {
      const fromStore = sessionStore.loadByFormattedKey(sessionKey);
      if (fromStore !== undefined && fromStore.messages.length > 0) return fromStore;
      if (!lcdStore) return fromStore;

      const lcdMessages = lcdStore.getMessages({
        conversationId: sessionKey,
        tenantId,
        agentId,
        sessionKey,
      });
      if (lcdMessages.length === 0) return fromStore;

      // Map LCD rows to the `{ role, content }` shape extractMessageContent
      // reads. Text parts only (the verbatim block's `text` rides
      // part.metadata.raw); user/assistant roles only.
      const messages = lcdMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role,
          content: m.parts
            .filter((p) => p.kind === "text")
            .map((p) => {
              const raw = p.metadata?.raw as { text?: unknown } | undefined;
              return typeof raw?.text === "string" ? raw.text : "";
            })
            .filter((t) => t.length > 0)
            .join(" "),
        }))
        .filter((m) => m.content.length > 0);

      if (messages.length === 0) return fromStore;
      const createdAt = lcdMessages[0]!.createdAt;
      const updatedAt = lcdMessages[lcdMessages.length - 1]!.createdAt;
      return { messages, metadata: {}, createdAt, updatedAt };
    },
  };
}
