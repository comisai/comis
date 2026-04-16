/**
 * Dangerous command detection patterns.
 *
 * Detects shell commands and operations that could cause data loss
 * or privilege escalation when injected into tool arguments.
 *
 * @module dangerous-commands
 */

/** exec ... command= (bounded .{0,50} for ReDoS safety -- was .* in original) */
export const EXEC_COMMAND = /\bexec\b.{0,50}command\s*=/gi;

/** elevated=true */
export const ELEVATED_TRUE = /elevated\s*=\s*true/gi;

/** rm -rf */
export const RM_RF = /rm\s+-rf/gi;

/** delete all (emails|files|data) */
export const DELETE_ALL = /delete\s+all\s+(emails?|files?|data)/gi;

/** All dangerous command patterns. */
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  EXEC_COMMAND,
  ELEVATED_TRUE,
  RM_RF,
  DELETE_ALL,
];
