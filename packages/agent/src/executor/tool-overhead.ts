// SPDX-License-Identifier: Apache-2.0
/**
 * The tool-schema char-overhead reduce — extracted from executor-tool-assembly.ts
 * so the turn-time S estimate and the FLOOR-01 boot floor share ONE function
 * (I8/R-3; the extraction IS the drift pin).
 *
 * Consumers:
 *   - executor-tool-assembly.ts: cachedSystemTokensEstimate (the turn-time S term)
 *   - context-engine/viable-floor.ts: toolSchemaTokens (the FLOOR-01 boot term)
 *
 * viable-floor.test.ts pins both sites to this single export by FUNCTION-REFERENCE
 * IDENTITY (FLOOR-01-13) — a re-derived copy at either site cannot pass.
 *
 * @module
 */

/**
 * The auto-discovery stub marker key (mirrors DEFERRAL_STUB_MARKER in
 * tool-deferral.ts — duplicated as a literal here to preserve the agent↛
 * tool-deferral import direction; tool-deferral imports tool-overhead, not the
 * reverse). A tool carrying this key is a deferred-tool stub that
 * createStubFilterInjector STRIPS from the wire, so it costs ~0 on the request
 * and MUST NOT be counted in the system-token estimate. See ROOT-CAUSE note below.
 */
export const DEFERRAL_STUB_MARKER_KEY = "__comis_deferral_stub__" as const;

/**
 * Structural input shape: the fields the overhead estimate reads off a tool
 * definition. Matches both pi ToolDefinition and plain config-built tools.
 */
export interface ToolOverheadInput {
  name?: string;
  description?: string;
  parameters?: unknown;
  /** Present (true) on auto-discovery stubs — excluded from the estimate (wire-stripped). */
  [DEFERRAL_STUB_MARKER_KEY]?: boolean;
}

/**
 * Sum of name + description + JSON.stringify(parameters) lengths across the
 * toolset — the char-size basis for the system-token estimate (S) at turn time
 * and for the FLOOR-01 toolSchemaTokens term at boot.
 *
 * ROOT-CAUSE context-exhaustion fix (2026-06-22 VPS gpt-5.3-codex): auto-discovery
 * STUBS (those carrying DEFERRAL_STUB_MARKER_KEY) are EXCLUDED. The fit pass defers
 * ~50 of 65 tools, then createAutoDiscoveryStubs pushes a stub per deferred tool
 * into mergedCustomTools so the SDK can resolve their names; createStubFilterInjector
 * strips those stubs from the WIRE (zero request cost). Counting them here made every
 * S estimate over the full mergedCustomTools balloon back to ~all-65-tools size, so
 * the pre-flight saw assembled ≈ 13.7K > the 8192 window and FALSE-exhausted — silently
 * negating the deferral. Skipping marked stubs makes the estimate match the wire (the
 * lead's "skip stubs in toolDefOverheadChars" fix). Non-stub tools are byte-identical.
 */
export function toolDefOverheadChars(tools: ReadonlyArray<ToolOverheadInput>): number {
  return tools.reduce((sum, t) => {
    // Wire-stripped auto-discovery stubs cost ~0 on the request — exclude them.
    if (t[DEFERRAL_STUB_MARKER_KEY] === true) return sum;
    const descLen = t.description?.length ?? 0;
    const paramLen = t.parameters ? JSON.stringify(t.parameters).length : 0;
    return sum + (t.name?.length ?? 0) + descLen + paramLen;
  }, 0);
}
