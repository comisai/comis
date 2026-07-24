// SPDX-License-Identifier: Apache-2.0
// @allow-throw: web API client dev-time validation guards; consumed by Lit element error-handler boundary (web user-facing flows exception).
/**
 * HTTP/SSE client for the Comis gateway REST API.
 *
 * Handles authentication via bearer token, data fetching for
 * agents/channels/activity/memory, and SSE subscriptions for
 * real-time event streaming.
 *
 * Extended with JSON-RPC memory and session management methods
 * for the memory inspector and session views.
 */

import type {
  AgentInfo,
  ChannelInfo,
  ActivityEntry,
  MemoryEntry,
  SessionInfo,
  SessionListItem,
  SessionMessage,
} from "./types/index.js";
import type { RpcClient } from "./rpc-client.js";
import type { SessionAuthority, SessionTarget } from "./session-scope.js";
/** Memory search result (api-client local -- not shared with other modules) */
export interface MemorySearchResult {
  readonly id: string;
  readonly content: string;
  readonly memoryType: string;
  readonly trustLevel: string;
  readonly score: number;
  readonly createdAt: number;
}

/** Chat response from POST /api/chat */
export interface ChatResponse {
  readonly response: string;
  readonly sessionId?: string;
  readonly sessionKey?: string;
}

/** Chat history message */
export interface ChatHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
}

/** SSE event handler */
export type SseEventHandler = (event: string, data: unknown) => void;

/** RPC call function signature for JSON-RPC 2.0 method invocation */
export type RpcCallFn = RpcClient["call"];

/**
 * The explicit tenant/agent a memory operation is scoped to. The daemon's
 * memory RPCs and REST endpoints require both — there is no silent default.
 */
export interface MemoryAuthority {
  readonly tenantId: string;
  readonly agentId: string;
}

/** Parameters for browsing memory entries */
export interface BrowseMemoryParams {
  readonly tenantId?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly type?: string;
  readonly trust?: string;
  readonly agentId?: string;
  readonly from?: number;
  readonly to?: number;
}

/** Parameters for listing sessions */
export interface ListSessionsParams extends SessionAuthority {
  readonly kind?: string;
  readonly sinceMinutes?: number;
}

/**
 * API client for the Comis gateway.
 */
export interface ApiClient {
  /** Fetch agent configurations */
  getAgents(): Promise<AgentInfo[]>;
  /** Fetch channel connection statuses */
  getChannels(): Promise<ChannelInfo[]>;
  /** Fetch recent activity entries */
  getActivity(limit?: number): Promise<ActivityEntry[]>;
  /** Search memory within an explicit tenant/agent scope */
  searchMemory(query: string, authority: MemoryAuthority, limit?: number): Promise<MemorySearchResult[]>;
  /** Get memory statistics for an explicit tenant/agent scope */
  getMemoryStats(authority: MemoryAuthority): Promise<Record<string, unknown>>;
  /** Send a chat message */
  chat(message: string, agentId?: string, sessionKey?: string): Promise<ChatResponse>;
  /** Load chat history */
  getChatHistory(): Promise<ChatHistoryMessage[]>;
  /** Check API health */
  health(): Promise<{ status: string; timestamp: string }>;

  // --- Memory management methods ---

  /** Browse memory entries (paginated, no query needed) within an explicit tenant/agent scope */
  browseMemory(params: BrowseMemoryParams): Promise<{ entries: MemoryEntry[]; total: number }>;
  /** Delete a memory entry by ID within an explicit tenant/agent scope */
  deleteMemory(id: string, authority: MemoryAuthority): Promise<void>;
  /** Delete multiple memory entries within an explicit tenant/agent scope */
  deleteMemoryBulk(ids: string[], authority: MemoryAuthority): Promise<{ deleted: number }>;
  /** Export memory entries as JSONL string */
  exportMemory(ids?: string[]): Promise<string>;

  // --- Session management methods ---

  /** List all sessions */
  listSessions(params: ListSessionsParams): Promise<SessionListItem[]>;
  /** Get session detail with history */
  getSessionDetail(target: SessionTarget): Promise<{ session: SessionInfo; messages: SessionMessage[] }>;
  /** Reset a session */
  resetSession(target: SessionTarget): Promise<void>;
  /** Compact a session */
  compactSession(target: SessionTarget): Promise<void>;
  /** Delete a session */
  deleteSession(target: SessionTarget): Promise<void>;
  /** Export session as JSONL */
  exportSession(target: SessionTarget): Promise<string>;
  /** Bulk reset sessions */
  resetSessionsBulk(targets: SessionTarget[]): Promise<{ reset: number }>;
  /** Bulk export sessions */
  exportSessionsBulk(targets: SessionTarget[]): Promise<string>;
  /** Bulk delete sessions */
  deleteSessionsBulk(targets: SessionTarget[]): Promise<{ deleted: number }>;
}

/**
 * Create an API client for the Comis gateway.
 *
 * @param baseUrl - Gateway URL (e.g., "http://localhost:3000")
 * @param token - Bearer token for authentication
 * @param rpcCall - Optional JSON-RPC 2.0 call function for WebSocket-based methods
 */
export function createApiClient(
  baseUrl: string,
  token: string,
  rpcCall?: RpcCallFn,
): ApiClient {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });

    if (!res.ok) {
      const body = await res.text();
      // Truncate and sanitize raw error bodies to prevent leaking server internals to UI
      const safeBody = body.length > 200 ? body.slice(0, 200) + "..." : body;
      const sanitized = safeBody
        .replace(/https?:\/\/[^\s"')]+/g, "[URL]")
        .replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]"); // eslint-disable-line no-restricted-syntax -- web-api-client error-body sanitization (not the Pino censor literal)
      throw new Error(`Request failed (${res.status}): ${sanitized}`);
    }

    return res.json() as Promise<T>;
  }

  async function fetchText(path: string, init?: RequestInit): Promise<string> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });

    if (!res.ok) {
      const body = await res.text();
      const safeBody = body.length > 200 ? body.slice(0, 200) + "..." : body;
      const sanitized = safeBody
        .replace(/https?:\/\/[^\s"')]+/g, "[URL]")
        .replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]"); // eslint-disable-line no-restricted-syntax -- web-api-client error-body sanitization (not the Pino censor literal)
      throw new Error(`Request failed (${res.status}): ${sanitized}`);
    }

    return res.text();
  }

  return {
    async getAgents(): Promise<AgentInfo[]> {
      const result = await fetchJson<Record<string, unknown>>("/api/agents");
      // Gateway returns routing config; normalize to AgentInfo array
      const agents =
        (result as Record<string, unknown>)["agents"] ??
        ((result as Record<string, unknown>)["routing"] as Record<string, unknown> | undefined)?.[
          "agents"
        ] ??
        [];
      if (Array.isArray(agents)) {
        return agents as AgentInfo[];
      }
      // Fallback: extract agent info from config object
      return Object.entries(result).map(([id, cfg]) => ({
        id,
        provider: (cfg as Record<string, string>).provider ?? "unknown",
        model: (cfg as Record<string, string>).model ?? "unknown",
        status: "active",
      }));
    },

    async getChannels(): Promise<ChannelInfo[]> {
      const result = await fetchJson<Record<string, unknown>>("/api/channels");
      const channels = (result as Record<string, unknown>)["channels"] ?? [];
      if (Array.isArray(channels)) {
        return channels as ChannelInfo[];
      }
      // Normalize from config object
      return Object.entries(result).map(([name, cfg]) => ({
        type: (cfg as Record<string, string>).type ?? name,
        name,
        enabled: (cfg as Record<string, boolean>).enabled ?? false,
        status: (cfg as Record<string, boolean>).enabled
          ? ("healthy" as const)
          : ("disconnected" as const),
      }));
    },

    async getActivity(limit = 50): Promise<ActivityEntry[]> {
      const result = await fetchJson<{ entries: ActivityEntry[] }>(`/api/activity?limit=${limit}`);
      return result.entries ?? [];
    },

    async searchMemory(
      query: string,
      authority: MemoryAuthority,
      limit = 10,
    ): Promise<MemorySearchResult[]> {
      const result = await fetchJson<{ results?: MemorySearchResult[] }>(
        `/api/memory/search?q=${encodeURIComponent(query)}&limit=${limit}`
          + `&tenant=${encodeURIComponent(authority.tenantId)}`
          + `&agent=${encodeURIComponent(authority.agentId)}`,
      );
      return result.results ?? [];
    },

    async getMemoryStats(authority: MemoryAuthority): Promise<Record<string, unknown>> {
      return fetchJson<Record<string, unknown>>(
        `/api/memory/stats?tenant=${encodeURIComponent(authority.tenantId)}`
          + `&agent=${encodeURIComponent(authority.agentId)}`,
      );
    },

    async chat(message: string, agentId?: string, sessionKey?: string): Promise<ChatResponse> {
      return fetchJson<ChatResponse>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message, agentId, sessionKey }),
      });
    },

    async getChatHistory(): Promise<ChatHistoryMessage[]> {
      const result = await fetchJson<{ messages: ChatHistoryMessage[] }>("/api/chat/history");
      return result.messages ?? [];
    },

    async health(): Promise<{ status: string; timestamp: string }> {
      // Health endpoint does not require auth
      const res = await fetch(`${baseUrl}/api/health`);
      return res.json() as Promise<{ status: string; timestamp: string }>;
    },

    // --- Memory management methods ---

    async browseMemory(
      params: BrowseMemoryParams,
    ): Promise<{ entries: MemoryEntry[]; total: number }> {
      if (rpcCall && params.from === undefined && params.to === undefined) {
        const result = await rpcCall("memory.browse", {
          ...(params.tenantId !== undefined ? { tenant_id: params.tenantId } : {}),
          ...(params.agentId !== undefined ? { agent_id: params.agentId } : {}),
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.type !== undefined ? { memory_type: params.type } : {}),
          ...(params.trust !== undefined ? { trust_level: params.trust } : {}),
        });
        return {
          entries: result.entries as unknown as MemoryEntry[],
          total: result.total,
        };
      }
      const qs = new URLSearchParams();
      if (params.tenantId) qs.set("tenant", params.tenantId);
      if (params.agentId) qs.set("agent", params.agentId);
      if (params.offset !== undefined) qs.set("offset", String(params.offset));
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      if (params.type) qs.set("type", params.type);
      if (params.trust) qs.set("trust", params.trust);
      if (params.from !== undefined) qs.set("from", String(params.from));
      if (params.to !== undefined) qs.set("to", String(params.to));
      const query = qs.toString();
      return fetchJson<{ entries: MemoryEntry[]; total: number }>(
        `/api/memory/browse${query ? `?${query}` : ""}`,
      );
    },

    async deleteMemory(id: string, authority: MemoryAuthority): Promise<void> {
      if (rpcCall) {
        await rpcCall("memory.delete", {
          ids: [id],
          tenant_id: authority.tenantId,
          agent_id: authority.agentId,
        });
        return;
      }
      const qs = new URLSearchParams({ tenant: authority.tenantId, agent: authority.agentId });
      await fetchJson(`/api/memory/${encodeURIComponent(id)}?${qs.toString()}`, { method: "DELETE" });
    },

    async deleteMemoryBulk(ids: string[], authority: MemoryAuthority): Promise<{ deleted: number }> {
      if (rpcCall) {
        return rpcCall("memory.delete", {
          ids,
          tenant_id: authority.tenantId,
          agent_id: authority.agentId,
        });
      }
      return fetchJson<{ deleted: number }>("/api/memory/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids, tenant: authority.tenantId, agent: authority.agentId }),
      });
    },

    async exportMemory(ids?: string[]): Promise<string> {
      if (rpcCall) {
        const result = await rpcCall("memory.export", {});
        const selected = ids === undefined
          ? result.entries
          : result.entries.filter((entry) => ids.includes(String(entry.id)));
        return selected.map((entry) => JSON.stringify(entry)).join("\n");
      }
      return fetchText("/api/memory/export", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
    },

    // --- Session management methods ---

    async listSessions(params: ListSessionsParams): Promise<SessionListItem[]> {
      if (rpcCall) {
        const result = await rpcCall("session.list", {
          tenant_id: params.tenantId,
          agent_id: params.agentId,
          ...(params.kind !== undefined ? { kind: params.kind } : {}),
          ...(params.sinceMinutes !== undefined
            ? { since_minutes: params.sinceMinutes }
            : {}),
        });
        return result.sessions;
      }
      const qs = new URLSearchParams();
      qs.set("tenantId", params.tenantId);
      qs.set("agentId", params.agentId);
      if (params.kind) qs.set("kind", params.kind);
      if (params.sinceMinutes !== undefined) qs.set("sinceMinutes", String(params.sinceMinutes));
      const query = qs.toString();
      return fetchJson<SessionListItem[]>(`/api/sessions?${query}`);
    },

    async getSessionDetail(
      target: SessionTarget,
    ): Promise<{ session: SessionInfo; messages: SessionMessage[] }> {
      if (rpcCall) {
        return rpcCall("session.history", {
          tenant_id: target.tenantId,
          agent_id: target.agentId,
          conversation_ref: target.conversationRef,
        }) as Promise<{
          session: SessionInfo;
          messages: SessionMessage[];
        }>;
      }
      const qs = new URLSearchParams({ tenantId: target.tenantId, agentId: target.agentId });
      return fetchJson<{ session: SessionInfo; messages: SessionMessage[] }>(
        `/api/sessions/${encodeURIComponent(target.conversationRef)}?${qs.toString()}`,
      );
    },

    async resetSession(target: SessionTarget): Promise<void> {
      if (rpcCall) {
        await rpcCall("session.reset", {
          tenant_id: target.tenantId,
          agent_id: target.agentId,
          conversation_ref: target.conversationRef,
        });
        return;
      }
      const qs = new URLSearchParams({ tenantId: target.tenantId, agentId: target.agentId });
      await fetchJson(
        `/api/sessions/${encodeURIComponent(target.conversationRef)}/reset?${qs.toString()}`,
        { method: "POST" },
      );
    },

    async compactSession(target: SessionTarget): Promise<void> {
      if (rpcCall) {
        await rpcCall("session.compact", {
          tenant_id: target.tenantId,
          agent_id: target.agentId,
          conversation_ref: target.conversationRef,
        });
        return;
      }
      const qs = new URLSearchParams({ tenantId: target.tenantId, agentId: target.agentId });
      await fetchJson(
        `/api/sessions/${encodeURIComponent(target.conversationRef)}/compact?${qs.toString()}`,
        { method: "POST" },
      );
    },

    async deleteSession(target: SessionTarget): Promise<void> {
      if (rpcCall) {
        await rpcCall("session.delete", {
          tenant_id: target.tenantId,
          agent_id: target.agentId,
          conversation_ref: target.conversationRef,
        });
        return;
      }
      const qs = new URLSearchParams({ tenantId: target.tenantId, agentId: target.agentId });
      await fetchJson(
        `/api/sessions/${encodeURIComponent(target.conversationRef)}?${qs.toString()}`,
        { method: "DELETE" },
      );
    },

    async exportSession(target: SessionTarget): Promise<string> {
      if (rpcCall) {
        const result = await rpcCall("session.export", {
          tenant_id: target.tenantId,
          agent_id: target.agentId,
          conversation_ref: target.conversationRef,
        });
        return JSON.stringify(result, null, 2);
      }
      const qs = new URLSearchParams({ tenantId: target.tenantId, agentId: target.agentId });
      return fetchText(
        `/api/sessions/${encodeURIComponent(target.conversationRef)}/export?${qs.toString()}`,
      );
    },

    async resetSessionsBulk(targets: SessionTarget[]): Promise<{ reset: number }> {
      if (rpcCall) {
        const results = await Promise.all(
          targets.map((target) => rpcCall("session.reset", {
            tenant_id: target.tenantId,
            agent_id: target.agentId,
            conversation_ref: target.conversationRef,
          })),
        );
        return { reset: results.length };
      }
      return fetchJson<{ reset: number }>("/api/sessions/bulk-reset", {
        method: "POST",
        body: JSON.stringify({ targets }),
      });
    },

    async exportSessionsBulk(targets: SessionTarget[]): Promise<string> {
      if (rpcCall) {
        const results = await Promise.all(
          targets.map((target) => rpcCall("session.export", {
            tenant_id: target.tenantId,
            agent_id: target.agentId,
            conversation_ref: target.conversationRef,
          })),
        );
        return results.map((result) => JSON.stringify(result)).join("\n");
      }
      return fetchText("/api/sessions/bulk-export", {
        method: "POST",
        body: JSON.stringify({ targets }),
      });
    },

    async deleteSessionsBulk(targets: SessionTarget[]): Promise<{ deleted: number }> {
      if (rpcCall) {
        const results = await Promise.all(
          targets.map((target) => rpcCall("session.delete", {
            tenant_id: target.tenantId,
            agent_id: target.agentId,
            conversation_ref: target.conversationRef,
          })),
        );
        return { deleted: results.length };
      }
      return fetchJson<{ deleted: number }>("/api/sessions/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ targets }),
      });
    },
  };
}
