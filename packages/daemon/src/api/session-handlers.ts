// SPDX-License-Identifier: Apache-2.0
/**
 * Session RPC handler module.
 * Handles all session and agent-related RPC methods:
 *   session.status, agents.list, session.list, session.history,
 *   session.send, session.spawn, session.run_status,
 *   session.delete, session.reset, session.export, session.compact
 * Extracted from daemon.ts rpcCallInner for independent testability.
 *
 * Phase 35 Wave C plan 35-19 (Wave C CLOSURE): handler refactored to use
 * computed-property keys (`[SessionXxxContract.method]:`) so the
 * bidirectional 1:1 architecture test (WEB-CONTRACTS-07) resolves every
 * method to the registry. Per-method pipeline: bespoke pre-Zod guards
 * FIRST (read from rawParams — preserves user-friendly error messages
 * matching the existing handler-test assertions) → stripInternalFields →
 * contract.request.parse → existing business logic UNCHANGED → dev-mode
 * contract.response.parse (D-10).
 *
 * @module
 */

import {
  parseFormattedSessionKey,
  safePath,
  type DeliveryOrigin,
  SessionStatusContract,
  AgentsListContract,
  SessionListContract,
  SessionSearchContract,
  SessionHistoryContract,
  SessionSendContract,
  SessionSpawnContract,
  SessionRunStatusContract,
  SessionDeleteContract,
  SessionResetContract,
  SessionExportContract,
  SessionCompactContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
  systemDateFrom,
  systemSetTimeout,
} from "@comis/core";
import { readdirSync, statSync, readFileSync } from "node:fs";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper (D-10)
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts (Plan 34-08a).
// Single source of truth: SessionsApiDeps. The session-handlers factory
// consumes SessionHandlerDeps as before; the alias keeps call sites and
// handler bodies unchanged (DAEMON-API-03 Option A retarget).
import type { SessionsApiDeps as SessionHandlerDeps } from "./types.js";
export type { SessionHandlerDeps };

// ---------------------------------------------------------------------------
// JSONL session scanning
// ---------------------------------------------------------------------------

/** Shape of a JSONL session entry merged into session.list results. */
interface JsonlSessionInfo {
  sessionKey: string;
  userId: string;
  channelId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * Scan JSONL session directories for each configured agent and return
 * session info records for sessions that exist only as JSONL files.
 * Performance-guarded: skips agents with >1000 session files.
 */
function scanJsonlSessions(
  agentDataDir: string,
  agents: Record<string, unknown>,
): JsonlSessionInfo[] {
  const results: JsonlSessionInfo[] = [];

  for (const agentId of Object.keys(agents)) {
    const sessionsDir = safePath(agentDataDir, agentId, "sessions");
    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
    } catch {
      continue; // Directory doesn't exist for this agent
    }

    // Performance guard: skip agents with too many session files
    if (files.length > 1000) {
      continue;
    }

    for (const file of files) {
      const filePath = safePath(sessionsDir, file);
      try {
        const stat = statSync(filePath);
        // Derive session key from filename (remove .jsonl extension)
        const sessionKey = file.slice(0, -6); // remove ".jsonl"

        // Count lines (messages) without parsing full content
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(l => l.trim().length > 0);
        const messageCount = lines.length;

        // Parse first line to extract metadata if available
        let userId = "unknown";
        const channelId = "unknown";
        if (lines.length > 0) {
          try {
            const firstMsg = JSON.parse(lines[0]) as Record<string, unknown>;
            if (firstMsg.role === "user") {
              userId = (firstMsg.userId as string) ?? "unknown";
            }
          } catch { /* skip parse errors */ }
        }

        results.push({
          sessionKey,
          userId,
          channelId,
          metadata: {},
          createdAt: Math.floor(stat.birthtimeMs),
          updatedAt: Math.floor(stat.mtimeMs),
          messageCount,
        });
      } catch {
        continue; // Skip unreadable files
      }
    }
  }

  return results;
}

/**
 * Scan workspace sessions directory for JSONL session files.
 * Structure: {workspaceDir}/sessions/{tenantId}/{channelDir}/{sessionFile}.jsonl
 * These sessions are created by the pi-agent session manager and may not be
 * indexed in SQLite yet. Returns session info records for merging into session.list.
 */
function scanWorkspaceSessions(workspaceDir: string): JsonlSessionInfo[] {
  const results: JsonlSessionInfo[] = [];
  const sessionsRoot = safePath(workspaceDir, "sessions");

  let tenantDirs: string[];
  try {
    tenantDirs = readdirSync(sessionsRoot);
  } catch {
    return results;
  }

  for (const tenantId of tenantDirs) {
    const tenantPath = safePath(sessionsRoot, tenantId);
    let channelDirs: string[];
    try {
      const st = statSync(tenantPath);
      if (!st.isDirectory()) continue;
      channelDirs = readdirSync(tenantPath);
    } catch {
      continue;
    }

    // Performance guard
    if (channelDirs.length > 1000) continue;

    for (const channelDir of channelDirs) {
      const channelPath = safePath(tenantPath, channelDir);
      let files: string[];
      try {
        const st = statSync(channelPath);
        if (!st.isDirectory()) continue;
        files = readdirSync(channelPath).filter(f => f.endsWith(".jsonl"));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = safePath(channelPath, file);
        try {
          const st = statSync(filePath);
          const sessionKey = `${tenantId}:${file.slice(0, -6)}`; // tenantId:filename-without-ext
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n").filter(l => l.trim().length > 0);

          // channelDir is the chat/channel ID (e.g., "678314278")
          results.push({
            sessionKey,
            userId: "unknown",
            channelId: channelDir,
            metadata: { _workspaceJsonlPath: filePath },
            createdAt: Math.floor(st.birthtimeMs),
            updatedAt: Math.floor(st.mtimeMs),
            messageCount: lines.length,
          });
        } catch {
          continue;
        }
      }
    }
  }

  return results;
}

/**
 * Load a JSONL session file and return it as SessionData-compatible shape.
 * Used as fallback when session.history can't find a session in SQLite.
 * pi-agent JSONL uses `{type: "message", message: {role, content}, timestamp}` wrappers.
 * We unwrap to `{role, content, timestamp}` which session.history expects.
 */
function loadJsonlSession(filePath: string): { messages: unknown[]; metadata: Record<string, unknown>; createdAt: number; updatedAt: number } | undefined {
  try {
    const st = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);
    const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Unwrap pi-agent message wrappers: {type:"message", message:{role,content}} → {role,content,timestamp}
    const messages: unknown[] = [];
    for (const entry of parsed) {
      const e = entry as Record<string, unknown>;
      if (e.type === "message" && e.message) {
        const msg = e.message as Record<string, unknown>;
        // Attach timestamp from the wrapper if present
        if (e.timestamp && !msg.timestamp) {
          msg.timestamp = typeof e.timestamp === "string" ? systemDateFrom(e.timestamp as string).getTime() : e.timestamp;
        }
        messages.push(msg);
      }
    }

    return {
      messages,
      metadata: {},
      createdAt: Math.floor(st.birthtimeMs),
      updatedAt: Math.floor(st.mtimeMs),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect available session keys from all sources (SQLite, JSONL, workspace)
 * for inclusion in "session not found" error messages.
 */
function collectAvailableSessionKeys(deps: SessionHandlerDeps): string[] {
  const keys: string[] = [];

  for (const s of deps.sessionStore.listDetailed()) {
    keys.push(s.sessionKey);
  }

  if (deps.defaultWorkspaceDir) {
    const existing = new Set(keys);
    for (const ws of scanWorkspaceSessions(deps.defaultWorkspaceDir)) {
      if (!existing.has(ws.sessionKey)) {
        keys.push(ws.sessionKey);
      }
    }
  }

  return keys;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of session/agent RPC handlers bound to the given deps.
 */
export function createSessionHandlers(deps: SessionHandlerDeps): Record<string, RpcHandler> {
  return {
    [SessionStatusContract.method]: async (rawParams) => {
      // Resolve which agent this session belongs to. _agentId is dispatcher-
      // injected (read BEFORE strip).
      const statusAgentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;

      const userParams = stripInternalFields(rawParams);
      SessionStatusContract.request.parse(userParams);

      const statusAgentConfig = deps.agents[statusAgentId] ?? deps.agents[deps.defaultAgentId];
      const agentCostTracker = deps.costTrackers.get(statusAgentId) ?? deps.costTrackers.get(deps.defaultAgentId)!;
      const agentStepCounter = deps.stepCounters.get(statusAgentId) ?? deps.stepCounters.get(deps.defaultAgentId)!;
      const allCosts = agentCostTracker.getAll();
      const totalTokens = allCosts.reduce((sum: number, r: { tokens: { total: number } }) => sum + r.tokens.total, 0);
      const totalCost = allCosts.reduce((sum: number, r: { cost: { total: number } }) => sum + r.cost.total, 0);
      const result = {
        model: statusAgentConfig?.model ?? "unknown",
        agentName: statusAgentConfig?.name ?? "unknown",
        tokensUsed: { totalTokens, totalCost },
        stepsExecuted: agentStepCounter.getCount(),
        maxSteps: statusAgentConfig?.maxSteps ?? 25,
      };
      if (IS_DEV) SessionStatusContract.response.parse(result);
      return result;
    },

    [AgentsListContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      AgentsListContract.request.parse(userParams);
      const result = { agents: Object.keys(deps.agents) };
      if (IS_DEV) AgentsListContract.response.parse(result);
      return result;
    },

    [SessionListContract.method]: async (rawParams) => {
      // Bespoke pre-Zod (defaults): no required-field guards (handler defaults
      // kind="all" + sinceMinutes=undefined). Internal-field reads BEFORE strip.
      const callerMetadata = rawParams._callerMetadata as Record<string, unknown> | undefined;
      const callerSessionKey = rawParams._callerSessionKey as string | undefined;
      const tenantId = rawParams._tenantId as string | undefined;

      const userParams = stripInternalFields(rawParams);
      const params = SessionListContract.request.parse(userParams);

      const kind = params.kind ?? "all";
      const sinceMinutes = params.since_minutes;

      let sessions = deps.sessionStore.listDetailed(tenantId);

      // Merge JSONL sessions that are not in SQLite
      if (deps.agentDataDir) {
        const jsonlSessions = scanJsonlSessions(deps.agentDataDir, deps.agents);
        const sqliteKeys = new Set(sessions.map(s => s.sessionKey));
        for (const js of jsonlSessions) {
          if (!sqliteKeys.has(js.sessionKey)) {
            sessions.push(js);
          }
        }
      }

      // Merge workspace JSONL sessions (pi-agent session manager writes here)
      if (deps.defaultWorkspaceDir) {
        const wsSessions = scanWorkspaceSessions(deps.defaultWorkspaceDir);
        const existingKeys = new Set(sessions.map(s => s.sessionKey));
        for (const ws of wsSessions) {
          if (!existingKeys.has(ws.sessionKey)) {
            sessions.push(ws);
          }
        }
      }

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

      let sessions = deps.sessionStore.listDetailed(tenantId);

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

      for (const session of sessions) {
        if (results.length >= limit) break;

        const data = deps.sessionStore.loadByFormattedKey(session.sessionKey);
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
          const matchIdx = textLower.indexOf(queryLower);
          if (matchIdx === -1) continue;

          // Build snippet: up to 200 chars surrounding the match
          const snippetStart = Math.max(0, matchIdx - 80);
          const snippetEnd = Math.min(text.length, matchIdx + query.length + 120);
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

    [SessionHistoryContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: missing session_key triggers the standard Zod error.
      // The session-not-found error message preserves the user-friendly hint
      // including the list of available keys — that path runs AFTER the
      // parse since session_key must be present to do the lookup.
      const userParams = stripInternalFields(rawParams);
      const params = SessionHistoryContract.request.parse(userParams);

      const sessionKey = params.session_key;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;

      let data = deps.sessionStore.loadByFormattedKey(sessionKey);

      // Fallback: check if this is a workspace JSONL session (metadata stores the path)
      if (!data && deps.defaultWorkspaceDir) {
        const wsSessions = scanWorkspaceSessions(deps.defaultWorkspaceDir);
        const match = wsSessions.find(ws => ws.sessionKey === sessionKey);
        if (match && match.metadata._workspaceJsonlPath) {
          data = loadJsonlSession(match.metadata._workspaceJsonlPath as string);
        }
      }

      if (!data) {
        const available = collectAvailableSessionKeys(deps);
        const hint = available.length > 0
          ? `. Available session keys: ${available.join(", ")}`
          : ". Use action 'list' to discover available session keys";
        throw new Error(`Session not found: ${sessionKey}${hint}`);
      }

      // Parse session key for metadata
      const parsed = parseFormattedSessionKey(sessionKey);
      const agentId = parsed?.agentId ?? "default";
      const isSubAgent = data.metadata.parentSessionKey !== undefined;
      const channelType = isSubAgent
        ? "sub-agent"
        : parsed?.guildId
          ? "group"
          : "dm";

      // Pre-scan: resolve gateway attachment tool calls so we can inject
      // <!-- attachment:... --> markers into displayable assistant messages.
      // Attachment tool calls appear as toolCall/tool_use blocks with name "message"
      // and arguments.action "attach"; their results contain the media ID.
      const attachMeta = new Map<string, { type: string; mimeType: string; fileName: string; caption: string }>();
      const attachMedia = new Map<string, string>(); // toolCallId → /media/... URL
      for (const msg of data.messages) {
        const m = msg as Record<string, unknown>;
        const role = m.role as string | undefined;
        if (role === "assistant" && Array.isArray(m.content)) {
          for (const block of m.content as Array<Record<string, unknown>>) {
            const bt = block.type as string;
            if ((bt === "toolCall" || bt === "tool_use") && block.name === "message") {
              const args = (block.arguments ?? block.input) as Record<string, unknown> | undefined;
              if (args?.action === "attach") {
                attachMeta.set(block.id as string, {
                  type: (args.attachment_type as string) ?? "file",
                  mimeType: (args.mime_type as string) ?? "application/octet-stream",
                  fileName: (args.file_name as string) ?? "attachment",
                  caption: (args.caption as string) ?? "",
                });
              }
            }
          }
        }
        if ((role === "toolResult" || role === "tool") && attachMeta.has(m.tool_use_id as string)) {
          let resultText = "";
          if (typeof m.content === "string") {
            resultText = m.content;
          } else if (Array.isArray(m.content)) {
            for (const part of m.content as Array<Record<string, unknown>>) {
              if (part.type === "text" && typeof part.text === "string") resultText += part.text;
            }
          }
          try {
            const parsedResult = JSON.parse(resultText) as Record<string, unknown>;
            if (typeof parsedResult.messageId === "string") {
              attachMedia.set(m.tool_use_id as string, `/media/${parsedResult.messageId}`);
            }
          } catch { /* skip unparseable tool results */ }
        }
      }

      // Extract displayable messages and compute stats from raw message data.
      // Token usage may live in the `usage` field on API response messages,
      // or is estimated from content length (chars / 4) when not available.
      // Tool calls appear as `tool_use` content blocks or as separate tool-role messages.
      const messages: Array<{ role: string; content: string; timestamp: number }> = [];
      let toolCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let hasApiUsage = false;
      for (const msg of data.messages) {
        const m = msg as Record<string, unknown>;
        const role = m.role as string | undefined;

        // Accumulate token usage from API response metadata (if present)
        const usage = m.usage as Record<string, number> | undefined;
        if (usage) {
          hasApiUsage = true;
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
        }

        // Count tool_use blocks in content arrays and tool-role messages
        if (role === "tool") { toolCalls++; }
        if (Array.isArray(m.content)) {
          for (const block of m.content as Array<Record<string, unknown>>) {
            if (block.type === "tool_use") toolCalls++;
          }
        }

        // Only render user/assistant as displayable conversation messages
        if (role !== "user" && role !== "assistant") continue;
        let text = "";
        if (typeof m.content === "string") {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          for (const part of m.content as Array<Record<string, unknown>>) {
            if (part.type === "text" && typeof part.text === "string") {
              text += part.text;
            }
          }
          // Inject resolved attachment markers for gateway media tool calls
          if (role === "assistant") {
            for (const block of m.content as Array<Record<string, unknown>>) {
              const bt = block.type as string;
              if ((bt === "toolCall" || bt === "tool_use") && block.name === "message") {
                const toolId = block.id as string;
                const url = attachMedia.get(toolId);
                if (url) {
                  const att = attachMeta.get(toolId)!;
                  const json = JSON.stringify({ url, type: att.type, mimeType: att.mimeType, fileName: att.fileName });
                  const marker = att.caption
                    ? `${att.caption}\n\n<!-- attachment:${json} -->`
                    : `<!-- attachment:${json} -->`;
                  text += (text ? "\n\n" : "") + marker;
                }
              }
            }
          }
        }
        if (text) {
          messages.push({
            role,
            content: text,
            timestamp: (m.timestamp as number) ?? data.updatedAt,
          });
        }
      }

      // If no API usage data was found, estimate tokens from message content
      if (!hasApiUsage) {
        for (const msg of data.messages) {
          const m = msg as Record<string, unknown>;
          const role = m.role as string | undefined;
          const contentLen = typeof m.content === "string"
            ? m.content.length
            : Array.isArray(m.content)
              ? JSON.stringify(m.content).length
              : 0;
          const estimated = Math.round(contentLen / 4);
          if (role === "user") inputTokens += estimated;
          else if (role === "assistant") outputTokens += estimated;
        }
      }

      // Build session metadata from computed stats + stored metadata
      const meta = data.metadata as Record<string, unknown>;
      const totalTokens = inputTokens + outputTokens;
      const session = {
        key: sessionKey,
        agentId,
        channelType,
        messageCount: data.messages.length,
        totalTokens,
        inputTokens,
        outputTokens,
        toolCalls,
        compactions: Number(meta.compactions ?? 0),
        resetCount: Number(meta.resetCount ?? 0),
        createdAt: data.createdAt,
        lastActiveAt: data.updatedAt,
        label: (meta.label as string) ?? undefined,
      };

      // Apply pagination
      const paginated = messages.slice(offset, offset + limit);
      const result = {
        session,
        messages: paginated,
        total: messages.length,
        offset,
        limit,
        hasMore: offset + limit < messages.length,
      };
      if (IS_DEV) SessionHistoryContract.response.parse(result);
      return result;
    },

    [SessionSendContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: agent-to-agent policy check FIRST (preserves the
      // user-friendly error message AND prevents Zod from filtering useful
      // diagnostics).
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy. Enable security.agentToAgent.enabled in config.");
      }

      // Internal-field reads BEFORE strip
      const callerSessionKey = rawParams._callerSessionKey as string | undefined;
      const callerChannelType = rawParams._callerChannelType as string | undefined;
      const callerChannelId = rawParams._callerChannelId as string | undefined;

      const userParams = stripInternalFields(rawParams);
      const params = SessionSendContract.request.parse(userParams);

      const mode = params.mode ?? "fire-and-forget";
      const result = await deps.crossSessionSender.send({
        targetSessionKey: params.session_key,
        text: params.text,
        mode: mode as "fire-and-forget" | "wait" | "ping-pong",
        timeoutMs: params.timeout_ms,
        maxTurns: params.max_turns,
        callerSessionKey,
        announceChannelType: callerChannelType,
        announceChannelId: callerChannelId,
        agentId: params.agent_id,
      });
      return result;
    },

    [SessionSpawnContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: agent-to-agent policy check FIRST.
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy.");
      }

      // Internal-field reads BEFORE strip (caller-routing + audit trail).
      const callerSessionKey = rawParams._callerSessionKey as string | undefined;
      const callerChannelType = rawParams._callerChannelType as string | undefined;
      const callerChannelId = rawParams._callerChannelId as string | undefined;
      const callerAgentIdInternal = rawParams._agentId as string | undefined;

      const userParams = stripInternalFields(rawParams);
      const params = SessionSpawnContract.request.parse(userParams);

      const task = params.task;
      const spawnAgentId = params.agent ?? deps.defaultAgentId;
      const isAsync = params.async === true;
      const maxSteps = params.max_steps;

      deps.logger?.info({
        method: "session.spawn",
        agentId: spawnAgentId,
        async: isAsync,
        taskLength: task.length,
      }, "session.spawn request received");

      const expectedOutputs = params.expected_outputs;

      // DeliveryOrigin provides defaults for announce routing
      // LLM-supplied explicit params take precedence over DeliveryOrigin defaults
      const explicitAnnounceType = params.announce_channel_type;
      const explicitAnnounceId = params.announce_channel_id;

      // Build requesterOrigin from caller context (already validated DeliveryOrigin, serialized through RPC)
      const requesterOrigin: DeliveryOrigin | undefined = callerChannelType && callerChannelId
        ? { channelType: callerChannelType, channelId: callerChannelId, userId: "system", tenantId: "default" } as DeliveryOrigin
        : undefined;

      // Read caller's spawn depth from session metadata for depth propagation
      const callerSession = callerSessionKey
        ? deps.sessionStore.loadByFormattedKey(callerSessionKey)
        : undefined;
      const callerDepth = typeof callerSession?.metadata?.spawnDepth === "number"
        ? callerSession.metadata.spawnDepth as number
        : 0;
      const maxSpawnDepth = typeof callerSession?.metadata?.maxSpawnDepth === "number"
        ? callerSession.metadata.maxSpawnDepth as number
        : undefined;

      // Read spawn packet fields from RPC params
      const artifactRefs = params.artifact_refs;
      const objective = params.objective;
      const domainKnowledge = params.domain_knowledge;
      const toolGroups = params.tool_groups;
      const includeParentHistory = (params.include_parent_history === "summary" ? "summary" : "none") as "none" | "summary";

      if (isAsync) {
        // Non-blocking spawn
        const runId = deps.subAgentRunner.spawn({
          task,
          agentId: spawnAgentId,
          callerSessionKey,
          callerAgentId: callerAgentIdInternal,
          announceChannelType: explicitAnnounceType ?? callerChannelType,
          announceChannelId: explicitAnnounceId ?? callerChannelId,
          model: params.model,
          requesterOrigin,
          max_steps: maxSteps,
          expected_outputs: expectedOutputs,
          depth: callerDepth,
          maxDepth: maxSpawnDepth,
          artifactRefs,
          objective,
          domainKnowledge,
          toolGroups,
          includeParentHistory,
        });
        // Check if spawn was queued rather than immediately started
        const spawnStatus = deps.subAgentRunner.getRunStatus(runId);
        if (spawnStatus?.status === "queued") {
          return { runId, async: true, queued: true };
        }
        return { runId, async: true };
      }

      // Synchronous (backward compatible) -- delegate to sub-agent runner but await result
      const runId = deps.subAgentRunner.spawn({
        task,
        agentId: spawnAgentId,
        callerSessionKey,
        callerAgentId: callerAgentIdInternal,
        announceChannelType: explicitAnnounceType ?? callerChannelType,
        announceChannelId: explicitAnnounceId ?? callerChannelId,
        model: params.model,
        requesterOrigin,
        max_steps: maxSteps,
        expected_outputs: expectedOutputs,
        depth: callerDepth,
        maxDepth: maxSpawnDepth,
        artifactRefs,
        objective,
        domainKnowledge,
        toolGroups,
        includeParentHistory,
      });

      // For sync mode, poll until complete (up to waitTimeoutMs)
      const timeout = deps.securityConfig.agentToAgent!.waitTimeoutMs;
      const deadline = systemNowMs() + timeout;
      let run = deps.subAgentRunner.getRunStatus(runId);
      while ((run?.status === "running" || run?.status === "queued") && systemNowMs() < deadline) {
        await new Promise(r => systemSetTimeout(() => r(undefined), 100));
        run = deps.subAgentRunner.getRunStatus(runId);
      }

      if (!run || run.status === "running" || run.status === "queued") {
        return { runId, async: true, note: "Spawn timed out, check run_status later" };
      }

      if (run.status === "failed") {
        throw new Error(`Sub-agent failed: ${run.error}`);
      }

      return {
        sessionKey: run.sessionKey,
        response: run.result?.response,
        tokensUsed: run.result?.tokensUsed,
        finishReason: run.result?.finishReason,
        announced: true, // announce handled by runner
        taskDescription: task,
      };
    },

    [SessionRunStatusContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = SessionRunStatusContract.request.parse(userParams);

      const runId = params.run_id;
      const run = deps.subAgentRunner.getRunStatus(runId);
      if (!run) throw new Error(`Unknown run ID: ${runId}`);
      const result = {
        runId: run.runId,
        status: run.status,
        agentId: run.agentId,
        task: run.task,
        sessionKey: run.sessionKey,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        runtimeMs: run.completedAt ? run.completedAt - run.startedAt : systemNowMs() - run.startedAt,
        response: run.result?.response,
        tokensUsed: run.result?.tokensUsed,
        cost: run.result?.cost,
        error: run.error,
      };
      if (IS_DEV) SessionRunStatusContract.response.parse(result);
      return result;
    },

    [SessionDeleteContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: admin trust check + missing-key + not-found guards
      // FIRST (preserves user-friendly error messages matching the existing
      // handler-test assertions — see session-handlers.test.ts:73-92).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      const userParams = stripInternalFields(rawParams);
      SessionDeleteContract.request.parse(userParams);

      const data = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (!data) throw new Error(`Session not found: ${sessionKey}`);

      // Archive transcript before deletion
      const transcript = {
        messages: data.messages,
        metadata: data.metadata,
        messageCount: data.messages.length,
      };

      deps.sessionStore.deleteByFormattedKey(sessionKey);

      // Clear approval cache entries for the deleted session to prevent
      // stale cached approvals from auto-approving in a new session with the same key.
      deps.approvalGate?.clearApprovalCache(sessionKey);

      return { sessionKey, deleted: true, transcript };
    },

    [SessionResetContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: missing-key + not-found guards FIRST.
      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      const userParams = stripInternalFields(rawParams);
      SessionResetContract.request.parse(userParams);

      const data = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (!data) throw new Error(`Session not found: ${sessionKey}`);

      const previousMessageCount = data.messages.length;

      // Clear messages but preserve metadata (identity)
      deps.sessionStore.saveByFormattedKey(sessionKey, [], data.metadata);

      // Clear approval cache entries for the reset session.
      deps.approvalGate?.clearApprovalCache(sessionKey);

      const result = { sessionKey, reset: true as const, previousMessageCount };
      if (IS_DEV) SessionResetContract.response.parse(result);
      return result;
    },

    [SessionExportContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: admin trust check + missing-key + not-found guards FIRST.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      const userParams = stripInternalFields(rawParams);
      SessionExportContract.request.parse(userParams);

      const data = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (!data) throw new Error(`Session not found: ${sessionKey}`);

      return {
        sessionKey,
        messages: data.messages,
        metadata: data.metadata,
        messageCount: data.messages.length,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    },

    [SessionCompactContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: missing-key + not-found guards FIRST.
      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      const userParams = stripInternalFields(rawParams);
      const params = SessionCompactContract.request.parse(userParams);

      const instructions = params.instructions;

      const data = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (!data) throw new Error(`Session not found: ${sessionKey}`);

      const messageCount = data.messages.length;
      const estimatedTokens = Math.round(
        data.messages.reduce<number>(
          (sum, m) => sum + JSON.stringify(m).length / 4,
          0,
        ),
      );

      const result = {
        sessionKey,
        messageCount,
        estimatedTokens,
        compactionTriggered: true as const,
        instructions: instructions ?? null,
      };
      if (IS_DEV) SessionCompactContract.response.parse(result);
      return result;
    },
  };
}
