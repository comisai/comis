// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Session list/search RPC handlers.
 *
 * Handlers covering session-discovery queries (no per-session loading required):
 *   - session.list: enumerate sessions (SQLite + JSONL + workspace)
 *   - session.search: full-text search across session message bodies
 *
 * @module
 */

import {
  parseFormattedSessionKey,
  SessionListContract,
  SessionSearchContract,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import {
  IS_DEV,
  type SessionHandlerDeps,
  scanJsonlSessions,
  scanWorkspaceSessions,
  loadJsonlSession,
} from "./session-helpers.js";

/**
 * Enumerate sessions for BOTH list and search: SQLite (`listDetailed`) MERGED with
 * the two JSONL sources — the agent-data-dir scan and the workspace scan (where the
 * pi-agent session manager writes, e.g. the OpenAI-compat chat session). Returns a
 * fresh, de-duplicated array (SQLite key wins; each JSONL key added once).
 *
 * Shared so search mode can NEVER again drift from list mode: search previously did
 * `listDetailed()` ALONE and was blind to JSONL-only sessions, so `session.search`
 * returned 0 hits for content `session.history`/`session.list` could see (observed
 * live: the chat-API session is JSONL-only — the SQLite `sessions` table was
 * empty — so every search returned empty).
 */
export function enumerateListableSessions(
  deps: SessionHandlerDeps,
  tenantId: string | undefined,
): ReturnType<SessionHandlerDeps["sessionStore"]["listDetailed"]> {
  const sessions = [...deps.sessionStore.listDetailed(tenantId)];
  if (deps.agentDataDir) {
    const jsonlSessions = scanJsonlSessions(deps.agentDataDir, deps.agents);
    const sqliteKeys = new Set(sessions.map((s) => s.sessionKey));
    for (const js of jsonlSessions) {
      if (!sqliteKeys.has(js.sessionKey)) sessions.push(js);
    }
  }
  if (deps.defaultWorkspaceDir) {
    const wsSessions = scanWorkspaceSessions(deps.defaultWorkspaceDir);
    const existingKeys = new Set(sessions.map((s) => s.sessionKey));
    for (const ws of wsSessions) {
      if (!existingKeys.has(ws.sessionKey)) sessions.push(ws);
    }
  }
  return sessions;
}

/**
 * Bind the session list + search handlers. Object-spread compatible with
 * `Record<string, RpcHandler>`.
 */
export function bindSessionListHandlers(deps: SessionHandlerDeps): Record<string, RpcHandler> {
  return {
    [SessionListContract.method]: async (rawParams) => {
      // Bespoke pre-Zod (defaults): no required-field guards (handler defaults
      // kind="all" + sinceMinutes=undefined). Internal-field reads BEFORE strip.
      const callerMetadata = rawParams._callerMetadata as Record<string, unknown> | undefined;
      const callerSessionKey = rawParams._callerSessionKey as string | undefined;
      // The tool.invoke rpc route injects `_agentId = lease.agentId`; its
      // PRESENCE is the unforgeable agent-origin signal (inbound _agentId is
      // stripped from external callers at the gateway). Admin/operator/CLI calls
      // arrive with NO _agentId and keep full enumeration.
      const callerAgentId = rawParams._agentId as string | undefined;
      const tenantId = rawParams._tenantId as string | undefined;

      const userParams = stripInternalFields(rawParams);
      const params = SessionListContract.request.parse(userParams);

      const kind = params.kind ?? "all";
      const sinceMinutes = params.since_minutes;

      let sessions = enumerateListableSessions(deps, tenantId);

      // Recency filter: only sessions active within N minutes
      if (sinceMinutes !== undefined) {
        const cutoff = systemNowMs() - sinceMinutes * 60_000;
        sessions = sessions.filter((s) => s.updatedAt >= cutoff);
      }

      // Kind filter: derive kind from session data
      if (kind !== "all") {
        sessions = sessions.filter((s) => {
          const isSubAgent = s.metadata.parentSessionKey !== undefined;
          const parsed = parseFormattedSessionKey(s.sessionKey);
          const hasGuild = parsed?.guildId !== undefined;
          switch (kind) {
            case "sub-agent":
              return isSubAgent;
            case "group":
              return hasGuild && !isSubAgent;
            case "dm":
              return !hasGuild && !isSubAgent;
            default:
              return true;
          }
        });
      }

      // AgentId self-scope: an agent-origin caller may enumerate ONLY
      // its own sessions. Mirror session.search's `_agentId` filter exactly
      // (the predicate `parseFormattedSessionKey(s.sessionKey)?.agentId ===
      // callerAgentId`) so a jailed orch:read script cannot harvest the
      // directory of every agent's/user's sessions (the keys that would turn
      // a single-session read into a turnkey cross-tenant exfiltration,
      // plus a userId/channelId enumeration leak in its own right). Fail CLOSED
      // (filter to the caller's own) — composes with the sub-agent narrowing
      // below. When `callerAgentId` is undefined (admin / operator / CLI) the
      // full directory is preserved, as before.
      if (callerAgentId) {
        sessions = sessions.filter(
          (s) => parseFormattedSessionKey(s.sessionKey)?.agentId === callerAgentId,
        );
      }

      // Sandboxed visibility: sub-agents only see sessions they spawned
      if (callerMetadata?.parentSessionKey) {
        // Caller is a sub-agent -- only show sessions whose parentSessionKey matches caller
        sessions = sessions.filter(
          (s) => s.metadata.parentSessionKey === callerSessionKey,
        );
      }

      const result = {
        sessions: sessions.map((s) => {
          const parsed = parseFormattedSessionKey(s.sessionKey);

          // Estimate tokens from message count for list view (avoids loading full session data).
          // Rough heuristic: ~500 tokens per message on average (user + assistant turns).
          // Exact counts are available in session.history when a specific session is opened.
          const totalTokens = s.messageCount * 500;

          return {
            sessionKey: s.sessionKey,
            agentId: parsed?.agentId ?? "default",
            userId: s.userId,
            channelId: s.channelId,
            kind: s.metadata.parentSessionKey
              ? "sub-agent"
              : parsed?.guildId
                ? "group"
                : "dm",
            messageCount: s.messageCount,
            totalTokens,
            updatedAt: s.updatedAt,
            createdAt: s.createdAt,
          };
        }),
        total: sessions.length,
      };
      if (IS_DEV) SessionListContract.response.parse(result);
      return result;
    },

    [SessionSearchContract.method]: async (rawParams) => {
      // Internal-field reads BEFORE strip (caller-scoping)
      const callerAgentId = rawParams._agentId as string | undefined;
      const tenantId = rawParams._tenantId as string | undefined;

      const userParams = stripInternalFields(rawParams);
      const params = SessionSearchContract.request.parse(userParams);

      const query = params.query;
      const scope = params.scope ?? "all";
      const shouldSummarize = params.summarize !== false;

      let sessions = enumerateListableSessions(deps, tenantId);

      // AgentId scoping: when _agentId is provided, filter to caller's sessions
      if (callerAgentId) {
        sessions = sessions.filter((s) => {
          const parsed = parseFormattedSessionKey(s.sessionKey);
          return parsed?.agentId === callerAgentId;
        });
      }

      // Recent-sessions mode: no query provided
      if (!query) {
        const recentLimit = Math.min(Math.max(params.limit ?? 10, 1), 30);
        const recentSessions = sessions.slice(0, recentLimit).map((s) => {
          const parsed = parseFormattedSessionKey(s.sessionKey);
          return {
            sessionKey: s.sessionKey,
            agentId: parsed?.agentId ?? "default",
            channelType: s.metadata.parentSessionKey !== undefined
              ? "sub-agent"
              : parsed?.guildId
                ? "group"
                : "dm",
            messageCount: s.messageCount,
            updatedAt: s.updatedAt,
            createdAt: s.createdAt,
          };
        });
        return { mode: "recent" as const, sessions: recentSessions, total: recentSessions.length };
      }

      // Search mode: query provided
      const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);

      interface SearchResult {
        sessionKey: string;
        agentId: string;
        channelType: string;
        snippet: string;
        rawSnippet?: string;
        summary?: string;
        score: number;
        timestamp: number;
      }

      const results: SearchResult[] = [];
      const queryLower = query.toLowerCase();
      // Token-AND matching: a message matches when EVERY whitespace-delimited
      // query term appears in it (order-independent), not when the whole query
      // is a contiguous substring. The tool advertises "keywords"; a literal
      // indexOf on the joined query silently returned 0 for multi-keyword
      // queries whose terms were separated in the text (e.g. "axolotl Quark"
      // vs "...axolotl named Quark") — a silent-empty footgun observed
      // live. A single-token query degenerates to the prior substring
      // behavior, so existing phrase/keyword callers are unaffected.
      // Strip surrounding double-quotes per token: the tool-side FTS5
      // sanitizer wraps dotted/hyphenated terms (e.g. "chat-send", "v1.0")
      // in quotes for an FTS5 path this substring handler never takes, so the
      // quotes would otherwise defeat indexOf.
      const queryTokens = queryLower
        .split(/\s+/)
        .map((t) => t.replace(/^"+|"+$/g, ""))
        .filter((t) => t.length > 0);

      for (const session of sessions) {
        if (results.length >= limit) break;

        let data = deps.sessionStore.loadByFormattedKey(session.sessionKey);
        // Workspace-JSONL fallback — MUST mirror session.history (session-read.ts):
        // the OpenAI-compat chat session + any pi-agent-session-manager session is
        // JSONL-only (the primary store's loadByFormattedKey returns null for it), so
        // without this fallback session.search SKIPPED every such session → 0 hits for
        // content session.history could read (observed live). The enumerated entry
        // carries the JSONL path from scanWorkspaceSessions.
        if (!data && session.metadata?._workspaceJsonlPath) {
          data = loadJsonlSession(session.metadata._workspaceJsonlPath as string);
        }
        if (!data) continue;

        let bestMatch: { snippet: string; score: number; timestamp: number } | undefined;

        for (const msg of data.messages) {
          const m = msg as Record<string, unknown>;
          const role = m.role as string | undefined;

          // Scope filter: skip messages that don't match the requested scope
          if (scope !== "all") {
            if (scope === "tool") {
              if (role !== "tool" && role !== "toolResult") continue;
            } else if (role !== scope) {
              continue;
            }
          }

          // Extract text content from message
          let text = "";
          if (typeof m.content === "string") {
            text = m.content;
          } else if (Array.isArray(m.content)) {
            for (const part of m.content as Array<Record<string, unknown>>) {
              if (part.type === "text" && typeof part.text === "string") {
                text += part.text;
              }
            }
          }

          if (!text) continue;

          const textLower = text.toLowerCase();
          // Require ALL query tokens present (AND). Anchor the snippet on the
          // earliest-matching token so the surrounding context is shown.
          let anchorIdx = -1;
          let allPresent = true;
          for (const token of queryTokens) {
            const idx = textLower.indexOf(token);
            if (idx === -1) {
              allPresent = false;
              break;
            }
            if (anchorIdx === -1 || idx < anchorIdx) anchorIdx = idx;
          }
          if (!allPresent || anchorIdx === -1) continue;
          const matchIdx = anchorIdx;

          // Build snippet: up to 200 chars surrounding the earliest match
          const snippetStart = Math.max(0, matchIdx - 80);
          const snippetEnd = Math.min(text.length, matchIdx + 120);
          const snippet = (snippetStart > 0 ? "..." : "") +
            text.slice(snippetStart, snippetEnd) +
            (snippetEnd < text.length ? "..." : "");

          const score = 1.0;
          const timestamp = (m.timestamp as number) ?? session.updatedAt;

          // Keep best (first) match per session
          if (!bestMatch) {
            bestMatch = { snippet, score, timestamp };
          }
        }

        if (bestMatch) {
          const parsed = parseFormattedSessionKey(session.sessionKey);
          const isSubAgent = session.metadata.parentSessionKey !== undefined;
          const channelType = isSubAgent
            ? "sub-agent"
            : parsed?.guildId
              ? "group"
              : "dm";

          results.push({
            sessionKey: session.sessionKey,
            agentId: parsed?.agentId ?? "default",
            channelType,
            snippet: bestMatch.snippet,
            score: bestMatch.score,
            timestamp: bestMatch.timestamp,
          });
        }
      }

      // LLM summarization: when enabled and summarizer is available
      if (shouldSummarize && deps.summarizeSession && results.length > 0) {
        const summarizeCap = Math.min(results.length, 5);
        const summaryPromises = results.slice(0, summarizeCap).map(async (result) => {
          const data = deps.sessionStore.loadByFormattedKey(result.sessionKey);
          if (!data) return null;
          return deps.summarizeSession!(data.messages, query);
        });

        const settled = await Promise.allSettled(summaryPromises);
        for (let i = 0; i < summarizeCap; i++) {
          const outcome = settled[i]!;
          if (outcome.status === "fulfilled" && outcome.value) {
            results[i]!.rawSnippet = results[i]!.snippet;
            results[i]!.summary = outcome.value;
          }
        }
      }

      return { mode: "search" as const, results, total: results.length };
    },
  };
}
