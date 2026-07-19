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

import { AuthorizationError } from "./errors.js";
import {
  MemoryPortabilityExportContract,
  MemoryPortabilityImportContract,
  scrubSecretsFromText,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";

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
        throw new AuthorizationError("Admin access required for memory export");
      }

      const exportUserParams = stripInternalFields(rawParams);
      const exportParams = MemoryPortabilityExportContract.request.parse(exportUserParams);
      const exportTenantId = exportParams.tenant_id;
      const exportAgentId = exportParams.agent_id;
      const exportLimit = exportParams.limit ?? 10_000;

      // Capture start time for accurate durationMs in the completion log.
      const exportStart = systemNowMs();

      const exportEntries = deps.memoryApi.inspect({
        tenantId: exportTenantId,
        agentId: exportAgentId,
        limit: exportLimit,
        offset: 0,
      });

      const exportedEntries = exportEntries.map((e) => {
        // Scrub ALL free-text fields — not just content — to prevent secret exfil
        // via source provenance or tags. scrubSecretsFromText only redacts secret-shaped values;
        // non-secret text (e.g. "operator", "discord") passes through unchanged.
        const { text: scrubbedContent } = scrubSecretsFromText(e.content);
        const { text: scrubbedSourceWho } = scrubSecretsFromText(
          typeof e.source.who === "string" ? e.source.who : "",
        );
        const rawChannel = (e.source as unknown as { channel?: string }).channel ?? null;
        const { text: scrubbedChannel } = rawChannel !== null
          ? scrubSecretsFromText(rawChannel)
          : { text: null };
        const rawSessionKey = (e.source as unknown as { sessionKey?: string }).sessionKey ?? null;
        const { text: scrubbedSessionKey } = rawSessionKey !== null
          ? scrubSecretsFromText(rawSessionKey)
          : { text: null };
        const scrubbedTags = e.tags.map((t) => scrubSecretsFromText(t).text);

        return {
          id: e.id,
          content: scrubbedContent,
          trust_level: e.trustLevel,
          memory_type: (e as unknown as { memoryType?: string }).memoryType ?? "semantic",
          tags: scrubbedTags,
          source_who: scrubbedSourceWho,
          source_channel: scrubbedChannel,
          source_session_key: scrubbedSessionKey,
          created_at: e.createdAt,
          occurred_at: (e as unknown as { occurredAt?: number }).occurredAt ?? null,
          proof_count: (e as unknown as { proofCount?: number }).proofCount ?? null,
          source_ids: (e as unknown as { sourceIds?: string[] }).sourceIds ?? null,
          confidence: (e as unknown as { confidence?: number }).confidence ?? null,
          observation_kind: (e as unknown as { observationKind?: string }).observationKind ?? null,
          pattern_type: (e as unknown as { patternType?: string }).patternType ?? null,
          visibility: e.visibility.kind,
          conversation_ref: e.visibility.kind === "conversation" ? e.visibility.conversationRef : null,
          principal_id: e.visibility.kind === "principal" ? e.visibility.principalId : null,
        };
      });

      const exportResult = {
        schemaVersion: "comis-memory-export-v1" as const,
        exportedAt: systemNowMs(),
        scope: { tenantId: exportTenantId, agentId: exportAgentId },
        entryCount: exportedEntries.length,
        entries: exportedEntries,
      };

      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryPortabilityExportContract.response.parse(exportResult);
      }

      deps.logger?.info(
        {
          agentId: exportAgentId,
          tenantId: exportTenantId,
          entryCount: exportedEntries.length,
          durationMs: systemNowMs() - exportStart,
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
        throw new AuthorizationError("Admin access required for memory import");
      }

      const importUserParams = stripInternalFields(rawParams);
      const importParams = MemoryPortabilityImportContract.request.parse(importUserParams);
      // Re-stamp scope from authenticated RPC params — NEVER trust envelope body.
      const importTenantId = importParams.tenant_id;
      const importAgentId = importParams.agent_id;
      const importDryRun = importParams.dry_run ?? false;
      const importIdentity = resolveInternalTurnIdentity({
        tenantId: importTenantId,
        agentId: importAgentId,
        originKind: "control-plane",
        instanceId: "memory-portability",
        conversationId: `memory-import-${importAgentId}`,
        principalId: `control-plane-memory-import-${importAgentId}`,
      });
      if (!importIdentity.ok) throw new AuthorizationError(importIdentity.error.message);

      // Fail-closed firewall guard — a missing validator is a wiring mistake.
      // Silently bypassing the security firewall is more dangerous than refusing the batch.
      // Production daemon always wires validateMemoryWrite (daemon.ts); this protects against
      // test-harness wiring errors and future DI mistakes.
      if (!deps.memoryWriteValidator) {
        throw new Error(
          "Memory import requires a memoryWriteValidator — refusing to import without security firewall",
        );
      }

      // Capture start time for accurate durationMs in the completion log.
      const importStart = systemNowMs();

      let importCount = 0;
      let blockedCount = 0;
      let downgradedCount = 0;
      let dedupedCount = 0;

      // Duplicate-content idempotency: build the set of content already present in the
      // TARGET scope so the import is idempotent — re-importing an export (or an overlapping set)
      // skips entries that already exist instead of inserting fresh-id duplicates (live: a 34-entry
      // re-import doubled a 33-row store to 67). A DELETED memory is still restored (its content is
      // absent here, so it imports). Bounded read (100K) — a larger store degrades to "may re-add"
      // past the bound, never to a crash.
      const existingContent = new Set<string>(
        deps.memoryApi
          .inspect({ tenantId: importTenantId, agentId: importAgentId, limit: 100_000, offset: 0 })
          .map((e) => e.content),
      );

      for (const rawEntry of importParams.entries) {
        const entryContent = typeof rawEntry["content"] === "string" ? rawEntry["content"] : "";

        // Memory-poisoning firewall — mirrors memory.store handler.
        // CRITICAL: block + continue (do NOT throw — batch must not abort on one poisoned entry).
        // WARN: downgrade trust to "external" + add "security-tainted" tag.
        // Assigned on every non-skipped path below (warn → "external"; clean → envelope-derived);
        // the critical branch `continue`s before this is read. No initializer needed.
        let entryTrustLevel: "learned" | "external";
        const entryExtraTags: string[] = [];

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

        const rawVisibility = rawEntry["visibility"];
        const visibility = rawVisibility === "conversation"
          ? { kind: "conversation" as const }
          : rawVisibility === "principal"
            ? { kind: "principal" as const }
            : rawVisibility === "agent-shared"
              ? { kind: "agent-shared" as const }
              : undefined;
        if (visibility === undefined) {
          blockedCount++;
          deps.logger?.warn(
            {
              agentId: importAgentId,
              hint: "Export and import the entry with an explicit memory visibility",
              errorKind: "validation" as const,
              step: "memory-portability-import",
            },
            "Memory import skipped an entry without visibility",
          );
          continue;
        }

        // Idempotent skip — content already present in the target scope (or earlier
        // in THIS batch). Counted separately from blocked (security) and downgraded. Security wins:
        // a CRITICAL entry was already blocked above before reaching here.
        if (existingContent.has(entryContent)) {
          dedupedCount++;
          continue;
        }
        existingContent.add(entryContent);

        if (!importDryRun) {
          const importEntryId = randomUUID();
          const rawTags = rawEntry["tags"];
          // Filter to string elements only — z.record(z.string(), z.unknown()) allows
          // non-string array elements in the imported payload; they must not reach the store.
          const envelopeTags = Array.isArray(rawTags)
            ? rawTags.filter((t): t is string => typeof t === "string")
            : [];

          // Pinned pin state is NOT imported: `pinned` is deliberately absent from storeEntry.
          // The `pinned` column defaults to 0 at the SQLite level — imported entries are never
          // pre-pinned. Pin state is local operator curation, not portable across scopes.
          const storeEntry = {
            id: importEntryId,
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
            {
              turnScope: importIdentity.value.turnScope,
              visibility,
              operatorPermission: {
                kind: "operator-memory-visibility",
                tenantId: importTenantId,
                agentId: importAgentId,
              },
            },
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
        deduped: dedupedCount,
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
          deduped: dedupedCount,
          total: importResult.total,
          dryRun: importDryRun,
          durationMs: systemNowMs() - importStart,
          step: "memory-portability-import",
        },
        "Memory portability import complete",
      );

      return importResult;
    },
  };
}
