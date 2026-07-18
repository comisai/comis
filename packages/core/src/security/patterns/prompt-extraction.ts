// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt extraction detection patterns.
 *
 * Detects requests to extract internal instructions and declarations by the
 * LLM that reveal them. Consumed by the input and output guards.
 *
 * @module prompt-extraction
 */

/** "my/the system prompt is/says/reads/contains" */
export const SYSTEM_PROMPT_LABEL = /(?:my|the)\s+system\s+prompt\s+(?:is|says|reads|contains)/gi;

/** "my/the original/initial instructions are/is/say" */
export const INSTRUCTIONS_LABEL = /(?:my|the)\s+(?:original|initial)\s+instructions?\s+(?:are|is|say)/gi;

/** A disclosure verb followed by an internal prompt/instruction target. */
export const PROMPT_EXTRACTION_REQUEST =
  /\b(?:reveal|show|display|print|repeat|state|quote|recite|provide|tell|translate|summarize|describe)\b[\s\S]{0,200}\b(?:(?:my|your|the)\s+system\s+(?:prompt|message)|(?:your|the)\s+(?:hidden|internal|initial|original|first)\s+instructions?)\b/i;

/** All prompt extraction patterns. */
export const PROMPT_EXTRACTION_PATTERNS: readonly RegExp[] = [
  SYSTEM_PROMPT_LABEL,
  INSTRUCTIONS_LABEL,
];
