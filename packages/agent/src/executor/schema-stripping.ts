// ---------------------------------------------------------------------------
// Schema Stripping
// ---------------------------------------------------------------------------

// Replaces verbose <functions> blocks in discover_tools tool results with
// compact summaries. The full JSON schemas are delivered via the tools
// parameter on subsequent turns (via DiscoveryTracker), so the verbose
// blocks in history are pure token waste (~1,720 tokens per discovery result).

// Called post-execution within the withSession write lock, using the same
// fileEntries mutation + _rewriteFile() pattern as the observation masker
// (observation-masker.ts lines 116-142).
// ---------------------------------------------------------------------------

/**
 * Strip verbose `<functions>` blocks from `discover_tools` tool results
 * in session history.
 *
 * Scans `SessionManager.fileEntries` for `discover_tools` tool results
 * containing `<functions>` blocks and replaces them with compact summaries
 * listing only tool names.
 *
 * Guards:
 * - Already-stripped results (prefixed `[Discovery loaded:`) are skipped
 * - Results without `<functions>` block (no-match) are left unchanged
 * - Non-`discover_tools` entries are skipped entirely
 *
 * @param sm - SessionManager instance (from withSession callback)
 * @param logger - Optional logger for DEBUG-level stripping stats
 */
export function stripDiscoverySchemas(
  sm: unknown,
  logger?: { debug: (obj: Record<string, unknown>, msg: string) => void },
): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sessionManager = sm as any;
  const fileEntries = sessionManager.fileEntries;
  if (!Array.isArray(fileEntries)) return;

  let strippedCount = 0;
  let totalCharsSaved = 0;

  for (const entry of fileEntries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult") continue;
    if (msg.toolName !== "discover_tools") continue;

    const content = msg.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const firstBlock = content[0];
    if (
      !firstBlock ||
      firstBlock.type !== "text" ||
      typeof firstBlock.text !== "string"
    )
      continue;

    const text = firstBlock.text;

    // Skip already-stripped results
    if (text.startsWith("[Discovery loaded:")) continue;
    // Skip results without <functions> block (e.g., "No matching tools found")
    if (!text.includes("<functions>")) continue;

    // Extract tool names and build compact summary
    const names = extractToolNamesFromFunctionsBlock(text);
    if (names.length === 0) continue;

    const originalChars = text.length;
    const summary = buildStrippedSummary(names);

    // Mutate in-place (safe within withSession write lock)
    msg.content = [{ type: "text", text: summary }];
    totalCharsSaved += originalChars - summary.length;
    strippedCount++;
  }

  if (strippedCount > 0) {
    if (typeof sessionManager._rewriteFile === "function") {
      sessionManager._rewriteFile();
    }
    logger?.debug(
      { strippedCount, totalCharsSaved },
      "Discovery schemas stripped from session history",
    );
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported — tested via stripDiscoverySchemas)
// ---------------------------------------------------------------------------

/**
 * Build compact summary text replacing a `<functions>` block.
 *
 * Prefix `[Discovery loaded:` enables detection by other layers
 * (observation masker, dead content evictor) to avoid double-processing.
 */
function buildStrippedSummary(names: string[]): string {
  const listing = names.map((n) => `- ${n}`).join("\n");
  return `[Discovery loaded: ${names.length} tool(s) are now callable]\n${listing}`;
}

/**
 * Extract tool names from a `<functions>` block.
 *
 * Each `<function>` entry contains a JSON object with a `name` field.
 * Malformed JSON or missing `name` fields are silently skipped.
 */
function extractToolNamesFromFunctionsBlock(text: string): string[] {
  const names: string[] = [];
  const pattern = /<function>([\s\S]*?)<\/function>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (typeof parsed.name === "string") names.push(parsed.name);
    } catch {
      /* skip malformed entries */
    }
  }
  return names;
}
