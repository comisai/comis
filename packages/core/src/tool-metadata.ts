// SPDX-License-Identifier: Apache-2.0
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

import type { ErrorKind } from "./logging/log-fields.js";

// ---------------------------------------------------------------------------
// ToolCapabilityMetadata interface (capability layer)
// ---------------------------------------------------------------------------

/**
 * Capability metadata for a builtin/platform tool -- used by the capability
 * layer to route tools into clusters and detect install-detour overlap.
 *
 * All fields optional. Operators may override `cluster` per-tool via
 * `tooling.capabilityClusters.builtinAssignments[toolName]`. The metadata
 * default applies when no operator override is present.
 *
 * `getBuiltinCluster` precedence: operator override > metadata default > undefined.
 */
export interface ToolCapabilityMetadata {
  /** Cluster ID this tool belongs to (e.g., "data-fetching-financial"). */
  readonly cluster?: string;
  /** Operator-tunable display summary; falls back to tool description if absent. */
  readonly summary?: string;
  /** Package names this tool replaces (for install-detour overlap detection). */
  readonly replacesPackages?: readonly string[];
}

export type TrackedInvocationSideEffect =
  | "scheduling"
  | "outbound_delivery"
  | "deferred_work";

export type ToolInvocationSideEffects =
  | {
      readonly kind: "always";
      readonly capabilities: readonly TrackedInvocationSideEffect[];
    }
  | {
      readonly kind: "by_action";
      readonly parameter: "action";
      readonly actions: Readonly<
        Record<string, readonly TrackedInvocationSideEffect[]>
      >;
    };

/** Model-visible recovery guidance for one structured tool failure. */
export interface ToolFailureFallback {
  /** Structured `details.error` code that activates this alternative. */
  readonly onErrorCode: string;
  /** Alternative tool that must be present in the live tool set. */
  readonly toolName: string;
  /** Bounded, code-owned instruction appended to the failed tool result. */
  readonly guidance: string;
}

// ---------------------------------------------------------------------------
// ComisToolMetadata interface
// ---------------------------------------------------------------------------

/** Per-tool metadata stored in the side-channel registry. All fields optional. */
// @optional-field-count: 17 optional fields — this is a side-channel metadata
// aggregator keyed by tool name, registered incrementally via spread-merge from
// independent sources (result caps, parallel-safety flags, action-gating
// schema, MCP-export policy, capability routing, activity hints, failure
// classification, and failure alternatives). Every field is conditionally
// present per tool by design; the registry merges partial registrations, so a
// required field would force every caller to supply unrelated keys. Splitting
// would fragment a single per-tool record into N parallel maps with no added
// type safety. Well-bounded record, not an undermodeled type.
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
  /** Runtime-owned classification of effects attempted by an invocation.
   *  Absence is fail-closed: the bridge records an unclassified invocation. */
  invocationSideEffects?: ToolInvocationSideEffects;
  /** Valid `action` enum values for action-discriminated tools. Used by the
   *  generic schema-validator in @comis/skills/bridge to gate unknown actions
   *  before the per-tool validateInput runs. Field shape mirrors
   *  `ManagedSectionRedirect.schemaFragment.actions` in
   *  @comis/core/src/config/managed-sections.ts so cross-consistency tests
   *  can compare them. */
  validActions?: readonly string[];
  /** Full set of accepted top-level parameter keys. Unknown keys trigger a
   *  Levenshtein "did you mean" hint via the schema-validator. Action-
   *  discriminated tools list the union across all actions; non-discriminated
   *  tools list every accepted key. Omit when the tool's params are open-
   *  ended (e.g. exec). */
  validKeys?: readonly string[];
  /** Required keys per action value (action-discriminated tools only). Maps
   *  each `action` literal to the list of params that MUST be present beyond
   *  `action` itself. Field name + shape mirror
   *  `ManagedSectionRedirect.schemaFragment.requiredByAction` in
   *  @comis/core/src/config/managed-sections.ts. Omit actions with no
   *  required fields beyond `action`. */
  requiredByAction?: Readonly<Record<string, readonly string[]>>;
  /** Pre-flight input validator. Returns error string on failure, undefined on success. */
  validateInput?: (
    params: Record<string, unknown>,
  ) => string | undefined | Promise<string | undefined>;
  /** Capability metadata for tool-first routing. */
  capability?: ToolCapabilityMetadata;
  /** Per-tool MCP-export policy for the /mcp/v1 server endpoint.
   *  - `"safe"`: exposed to any MCP client with scope `mcp-client` (no allowlist needed).
   *  - `"permission-gated"`: exposed only when the per-client
   *    `mcpClient.allowlist` includes this tool name.
   *  - `"never-export"`: NEVER exposed via the MCP server endpoint.
   *  - `undefined` ⇒ treated as `"never-export"` (default-deny safety net;
   *    CI gate enforces that `undefined` is impossible in committed code).
   *  Spread-merge in `registerToolMetadata` preserves this field across multiple
   *  registrations for the same tool name. */
  mcpExportPolicy?: "safe" | "permission-gated" | "never-export";
  /** When true, this tool's lifecycle produces no activity messages (the
   *  activity pipeline skips it). Lifecycle reactions + final delivery are
   *  unaffected. Read by the activity layer. */
  suppressActivity?: boolean;
  /** When true, a non-zero `details.exitCode` in this tool's RESULT is the DRIVEN
   *  subject's exit code (informational), NOT the tool's own outcome — so the bridge's
   *  exit-code failure heuristic must NOT flag the call as failed. Set on the
   *  terminal-driver perception tools (status/read/wait), whose result reports the driven
   *  session's `exitCode`. Without it a driven program exiting non-zero (e.g. bash `exit 1`)
   *  misclassifies a perfectly-successful `terminal_session_status` as a tool
   *  failure. Default (absent) ⇒ the heuristic applies (exec/process, where
   *  the exit code IS the tool's outcome). */
  exitCodeIsDrivenSession?: boolean;
  /** Tool-specific failure classifier consulted *before* the `tool:executed`
   *  emit, so observability never sees the raw result. Receives the
   *  tool result and the SDK `isError` flag; returns `true`/`false` (failed or
   *  not) or `{ errorKind, … }` (failed, with a closed-union classification plus
   *  optional verdict provenance). Lets a tool flag a logically-failed result
   *  that the SDK reported as success (e.g. a non-zero exit code).
   *
   *  Verdict provenance — all optional, additive on the contract:
   *  - `classifiedField`: which STRUCTURED field drove the verdict (never the body).
   *  - `matchedRule`: the literal regex/rule description that matched (a fixed
   *    string, not a serialized RegExp and not tool-output data).
   *  - `matchedToken`: the concrete token that matched (e.g. a status code). This
   *    is the only provenance field that may carry tool output, so downstream
   *    log sinks bound it via `sanitizeLogString(...).slice(0, 1500)`. */
  failureDetector?: (
    result: unknown,
    isError: boolean,
  ) =>
    | boolean
    | {
        errorKind: ErrorKind;
        /** Which structured field drove the verdict. */
        classifiedField?: "error" | "status" | "message" | "failures";
        /** The regex/rule literal that matched. */
        matchedRule?: string;
        /** The concrete token that matched, e.g. a status code. */
        matchedToken?: string;
      };
  /** Structured failure-to-tool alternatives. The agent loop appends guidance
   *  only when `details.error` matches and the named tool is live, so disabled
   *  capabilities never appear as available recovery paths. */
  failureFallbacks?: readonly ToolFailureFallback[];
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton Map)
// ---------------------------------------------------------------------------

const registry = new Map<string, ComisToolMetadata>();

/**
 * Register metadata for a tool. Merges with any existing metadata via spread,
 * allowing incremental registration from different sources.
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
