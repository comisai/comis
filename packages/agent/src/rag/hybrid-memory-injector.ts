// SPDX-License-Identifier: Apache-2.0
/**
 * Hybrid memory injection: splits RAG results between inline (with user
 * message) and system prompt placement for optimal LLM attention.
 *
 * The top-1 highest-scoring memory is inlined with the user message for
 * maximum attention weight. Remaining memories go into the system prompt
 * as additional sections (same format as current RAG retriever).
 *
 * @module
 */

import type { MemorySearchResult, WrapExternalContentOptions } from "@comis/core";
import { sanitizeToolOutput } from "../safety/tool-output-safety.js";
import { formatMemorySection } from "./rag-retriever.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of hybrid memory splitting. */
export interface HybridMemoryInjection {
  /** Top-1 memory formatted for inline injection with user message. */
  inlineMemory: string | undefined;
  /** Remaining memories formatted as system prompt sections. */
  systemPromptSections: string[];
}

/** Hybrid memory injector interface. */
export interface HybridMemoryInjector {
  /**
   * Split memory results into inline and system prompt portions.
   *
   * @param results - Memory search results, pre-sorted by score descending
   * @param maxChars - Maximum character budget for system prompt sections
   * @returns Split injection result
   */
  split(results: MemorySearchResult[], maxChars: number): HybridMemoryInjection;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a hybrid memory injector.
 *
 * @param opts.inlineMinScore - Minimum score for top-1 inline injection (default: 0.7)
 * @param opts.onSuspiciousContent - Callback for suspicious content detection
 * @returns HybridMemoryInjector instance
 */
export function createHybridMemoryInjector(opts?: {
  /** Minimum score threshold for inline injection. Default: 0.7 */
  inlineMinScore?: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): HybridMemoryInjector {
  const inlineMinScore = opts?.inlineMinScore ?? 0.7;

  return {
    split(results: MemorySearchResult[], maxChars: number): HybridMemoryInjection {
      // Empty results
      if (results.length === 0) {
        return { inlineMemory: undefined, systemPromptSections: [] };
      }

      const top = results[0];
      const topScore = top.score ?? 0;

      // Check if top-1 qualifies for inline injection
      if (topScore >= inlineMinScore) {
        // Format top-1 as inline memory
        const date = new Date(top.entry.createdAt).toISOString().split("T")[0];
        const sanitized = sanitizeToolOutput(top.entry.content);
        const inlineMemory = `\n[Relevant context from memory: ${sanitized} (recorded ${date})]\n`;

        // Format remaining results for system prompt
        const remaining = results.slice(1);
        const systemPromptSections: string[] = [];
        if (remaining.length > 0) {
          const section = formatMemorySection(remaining, maxChars, opts?.onSuspiciousContent);
          if (section) {
            systemPromptSections.push(section);
          }
        }

        return { inlineMemory, systemPromptSections };
      }

      // Top-1 didn't qualify -- all go to system prompt
      const section = formatMemorySection(results, maxChars, opts?.onSuspiciousContent);
      const systemPromptSections = section ? [section] : [];
      return { inlineMemory: undefined, systemPromptSections };
    },
  };
}
