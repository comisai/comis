// SPDX-License-Identifier: Apache-2.0
/**
 * Memory RPC handler module.
 * Handles all memory-related RPC methods:
 *   memory.search_files, memory.get_file, memory.store,
 *   memory.stats, memory.browse, memory.delete, memory.flush, memory.export
 * Extracted from daemon.ts rpcCallInner for independent testability.
 *
 * Phase 35 Wave C (Plan 35-14): refactored to use the `@comis/core`
 * contract registry. Method keys are computed-property names
 * (`[MemoryStoreContract.method]:`) so the bidirectional 1:1
 * architecture test resolves them through `defineContract({ method, ... })`
 * declarations in `packages/core/src/api-contracts/memory.ts`. The
 * dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` (D-04
 * Pitfall 6 — never model internals in the contract schema). The admin
 * trust check (where applicable) reads `rawParams._trustLevel` BEFORE
 * the strip step; the optional `_agentId` fallback for the agent-side
 * memory.store path is ALSO read from rawParams pre-strip.
 *
 * The bespoke pre-Zod validation (admin gate, missing-content guard,
 * ids array presence + non-empty check, etc.) is intentionally retained
 * for user-friendly error UX matching the existing 15+ handler-test
 * assertions in memory-handlers.test.ts. The contract parse runs AFTER
 * the bespoke checks and serves to (a) narrow params types for the rest
 * of the handler body and (b) provide a defense-in-depth gate against
 * future drift between the contract schema and the bespoke checks.
 *
 * @module
 */

import {
  MemorySearchFilesContract,
  MemoryGetFileContract,
  MemoryStoreContract,
  MemoryStatsContract,
  MemoryBrowseContract,
  MemoryDeleteContract,
  MemoryFlushContract,
  MemoryExportContract,
  safePath,
  stripInternalFields,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts (Plan 34-08a).
// Single source of truth: MemoryApiDeps (shared with context-handlers).
// DAEMON-API-03 Option A retarget — handler bodies and call sites unchanged.
import type { MemoryApiDeps as MemoryHandlerDeps } from "./types.js";
export type { MemoryHandlerDeps };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of memory RPC handlers bound to the given deps.
 */
export function createMemoryHandlers(deps: MemoryHandlerDeps): Record<string, RpcHandler> {
  return {
    [MemorySearchFilesContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = MemorySearchFilesContract.request.parse(userParams);
      const limit = params.limit ?? 10;
      const agentId = rawParams._agentId as string | undefined;
      const results = await deps.memoryApi.search(params.query, {
        limit,
        agentId,
        tenantId: deps.tenantId,
      });
      const result = {
        results: results.map((r) => ({
          id: r.entry.id,
          content: r.entry.content.slice(0, 500),
          score: r.score ?? 0,
          tags: r.entry.tags,
          createdAt: r.entry.createdAt,
        })),
      };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        MemorySearchFilesContract.response.parse(result);
      }
      return result;
    },

    [MemoryGetFileContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = MemoryGetFileContract.request.parse(userParams);
      // SafePath validation -- resolve against per-agent workspace dir
      const fileAgentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
      const fileWorkspaceDir = deps.workspaceDirs.get(fileAgentId) ?? deps.defaultWorkspaceDir;
      const resolvedPath = safePath(fileWorkspaceDir, params.path);
      const content = await fs.readFile(resolvedPath, "utf-8");
      const lines = content.split("\n");
      const startLine = params.startLine ?? 1;
      const endLine = params.endLine ?? lines.length;
      const selected = lines.slice(Math.max(0, startLine - 1), endLine);
      const result = {
        path: params.path,
        startLine,
        endLine,
        totalLines: lines.length,
        content: selected.join("\n"),
      };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        MemoryGetFileContract.response.parse(result);
      }
      return result;
    },

    [MemoryStoreContract.method]: async (rawParams) => {
      // Bespoke pre-Zod content guard FIRST so the user-facing message
      // stays "Missing required parameter: content" (matches existing
      // memory-handlers.test.ts assertions). The contract `.min(1)` is
      // defense-in-depth that fires only if the bespoke guard is bypassed.
      const storeContentRaw = rawParams.content as string | undefined;
      if (!storeContentRaw) throw new Error("Missing required parameter: content");

      // Strip internals + contract-parse for type narrowing. The `_agentId`
      // and `_trustLevel` internals are read from rawParams BELOW (BEFORE
      // strip) because they drive the agent-vs-operator attribution branch.
      const userParams = stripInternalFields(rawParams);
      const params = MemoryStoreContract.request.parse(userParams);

      const storeContent = params.content;
      const storeTags = params.tags ?? [];
      const storeAgentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
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
              errorKind: "validation" as const,
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
      const requestedTrustLevel = params.trustLevel;
      const callerTrustLevel = rawParams._trustLevel as string | undefined;
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
      const result = { stored: true as const, id: storeEntryId };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        MemoryStoreContract.response.parse(result);
      }
      return result;
    },

    // -----------------------------------------------------------------------
    // Memory management handlers
    // -----------------------------------------------------------------------

    [MemoryStatsContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = MemoryStatsContract.request.parse(userParams);
      const tenantId = params.tenant_id ?? deps.tenantId;
      const agentId = params.agent_id;
      const result = deps.memoryApi.stats(tenantId, agentId);
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        MemoryStatsContract.response.parse(result);
      }
      return result;
    },

    [MemoryBrowseContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = MemoryBrowseContract.request.parse(userParams);
      const tenantId = params.tenant_id ?? deps.tenantId;
      const agentId = params.agent_id;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;
      const sort = params.sort ?? "newest";
      const memoryType = params.memory_type;
      const trustLevel = params.trust_level;
      const tags = params.tags;

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

      const result = {
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
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        MemoryBrowseContract.response.parse(result);
      }
      return result;
    },

    [MemoryDeleteContract.method]: async (rawParams) => {
      // Admin gate FIRST — separate from the contract schema (D-04).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for memory deletion");
      }

      // Bespoke ids-presence guard FIRST so user-facing message stays
      // "Missing or empty required parameter: ids" (matches existing
      // memory-handlers.test.ts assertions). The contract `.min(1)` is
      // defense-in-depth.
      const idsRaw = rawParams.ids as string[] | undefined;
      if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
        throw new Error("Missing or empty required parameter: ids");
      }

      const userParams = stripInternalFields(rawParams);
      const params = MemoryDeleteContract.request.parse(userParams);
      const ids = params.ids;
      const tenantId = params.tenant_id ?? deps.tenantId;

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

      const result = { deleted: successCount, failed: failCount, total: ids.length };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        MemoryDeleteContract.response.parse(result);
      }
      return result;
    },

    [MemoryFlushContract.method]: async (rawParams) => {
      // Admin gate FIRST — separate from the contract schema (D-04).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for memory flush");
      }

      const userParams = stripInternalFields(rawParams);
      const params = MemoryFlushContract.request.parse(userParams);
      const tenantId = params.tenant_id ?? deps.tenantId;
      const agentId = params.agent_id;

      const count = deps.memoryApi.clear({ tenantId, agentId });

      const result = {
        flushed: true as const,
        entriesRemoved: count,
        scope: { tenantId, agentId: agentId ?? null },
      };
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        MemoryFlushContract.response.parse(result);
      }
      return result;
    },

    [MemoryExportContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = MemoryExportContract.request.parse(userParams);
      const tenantId = params.tenant_id ?? deps.tenantId;
      const agentId = params.agent_id;
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 1000;

      const entries = deps.memoryApi.inspect({ tenantId, agentId, limit, offset });

      const result = {
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
      // eslint-disable-next-line no-restricted-syntax -- D-10 LOCKED: dev-mode response validation gate; daemon side is the trust boundary.
      if (process.env.NODE_ENV !== "production") {
        MemoryExportContract.response.parse(result);
      }
      return result;
    },
  };
}
