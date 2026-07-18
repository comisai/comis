// SPDX-License-Identifier: Apache-2.0
/**
 * Hybrid memory injection: splits RAG results between inline (with user
 * message) and system prompt placement for optimal LLM attention.
 *
 * The top-1 highest-scoring same-sender memory is inlined with the user message
 * for maximum attention weight. Unknown-sender, cross-sender, and remaining
 * memories go into the system prompt as annotated sections.
 *
 * @module
 */

import type { MemorySearchResult, WrapExternalContentOptions } from "@comis/core";
import { systemDateFrom } from "@comis/core";
import { sanitizeToolOutput } from "../safety/tool-output-safety.js";
import { formatMemorySection } from "./rag-retriever.js";

/**
 * Matches the inline-recall block this module prepends to a user turn (see the
 * `inlineMemory` template below: `\n[Relevant context from memory: <content>
 * (recorded YYYY-MM-DD[, occurred YYYY-MM-DD])]\n`). KEEP IN SYNC with that
 * template. Anchored at the start (the envelope-wrapper adds it as the OUTERMOST
 * prefix) and matched to the date-anchored `(recorded …)]` terminator so recalled
 * content containing `[`/`]` is handled without over-stripping.
 */
const INLINE_RECALL_BLOCK_RE =
  /^\s*\[Relevant context from memory: [\s\S]*? \(recorded \d{4}-\d{2}-\d{2}(?:, occurred \d{4}-\d{2}-\d{2})?\)\]\n?/;

const CURRENT_TURN_LANGUAGE_HEADING = "## Reply Language for This Turn";
const SYSTEM_CONTEXT_START = "[System context]";
const SYSTEM_CONTEXT_END = "[End system context]";
const CURRENT_TURN_SCRIPT_LINE_RE =
  /^Current message dominant script: (?:Latin|Cyrillic|Hebrew|Arabic|CJK|Thai|Greek|Devanagari|Other)\.$/m;
const CURRENT_TURN_LANGUAGE_TAIL = [
  "[Current-turn language constraint]",
  "The current user message, not recalled memory, is authoritative for reply language.",
];

/**
 * Re-emit the trusted current-turn language constraint after deferred recall,
 * which request-body cache stabilization deliberately moves to the freshest
 * model-visible position. User text appears after the trusted system-context
 * envelope and therefore cannot activate this check by itself.
 */
export function buildRecallLanguageTail(rest: string): string | undefined {
  const contextStart = rest.indexOf(SYSTEM_CONTEXT_START);
  if (contextStart < 0) return undefined;
  const contextEnd = rest.indexOf(SYSTEM_CONTEXT_END, contextStart + SYSTEM_CONTEXT_START.length);
  if (contextEnd < 0) return undefined;
  const systemContext = rest.slice(contextStart, contextEnd);
  const languageSectionStart = systemContext.lastIndexOf(CURRENT_TURN_LANGUAGE_HEADING);
  if (languageSectionStart < 0) return undefined;
  const languageSection = systemContext.slice(languageSectionStart);
  const scriptLine = CURRENT_TURN_SCRIPT_LINE_RE.exec(languageSection)?.[0];
  return [
    ...CURRENT_TURN_LANGUAGE_TAIL,
    ...(scriptLine === undefined ? [] : [scriptLine]),
    "Produce the entire user-facing reply in the language expressed by the current message, including every heading, sentence, bullet, label, suggestion, and follow-up.",
  ].join("\n");
}

/**
 * Remove the leading inline-recall block from a user message's text. The single
 * source of truth for carving this TRANSIENT cross-session recall back out before
 * it is persisted into the LCD lossless store — the store must keep the actual
 * conversation, not the per-turn rendered prompt's recalled memory (which would
 * bloat the store, cross-contaminate the session, and feed back into later
 * recall). A no-op when no block is present.
 */
export function stripInlineRecalledMemory(text: string): string {
  return text.replace(INLINE_RECALL_BLOCK_RE, "");
}

/**
 * Split a user message's text into its leading inline-recall block and the rest.
 * Returns `{ recall: null, rest: text }` when no block is present. Used by the
 * request-body caching layer to move the TRANSIENT recall block onto the
 * UNCACHED tail (a separate trailing content block, after the cache fence) so it
 * is visible to the model yet never cached — preventing the cached-prefix mutation
 * that occurs when the request-body layer strips the recall the turn after it
 * goes historical.
 */
export function extractInlineRecalledMemory(text: string): { recall: string | null; rest: string } {
  const m = INLINE_RECALL_BLOCK_RE.exec(text);
  if (!m) return { recall: null, rest: text };
  return { recall: m[0], rest: text.slice(m[0].length) };
}

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
   * @param maxChars - Maximum character budget for all injected recall text
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
  /** Current conversation sender. Foreign memories stay recallable in the
   *  annotated system section but are not promoted beside the user message. */
  requesterUserId?: string;
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
      const hasInlineSenderProvenance =
        opts?.requesterUserId === undefined || top.entry.userId === opts.requesterUserId;

      // Only same-sender top-1 recall receives the high-salience inline position.
      // Unknown and cross-sender memories remain available in the annotated
      // system section, where their provenance warning cannot be separated.
      if (topScore >= inlineMinScore && hasInlineSenderProvenance) {
        // Format top-1 as inline memory
        const date = systemDateFrom(top.entry.createdAt).toISOString().split("T")[0];
        // Surface the EVENT date only when present; absent → the inline
        // string is byte-identical to the original recorded-only format. systemDateFrom
        // (not new Date) keeps the wall-clock globals banned (globals.test.ts).
        const occurred =
          typeof top.entry.occurredAt === "number"
            ? `, occurred ${systemDateFrom(top.entry.occurredAt).toISOString().split("T")[0]}`
            : "";
        const sanitized = sanitizeToolOutput(top.entry.content);
        const inlineMemory = `\n[Relevant context from memory: ${sanitized} (recorded ${date}${occurred})]\n`;

        // If the top hit cannot fit as a complete inline envelope, keep the
        // canonical formatter as the only placement. It either fits a complete
        // annotated entry or emits nothing; recall text is never cut mid-entry.
        if (inlineMemory.length > maxChars) {
          const section = formatMemorySection(
            results,
            maxChars,
            opts?.onSuspiciousContent,
            opts?.requesterUserId,
          );
          return {
            inlineMemory: undefined,
            systemPromptSections: section ? [section] : [],
          };
        }

        // Format remaining results for system prompt
        const remaining = results.slice(1);
        const systemPromptSections: string[] = [];
        if (remaining.length > 0) {
          const section = formatMemorySection(
            remaining,
            Math.max(0, maxChars - inlineMemory.length),
            opts?.onSuspiciousContent,
            opts?.requesterUserId,
          );
          if (section) {
            systemPromptSections.push(section);
          }
        }

        return { inlineMemory, systemPromptSections };
      }

      // Top-1 didn't qualify -- all go to system prompt
      const section = formatMemorySection(
        results,
        maxChars,
        opts?.onSuspiciousContent,
        opts?.requesterUserId,
      );
      const systemPromptSections = section ? [section] : [];
      return { inlineMemory: undefined, systemPromptSections };
    },
  };
}
