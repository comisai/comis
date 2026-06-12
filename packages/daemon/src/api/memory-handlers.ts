// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Memory RPC handler module.
 * Handles all memory-related RPC methods:
 *   memory.search_files, memory.get_file, memory.store,
 *   memory.stats, memory.browse, memory.delete, memory.flush, memory.export
 * Extracted from daemon.ts rpcCallInner for independent testability.
 *
 * Uses the `@comis/core` contract registry. Method keys are
 * computed-property names (`[MemoryStoreContract.method]:`) so the
 * bidirectional 1:1 architecture test resolves them through
 * `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/memory.ts`. The dispatcher-injected
 * `_X` internal fields are stripped via `stripInternalFields` BEFORE
 * `contract.request.parse(...)` — never model internals in the contract
 * schema. The admin trust check (where applicable) reads
 * `rawParams._trustLevel` BEFORE the strip step; the optional `_agentId`
 * fallback for the agent-side memory.store path is ALSO read from
 * rawParams pre-strip.
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
  MemoryRecallTraceContract,
  MemoryObservationsContract,
  MemoryEntitiesContract,
  MemoryRecallStatsContract,
  parseFormattedSessionKey,
  safePath,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
// ValidationError: typed caller-error → dispatcher logs warn/validation (FIX 2).
import { ValidationError } from "./errors.js";
import { resolveRecallTraceFilePath } from "@comis/observability";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import type { RpcHandler } from "./types.js";
/** Max chars of an observation body surfaced as a provenance PREVIEW
 *  (never the full body unbounded; mirrors memory.search_files). */
const OBSERVATION_PREVIEW_MAX = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: MemoryApiDeps (shared with context-handlers).
// Handler bodies and call sites are unchanged by the alias.
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
      if (systemGetEnv("NODE_ENV") !== "production") {
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
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryGetFileContract.response.parse(result);
      }
      return result;
    },

    [MemoryStoreContract.method]: async (rawParams) => {
      // Bespoke pre-Zod content guard FIRST so the user-facing message
      // stays "Missing required parameter: content" (matches existing
      // memory-handlers.test.ts assertions). The contract `.min(1)` is
      // defense-in-depth that fires only if the bespoke guard is bypassed.
      // FIX 2: ValidationError (not bare Error) → dispatcher logs warn/validation,
      // not error/internal — behavior unchanged (still rejected, same message).
      const storeContentRaw = rawParams.content as string | undefined;
      if (!storeContentRaw) throw new ValidationError("Missing required parameter: content");

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
            timestamp: systemNowMs(),
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
            timestamp: systemNowMs(),
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

      // Attribution (live finding 2026-06-11): tool-stored user facts carried
      // the literal user_id "agent" while paired auto-captures carried the
      // real session user — "who is this fact about" was lost on the tool
      // path. Recover the userId from the dispatcher-injected caller session
      // key; fall back to "agent" when no session context exists.
      const storeCallerSessionKey = rawParams._callerSessionKey as string | undefined;
      const storeCallerUserId =
        storeCallerSessionKey !== undefined
          ? parseFormattedSessionKey(storeCallerSessionKey)?.userId
          : undefined;

      const storeResult = await deps.memoryAdapter.store({
        id: storeEntryId,
        tenantId: deps.tenantId,
        agentId: storeAgentId,
        userId: isAdminCaller ? "operator" : (storeCallerUserId ?? "agent"),
        content: storeContent,
        trustLevel: storeTrustLevel,
        source: storeSource,
        tags: [storeTag, ...storeTags, ...storeExtraTags],
        createdAt: systemNowMs(),
      });
      if (!storeResult.ok) {
        throw new Error(`Memory store failed: ${storeResult.error.message}`);
      }
      if (deps.embeddingQueue) {
        deps.embeddingQueue.enqueue(storeEntryId, storeContent);
      }
      const result = { stored: true as const, id: storeEntryId };
      if (systemGetEnv("NODE_ENV") !== "production") {
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
      if (systemGetEnv("NODE_ENV") !== "production") {
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
      const tags = params.tags;
      // Shared filters for the page read + the full-count (P4: total = FULL count(), not page length).
      const filters = {
        tenantId,
        agentId,
        memoryType: params.memory_type as "working" | "episodic" | "semantic" | "procedural" | undefined,
        trustLevel: params.trust_level as "system" | "learned" | "external" | undefined,
        tags,
      };

      let entries = deps.memoryApi.inspect({ ...filters, limit, offset });

      // inspect() always sorts DESC (newest first). Reverse for "oldest".
      if (sort === "oldest") {
        entries = entries.slice().reverse();
      }

      const total = deps.memoryApi.count(filters);

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
        total,
        offset,
        limit,
        hasMore: offset + entries.length < total, // more rows exist past this window
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryBrowseContract.response.parse(result);
      }
      return result;
    },

    [MemoryDeleteContract.method]: async (rawParams) => {
      // Admin gate FIRST — separate from the contract schema.
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
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryDeleteContract.response.parse(result);
      }
      return result;
    },

    [MemoryFlushContract.method]: async (rawParams) => {
      // Admin gate FIRST — separate from the contract schema.
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
      if (systemGetEnv("NODE_ENV") !== "production") {
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
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryExportContract.response.parse(result);
      }
      return result;
    },

    // -----------------------------------------------------------------------
    // Memory-diagnostic handlers — admin-gated FIRST, then
    // every query scoped to (tenant, agent) via deps.tenantId + params.agent_id.
    // The agent is never on this path; the queries run here in the daemon.
    // -----------------------------------------------------------------------

    [MemoryObservationsContract.method]: async (rawParams) => {
      // Admin gate FIRST — before parse + query.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for memory observations");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MemoryObservationsContract.request.parse(userParams);
      // Scope NEVER widened — tenantId falls back to deps.tenantId.
      const tenantId = params.tenant_id ?? deps.tenantId;
      const agentId = params.agent_id ?? deps.defaultAgentId;
      const limit = params.limit ?? 50;

      if (!deps.consolidationStore) {
        throw new Error("Memory observations unavailable: consolidation store not wired");
      }
      const obsResult = await deps.consolidationStore.listObservations(agentId, tenantId, limit);
      if (!obsResult.ok) {
        throw new Error(`Memory observations failed: ${obsResult.error.message}`);
      }

      const result = {
        observations: obsResult.value.map((e) => ({
          id: e.id,
          // Provenance PREVIEW only — truncate the body.
          content: e.content.slice(0, OBSERVATION_PREVIEW_MAX),
          ...(e.proofCount !== undefined ? { proofCount: e.proofCount } : {}),
          ...(e.sourceIds !== undefined ? { sourceIds: e.sourceIds } : {}),
          ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
          ...(e.consolidatedAt !== undefined ? { consolidatedAt: e.consolidatedAt } : {}),
          createdAt: e.createdAt,
        })),
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryObservationsContract.response.parse(result);
      }
      return result;
    },

    [MemoryEntitiesContract.method]: async (rawParams) => {
      // Admin gate FIRST.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for memory entities");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MemoryEntitiesContract.request.parse(userParams);
      const tenantId = params.tenant_id ?? deps.tenantId;
      const agentId = params.agent_id ?? deps.defaultAgentId;
      const limit = params.limit ?? 100;

      if (!deps.entityStore) {
        throw new Error("Memory entities unavailable: entity store not wired");
      }
      // listEntities bakes the `WHERE tenant_id=? AND agent_id=?` scope.
      const entResult = await deps.entityStore.listEntities(agentId, tenantId, limit);
      if (!entResult.ok) {
        throw new Error(`Memory entities failed: ${entResult.error.message}`);
      }

      const result = {
        entities: entResult.value.map((row) => ({
          id: row.id,
          name: row.name,
          mentionCount: row.mentionCount,
          ...(row.firstSeen !== undefined ? { firstSeen: row.firstSeen } : {}),
          ...(row.lastSeen !== undefined ? { lastSeen: row.lastSeen } : {}),
        })),
      };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryEntitiesContract.response.parse(result);
      }
      return result;
    },

    [MemoryRecallStatsContract.method]: async (rawParams) => {
      // Admin gate FIRST.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for memory recall stats");
      }
      const userParams = stripInternalFields(rawParams);
      MemoryRecallStatsContract.request.parse(userParams);

      // The counters are a process-lifetime gauge (reset on restart). When the
      // wiring is absent, return a zeroed snapshot so the operator view still
      // renders rather than erroring.
      const snap = deps.recallCounters?.snapshot() ?? {
        laneUsage: { fts: 0, vector: 0, entity: 0 },
        rerankRuns: 0,
        rerankFallbacks: 0,
        consolidationClusters: 0,
        observationsCreated: 0,
        recalls: 0,
        recallsWithHits: 0,
      };

      // Derived rates — guard the divide-by-zero on a fresh/unwired process.
      const rerankFallbackRate = snap.rerankRuns > 0 ? snap.rerankFallbacks / snap.rerankRuns : 0;
      const recallHitRate = snap.recalls > 0 ? snap.recallsWithHits / snap.recalls : 0;

      const result = { ...snap, rerankFallbackRate, recallHitRate };
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryRecallStatsContract.response.parse(result);
      }
      return result;
    },

    [MemoryRecallTraceContract.method]: async (rawParams) => {
      // Admin gate FIRST.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for memory recall trace");
      }
      const userParams = stripInternalFields(rawParams);
      const params = MemoryRecallTraceContract.request.parse(userParams);

      // Mirror obs.trace.search: at least one selector required.
      if (!params.session_key && !params.trace_id) {
        throw new Error("Recall trace requires at least one of session_key / trace_id");
      }

      const tenantId = params.tenant_id ?? deps.tenantId;
      const agentId = params.agent_id ?? deps.defaultAgentId;
      const limit = params.limit ?? 200;

      // Resolve the daemon-wide recall-trace JSONL via the same `~`-expanding
      // resolver the recorder uses (safePath-confined to the data dir).
      const baseDir = deps.dataDir ?? safePath(os.homedir(), ".comis");
      const filePath = resolveRecallTraceFilePath({ confinedBaseDir: baseDir });

      const records: Array<Record<string, unknown>> = [];
      // The records are already sanitized/redacted on disk — do NOT
      // re-sanitize, but DO scope-filter (defense-in-depth).
      if (fsSync.existsSync(filePath)) {
        let content: string;
        try {
          content = fsSync.readFileSync(filePath, "utf-8");
        } catch {
          content = "";
        }
        for (const line of content.split("\n")) {
          // Early-break once `limit` matching records are collected.
          // The handler used `continue` here, so it walked the ENTIRE (up to
          // 50 MB) file even after the limit was satisfied — heavy for an admin
          // RPC. Records are appended chronologically and the response keeps
          // that forward order (the existing session_key/trace_id tests assert
          // records[0] is the FIRST match), so stopping at the limit preserves
          // the returned set exactly while bounding the scan.
          if (records.length >= limit) break;
          if (!line) continue;
          let rec: Record<string, unknown>;
          try {
            rec = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // Skip malformed JSONL lines per standard JSONL convention.
            continue;
          }
          // Selector match: session_key OR trace_id.
          // The production recorder ALWAYS writes `sessionId`
          // (= formatSessionKey(...)) and writes `sessionKey` only when an
          // envelope is supplied. `comis memory recall-trace <session>` passes
          // the formatted session key, so the selector must match it against
          // the field the recorder actually writes — `sessionKey` when present,
          // else the always-present `sessionId`. Matching only `rec.sessionKey`
          // returned ZERO records in production.
          const recSession = rec.sessionKey ?? rec.sessionId;
          const matchesSelector =
            (params.session_key !== undefined && recSession === params.session_key) ||
            (params.trace_id !== undefined && rec.traceId === params.trace_id);
          if (!matchesSelector) continue;
          // Defense-in-depth scope filter — only when the record carries the
          // dimension (older/leaner records may omit them).
          if (typeof rec.tenantId === "string" && rec.tenantId !== tenantId) continue;
          if (typeof rec.agentId === "string" && rec.agentId !== agentId) continue;
          records.push(rec);
        }
      }

      // Honest empty (live finding 2026-06-11): a bare `{records: []}` made
      // a disabled recorder indistinguishable from "no recalls happened" —
      // the diagnosis tool itself degraded silently. Report the recorder
      // gate, and when empty, say WHY + which knob enables tracing.
      const tracingEnabled = deps.recallTraceEnabled === true;
      const result: { records: typeof records; tracingEnabled: boolean; hint?: string } = {
        records,
        tracingEnabled,
      };
      if (records.length === 0) {
        result.hint = tracingEnabled
          ? "no recall-trace records matched this selector yet — traces are recorded per recall while diagnostics.recallTrace.enabled is true; re-run the session and query again"
          : "recall tracing is DISABLED (diagnostics.recallTrace.enabled defaults to false) — no traces are being recorded; set diagnostics.recallTrace.enabled: true and re-run the session";
      }
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryRecallTraceContract.response.parse(result);
      }
      return result;
    },
  };
}
