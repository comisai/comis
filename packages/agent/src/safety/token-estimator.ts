/**
 * Shared per-block-type character estimation for context guard pipeline.
 *
 * Provides accurate per-block-type character estimation with WeakMap caching
 * so that multiple consumers do not redundantly re-scan the same messages.
 * Used by the context engine pipeline for token estimation.
 *
 * @module
 */

import type { Message } from "@mariozechner/pi-ai";

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
      switch (block.type) {
        case "text":
          chars += (block as { text: string }).text.length;
          break;

        case "image":
          chars += IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
          break;

        case "thinking":
          chars += (block as { thinking: string }).thinking.length;
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
 * Estimate token count for a single message with content-aware ratios.
 *
 * Uses different chars-per-token ratios based on content type:
 * - Text content (user messages, assistant text): 4:1 (standard)
 * - Tool call arguments (JSON): 3:1 (structured data)
 * - Tool results: 3:1 (typically code, JSON, structured output)
 * - Thinking blocks: 4:1 (natural language reasoning)
 * - Images: fixed estimate (IMAGE_TOKEN_ESTIMATE)
 *
 * This provides more accurate token estimates than the flat 4:1 ratio,
 * especially for code-heavy and tool-intensive conversations.
 */
export function estimateMessageTokens(msg: Message): number {
  if (typeof msg.content === "string") {
    const ratio = msg.role === "toolResult" ? CHARS_PER_TOKEN_STRUCTURED : CHARS_PER_TOKEN;
    return Math.ceil(msg.content.length / ratio);
  }

  if (!Array.isArray(msg.content)) return 0;

  let tokens = 0;
  const isStructured = msg.role === "toolResult";

  for (const block of msg.content) {
    switch (block.type) {
      case "text": {
        const text = (block as { text: string }).text;
        tokens += Math.ceil(text.length / (isStructured ? CHARS_PER_TOKEN_STRUCTURED : CHARS_PER_TOKEN));
        break;
      }

      case "image":
        tokens += IMAGE_TOKEN_ESTIMATE;
        break;

      case "thinking":
        tokens += Math.ceil((block as { thinking: string }).thinking.length / CHARS_PER_TOKEN);
        break;

      case "toolCall": {
        try {
          const args = (block as { arguments: unknown }).arguments ?? {};
          tokens += Math.ceil(JSON.stringify(args).length / CHARS_PER_TOKEN_STRUCTURED);
        } catch {
          tokens += Math.ceil(TOOL_STRINGIFY_FALLBACK / CHARS_PER_TOKEN_STRUCTURED);
        }
        break;
      }

      default:
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
