// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Memory-portability RPC handler module.
 * Handles the two portability methods:
 *   memory.portability.export — versioned, secret-scrubbed envelope export.
 *   memory.portability.import — firewalled import from comis-memory-export-v1.
 *
 * Extracted from memory-handlers.ts to keep both files within the 800-line cap.
 * Composed back into createMemoryHandlers via object spread.
 *
 * @module
 */

import {
  MemoryPortabilityExportContract,
  MemoryPortabilityImportContract,
  scrubSecretsFromText,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { randomUUID } from "node:crypto";

import type { RpcHandler } from "./types.js";
import type { MemoryApiDeps as MemoryHandlerDeps } from "./types.js";

/**
 * Returns a partial handler record containing only the two portability methods.
 * Composed into createMemoryHandlers via spread.
 */
export function createMemoryPortabilityHandlers(
  deps: MemoryHandlerDeps,
): Record<string, RpcHandler> {
  return {
    // -----------------------------------------------------------------------
    // memory.portability.export — versioned, secret-scrubbed envelope export.
    // Admin-gated. Returns the scrubbed payload over RPC; the CLI writes the
    // JSON file client-side (avoids node --permission fd-fs restriction).
    // -----------------------------------------------------------------------

    [MemoryPortabilityExportContract.method]: async (rawParams) => {
      // Admin gate FIRST — before stripInternalFields (which strips _trustLevel).
      const exportTrustLevel = rawParams._trustLevel as string | undefined;
      if (exportTrustLevel !== "admin") {
        throw new Error("Admin access required for memory export");
      }

      const exportUserParams = stripInternalFields(rawParams);
      const exportParams = MemoryPortabilityExportContract.request.parse(exportUserParams);
      const exportTenantId = exportParams.tenant_id ?? deps.tenantId;
      const exportAgentId = exportParams.agent_id;
      const exportLimit = exportParams.limit ?? 10_000;

      const exportEntries = deps.memoryApi.inspect({
        tenantId: exportTenantId,
        agentId: exportAgentId,
        limit: exportLimit,
        offset: 0,
      });

      const exportedEntries = exportEntries.map((e) => {
        const { text: scrubbedContent } = scrubSecretsFromText(e.content);
        return {
          id: e.id,
          content: scrubbedContent,
          trust_level: e.trustLevel,
          memory_type: (e as unknown as { memoryType?: string }).memoryType ?? "semantic",
          tags: e.tags,
          source_who: e.source.who,
          source_channel: (e.source as unknown as { channel?: string }).channel ?? null,
          source_session_key: (e.source as unknown as { sessionKey?: string }).sessionKey ?? null,
          created_at: e.createdAt,
          occurred_at: (e as unknown as { occurredAt?: number }).occurredAt ?? null,
          proof_count: (e as unknown as { proofCount?: number }).proofCount ?? null,
          source_ids: (e as unknown as { sourceIds?: string[] }).sourceIds ?? null,
          confidence: (e as unknown as { confidence?: number }).confidence ?? null,
          observation_kind: (e as unknown as { observationKind?: string }).observationKind ?? null,
          pattern_type: (e as unknown as { patternType?: string }).patternType ?? null,
        };
      });

      const exportResult = {
        schemaVersion: "comis-memory-export-v1" as const,
        exportedAt: systemNowMs(),
        scope: { tenantId: exportTenantId, agentId: exportAgentId ?? null },
        entryCount: exportedEntries.length,
        entries: exportedEntries,
      };

      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryPortabilityExportContract.response.parse(exportResult);
      }

      deps.logger?.info(
        {
          agentId: exportAgentId ?? "all",
          tenantId: exportTenantId,
          entryCount: exportedEntries.length,
          durationMs: 0,
          step: "memory-portability-export",
        },
        "Memory portability export complete",
      );

      return exportResult;
    },

    // -----------------------------------------------------------------------
    // memory.portability.import — firewalled import from comis-memory-export-v1.
    // Admin-gated. Runs every entry through validateMemoryWrite (even in dry-run).
    // CRITICAL → blocked (continue); WARN → external trust + security-tainted tag.
    // Re-stamps tenantId/agentId from authenticated RPC params — never envelope.
    // -----------------------------------------------------------------------

    [MemoryPortabilityImportContract.method]: async (rawParams) => {
      // Admin gate FIRST — before stripInternalFields (which strips _trustLevel).
      const importTrustLevel = rawParams._trustLevel as string | undefined;
      if (importTrustLevel !== "admin") {
        throw new Error("Admin access required for memory import");
      }

      const importUserParams = stripInternalFields(rawParams);
      const importParams = MemoryPortabilityImportContract.request.parse(importUserParams);
      // Re-stamp scope from authenticated RPC params — NEVER trust envelope body.
      const importTenantId = importParams.tenant_id ?? deps.tenantId;
      const importAgentId = importParams.agent_id;
      const importDryRun = importParams.dry_run ?? false;

      let importCount = 0;
      let blockedCount = 0;
      let downgradedCount = 0;

      for (const rawEntry of importParams.entries) {
        const entryContent = typeof rawEntry["content"] === "string" ? rawEntry["content"] : "";

        // Memory-poisoning firewall — mirrors memory.store handler.
        // CRITICAL: block + continue (do NOT throw — batch must not abort on one poisoned entry).
        // WARN: downgrade trust to "external" + add "security-tainted" tag.
        let entryTrustLevel: "learned" | "external" = "learned";
        const entryExtraTags: string[] = [];

        if (deps.memoryWriteValidator) {
          const importValidation = deps.memoryWriteValidator(entryContent);

          if (importValidation.severity === "critical") {
            blockedCount++;
            deps.logger?.info(
              {
                agentId: importAgentId,
                contentLength: entryContent.length,
                patterns: importValidation.criticalPatterns,
                step: "memory-portability-import",
              },
              "Memory import blocked: critical security patterns detected",
            );
            deps.eventBus?.emit("security:memory_tainted", {
              timestamp: systemNowMs(),
              agentId: importAgentId,
              originalTrustLevel: String(rawEntry["trust_level"] ?? "learned"),
              adjustedTrustLevel: "blocked",
              patterns: importValidation.criticalPatterns,
              blocked: true,
            });
            continue;  // skip this entry — do NOT persist; batch continues
          }

          if (importValidation.severity === "warn") {
            entryTrustLevel = "external";
            entryExtraTags.push("security-tainted");
            downgradedCount++;
            deps.logger?.warn(
              {
                agentId: importAgentId,
                contentLength: entryContent.length,
                patterns: importValidation.patterns,
                hint: "Imported memory tainted: trust downgraded to external",
                errorKind: "validation" as const,
                step: "memory-portability-import",
              },
              "Memory import tainted: suspicious patterns detected",
            );
            deps.eventBus?.emit("security:memory_tainted", {
              timestamp: systemNowMs(),
              agentId: importAgentId,
              originalTrustLevel: String(rawEntry["trust_level"] ?? "learned"),
              adjustedTrustLevel: "external",
              patterns: importValidation.patterns,
              blocked: false,
            });
          } else {
            // Clean: use envelope's trust_level, cap at "learned" — never allow "system" via import.
            const envelopeTrust = String(rawEntry["trust_level"] ?? "learned");
            entryTrustLevel = envelopeTrust === "external" ? "external" : "learned";
          }
        }

        if (!importDryRun) {
          const importEntryId = randomUUID();
          const rawTags = rawEntry["tags"];
          const envelopeTags = Array.isArray(rawTags) ? (rawTags as string[]) : [];

          const storeEntry = {
            id: importEntryId,
            tenantId: importTenantId,    // re-stamp to target — NEVER trust envelope's tenantId
            agentId: importAgentId,      // re-stamp to target — NEVER trust envelope's agentId
            userId: "import",
            content: entryContent,
            trustLevel: entryTrustLevel,
            source: {
              who: typeof rawEntry["source_who"] === "string" ? rawEntry["source_who"] : "import",
              channel:
                typeof rawEntry["source_channel"] === "string"
                  ? rawEntry["source_channel"]
                  : undefined,
              sessionKey:
                typeof rawEntry["source_session_key"] === "string"
                  ? rawEntry["source_session_key"]
                  : undefined,
            },
            tags: [...envelopeTags, ...entryExtraTags],
            createdAt: systemNowMs(),
            occurredAt:
              typeof rawEntry["occurred_at"] === "number"
                ? rawEntry["occurred_at"]
                : undefined,
            memoryType: rawEntry["memory_type"] as
              | "working"
              | "episodic"
              | "semantic"
              | "procedural"
              | undefined,
            proofCount:
              typeof rawEntry["proof_count"] === "number" ? rawEntry["proof_count"] : undefined,
            confidence:
              typeof rawEntry["confidence"] === "number" ? rawEntry["confidence"] : undefined,
            observationKind: rawEntry["observation_kind"] as
              | "merge"
              | "deductive"
              | "inductive"
              | undefined,
            patternType: rawEntry["pattern_type"] as
              | "preference"
              | "behavior"
              | "personality"
              | "tendency"
              | "correlation"
              | undefined,
          };

          const importStoreResult = await deps.memoryAdapter.store(
            storeEntry as Parameters<typeof deps.memoryAdapter.store>[0],
          );
          if (importStoreResult.ok) {
            importCount++;
            if (deps.embeddingQueue) {
              deps.embeddingQueue.enqueue(importEntryId, entryContent);
            }
          } else {
            blockedCount++;
            deps.logger?.warn(
              {
                agentId: importAgentId,
                hint: "Memory store failed during import — entry skipped",
                errorKind: "internal" as const,
                step: "memory-portability-import",
              },
              "Memory import store failure",
            );
          }
        } else {
          // dry-run: count what WOULD be imported (CRITICAL entries already skipped above via continue).
          importCount++;
        }
      }

      const importResult = {
        imported: importCount,
        blocked: blockedCount,
        downgraded: downgradedCount,
        total: importParams.entries.length,
        dryRun: importDryRun,
      };

      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryPortabilityImportContract.response.parse(importResult);
      }

      deps.logger?.info(
        {
          agentId: importAgentId,
          tenantId: importTenantId,
          imported: importCount,
          blocked: blockedCount,
          downgraded: downgradedCount,
          total: importResult.total,
          dryRun: importDryRun,
          durationMs: 0,
          step: "memory-portability-import",
        },
        "Memory portability import complete",
      );

      return importResult;
    },
  };
}
