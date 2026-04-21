// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram file reference guard -- wraps file references with TLD-colliding
 * extensions in `<code>` tags to prevent Telegram from generating broken link
 * preview cards.
 *
 * When an agent mentions files like `config.go`, `utils.py`, or `README.md`,
 * Telegram's URL detector treats them as domain names and generates broken
 * link preview cards. This guard wraps such references in `<code>` tags at
 * the IR rendering level, preventing the false detection.
 *
 * Operates on already-HTML-escaped text (called after `escapeHtml()` in
 * `renderTelegramSpan` for text spans only).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Extension registries
// ---------------------------------------------------------------------------

/**
 * Curated set of file extensions that always trigger the guard.
 * These are programming/config file extensions that collide with country-code
 * TLDs or are otherwise treated as URLs by Telegram's link detector.
 *
 * Always-guard set.
 */
export const ALWAYS_GUARD_EXTENSIONS: ReadonlySet<string> = new Set([
  // Primary TLD-collision extensions
  "md", "go", "py", "pl", "sh", "am", "at", "be", "cc", "rs",
  "re", "do", "st", "im", "la", "me", "nu", "to",
  // Common programming extensions that collide with TLDs
  "ts", "js", "rb", "cs", "vb", "hs", "ml", "li", "lv", "lt",
  "hr", "si", "ba", "mk", "al", "so",
]);

/**
 * Ambiguous extensions that need context-based heuristics.
 * These are both legitimate file extensions and very common TLDs.
 * Only guarded when preceded by path separators or import keywords.
 */
export const AMBIGUOUS_EXTENSIONS: ReadonlySet<string> = new Set([
  "io", "ai",
]);

// ---------------------------------------------------------------------------
// Module-level config state
// ---------------------------------------------------------------------------

interface GuardConfig {
  enabled: boolean;
  additionalExtensions: string[];
  excludedExtensions: string[];
}

/** Private mutable config, initialized with defaults. */
let guardConfig: GuardConfig = {
  enabled: true,
  additionalExtensions: [],
  excludedExtensions: [],
};

/**
 * Initialize the Telegram file-ref guard config.
 * Called once during daemon bootstrap from `setup-channels.ts`.
 *
 * @param config - Guard config from `container.config.telegramFileRefGuard`
 */
export function initTelegramFileGuardConfig(config: {
  enabled: boolean;
  additionalExtensions: string[];
  excludedExtensions: string[];
}): void {
  guardConfig = { ...config };
}

/**
 * Returns whether the Telegram file-ref guard is enabled.
 * Used by `ir-renderer.ts` to decide whether to call the guard.
 */
export function isTelegramFileGuardEnabled(): boolean {
  return guardConfig.enabled;
}

// ---------------------------------------------------------------------------
// URL detection regex
// ---------------------------------------------------------------------------

/**
 * Regex to find URL spans in text. Matches `https://...` or `http://...`
 * sequences up to the next whitespace or end of string.
 * Used to build an index of URL regions so the file-ref guard can skip them.
 */
const URL_RE = /https?:\/\/\S+/g;

// ---------------------------------------------------------------------------
// File reference regex
// ---------------------------------------------------------------------------

/**
 * Regex for matching file references in HTML-escaped text.
 *
 * Groups:
 *   1. Optional path prefix: `src/utils/` (one or more path segments)
 *   2. Filename: `helper`, `README`, `config`
 *   3. Extension: `ts`, `go`, `md`
 *
 * - Word boundary or whitespace/punctuation at end prevents partial matches
 * - The `\w` in path/filename allows alphanumerics and underscore
 * - Dots and hyphens in filename: `Makefile.am`, `my-config.ts`
 *
 * URL exclusion is handled separately by checking match offset against
 * pre-computed URL regions (see `guardTelegramFileRefs`).
 */
const FILE_REF_RE =
  /((?:[\w.@-]+\/)+)?([\w][\w.-]*?)\.(\w{2,4})(?=[\s,;:)\]!?}"'<>]|&(?:amp|lt|gt);|$)/g;

// ---------------------------------------------------------------------------
// URL region detection
// ---------------------------------------------------------------------------

interface Region { start: number; end: number }

/**
 * Find all URL regions in the text.
 * Returns an array of { start, end } ranges.
 */
function findUrlRegions(text: string): Region[] {
  const regions: Region[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    regions.push({ start: m.index, end: m.index + m[0].length });
  }
  return regions;
}

/**
 * Check if an offset falls inside any URL region.
 */
function isInsideUrl(offset: number, regions: Region[]): boolean {
  for (const r of regions) {
    if (offset >= r.start && offset < r.end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Import keyword detection for ambiguous extensions
// ---------------------------------------------------------------------------

/**
 * Check if text preceding a match contains import-like keywords.
 * Looks for `import `, `from `, `require(` patterns.
 */
function hasImportContext(text: string, matchIndex: number): boolean {
  // Look at up to 30 chars before the match for keyword context
  const lookback = text.slice(Math.max(0, matchIndex - 30), matchIndex);
  return /(?:import\s+|from\s+|require\s*\(\s*['"]?)$/.test(lookback);
}

// ---------------------------------------------------------------------------
// Core guard function
// ---------------------------------------------------------------------------

/**
 * Guard file references in HTML-escaped text for Telegram rendering.
 *
 * Wraps file references with TLD-colliding extensions in `<code>` tags to
 * prevent Telegram from generating broken link preview cards.
 *
 * Operates on already-HTML-escaped text (after `escapeHtml()` in
 * `renderTelegramSpan`). Since this runs on individual text spans (not full
 * HTML), there are no existing `<code>` tags to worry about.
 *
 * @param htmlText - HTML-escaped text from a text span
 * @returns Text with file references wrapped in `<code>` tags
 */
export function guardTelegramFileRefs(htmlText: string): string {
  // Build effective extension sets from config
  const additional = new Set(
    guardConfig.additionalExtensions.map((e) => e.replace(/^\./, "").toLowerCase()),
  );
  const excluded = new Set(
    guardConfig.excludedExtensions.map((e) => e.replace(/^\./, "").toLowerCase()),
  );

  // Pre-compute URL regions so we can skip matches inside URLs
  const urlRegions = findUrlRegions(htmlText);

  // Reset regex state (global flag)
  FILE_REF_RE.lastIndex = 0;

  return htmlText.replace(FILE_REF_RE, (match, pathPrefix: string | undefined, _filename: string, ext: string, offset: number) => {
    // Skip matches inside URL regions
    if (isInsideUrl(offset, urlRegions)) return match;

    const normalizedExt = ext.toLowerCase();

    // Skip excluded extensions
    if (excluded.has(normalizedExt)) return match;

    // Always-guard set or additional extensions
    if (ALWAYS_GUARD_EXTENSIONS.has(normalizedExt) || additional.has(normalizedExt)) {
      return `<code>${match}</code>`;
    }

    // Ambiguous extensions: guard only with path prefix or import context
    if (AMBIGUOUS_EXTENSIONS.has(normalizedExt)) {
      if (pathPrefix || hasImportContext(htmlText, offset)) {
        return `<code>${match}</code>`;
      }
    }

    return match;
  });
}
