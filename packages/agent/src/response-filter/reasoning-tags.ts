// SPDX-License-Identifier: Apache-2.0
/**
 * Non-streaming reasoning tag stripper with code-region protection.
 *
 * Strips `<think>`, `<thinking>`, `<thought>`, `<antThinking>` blocks
 * (tags AND content). Strips `<final>` tags but preserves their inner
 * content (unwrap). Tags inside code blocks (fenced or inline) are
 * never touched.
 *
 * @module
 */

import { findCodeRegions, isInsideCode } from "./code-regions.js";

export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

/**
 * Strip reasoning tags from complete (non-streaming) text.
 *
 * - <think>/<thinking>/<thought>/<antthinking>: strip tags AND content
 * - <final>: strip tags only, preserve inner content (unwrap)
 * - Tags inside code blocks (fenced or inline) are never touched
 *
 * Modes:
 * - "strict": drops content after unclosed opening tag
 * - "preserve": keeps trailing content even with unclosed tags
 *
 * Unbalanced-tag robustness: an ORPHAN
 * closing tag — a `</think>` with no matching opener in the visible text,
 * outside code regions — strips everything up to and including itself. On the
 * Ollama reasoning path the opener can be consumed as a separate reasoning
 * chunk while the closer plus the pre-close draft land in the content body;
 * the pre-closer text is by construction trailing reasoning.
 */
export function stripReasoningTagsFromText(
  text: string,
  options?: { mode?: ReasoningTagMode; trim?: ReasoningTagTrim },
): string {
  if (!text) return text;
  if (!QUICK_TAG_RE.test(text)) return text;

  const mode = options?.mode ?? "preserve";
  const trimMode = options?.trim ?? "both";

  let cleaned = text;

  // 1. Strip <final> tags (preserve content) -- code-region-aware
  if (FINAL_TAG_RE.test(cleaned)) {
    FINAL_TAG_RE.lastIndex = 0;
    const codeRegions = findCodeRegions(cleaned);
    const matches: Array<{ start: number; length: number; inCode: boolean }> = [];
    for (const match of cleaned.matchAll(FINAL_TAG_RE)) {
      const start = match.index ?? 0;
      matches.push({ start, length: match[0].length, inCode: isInsideCode(start, codeRegions) });
    }
    // Remove in reverse to preserve indices
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]!;
      if (!m.inCode) {
        cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
      }
    }
  }
  FINAL_TAG_RE.lastIndex = 0;

  // 2. Strip <think>/<thinking>/<thought>/<antthinking> blocks -- code-region-aware
  const codeRegions = findCodeRegions(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";
    if (isInsideCode(idx, codeRegions)) continue;

    if (!inThinking) {
      if (isClose) {
        // ORPHAN closer (no matching opener in the visible text): on the
        // Ollama reasoning path the opening <think> can be consumed as a
        // separate reasoning chunk while the closing tag plus the pre-close
        // draft land in the content body — everything before the orphan
        // closer is, by construction, trailing reasoning. Drop it along
        // with the tag.
        result = "";
      } else {
        result += cleaned.slice(lastIndex, idx);
        inThinking = true;
      }
    } else if (isClose) {
      inThinking = false;
    }
    lastIndex = idx + match[0].length;
  }

  if (!inThinking || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  return applyTrim(result, trimMode);
}

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") return value;
  if (mode === "start") return value.trimStart();
  return value.trim();
}
