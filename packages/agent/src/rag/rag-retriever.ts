/**
 * RAG Retriever -- Retrieves relevant memories for system prompt injection.
 *
 * Searches long-term memory, filters by trust level, formats with
 * provenance annotations, enforces token budget, and sanitizes content
 * against prompt injection before injection into the LLM system prompt.
 */

import type {
  MemoryPort,
  MemorySearchResult,
  SessionKey,
  RagConfig,
  TrustLevel,
  WrapExternalContentOptions,
} from "@comis/core";
import { wrapExternalContent } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { sanitizeToolOutput } from "../safety/tool-output-safety.js";

/**
 * RAG retriever interface -- produces formatted memory sections
 * suitable for system prompt injection.
 */
export interface RagRetriever {
  retrieve(query: string, sessionKey: SessionKey, options?: { agentId?: string }): Promise<string[]>;
}

/**
 * Dependencies for creating a RAG retriever.
 */
export interface RagRetrieverDeps {
  memoryPort: MemoryPort;
  config: RagConfig;
  /** Optional callback for suspicious content detection in external content. */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  /** Logger for RAG search observability. */
  logger?: ComisLogger;
}

/**
 * Format a list of memory search results into a single annotated section.
 *
 * Each result is formatted with trust-level tag, date, optional source
 * channel, and sanitized content. Results are appended until the
 * maxChars budget is exhausted.
 *
 * @param results - Memory search results sorted by score descending
 * @param maxChars - Maximum total characters for the formatted section
 * @returns Formatted section string, or empty string if no results fit
 */
export function formatMemorySection(
  results: MemorySearchResult[],
  maxChars: number,
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"],
): string {
  const header =
    "## Relevant Memories\n\nThe following are memories from past interactions, ranked by relevance:\n";

  let charCount = header.length;
  let body = "";

  for (const result of results) {
    const { entry } = result;

    // Format date as YYYY-MM-DD
    const date = new Date(entry.createdAt).toISOString().split("T")[0];

    // Format trust tag -- external gets explicit untrusted warning
    const trustTag =
      entry.trustLevel === "external" ? "[external/untrusted]" : `[${entry.trustLevel}]`;

    // Format optional source channel
    const source = entry.source.channel ? ` via ${entry.source.channel}` : "";

    // Sanitize content against prompt injection
    let sanitizedContent = sanitizeToolOutput(entry.content);

    // Wrap non-system content with security boundaries
    // Skip if already wrapped (taintLevel === "wrapped")
    const taintLevel = (entry as Record<string, unknown>).taintLevel as string | undefined;
    if (entry.trustLevel !== "system" && taintLevel !== "wrapped") {
      const sourceType = (entry as Record<string, unknown>).sourceType as string | undefined;
      sanitizedContent = wrapExternalContent(sanitizedContent, {
        source: (sourceType ?? "api") as "api",
        includeWarning: false, // Keep compact for RAG context
        onSuspiciousContent,
      });
    }

    // Build formatted line
    const line = `- ${trustTag} (${date}${source}): ${sanitizedContent}\n`;

    // Check budget
    if (charCount + line.length > maxChars) {
      break;
    }

    body += line;
    charCount += line.length;
  }

  // If no results fit within budget, return empty
  if (body === "") {
    return "";
  }

  return header + body;
}

/**
 * Deduplicate search results by content fingerprint.
 * When multiple entries have the same content (first 200 chars, trimmed+lowercased),
 * keeps only the most recent (highest createdAt). Preserves original score order.
 */
export function deduplicateResults(results: MemorySearchResult[]): MemorySearchResult[] {
  const seen = new Map<string, MemorySearchResult>();
  for (const r of results) {
    const fingerprint = r.entry.content.slice(0, 200).trim().toLowerCase();
    const existing = seen.get(fingerprint);
    if (!existing || r.entry.createdAt > existing.entry.createdAt) {
      seen.set(fingerprint, r);
    }
  }
  // Preserve original score order by filtering the input array
  return results.filter((r) => seen.get(r.entry.content.slice(0, 200).trim().toLowerCase()) === r);
}

/**
 * Create a RAG retriever instance.
 *
 * When disabled (config.enabled = false), retrieve() returns [] immediately.
 * Otherwise, searches memory, filters by trust level, formats with
 * provenance annotations, and enforces character budget.
 *
 * @param deps - Memory port and RAG configuration
 * @returns A RagRetriever instance
 */
export function createRagRetriever(deps: RagRetrieverDeps): RagRetriever {
  return {
    async retrieve(query: string, sessionKey: SessionKey, options?: { agentId?: string }): Promise<string[]> {
      // Short-circuit when RAG is disabled
      if (!deps.config.enabled) {
        return [];
      }

      const startMs = Date.now();
      deps.logger?.debug(
        { query: query.slice(0, 100), agentId: options?.agentId },
        "RAG search started",
      );

      // Search memory
      const results = await deps.memoryPort.search(sessionKey, query, {
        limit: deps.config.maxResults,
        minScore: deps.config.minScore,
        agentId: options?.agentId,
      });

      // Handle search errors gracefully
      if (!results.ok) {
        deps.logger?.warn(
          {
            err: results.error,
            query: query.slice(0, 100),
            agentId: options?.agentId,
            hint: "Memory search failed; RAG context will be empty for this execution",
            errorKind: "dependency" as const,
          },
          "RAG search error",
        );
        return [];
      }

      // No results found
      if (results.value.length === 0) {
        deps.logger?.debug(
          { resultCount: 0, durationMs: Date.now() - startMs, agentId: options?.agentId },
          "RAG search complete",
        );
        return [];
      }

      // Post-filter by allowed trust levels
      const allowedTrustLevels = new Set<TrustLevel>(deps.config.includeTrustLevels);
      const filtered = results.value.filter((r) => allowedTrustLevels.has(r.entry.trustLevel));

      if (filtered.length === 0) {
        return [];
      }

      // Deduplicate near-identical content (e.g., repeated cron instructions)
      const deduped = deduplicateResults(filtered);

      if (deduped.length === 0) {
        deps.logger?.debug(
          { resultCount: 0, durationMs: Date.now() - startMs, agentId: options?.agentId },
          "RAG search complete",
        );
        return [];
      }

      deps.logger?.debug(
        {
          resultCount: deduped.length,
          rawCount: results.value.length,
          filteredCount: filtered.length,
          durationMs: Date.now() - startMs,
          agentId: options?.agentId,
        },
        "RAG search complete",
      );

      // Format and enforce budget
      const section = formatMemorySection(deduped, deps.config.maxContextChars, deps.onSuspiciousContent);

      if (section === "") {
        return [];
      }

      return [section];
    },
  };
}
