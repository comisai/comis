// SPDX-License-Identifier: Apache-2.0
/**
 * Memory RPC handler module.
 * Handles all memory-related RPC methods:
 *   memory.search_files, memory.get_file, memory.store,
 *   memory.stats, memory.browse, memory.delete, memory.flush, memory.export
 * Extracted from daemon.ts rpcCallInner for independent testability.
 * @module
 */

import type { MemoryApi, SqliteMemoryAdapter, createEmbeddingQueue } from "@comis/memory";
import type { MemoryWriteValidationResult } from "@comis/core";
import { safePath } from "@comis/core";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by memory RPC handlers. */
export interface MemoryHandlerDeps {
  defaultAgentId: string;
  defaultWorkspaceDir: string;
  workspaceDirs: Map<string, string>;
  memoryApi: MemoryApi;
  memoryAdapter: SqliteMemoryAdapter;
  embeddingQueue?: ReturnType<typeof createEmbeddingQueue>;
  tenantId: string;
  /** Optional memory write validator for security scanning */
  memoryWriteValidator?: (content: string) => MemoryWriteValidationResult;
  /** Optional event bus for security event emission */
  eventBus?: { emit: (event: string, payload: unknown) => void };
  /** Optional logger for security log entries */
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void; info: (obj: Record<string, unknown>, msg: string) => void };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of memory RPC handlers bound to the given deps.
 */
export function createMemoryHandlers(deps: MemoryHandlerDeps): Record<string, RpcHandler> {
  return {
    "memory.search_files": async (params) => {
      const query = params.query as string;
      const limit = (params.limit as number) ?? 10;
      const agentId = params._agentId as string | undefined;
      const results = await deps.memoryApi.search(query, { limit, agentId, tenantId: deps.tenantId });
      return {
        results: results.map((r) => ({
          id: r.entry.id,
          content: r.entry.content.slice(0, 500),
          score: r.score ?? 0,
          tags: r.entry.tags,
          createdAt: r.entry.createdAt,
        })),
      };
    },

    "memory.get_file": async (params) => {
      const filePath = params.path as string;
      // SafePath validation -- resolve against per-agent workspace dir
      const fileAgentId = (params._agentId as string | undefined) ?? deps.defaultAgentId;
      const fileWorkspaceDir = deps.workspaceDirs.get(fileAgentId) ?? deps.defaultWorkspaceDir;
      const resolvedPath = safePath(fileWorkspaceDir, filePath);
      const content = await fs.readFile(resolvedPath, "utf-8");
      const lines = content.split("\n");
      const startLine = (params.startLine as number | undefined) ?? 1;
      const endLine = (params.endLine as number | undefined) ?? lines.length;
      const selected = lines.slice(Math.max(0, startLine - 1), endLine);
      return {
        path: filePath,
        startLine,
        endLine,
        totalLines: lines.length,
        content: selected.join("\n"),
      };
    },

    "memory.store": async (params) => {
      const storeContent = params.content as string;
      if (!storeContent) throw new Error("Missing required parameter: content");
      const storeTags = Array.isArray(params.tags) ? (params.tags as string[]) : [];
      const storeAgentId = (params._agentId as string | undefined) ?? deps.defaultAgentId;
      const storeEntryId = randomUUID();

      // Validate content before storage
      let storeTrustLevel: "learned" | "external" = "learned";
      let storeExtraTags: string[] = [];
      if (deps.memoryWriteValidator) {
        const validation = deps.memoryWriteValidator(storeContent);

        // CRITICAL -- block storage entirely
        if (validation.severity === "critical") {
          deps.logger?.info(
            {
              agentId: storeAgentId,
              contentLength: storeContent.length,
              patterns: validation.criticalPatterns,
            },
            "Memory store blocked: critical security patterns detected",
          );
          deps.eventBus?.emit("security:memory_tainted", {
            timestamp: Date.now(),
            agentId: storeAgentId,
            originalTrustLevel: "learned",
            adjustedTrustLevel: "blocked",
            patterns: validation.criticalPatterns,
            blocked: true,
          });
          throw new Error("Memory store blocked: content contains critical security patterns");
        }

        // WARN -- downgrade trust, add tainted tag
        if (validation.severity === "warn") {
          storeTrustLevel = "external";
          storeExtraTags = ["security-tainted"];
          deps.logger?.warn(
            {
              agentId: storeAgentId,
              contentLength: storeContent.length,
              patterns: validation.patterns,
              hint: "Memory content tainted: trust downgraded from learned to external",
              errorKind: "validation",
            },
            "Memory write tainted: suspicious patterns detected",
          );
          deps.eventBus?.emit("security:memory_tainted", {
            timestamp: Date.now(),
            agentId: storeAgentId,
            originalTrustLevel: "learned",
            adjustedTrustLevel: "external",
            patterns: validation.patterns,
            blocked: false,
          });
        }
      }

      // Admin callers can override trust level (operator-created entries)
      const requestedTrustLevel = params.trustLevel as string | undefined;
      const callerTrustLevel = params._trustLevel as string | undefined;
      const isAdminCaller = callerTrustLevel === "admin";
      if (isAdminCaller && requestedTrustLevel) {
        const validLevels = ["learned", "external"] as const;
        if (validLevels.includes(requestedTrustLevel as typeof validLevels[number])) {
          storeTrustLevel = requestedTrustLevel as "learned" | "external";
        }
      }

      // Admin callers get operator attribution; agents get agent attribution
      const storeSource = isAdminCaller
        ? { who: "operator", channel: "web-console" }
        : { who: storeAgentId, channel: "agent-tool" };
      const storeTag = isAdminCaller ? "operator-stored" : "agent-stored";

      const storeResult = await deps.memoryAdapter.store({
        id: storeEntryId,
        tenantId: deps.tenantId,
        agentId: storeAgentId,
        userId: isAdminCaller ? "operator" : "agent",
        content: storeContent,
        trustLevel: storeTrustLevel,
        source: storeSource,
        tags: [storeTag, ...storeTags, ...storeExtraTags],
        createdAt: Date.now(),
      });
      if (!storeResult.ok) {
        throw new Error(`Memory store failed: ${storeResult.error.message}`);
      }
      if (deps.embeddingQueue) {
        deps.embeddingQueue.enqueue(storeEntryId, storeContent);
      }
      return { stored: true, id: storeEntryId };
    },

    // -----------------------------------------------------------------------
    // Memory management handlers
    // -----------------------------------------------------------------------

    "memory.stats": async (params) => {
      const tenantId = (params.tenant_id as string | undefined) ?? deps.tenantId;
      const agentId = params.agent_id as string | undefined;
      return deps.memoryApi.stats(tenantId, agentId);
    },

    "memory.browse": async (params) => {
      const tenantId = (params.tenant_id as string | undefined) ?? deps.tenantId;
      const agentId = params.agent_id as string | undefined;
      const offset = (params.offset as number | undefined) ?? 0;
      const limit = (params.limit as number | undefined) ?? 20;
      const sort = (params.sort as string | undefined) ?? "newest";
      const memoryType = params.memory_type as string | undefined;
      const trustLevel = params.trust_level as string | undefined;
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : undefined;

      let entries = deps.memoryApi.inspect({
        tenantId,
        agentId,
        limit,
        offset,
        memoryType: memoryType as "working" | "episodic" | "semantic" | "procedural" | undefined,
        trustLevel: trustLevel as "system" | "learned" | "external" | undefined,
        tags,
      });

      // inspect() always sorts DESC (newest first). Reverse for "oldest".
      if (sort === "oldest") {
        entries = entries.slice().reverse();
      }

      return {
        entries: entries.map((e) => ({
          id: e.id,
          content: e.content.slice(0, 500),
          memoryType: (e as unknown as { memoryType?: string }).memoryType,
          trustLevel: e.trustLevel,
          tags: e.tags,
          agentId: e.agentId,
          createdAt: e.createdAt,
        })),
        total: entries.length,
        offset,
        limit,
        hasMore: entries.length === limit,
      };
    },

    "memory.delete": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for memory deletion");
      }

      const ids = params.ids as string[] | undefined;
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error("Missing or empty required parameter: ids");
      }
      const tenantId = (params.tenant_id as string | undefined) ?? deps.tenantId;

      let successCount = 0;
      let failCount = 0;
      for (const id of ids) {
        const result = await deps.memoryAdapter.delete(id, tenantId);
        if (result.ok) {
          successCount++;
        } else {
          failCount++;
        }
      }

      return { deleted: successCount, failed: failCount, total: ids.length };
    },

    "memory.flush": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for memory flush");
      }

      const tenantId = (params.tenant_id as string | undefined) ?? deps.tenantId;
      const agentId = params.agent_id as string | undefined;

      const count = deps.memoryApi.clear({ tenantId, agentId });

      return {
        flushed: true,
        entriesRemoved: count,
        scope: { tenantId, agentId: agentId ?? null },
      };
    },

    "memory.export": async (params) => {
      const tenantId = (params.tenant_id as string | undefined) ?? deps.tenantId;
      const agentId = params.agent_id as string | undefined;
      const offset = (params.offset as number | undefined) ?? 0;
      const limit = (params.limit as number | undefined) ?? 1000;

      const entries = deps.memoryApi.inspect({ tenantId, agentId, limit, offset });

      return {
        entries: entries.map((e) => ({
          id: e.id,
          content: e.content,
          memoryType: (e as unknown as { memoryType?: string }).memoryType,
          trustLevel: e.trustLevel,
          tags: e.tags,
          agentId: e.agentId,
          userId: e.userId,
          source: e.source,
          createdAt: e.createdAt,
        })),
        total: entries.length,
        offset,
        limit,
      };
    },
  };
}
