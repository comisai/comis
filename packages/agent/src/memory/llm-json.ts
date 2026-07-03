// SPDX-License-Identifier: Apache-2.0
/**
 * Shared lenient JSON recovery for the memory pipeline's LLM-output parsers
 * (extraction, consolidation, dialectic, reasoning, relationship,
 * usefulness-judge, user-representation).
 *
 * Live finding 2026-06-11: despite every prompt ending with
 * "Return ONLY valid JSON … no commentary", claude-sonnet-4-6 at
 * temperature 0 regularly narrates BEFORE the payload ("The memories
 * conflict on this date. … \n\n{ … }"). A whole-string `JSON.parse` then
 * fails and the TOTAL parsers degrade a VALID payload to their abstain/skip
 * default — observed live on BOTH the dialectic seam (valid grounded answer
 * degraded to abstain) and the review extraction ("Structured extraction
 * returned invalid output, skipping" on a fact-rich conversation).
 *
 * `parseLenientJson` recovers: whole-string parse first (fast path), then
 * the first balanced `{…}` block that parses (string-aware, skips non-JSON
 * brace groups in the narration). Returns undefined when nothing parses —
 * callers keep their non-fatal degrade.
 *
 * @module
 */

/** Strip markdown code fences from raw LLM text. */
export function stripFences(text: string): string {
  return text
    .replace(/```json?\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * Parse raw LLM text as JSON, tolerating commentary around the payload.
 * Recovers BOTH `{ … }` and `[ … ]` payloads (the relationship and
 * user-representation parsers expect top-level arrays). Returns the parsed
 * value, or undefined when no candidate parses. TOTAL — never throws.
 */
export function parseLenientJson(raw: string): unknown {
  const text = stripFences(raw);
  try {
    return JSON.parse(text);
  } catch {
    return extractFirstParseableJsonBlock(text);
  }
}

/**
 * Find the first balanced `{ … }` or `[ … ]` block (scanning each opener in
 * text order) that parses as JSON, and return the PARSED value. String-aware
 * (brackets inside JSON strings don't count) so a commentary prefix/suffix
 * never defeats the parse, and a non-JSON brace group in the narration
 * (e.g. "{weird}") is skipped rather than fatal. Returns undefined when no
 * candidate parses.
 */
export function extractFirstParseableJsonBlock(text: string): unknown {
  let searchFrom = 0;
  for (;;) {
    const objStart = text.indexOf("{", searchFrom);
    const arrStart = text.indexOf("[", searchFrom);
    const start =
      objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
    if (start === -1) return undefined;
    const candidate = balancedBlockAt(text, start, text[start] === "{" ? "{" : "[");
    if (candidate !== undefined) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Not JSON — keep scanning from the next character.
      }
    }
    searchFrom = start + 1;
  }
}

/** Back-compat alias for the object-only name used by the dialectic parser. */
export const extractFirstParseableJsonObject = extractFirstParseableJsonBlock;

/** The balanced block slice starting at `start`, or undefined if unbalanced. */
function balancedBlockAt(text: string, start: number, open: "{" | "["): string | undefined {
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
