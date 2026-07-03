// SPDX-License-Identifier: Apache-2.0
/**
 * semantic-classifier — maps a tool name to a {@link SemanticPhase}.
 * Pure string mapping; no channel coupling, no
 * logger. The label resolver uses this as the deterministic
 * fallback when no per-tool `LabelSpec` is registered.
 *
 * @module
 */

/**
 * The closed set of semantic phases — the same enum carried by
 * `ActivityEventSchema.semanticPhase` (`activity-event.ts`). Never
 * widened to `string` (AGENTS.md §2.8).
 */
export type SemanticPhase =
  | "tool"
  | "coding"
  | "web"
  | "memory"
  | "media"
  | "thinking"
  | "queued"
  | "done"
  | "error";

/**
 * Classify a tool name into its {@link SemanticPhase} by name prefix.
 * Deterministic, pure, total — every input resolves to a
 * member of the closed union; the default is `"tool"`.
 *
 * Prefix rules (most specific first; `web_search` before the generic default):
 *   - `memory_*`     → `"memory"`
 *   - `web_search*`  → `"web"`   (prefix, so `web_search_news` also matches)
 *   - `mcp_*`        → `"tool"`
 *   - everything else → `"tool"`
 *
 * @param toolName - the tool name (e.g. `"mcp_manage"`, `"memory_search"`)
 * @returns the semantic phase
 */
export function classifySemanticPhase(toolName: string): SemanticPhase {
  if (toolName.startsWith("memory_")) return "memory";
  if (toolName.startsWith("web_search")) return "web";
  if (toolName.startsWith("mcp_")) return "tool";
  return "tool";
}
