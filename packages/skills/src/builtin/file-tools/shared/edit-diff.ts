/**
 * @module edit-diff
 * Pure-logic editing algorithms: fuzzy matching (3-step cascade), batch edit
 * application with overlap detection, unified diff generation, curly quote
 * preservation, trailing newline cleanup, desanitization, and config validation.
 *
 * This module has NO I/O, NO state, NO side effects. All functions are pure
 * and testable without filesystem setup. The edit tool factory (edit-tool.ts)
 * consumes these functions and handles I/O + state.
 */

import YAML from "yaml";
import { normalizeToLF } from "./file-encoding.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatchResult {
  index: number;
  matchLength: number;
  strategy: "exact" | "desanitized" | "fuzzy";
  contentForReplacement: string;
}

export interface EditOperation {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface ApplyResult {
  baseContent: string;
  newContent: string;
  matchStrategy: "exact" | "desanitized" | "fuzzy";
}

// ---------------------------------------------------------------------------
// Desanitization map -- LLM-sanitized patterns that Claude introduces
// when copying XML-like content. More patterns can be added as discovered.
// ---------------------------------------------------------------------------

const DESANITIZE_MAP: Array<[RegExp, string]> = [
  [/<fnr>/g, "<function_results>"],
  [/<\/fnr>/g, "</function_results>"],
  [/<ant:/g, "<"],
];

// ---------------------------------------------------------------------------
// Config extensions recognized for validation
// ---------------------------------------------------------------------------

const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".jsonc"]);

// ---------------------------------------------------------------------------
// normalizeForFuzzyMatch
// ---------------------------------------------------------------------------

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - NFKC normalization (decomposes ligatures, normalizes forms)
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      // Strip trailing whitespace per line
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes -> '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes -> "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens -> -
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Special spaces -> regular space
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

// ---------------------------------------------------------------------------
// desanitize
// ---------------------------------------------------------------------------

/**
 * Apply desanitization patterns to recover LLM-sanitized tokens.
 * Claude sometimes sanitizes XML-like tokens when copying content.
 * Returns input unchanged if no patterns match.
 */
export function desanitize(text: string): string {
  let result = text;
  for (const [pattern, replacement] of DESANITIZE_MAP) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// findMatch -- 3-step cascade: exact -> desanitized -> fuzzy
// ---------------------------------------------------------------------------

/**
 * Find oldText in content using a 3-step cascade:
 * 1. Exact match (indexOf)
 * 2. Desanitized match (apply desanitize to oldText, then indexOf)
 * 3. Fuzzy match (normalize both, then indexOf)
 *
 * Returns null if text not found in any strategy.
 */
export function findMatch(
  content: string,
  oldText: string,
): MatchResult | null {
  // Step 1: Exact match
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      index: exactIndex,
      matchLength: oldText.length,
      strategy: "exact",
      contentForReplacement: content,
    };
  }

  // Step 2: Desanitized match
  const desanitized = desanitize(oldText);
  if (desanitized !== oldText) {
    const desanitizedIndex = content.indexOf(desanitized);
    if (desanitizedIndex !== -1) {
      return {
        index: desanitizedIndex,
        matchLength: desanitized.length,
        strategy: "desanitized",
        contentForReplacement: content,
      };
    }
  }

  // Step 3: Fuzzy match -- work entirely in normalized space
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex !== -1) {
    return {
      index: fuzzyIndex,
      matchLength: fuzzyOldText.length,
      strategy: "fuzzy",
      contentForReplacement: fuzzyContent,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// findAllMatches -- non-overlapping positions for replaceAll
// ---------------------------------------------------------------------------

/**
 * Find all non-overlapping occurrences of `oldText` in `content`.
 * Returns array of { index, length } sorted by ascending index.
 * Used by replaceAll mode to replace every occurrence in a single pass.
 */
export function findAllMatches(
  content: string,
  oldText: string,
): Array<{ index: number; length: number }> {
  const matches: Array<{ index: number; length: number }> = [];
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const idx = content.indexOf(oldText, searchFrom);
    if (idx === -1) break;
    matches.push({ index: idx, length: oldText.length });
    searchFrom = idx + oldText.length;
  }
  return matches;
}

// ---------------------------------------------------------------------------
// applyEdits -- batch edit application with overlap detection
// ---------------------------------------------------------------------------

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space.
 *
 * @param content - LF-normalized file content
 * @param edits - Array of oldText/newText pairs
 * @param filePath - File path for error messages
 * @returns Object with baseContent, newContent, and matchStrategy
 * @throws Error for empty oldText, not found, duplicate, overlap, or no-change
 */
export function applyEdits(
  content: string,
  edits: EditOperation[],
  filePath: string,
): ApplyResult {
  // Normalize all edit text to LF
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
    replaceAll: edit.replaceAll ?? false,
  }));

  // Validate no empty oldText
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      if (normalizedEdits.length === 1) {
        throw new Error(`oldText must not be empty in ${filePath}.`);
      }
      throw new Error(
        `edits[${i}].oldText must not be empty in ${filePath}.`,
      );
    }
  }

  // Find initial matches to determine if fuzzy mode is needed
  const initialMatches = normalizedEdits.map((edit) =>
    findMatch(content, edit.oldText),
  );

  const useFuzzy = initialMatches.some(
    (match) => match !== null && match.strategy === "fuzzy",
  );

  const baseContent = useFuzzy
    ? normalizeForFuzzyMatch(content)
    : content;

  // Re-match all edits against baseContent
  interface MatchedEdit {
    editIndex: number;
    matchIndex: number;
    matchLength: number;
    newText: string;
  }

  const matchedEdits: MatchedEdit[] = [];
  let overallStrategy: "exact" | "desanitized" | "fuzzy" = "exact";

  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];

    if (edit.replaceAll) {
      // replaceAll: find ALL match positions, skip uniqueness check
      const positions = findAllMatches(baseContent, edit.oldText);
      if (positions.length === 0) {
        // Try fuzzy match for error message context
        const fuzzyResult = findMatch(baseContent, edit.oldText);
        if (!fuzzyResult) {
          throw new Error(
            `[text_not_found] The old_text in edits[${i}] was not found in ${filePath}. ` +
            `Make sure it matches exactly (including whitespace and indentation).`,
          );
        }
        // Fuzzy found a single match -- use it, but note encoding diff
        matchedEdits.push({
          editIndex: i,
          matchIndex: fuzzyResult.index,
          matchLength: fuzzyResult.matchLength,
          newText: edit.newText,
        });
        if (fuzzyResult.strategy === "fuzzy") {
          overallStrategy = "fuzzy";
        } else if (
          fuzzyResult.strategy === "desanitized" &&
          overallStrategy !== "fuzzy"
        ) {
          overallStrategy = "desanitized";
        }
      } else {
        for (const pos of positions) {
          matchedEdits.push({
            editIndex: i,
            matchIndex: pos.index,
            matchLength: pos.length,
            newText: edit.newText,
          });
        }
      }
    } else {
      // Single-match logic (existing behavior)
      const matchResult = findMatch(baseContent, edit.oldText);

      if (!matchResult) {
        if (normalizedEdits.length === 1) {
          throw new Error(
            `Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`,
          );
        }
        throw new Error(
          `Could not find edits[${i}] in ${filePath}. The oldText must match exactly including all whitespace and newlines.`,
        );
      }

      const occurrences = countOccurrences(baseContent, edit.oldText);
      if (occurrences > 1) {
        if (normalizedEdits.length === 1) {
          throw new Error(
            `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context to make it unique.`,
          );
        }
        throw new Error(
          `Found ${occurrences} occurrences of edits[${i}] in ${filePath}. Each oldText must be unique. Please provide more context to make it unique.`,
        );
      }

      // Track the most permissive strategy used
      if (matchResult.strategy === "fuzzy") {
        overallStrategy = "fuzzy";
      } else if (
        matchResult.strategy === "desanitized" &&
        overallStrategy !== "fuzzy"
      ) {
        overallStrategy = "desanitized";
      }

      matchedEdits.push({
        editIndex: i,
        matchIndex: matchResult.index,
        matchLength: matchResult.matchLength,
        newText: edit.newText,
      });
    }
  }

  // Sort by matchIndex ascending for overlap detection
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);

  // Check overlaps
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  // Apply in reverse offset order (highest index first for stable positions)
  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const edit = matchedEdits[i];
    newContent =
      newContent.substring(0, edit.matchIndex) +
      edit.newText +
      newContent.substring(edit.matchIndex + edit.matchLength);
  }

  if (baseContent === newContent) {
    if (normalizedEdits.length === 1) {
      throw new Error(
        `No changes made to ${filePath}. The replacement produced identical content.`,
      );
    }
    throw new Error(
      `No changes made to ${filePath}. The replacements produced identical content.`,
    );
  }

  return { baseContent, newContent, matchStrategy: overallStrategy };
}

// ---------------------------------------------------------------------------
// generateDiffString -- line-based diff without npm 'diff' package
// ---------------------------------------------------------------------------

/**
 * Compute the longest common subsequence of two string arrays (lines).
 * Returns a table where lcs[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
 */
function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }
  return lcs;
}

interface DiffEntry {
  type: "context" | "add" | "remove";
  line: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/**
 * Produce a list of diff entries using LCS backtracking.
 */
function computeDiffEntries(
  oldLines: string[],
  newLines: string[],
): DiffEntry[] {
  const lcs = computeLCS(oldLines, newLines);
  const entries: DiffEntry[] = [];

  let i = oldLines.length;
  let j = newLines.length;

  // Backtrack through LCS table to produce diff
  const stack: DiffEntry[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({
        type: "context",
        line: oldLines[i - 1],
        oldLineNum: i,
        newLineNum: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      stack.push({
        type: "add",
        line: newLines[j - 1],
        newLineNum: j,
      });
      j--;
    } else {
      stack.push({
        type: "remove",
        line: oldLines[i - 1],
        oldLineNum: i,
      });
      i--;
    }
  }

  // Reverse since we built it backwards
  for (let k = stack.length - 1; k >= 0; k--) {
    entries.push(stack[k]);
  }

  return entries;
}

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 *
 * Does NOT use the npm 'diff' package -- implements LCS-based line diff inline.
 *
 * @param oldContent - Original content
 * @param newContent - Modified content
 * @param contextLines - Number of context lines around changes (default 4)
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  if (oldContent === newContent) {
    return { diff: "", firstChangedLine: undefined };
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const entries = computeDiffEntries(oldLines, newLines);

  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  // Find which entries are changes (non-context)
  const changeIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type !== "context") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    return { diff: "", firstChangedLine: undefined };
  }

  // Build change regions (contiguous groups of changes with context)
  interface Region {
    start: number;
    end: number;
  }
  const regions: Region[] = [];

  let regionStart = Math.max(0, changeIndices[0] - contextLines);
  let regionEnd = Math.min(
    entries.length - 1,
    changeIndices[0] + contextLines,
  );

  for (let c = 1; c < changeIndices.length; c++) {
    const nextStart = Math.max(0, changeIndices[c] - contextLines);
    const nextEnd = Math.min(
      entries.length - 1,
      changeIndices[c] + contextLines,
    );

    if (nextStart <= regionEnd + 1) {
      // Merge regions
      regionEnd = nextEnd;
    } else {
      regions.push({ start: regionStart, end: regionEnd });
      regionStart = nextStart;
      regionEnd = nextEnd;
    }
  }
  regions.push({ start: regionStart, end: regionEnd });

  // Render regions with ellipsis between
  const output: string[] = [];
  let firstChangedLine: number | undefined;

  for (let r = 0; r < regions.length; r++) {
    if (r > 0) {
      output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
    }

    for (let i = regions[r].start; i <= regions[r].end; i++) {
      const entry = entries[i];

      if (entry.type === "context") {
        const lineNum = String(entry.oldLineNum!).padStart(lineNumWidth, " ");
        output.push(` ${lineNum} ${entry.line}`);
      } else if (entry.type === "add") {
        if (firstChangedLine === undefined) {
          firstChangedLine = entry.newLineNum;
        }
        const lineNum = String(entry.newLineNum!).padStart(lineNumWidth, " ");
        output.push(`+${lineNum} ${entry.line}`);
      } else {
        if (firstChangedLine === undefined) {
          firstChangedLine = entry.oldLineNum;
        }
        const lineNum = String(entry.oldLineNum!).padStart(lineNumWidth, " ");
        output.push(`-${lineNum} ${entry.line}`);
      }
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

// ---------------------------------------------------------------------------
// detectQuoteStyle + applyCurlyQuotes
// ---------------------------------------------------------------------------

/**
 * Detect whether content uses curly or straight double quotes.
 */
export function detectQuoteStyle(content: string): "curly" | "straight" {
  if (/[\u201C\u201D]/.test(content)) {
    return "curly";
  }
  return "straight";
}

/**
 * Convert ASCII double quotes to curly pairs when style is "curly".
 * Simple left/right alternation: first " becomes open, second becomes close, etc.
 */
export function applyCurlyQuotes(
  newText: string,
  style: "curly" | "straight",
): string {
  if (style === "straight") return newText;

  let isOpen = true;
  return newText.replace(/"/g, () => {
    const quote = isOpen ? "\u201C" : "\u201D";
    isOpen = !isOpen;
    return quote;
  });
}

// ---------------------------------------------------------------------------
// cleanupTrailingNewlines
// ---------------------------------------------------------------------------

/**
 * Replace runs of 3+ consecutive newlines with exactly 2 newlines (one blank line).
 * Applied after edits when content deletion may leave extra blank lines.
 */
export function cleanupTrailingNewlines(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// validateConfigContent
// ---------------------------------------------------------------------------

/**
 * Strip single-line (//) and multi-line comments from JSONC content.
 */
function stripJsoncComments(content: string): string {
  // Remove single-line comments (// ...) not inside strings
  // Remove multi-line comments (/* ... */) not inside strings
  // Simple approach: process character by character
  let result = "";
  let inString = false;
  let stringChar = "";
  let i = 0;

  while (i < content.length) {
    if (inString) {
      if (content[i] === "\\" && i + 1 < content.length) {
        result += content[i] + content[i + 1];
        i += 2;
        continue;
      }
      if (content[i] === stringChar) {
        inString = false;
      }
      result += content[i];
      i++;
    } else {
      if (content[i] === '"' || content[i] === "'") {
        inString = true;
        stringChar = content[i];
        result += content[i];
        i++;
      } else if (
        content[i] === "/" &&
        i + 1 < content.length &&
        content[i + 1] === "/"
      ) {
        // Single-line comment -- skip to end of line
        i += 2;
        while (i < content.length && content[i] !== "\n") {
          i++;
        }
      } else if (
        content[i] === "/" &&
        i + 1 < content.length &&
        content[i + 1] === "*"
      ) {
        // Multi-line comment -- skip to */
        i += 2;
        while (
          i < content.length - 1 &&
          !(content[i] === "*" && content[i + 1] === "/")
        ) {
          i++;
        }
        if (i < content.length - 1) {
          i += 2; // skip */
        }
      } else {
        result += content[i];
        i++;
      }
    }
  }

  return result;
}

/**
 * Validate config file content after simulated edit.
 * Returns null on success, error string on failure.
 *
 * @param extension - File extension including dot (e.g., ".json", ".yaml")
 * @param content - The post-edit content to validate
 */
export function validateConfigContent(
  extension: string,
  content: string,
): string | null {
  if (!CONFIG_EXTENSIONS.has(extension)) {
    return null;
  }

  if (extension === ".toml") {
    // No TOML parser available -- skip validation
    return null;
  }

  if (extension === ".json") {
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Edit would produce invalid JSON: ${msg}`;
    }
  }

  if (extension === ".jsonc") {
    try {
      const stripped = stripJsoncComments(content);
      JSON.parse(stripped);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Edit would produce invalid JSONC: ${msg}`;
    }
  }

  if (extension === ".yaml" || extension === ".yml") {
    try {
      YAML.parse(content);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Edit would produce invalid YAML: ${msg}`;
    }
  }

  return null;
}
