// SPDX-License-Identifier: Apache-2.0
/**
 * Response sanitization pipeline entry point.
 *
 * Chains 4 sanitizer layers in order:
 *   1. stripMinimaxToolCallXml -- remove <invoke> XML (Minimax)
 *   2. stripModelSpecialTokens -- remove <|...|> tokens (GLM, DeepSeek)
 *   3. stripDowngradedToolCallText -- remove [Tool Call: ...] (Gemini replay)
 *   4. stripReasoningTagsFromText -- remove <think>/<thinking> blocks
 *
 * Followed by whitespace normalization (collapse 3+ newlines) and trim.
 *
 * Error handling: on any sanitizer failure, returns `text.trim()` as fallback
 * and logs WARN via the module-level logger (set via `setSanitizeLogger()`).
 *
 * @module
 */

import { stripReasoningTagsFromText } from "../../response-filter/reasoning-tags.js";
import { findCodeRegions, isInsideCode } from "../../response-filter/code-regions.js";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Inlined strip functions (previously in separate files)
// ---------------------------------------------------------------------------

/**
 * Strip Minimax's malformed tool call XML from LLM responses.
 *
 * Minimax models sometimes emit `<invoke name="..." type="minimax:tool_call">...</invoke>`
 * blocks and `<minimax:tool_call>` wrapper tags in their text output.
 */
function stripMinimaxToolCallXml(text: string): string {
  if (!text) return text;
  if (!/minimax:tool_call/i.test(text)) return text;
  let cleaned = text.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "");
  cleaned = cleaned.replace(/<\/?minimax:tool_call>/gi, "");
  return cleaned;
}

// Match both ASCII pipe <|...|> and full-width pipe <\uFF5C...\uFF5C> variants.
// CRITICAL: The `/g` regex is module-level. The function calls `.replace()` directly
// (not `.test()` first on the same regex) to avoid lastIndex state pollution.
// `.replace()` resets lastIndex internally.
const MODEL_SPECIAL_TOKEN_RE = /<[|\uFF5C][^|\uFF5C]*[|\uFF5C]>/g;

/**
 * Strip model control tokens (`<|...|>` and fullwidth variants) from LLM responses.
 *
 * GLM, DeepSeek, and similar models sometimes leak internal control tokens
 * like `<|endoftext|>`, `<|user|>`, `<|assistant|>` into their text output.
 */
function stripModelSpecialTokens(text: string): string {
  if (!text) return text;
  return text.replace(MODEL_SPECIAL_TOKEN_RE, " ").replace(/  +/g, " ").trim();
}

/**
 * Strip [Tool Call: name (ID: id)] markers and their Arguments JSON blocks.
 */
function stripToolCallMarkers(text: string): string {
  return text.replace(
    /\[Tool Call:\s*\S+\s*\(ID:\s*[^)]*\)\]\n?(?:Arguments:\s*```json\n[\s\S]*?```\n?)?/gi,
    "",
  );
}

/**
 * Strip downgraded tool call/result text blocks from LLM responses.
 *
 * When Gemini (or other providers) cannot emit structured tool calls,
 * they fall back to text-based `[Tool Call: name (ID: ...)]` markers,
 * Arguments JSON blocks, `[Tool Result for ID ...]` blocks, and
 * `[Historical context: ...]` markers.
 */
function stripDowngradedToolCallText(text: string): string {
  if (!text) return text;
  if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) {
    return text;
  }
  // Strip [Tool Call: name (ID: ...)] blocks and their Arguments JSON
  let cleaned = stripToolCallMarkers(text);
  // Strip [Tool Result for ID ...] blocks.
  // Uses blank-line delimiter (\n\n) or next [Tool marker as boundary to avoid
  // eating legitimate content after a garbled tool result.
  cleaned = cleaned.replace(
    /\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n\n|\n*\[Tool |\n*$)/gi,
    "",
  );
  // Strip [Historical context: ...] markers
  cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");
  return cleaned.trim();
}

// ---------------------------------------------------------------------------
// Pipeline exports
// ---------------------------------------------------------------------------

// Module-level logger, set once during bootstrap via setSanitizeLogger().
// This follows the Deps injection pattern without requiring a logger parameter
// on every sanitizeAssistantResponse() call (which would change every call site).
let logger: ComisLogger | undefined;

/** Set the module-level logger. Called once during daemon bootstrap. */
export function setSanitizeLogger(l: ComisLogger): void {
  logger = l;
}

/**
 * Options for the sanitization pipeline.
 */
export interface SanitizeOptions {
  /** When true, only return text inside `<final>` blocks; suppress everything else.
   *  This covers the non-streaming fallback path -- the streaming path handles
   *  enforceFinalTag via ThinkingTagFilter FSM options.
   *  Default: false. */
  enforceFinalTag?: boolean;
}

/**
 * Full response sanitization pipeline.
 *
 * Applied to raw LLM text output before it reaches channels/users.
 * Each layer targets a specific class of provider bug.
 */
export function sanitizeAssistantResponse(
  text: string,
  options?: SanitizeOptions,
): string {
  if (!text) return text;

  try {
    let cleaned = text;
    cleaned = stripMinimaxToolCallXml(cleaned);
    cleaned = stripModelSpecialTokens(cleaned);
    cleaned = stripDowngradedToolCallText(cleaned);

    if (options?.enforceFinalTag) {
      // "strict" mode: extract only content inside <final> blocks, drop everything else.
      // This is the non-streaming equivalent of the ThinkingTagFilter "suppressed" initial state.
      cleaned = extractFinalTagContent(cleaned);
    } else {
      // "preserve" mode keeps trailing content after unclosed tags -- avoids silently
      // dropping legitimate content.
      cleaned = stripReasoningTagsFromText(cleaned, { mode: "preserve", trim: "both" });
    }

    // Collapse excessive newlines left after block removal
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
    return cleaned.trim();
  } catch (cause) {
    // Sanitization failure must not crash the delivery pipeline.
    // Return trimmed input as best-effort fallback.
    logger?.warn(
      { err: cause, hint: "Sanitization failed -- returning trimmed raw text as fallback", errorKind: "internal" },
      "Response sanitization pipeline error",
    );
    return text.trim();
  }
}

/**
 * Extract only content inside `<final>...</final>` blocks.
 * Strips thinking tags from within extracted content.
 * Returns empty string if no `<final>` tags found.
 *
 * Used by the non-streaming path when enforceFinalTag is enabled.
 * The streaming path uses the ThinkingTagFilter FSM instead.
 *
 * LIMITATION: Nested `<final>` tags are not supported. The pairing algorithm
 * matches opens[i] with closes[i] positionally, which produces incorrect
 * results for `<final>A<final>B</final></final>` (inner content double-counted).
 * This is acceptable -- LLMs do not produce nested `<final>` tags in practice.
 */
export function extractFinalTagContent(text: string): string {
  const regions = findCodeRegions(text);
  const FINAL_OPEN_RE = /<\s*final\b[^<>]*>/gi;
  const FINAL_CLOSE_RE = /<\s*\/\s*final\b[^<>]*>/gi;

  // Collect <final> open/close positions outside code regions
  const opens: number[] = [];
  const closes: number[] = [];
  for (const m of text.matchAll(FINAL_OPEN_RE)) {
    const pos = m.index ?? 0;
    if (!isInsideCode(pos, regions)) opens.push(pos + m[0].length);
  }
  for (const m of text.matchAll(FINAL_CLOSE_RE)) {
    const pos = m.index ?? 0;
    if (!isInsideCode(pos, regions)) closes.push(pos);
  }

  if (opens.length === 0) return "";

  // Pair opens with closes, extract inner content
  const parts: string[] = [];
  for (let i = 0; i < opens.length; i++) {
    const start = opens[i]!;
    const end = closes[i] ?? text.length; // unclosed = to end
    parts.push(text.slice(start, end));
  }

  // Strip thinking tags from extracted content.
  // NOTE: Uses "strict" mode which DROPS content after unclosed thinking tags.
  const joined = parts.join("\n");
  return stripReasoningTagsFromText(joined, { mode: "strict", trim: "both" });
}
