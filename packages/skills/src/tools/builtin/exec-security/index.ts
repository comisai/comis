// SPDX-License-Identifier: Apache-2.0
/**
 * Exec command security module.
 *
 * Barrel re-export of the canonical public API. No aliases — every export
 * keeps its canonical name. Internal layer order: sandbox (low-level
 * primitives) → pre-check (pre-pipeline gates) → allowlist (denylist +
 * pipeline + exit codes). The barrel re-exports the union of all three.
 *
 * @module
 */

// Sandbox layer: quote tracker, env-var allowlist, path-protection constants.
export {
  ShellQuoteTracker,
  splitCommandSegments,
  SAFE_ENV_VARS,
  SAFE_ENV_PREFIXES,
  validateEnvVars,
  MUTATION_COMMANDS,
  PROTECTED_PATHS,
  PROTECTED_PATH_PREFIXES,
  REDIRECT_SENSITIVE_PREFIXES,
  validateDangerousPaths,
  validateRedirectTargets,
} from "./exec-security-sandbox.js";

// Pre-check layer: pre-pipeline sanitization gates.
export {
  sanitizeCommandInput,
  extractHeredoc,
  detectShellSubstitutions,
  detectDangerousPipeTargets,
  detectIFSInjection,
  detectBraceExpansion,
  detectProcEnvironAccess,
  detectCommentQuoteDesync,
} from "./exec-security-pre-check.js";

// Allowlist layer: denylist patterns, zsh detection, pipeline entry point,
// semantic exit-code interpreter.
export {
  DANGEROUS_COMMAND_PATTERNS,
  validateCommand,
  detectZshDangerousCommands,
  validateExecCommand,
  interpretExitCode,
} from "./exec-security-allowlist.js";
