// SPDX-License-Identifier: Apache-2.0
import type { SystemPromptBlocks } from "../bootstrap/index.js";
import { isReadOnlyTool } from "../executor/tool-parallelism.js";

/**
 * Classify a spawned child from its structured tool registry and explicit
 * role. Unknown or mutating tools keep the conservative mutable classification.
 */
export function isReadOnlyChild(childToolNames: readonly string[], role?: string): boolean {
  const everyToolReadOnly = childToolNames.every((name) => isReadOnlyTool(name));
  if (role === "read-only") return everyToolReadOnly;
  return childToolNames.length > 0 && everyToolReadOnly;
}

export interface EconomisedChildPrompt {
  readonly systemPrompt: string;
  readonly systemPromptBlocks?: SystemPromptBlocks;
}

/**
 * The typed prompt compiler owns section budgets and mode selection. This
 * boundary intentionally preserves its output byte-for-byte: recovering state
 * by parsing rendered headings would couple execution behavior to prose.
 */
export function economiseChildPrompt(assembledPrompt: string): string {
  return assembledPrompt;
}

export function economiseForReadOnlyChild(
  systemPrompt: string,
  systemPromptBlocks: SystemPromptBlocks | undefined,
  _childToolNames: readonly string[],
  _role?: string,
): EconomisedChildPrompt {
  return { systemPrompt, systemPromptBlocks };
}
