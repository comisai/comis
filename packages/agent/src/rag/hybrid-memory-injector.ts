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
import type { Message } from "@earendil-works/pi-ai";
import { scrubSecretsFromText, systemDateFrom } from "@comis/core";
import { sanitizeToolOutput } from "../safety/tool-output-safety.js";
import { formatMemorySection } from "./rag-retriever.js";

/**
 * Matches the inline-recall block this module prepends to a user turn (see the
 * `inlineMemory` template below: `\n[Relevant context from memory: <content>
 * (recorded YYYY-MM-DD[, occurred YYYY-MM-DD])]\n`). KEEP IN SYNC with that
 * template. Anchored at the start (the envelope-wrapper adds it as the OUTERMOST
 * prefix) and matched to the timestamp-anchored `(recorded …)]` terminator so recalled
 * content containing `[`/`]` is handled without over-stripping.
 */
const INLINE_RECALL_BLOCK_RE =
  /^\s*\[Relevant context from memory: [\s\S]*? \(recorded \d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?(?:, occurred \d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?)?\)\]\n?/;

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

/**
 * Carve the TRANSIENT inline-recall block out of a USER message — the
 * message-shape-aware form of {@link stripInlineRecalledMemory}, shared by every
 * canonical-history producer (the LCD persistence ingest and the inbound
 * conversation projection). The recall block is per-turn rendered prompt
 * context: the model sees it on its own turn, and it must never become durable
 * conversation state — persisted or replayed, it bloats the store,
 * cross-contaminates the session, feeds back into later recall, and mutates the
 * replayed prefix when it rotates out. Assistant / toolResult messages never
 * carry the prefix → returned referentially unchanged. Pure: returns a NEW
 * message only when something was stripped, so the common (no-recall) path
 * keeps the verbatim original.
 */
export function stripInlineRecalledMemoryFromMessage(m: Message): Message {
  if (m.role !== "user") return m;
  const content = (m as { content: unknown }).content;
  if (typeof content === "string") {
    const cleaned = stripInlineRecalledMemory(content);
    return cleaned === content ? m : ({ ...m, content: cleaned } as Message);
  }
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((b) => {
      // The recall is prepended to the message text → it rides the FIRST text block.
      if (!changed && b && (b as { type?: string }).type === "text") {
        const t = (b as { text: string }).text;
        const cleaned = stripInlineRecalledMemory(t);
        if (cleaned !== t) {
          changed = true;
          return { ...b, text: cleaned };
        }
      }
      return b;
    });
    return changed ? ({ ...m, content: next } as Message) : m;
  }
  return m;
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
      // A paired entry is a transcript of an earlier request and response, not
      // a current instruction. Keep it in the explicitly annotated system
      // memory section instead of placing it beside the live user request,
      // where old action parameters can look like part of the new request.
      const isPairedConversation = top.entry.tags.includes("paired");

      // Only same-sender top-1 recall receives the high-salience inline position.
      // Unknown and cross-sender memories remain available in the annotated
      // system section, where their provenance warning cannot be separated.
      if (topScore >= inlineMinScore && hasInlineSenderProvenance && !isPairedConversation) {
        // Format top-1 as inline memory
        const recordedTimestamp = systemDateFrom(top.entry.createdAt).toISOString();
        // Surface the exact EVENT time only when present; absent → the inline
        // string is byte-identical to the original recorded-only format. systemDateFrom
        // (not new Date) keeps the wall-clock globals banned (globals.test.ts).
        const occurredTimestamp =
          typeof top.entry.occurredAt === "number"
            ? `, occurred ${systemDateFrom(top.entry.occurredAt).toISOString()}`
            : "";
        const sanitized = sanitizeToolOutput(scrubSecretsFromText(top.entry.content).text);
        const inlineMemory =
          "\n[Relevant context from memory: This is past context and may be outdated. " +
          "Resolve references from the current conversation first. " +
          "Use this memory only when the current conversation has no plausible referent; " +
          "if ambiguity remains, ask the user rather than guess.\n" +
          `${sanitized} (recorded ${recordedTimestamp}${occurredTimestamp})]\n`;

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
