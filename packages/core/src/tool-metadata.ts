/**
 * Tool Metadata Registry
 *
 * Side-channel metadata store for tool definitions. The upstream AgentTool type
 * cannot be extended, so per-tool metadata (result size caps, read-only flags,
 * validators, etc.) is stored in a module-level Map keyed by tool name.
 *
 * Registry supports incremental registration via spread-merge semantics:
 * different sources can register different fields for the same tool.
 */

// ---------------------------------------------------------------------------
// ComisToolMetadata interface
// ---------------------------------------------------------------------------

/** Per-tool metadata stored in the side-channel registry. All fields optional. */
export interface ComisToolMetadata {
  /** Per-tool result size cap in characters. */
  maxResultSizeChars?: number;
  /** Tool does not mutate state -- safe for optimistic execution. */
  isReadOnly?: boolean;
  /** Safe for parallel execution with other concurrency-safe tools. */
  isConcurrencySafe?: boolean;
  /** BM25 keyword hints for deferred tool discovery. */
  searchHint?: string;
  /** JSON Schema describing tool output structure. */
  outputSchema?: Record<string, unknown>;
  /** Tool names that should be co-discovered whenever this tool is discovered (bidirectional). */
  coDiscoverWith?: string[];
  /** Pre-flight input validator. Returns error string on failure, undefined on success. */
  validateInput?: (
    params: Record<string, unknown>,
  ) => string | undefined | Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton Map)
// ---------------------------------------------------------------------------

const registry = new Map<string, ComisToolMetadata>();

/**
 * Register metadata for a tool. Merges with any existing metadata via spread,
 * allowing incremental registration from different phases.
 */
export function registerToolMetadata(
  name: string,
  meta: ComisToolMetadata,
): void {
  registry.set(name, { ...registry.get(name), ...meta });
}

/**
 * Retrieve metadata for a tool by name.
 * Returns undefined for unregistered tools (NOT an empty object).
 */
export function getToolMetadata(
  name: string,
): ComisToolMetadata | undefined {
  return registry.get(name);
}

/**
 * Returns the full registry as a ReadonlyMap for read-only iteration.
 */
export function getAllToolMetadata(): ReadonlyMap<string, ComisToolMetadata> {
  return registry;
}

/**
 * Clears the registry. Test-only -- underscore prefix signals internal use.
 * Import directly from tool-metadata.ts in test files, NOT from index.ts.
 */
export function _clearRegistryForTest(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// truncateContentBlocks() helper
// ---------------------------------------------------------------------------

/** Content block shape matching the LLM tool-result format. */
interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Minimum characters per block after truncation. */
const MIN_CHARS_PER_BLOCK = 500;

/**
 * Truncate text content blocks to fit within a character budget.
 *
 * - Returns the ORIGINAL array by reference when total chars <= maxChars
 *   (critical for reference-equality checks in callers).
 * - Applies proportional per-block budgets with a 500-char minimum.
 * - Uses a 60/40 head/tail split with a marker indicating removed chars.
 */
export function truncateContentBlocks(
  content: ContentBlock[],
  maxChars: number,
): ContentBlock[] {
  // Step 1: Compute total text length across all blocks
  let totalChars = 0;
  for (const block of content) {
    totalChars += block.text?.length ?? 0;
  }

  // Under or at budget -- return original array by reference
  if (totalChars <= maxChars) {
    return content;
  }

  // Step 2: Compute proportional ratio
  const ratio = maxChars / totalChars;

  // Step 3 & 4: Map each block, applying truncation to text blocks
  return content.map((block) => {
    // Skip non-text blocks or blocks without text
    if (block.type !== "text" || !block.text) {
      return block;
    }

    // Compute per-block budget with minimum floor
    const budget = Math.max(
      MIN_CHARS_PER_BLOCK,
      Math.floor(block.text.length * ratio),
    );

    // Block fits within its budget -- return unchanged
    if (block.text.length <= budget) {
      return block;
    }

    // Apply 60/40 head/tail split
    const head = Math.floor(budget * 0.6);
    const tail = budget - head;
    const removed = block.text.length - head - tail;
    const marker = `\n[... ${removed} chars truncated. Reduce output scope (e.g., use limit param or narrower query). ...]\n`;
    const text =
      block.text.slice(0, head) + marker + block.text.slice(-tail);

    return { ...block, text };
  });
}
