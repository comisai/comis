// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical sanitized MCP tool name parsers.
 *
 * Sanitized MCP tool names use the format `mcp__serverName--toolName`,
 * produced by `sanitizeMcpToolName` in @comis/skills' mcp-tool-bridge
 * (replaces `:` with `__`, `/` with `--` to satisfy LLM API constraints
 * that tool names match `^[a-zA-Z0-9_-]{1,128}$`).
 *
 * Both parsers split on the FIRST `--` after the `mcp__` prefix, which:
 *   - Correctly handles hyphenated server names (`mcp__foo-bar--baz`
 *     -> server="foo-bar", tool="baz")
 *   - Correctly handles underscored server names (`mcp__srv__v2--ns--tool`
 *     -> server="srv__v2", tool="ns--tool")
 *   - Returns undefined for non-MCP tools (`Read`) and malformed names
 *     (`mcp__`, `mcp__foo`, `mcp__--baz`)
 *
 * Asymmetry between the two functions is intentional:
 *   - `extractMcpServerName("mcp__foo--")` returns "foo" — callers that
 *     only need to GROUP by server (e.g., DeferredToolEntry grouping in
 *     tool-deferral.ts) tolerate empty tool names.
 *   - `parseSanitizedMcpToolName("mcp__foo--")` returns undefined —
 *     callers that need a complete (server, tool) pair require both
 *     halves to be non-empty.
 *
 * Used by:
 * - `packages/skills/src/bridge/mcp-tool-bridge.ts` — re-exports for
 *   public API surface (`packages/skills/src/index.ts:174`).
 * - `packages/agent/src/bridge/bridge-event-handlers.ts` — re-exports
 *   for in-package callers (`pi-event-bridge.ts:42`,
 *   `tool-deferral.ts:23`).
 * - `packages/agent/src/bridge/pi-event-bridge.ts:347` — log decoration
 *   when an MCP tool errors at the event-bus boundary.
 * - `packages/agent/src/executor/tool-deferral.ts:293,912,917` —
 *   grouping `DeferredToolEntry[]` by server name.
 * - Phase 22 (future): install-detour parser will consume
 *   `parseSanitizedMcpToolName` for `{server, tool}` pair-matching.
 *
 * Source: design v1.1 §7 (Phase 2 — Canonical MCP Parser Migration).
 *
 * @module
 */

/**
 * Extract the MCP server name from a sanitized tool name.
 *
 * Sanitized MCP tool names use the format `mcp__serverName--toolName`.
 * Returns `undefined` for non-MCP tools, malformed names with no
 * `--` separator, or names with an empty server (`mcp__--baz`).
 *
 * @example
 * extractMcpServerName("mcp__context7--resolve-library-id") // "context7"
 * extractMcpServerName("mcp__foo-bar--baz")                 // "foo-bar"
 * extractMcpServerName("mcp__srv__v2--ns--tool")            // "srv__v2"
 * extractMcpServerName("Read")                              // undefined
 * extractMcpServerName("mcp__")                             // undefined
 * extractMcpServerName("mcp__foo")                          // undefined
 * extractMcpServerName("mcp__--baz")                        // undefined
 */
export function extractMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice(5);
  const sepIdx = rest.indexOf("--");
  if (sepIdx <= 0) return undefined;
  return rest.slice(0, sepIdx);
}

/**
 * Parse a sanitized MCP tool name into its server and tool components.
 *
 * Returns `undefined` for non-MCP tools, malformed names, or names where
 * either the server or tool component would be empty.
 *
 * Stricter than `extractMcpServerName`: this function ALSO rejects names
 * with an empty tool (`mcp__foo--` returns `undefined` here, but
 * `extractMcpServerName` returns `"foo"`).
 *
 * @example
 * parseSanitizedMcpToolName("mcp__context7--resolve-library-id")
 *   // { server: "context7", tool: "resolve-library-id" }
 * parseSanitizedMcpToolName("mcp__foo--bar--baz")
 *   // { server: "foo", tool: "bar--baz" }   // splits on FIRST "--"
 * parseSanitizedMcpToolName("mcp__foo--")    // undefined
 * parseSanitizedMcpToolName("Read")          // undefined
 */
export function parseSanitizedMcpToolName(
  toolName: string,
): { server: string; tool: string } | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice(5);
  const sepIdx = rest.indexOf("--");
  if (sepIdx <= 0 || sepIdx >= rest.length - 2) return undefined;
  return { server: rest.slice(0, sepIdx), tool: rest.slice(sepIdx + 2) };
}
