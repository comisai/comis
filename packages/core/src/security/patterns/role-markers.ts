// SPDX-License-Identifier: Apache-2.0
/**
 * Role and XML marker detection patterns.
 *
 * Detects system/assistant/user role markers and XML structural tags
 * used in injection attempts to impersonate system prompts.
 *
 * @module role-markers
 */

/** Shared by tool-output-safety.ts AND external-content.ts: system: (with whitespace) */
export const SYSTEM_COLON = /system\s*:\s+/gi;

/** Shared by tool-output-safety.ts AND external-content.ts: [SYSTEM] */
export const SYSTEM_BRACKET = /\[SYSTEM\]/gi;

/** Shared by tool-output-safety.ts AND external-content.ts: [INST] */
export const INST_BRACKET = /\[INST\]/gi;

/** Shared by tool-output-safety.ts AND external-content.ts: <system> or </system> */
export const SYSTEM_TAG = /<\/?system>/gi;

/** external-content.ts only: system prompt/override/command */
export const SYSTEM_COMMAND = /system[ \t]{0,20}:?[ \t]{0,20}(prompt|override|command)/gi;

/** external-content.ts only: role boundary like ] \n [system]: */
export const ROLE_BOUNDARY = /\][ \t]{0,20}\n[ \t]{0,20}\[?(system|assistant|user)\]?:/gi;

/** All role/XML marker patterns. */
export const ROLE_MARKER_PATTERNS: readonly RegExp[] = [
  SYSTEM_COLON,
  SYSTEM_BRACKET,
  INST_BRACKET,
  SYSTEM_TAG,
  SYSTEM_COMMAND,
  ROLE_BOUNDARY,
];
