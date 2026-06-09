// SPDX-License-Identifier: Apache-2.0
/**
 * defer_loading injection for deferred tools.
 *
 * For Anthropic non-Haiku models that support tool_search, injects
 * `defer_loading: true` on tools whose names appear in the deferred-tools
 * set. When at least one tool is deferred, removes the client-side
 * `discover_tools` (replaced by server-side tool_search) and appends the
 * server-side `tool_search_tool_regex` tool definition.
 *
 * Bypasses safely (no-op):
 *  - When `config.getDeferredToolNames` is undefined.
 *  - When `supportsToolSearch(modelId)` returns false (e.g., Haiku).
 *  - When the deferral latch fixes the decision to off.
 *  - When `deferCount === 0` even after activation (deferred tools were
 *    excluded upstream; payload lacks deferred definitions and injecting
 *    the search tool would crash the API/SDK).
 *  - For each tool, the stub-marker guard (DEFERRAL_STUB_MARKER) prevents
 *    auto-discovery stub tools from being counted toward `deferCount`. This
 *    interacts with `createStubFilterInjector` (stub-filter-injector.ts):
 *    the stub-filter wrapper later strips stubs by name from the API
 *    payload, but it runs AFTER this injector in the onPayload chain
 *    (innermost wrapper's onPayload runs last because each wrapper calls
 *    `existingOnPayload` first via `reduceRight` composition). Without
 *    this guard, exclude-model sessions with auto-discovery stubs would
 *    falsely set `deferCount > 0`, swap `discover_tools` for
 *    `tool_search_tool_regex`, and ship a payload where neither
 *    discovery mechanism works.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";

import { DEFERRAL_STUB_MARKER, supportsToolSearch } from "../../tool-deferral.js";
import type { RequestBodyInjectorConfig } from "./types.js";

/**
 * Inject defer_loading markers and (conditionally) swap client-side
 * discovery for the server-side tool_search tool. Mutates `result.tools`
 * in place when activation conditions are met.
 */
export function injectToolDeferral(
  result: Record<string, unknown>,
  modelId: string,
  config: RequestBodyInjectorConfig,
  logger: ComisLogger,
): void {
  if (!config.getDeferredToolNames || !(config.modelProfile?.supportsServerToolSearch ?? supportsToolSearch(modelId))) return;

  const deferredNames = config.getDeferredToolNames();
  // Latch defer_loading activation
  const deferLatch = config.getDeferLoadingLatch?.();
  const shouldDeferLoad = deferLatch
    ? deferLatch.setOnce(deferredNames.size > 0)
    : deferredNames.size > 0;
  if (!shouldDeferLoad || !Array.isArray(result.tools)) return;

  const tools = result.tools as Array<Record<string, unknown>>;
  let deferCount = 0;
  for (const tool of tools) {
    if (
      deferredNames.has(tool.name as string)
      && tool[DEFERRAL_STUB_MARKER as unknown as string] !== true
    ) {
      tool.defer_loading = true;
      deferCount++;
    }
  }
  // Only switch to server-side tool_search when tools were actually
  // marked defer_loading in the payload. When deferred tools are
  // excluded upstream (tool-deferral.ts client-side exclusion),
  // deferCount is 0 and the payload lacks deferred definitions —
  // injecting tool_search_tool without any deferred tools crashes
  // the Anthropic API/SDK.
  if (deferCount > 0) {
    // Remove client-side discover_tools (replaced by server-side tool_search)
    const discoverIdx = tools.findIndex(t => (t.name as string) === "discover_tools");
    if (discoverIdx !== -1) {
      tools.splice(discoverIdx, 1);
    }
    // Append server-side search tool (only if not already present)
    const hasSearchTool = tools.some(t =>
      typeof t.type === "string" && (t.type as string).startsWith("tool_search_tool_"),
    );
    if (!hasSearchTool) {
      tools.push({
        type: "tool_search_tool_regex_20251119",
        name: "tool_search_tool_regex",
      });
    }
  }
  logger.debug(
    { deferCount, modelId, searchToolAppended: deferCount > 0 },
    "DEFER-TOOL: Injected defer_loading on deferred tools",
  );
}
