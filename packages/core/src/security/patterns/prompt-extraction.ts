// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt extraction detection patterns.
 *
 * Detects attempts by the LLM to reveal its system prompt or original
 * instructions in its output. Originally from output-guard.ts.
 *
 * @module prompt-extraction
 */

/** "my/the system prompt is/says/reads/contains" */
export const SYSTEM_PROMPT_LABEL = /(?:my|the)\s+system\s+prompt\s+(?:is|says|reads|contains)/gi;

/** "my/the original/initial instructions are/is/say" */
export const INSTRUCTIONS_LABEL = /(?:my|the)\s+(?:original|initial)\s+instructions?\s+(?:are|is|say)/gi;

/** All prompt extraction patterns. */
export const PROMPT_EXTRACTION_PATTERNS: readonly RegExp[] = [
  SYSTEM_PROMPT_LABEL,
  INSTRUCTIONS_LABEL,
];
