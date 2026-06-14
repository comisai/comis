// SPDX-License-Identifier: Apache-2.0
/**
 * Shared per-block-type character estimation for context guard pipeline.
 *
 * Provides accurate per-block-type character estimation with WeakMap caching
 * so that multiple consumers do not redundantly re-scan the same messages.
 * Used by the context engine pipeline for token estimation.
 *
 * @module
 */

import type { Message } from "@earendil-works/pi-ai";
import { scriptTokenFactor } from "@comis/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** General text characters-per-token ratio (conservative 4:1 estimate). */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimated tokens consumed by a single image block.
 *
 * Based on typical vision model token usage (~1600 tokens per image).
 * Character equivalent: IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN = 6400.
 */
export const IMAGE_TOKEN_ESTIMATE = 1600;

/** Character fallback for unknown/unrecognized block types. */
const UNKNOWN_BLOCK_CHARS = 256;

/** Character fallback when JSON.stringify fails on tool call arguments. */
const TOOL_STRINGIFY_FALLBACK = 128;

// ---------------------------------------------------------------------------
// Per-message estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the character count consumed by a single message's content.
 *
 * Dispatches on block type:
 * - `text`: string length of `.text`
 * - `image`: IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN (6400 chars)
 * - `thinking`: string length of `.thinking`
 * - `toolCall`: JSON.stringify of `.arguments` length (fallback 128 on error)
 * - unknown: 256 chars
 *
 * When `content` is a plain string (UserMessage shorthand), returns
 * the string length directly.
 *
 * @param msg - A pi-ai Message (UserMessage, AssistantMessage, or ToolResultMessage)
 * @param cache - Optional WeakMap for caching results across repeated calls
 * @returns Estimated character count for the message
 */
export function estimateMessageChars(
  msg: Message,
  cache?: WeakMap<Message, number>,
): number {
  if (cache) {
    const cached = cache.get(msg);
    if (cached !== undefined) return cached;
  }

  let chars = 0;

  if (typeof msg.content === "string") {
    // UserMessage with string content
    chars = msg.content.length;
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      // Defensive (LCD/codex turn-abort regression 2026-06-14): a malformed or
      // undefined content block must NEVER throw out of estimation. The LCD
      // context-engine assembler runs this inside transformContext BEFORE the
      // LLM call, so a throw aborts the whole turn and surfaces to the user as a
      // silent "AI didn't produce a response". Flat-penalty anything that isn't
      // an object with a string `type`.
      if (block == null || typeof block !== "object" || typeof (block as { type?: unknown }).type !== "string") {
        chars += UNKNOWN_BLOCK_CHARS;
        continue;
      }
      switch (block.type) {
        case "text":
          chars += ((block as { text?: string }).text ?? "").length;
          break;

        case "image":
          chars += IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
          break;

        case "thinking":
          chars += ((block as { thinking?: string }).thinking ?? "").length;
          break;

        case "toolCall": {
          try {
            const args = (block as { arguments: unknown }).arguments ?? {};
            chars += JSON.stringify(args).length;
          } catch {
            chars += TOOL_STRINGIFY_FALLBACK;
          }
          break;
        }

        default:
          chars += UNKNOWN_BLOCK_CHARS;
          break;
      }
    }
  }

  if (cache) {
    cache.set(msg, chars);
  }

  return chars;
}

// ---------------------------------------------------------------------------
// Context-level estimation
// ---------------------------------------------------------------------------

/**
 * Estimate total character count across an array of messages.
 *
 * Sums `estimateMessageChars` for each message, passing the optional
 * WeakMap cache through so repeated calls on overlapping message arrays
 * benefit from cached per-message estimates.
 *
 * @param messages - Array of pi-ai Messages to estimate
 * @param cache - Optional WeakMap for caching per-message results
 * @returns Total estimated character count across all messages
 */
export function estimateContextChars(
  messages: Message[],
  cache?: WeakMap<Message, number>,
): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageChars(msg, cache);
  }
  return total;
}

/**
 * Estimate context chars with dual ratio for tool results.
 *
 * Text content: 1 char counted as 1 (standard 4:1 chars/token)
 * Tool results: 1 char counted as 2 (2:1 chars/token for structured data)
 *
 * This normalizes to a single char scale where tool result chars are
 * weighted 2x to reflect their higher token density. Used ONLY by the
 * observation masker threshold check.
 *
 * Deliberately factor-free: a RELATIVE char-pressure heuristic — a script
 * factor would cancel (TOK-01, design §4).
 */
export function estimateContextCharsWithDualRatio(
  messages: Message[],
  cache?: WeakMap<Message, number>,
): number {
  let total = 0;
  for (const msg of messages) {
    const chars = estimateMessageChars(msg, cache);
    if (msg.role === "toolResult") {
      total += chars * 2;
    } else {
      total += chars;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Content-aware token estimation
// ---------------------------------------------------------------------------

/** Chars-per-token ratio for structured content (JSON, code, tool results). */
const CHARS_PER_TOKEN_STRUCTURED = 3;

/**
 * Memo for the factored per-message estimate (TOK-01), keyed on CONTENT
 * IDENTITY, not object identity alone (review WR-01). Several pipeline
 * layers reassign `msg.content` in place on live Message objects
 * (observation-masker placeholder swap, microcompaction-guard
 * empty-toolResult normalization, schema-stripping, tool-result-clearing
 * TTL clears) — an object-keyed memo returns stale counts after those
 * swaps, and a stale-LOW count after a content-GROWING reassignment is
 * exactly the anti-conservative under-count class TOK-01 closes. Each
 * entry therefore records the content value/reference it was computed from
 * and is recomputed whenever `msg.content` no longer matches (one compare
 * on the hit path; every in-repo mutation site reassigns a fresh array or
 * string, which always breaks the match). Mutating the EXISTING content
 * array or its blocks in place would still bypass this memo — reassign
 * `msg.content` instead (the pattern all current mutation sites use).
 * Fresh objects (e.g. partsToMessage output) simply miss and are GC'd.
 * The script factor adds an O(n) codepoint scan per text — the memo
 * prevents re-scans when triggers/assemblers re-estimate the same
 * unchanged Message.
 */
interface FactoredTokensMemoEntry {
  /** The `msg.content` value the tokens were computed from. */
  readonly contentRef: Message["content"];
  readonly tokens: number;
}
const factoredTokensMemo = new WeakMap<Message, FactoredTokensMemoEntry>();

/**
 * Estimate token count for a single message with content-aware ratios.
 *
 * Uses different chars-per-token ratios based on content type:
 * - Text content (user messages, assistant text): 4:1 (standard)
 * - Tool call arguments (JSON): 3:1 (structured data)
 * - Tool results: 3:1 (typically code, JSON, structured output)
 * - Thinking blocks: 4:1 (natural language reasoning)
 * - Images: fixed estimate (IMAGE_TOKEN_ESTIMATE)
 *
 * Each ratio is additionally multiplied by `scriptTokenFactor(text)` over
 * the EXACT string whose `.length` is divided (TOK-01, one rule every
 * site): dense non-Latin scripts (Hebrew/Arabic/CJK/...) tokenize at far
 * fewer chars/token than the flat ratios assume, so the divisor shrinks and
 * the estimate grows. Pure-ASCII text has factor 1.0 — byte-identical to
 * the unfactored math (I1).
 */
export function estimateMessageTokens(msg: Message): number {
  const cached = factoredTokensMemo.get(msg);
  if (cached !== undefined && cached.contentRef === msg.content) return cached.tokens;
  const tokens = computeMessageTokens(msg);
  factoredTokensMemo.set(msg, { contentRef: msg.content, tokens });
  return tokens;
}

function computeMessageTokens(msg: Message): number {
  if (typeof msg.content === "string") {
    const ratio = msg.role === "toolResult" ? CHARS_PER_TOKEN_STRUCTURED : CHARS_PER_TOKEN;
    return Math.ceil(msg.content.length / (ratio * scriptTokenFactor(msg.content)));
  }

  if (!Array.isArray(msg.content)) return 0;

  let tokens = 0;
  const isStructured = msg.role === "toolResult";

  for (const block of msg.content) {
    // Defensive (LCD/codex turn-abort regression 2026-06-14): a malformed or
    // undefined content block must NEVER throw out of estimation. The LCD
    // context-engine assembler runs this inside transformContext BEFORE the LLM
    // call, so a throw aborts the whole turn and surfaces to the user as a
    // silent "AI didn't produce a response". Flat-penalty anything that isn't an
    // object with a string `type`.
    if (block == null || typeof block !== "object" || typeof (block as { type?: unknown }).type !== "string") {
      // flat-by-design: a malformed/undefined block carries no source text to language-factor — UNKNOWN_BLOCK_CHARS is a fixed structural penalty, not derived from any string (TOK-01).
      tokens += Math.ceil(UNKNOWN_BLOCK_CHARS / CHARS_PER_TOKEN);
      continue;
    }
    switch (block.type) {
      case "text": {
        const text = (block as { text?: string }).text ?? "";
        tokens += Math.ceil(
          text.length /
            ((isStructured ? CHARS_PER_TOKEN_STRUCTURED : CHARS_PER_TOKEN) * scriptTokenFactor(text)),
        );
        break;
      }

      case "image":
        tokens += IMAGE_TOKEN_ESTIMATE;
        break;

      case "thinking": {
        const thinking = (block as { thinking?: string }).thinking ?? "";
        tokens += Math.ceil(thinking.length / (CHARS_PER_TOKEN * scriptTokenFactor(thinking)));
        break;
      }

      case "toolCall": {
        try {
          const args = (block as { arguments: unknown }).arguments ?? {};
          const json = JSON.stringify(args);
          tokens += Math.ceil(json.length / (CHARS_PER_TOKEN_STRUCTURED * scriptTokenFactor(json)));
        } catch {
          // flat-by-design: constant penalty, no source text in scope (TOK-01)
          tokens += Math.ceil(TOOL_STRINGIFY_FALLBACK / CHARS_PER_TOKEN_STRUCTURED);
        }
        break;
      }

      default:
        // flat-by-design: constant penalty, no source text in scope (TOK-01)
        tokens += Math.ceil(UNKNOWN_BLOCK_CHARS / CHARS_PER_TOKEN);
        break;
    }
  }

  return tokens;
}

/**
 * Estimate total token count across an array of messages with content-aware ratios.
 */
export function estimateContextTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Anchor-based token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate token count using an API-grounded anchor with char-based delta.
 *
 * When a valid anchor is available, uses anchor.inputTokens as the base and
 * estimates only the delta for messages added since the anchor was recorded.
 * Falls back to charBasedTokens when anchor is null or stale.
 *
 * @param anchor - TokenAnchor from the last API response, or null
 * @param messages - Current message array
 * @param charBasedTokens - Fallback estimate from char-based heuristics
 * @returns Estimated token count (anchor + delta, or charBasedTokens fallback)
 */
export function estimateWithAnchor(
  anchor: { inputTokens: number; messageCount: number; timestamp: number } | null,
  messages: Message[],
  charBasedTokens: number,
): number {
  if (!anchor) return charBasedTokens;

  const newMessageCount = messages.length - anchor.messageCount;

  if (newMessageCount < 0) {
    // Messages were removed (compaction or trim) -- anchor is stale
    return charBasedTokens;
  }

  if (newMessageCount === 0) {
    // No new messages since anchor -- anchor IS the exact estimate
    return anchor.inputTokens;
  }

  // Estimate only the delta for new messages using content-aware ratios
  const newMessages = messages.slice(messages.length - newMessageCount);
  let deltaTokens = 0;
  for (const msg of newMessages) {
    deltaTokens += estimateMessageTokens(msg);
  }

  return anchor.inputTokens + deltaTokens;
}
