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
 * Structural input shape: the fields the overhead estimate reads off a tool
 * definition. Matches both pi ToolDefinition and plain config-built tools.
 */
export interface ToolOverheadInput {
  name?: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Sum of name + description + JSON.stringify(parameters) lengths across the
 * toolset — the char-size basis for the system-token estimate (S) at turn time
 * and for the FLOOR-01 toolSchemaTokens term at boot.
 *
 * Byte-equivalent algebra to the previously inline reduce in
 * executor-tool-assembly.ts — behavior-neutral extraction.
 */
export function toolDefOverheadChars(tools: ReadonlyArray<ToolOverheadInput>): number {
  return tools.reduce((sum, t) => {
    const descLen = t.description?.length ?? 0;
    const paramLen = t.parameters ? JSON.stringify(t.parameters).length : 0;
    return sum + (t.name?.length ?? 0) + descLen + paramLen;
  }, 0);
}
