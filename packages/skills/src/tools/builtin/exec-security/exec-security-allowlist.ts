// SPDX-License-Identifier: Apache-2.0
/**
 * Exec command security — denylist patterns + zsh detection + main pipeline.
 *
 * Owns the post-pre-check gates + the pipeline entry point + exit-code
 * semantics:
 *   - DANGEROUS_COMMAND_PATTERNS (regex denylist; Gate 2.5 + Gate 3+4)
 *   - validateCommand (denylist check; pre-split and per-segment)
 *   - detectZshDangerousCommands (Gate 7)
 *   - validateExecCommand (Gates 0-12 pipeline composition)
 *   - interpretExitCode (semantic exit-code interpreter)
 *
 * @module
 */

import {
  splitCommandSegments,
  validateDangerousPaths,
  validateRedirectTargets,
  validateEnvVars,
} from "./exec-security-sandbox.js";
import {
  sanitizeCommandInput,
  detectShellSubstitutions,
  detectDangerousPipeTargets,
  detectIFSInjection,
  detectBraceExpansion,
  detectProcEnvironAccess,
  detectCommentQuoteDesync,
} from "./exec-security-pre-check.js";

// --------------------------------------------------------------------------
// Dangerous command patterns (denylist)
// --------------------------------------------------------------------------

/**
 * Command patterns that are blocked before spawning. Defense-in-depth only --
 * the actual security boundary is the builtinTools.exec toggle and tool policy.
 */
export const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  reason: string;
}> = [
  // Category A -- Destructive filesystem operations
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(\/|~)/,
    reason: "Recursive delete on root or home directory",
  },
  { pattern: /\bmkfs\b/, reason: "Filesystem format command" },
  {
    pattern: /\bdd\b.*\bof\s*=\s*\/dev\//,
    reason: "Direct write to block device",
  },
  // Category B -- Permission/system compromise
  {
    pattern: /\bchmod\b.*\b777\b.*\//,
    reason: "World-writable permissions on system path",
  },
  {
    pattern: /:\(\)\s*\{.*\|.*&\s*\}/,
    reason: "Fork bomb pattern",
  },
  // Category C -- Migrated to detectDangerousPipeTargets()
  // Category D -- Sensitive file access
  {
    pattern: /\/etc\/(passwd|shadow|sudoers)/,
    reason: "Access to sensitive system file",
  },
  { pattern: /\/\.ssh\//, reason: "Access to SSH key directory" },
  {
    pattern: /\.comis\/\.env/,
    reason:
      "Access to secret envfile is blocked. Use the gateway tool with action='env_list' " +
      "to see which secret names are configured (names only, no values). " +
      "Secret values are never returned to the agent.",
  },
  {
    pattern: /\.comis\/auth-profiles\.json/,
    reason:
      "Access to the OAuth credential store (auth-profiles.json) is blocked. " +
      "It contains refresh and access tokens for every connected provider. " +
      "Use the gateway tool to manage OAuth profiles -- token values are never returned to the agent.",
  },
  // Category E -- Config file modification bypass
  // Defense-in-depth: the agent system prompt is the primary guard.
  // These regexes can be bypassed via quoting, variable expansion, etc.
  // The real security boundary is the tool policy toggle.
  // Note: plain `cat` (read) is intentionally excluded -- only write tools are blocked.
  {
    pattern:
      /(?:sed|awk|tee|cp|mv|perl|ruby)\b.*(?:\.comis\/config|comis.*config\.yaml|config\.local\.yaml)/,
    reason:
      "Direct config file modification bypasses validation and audit. Use gateway tool's config.patch instead.",
  },
  {
    pattern:
      /(?:echo|cat)\s*>.*(?:\.comis\/config|comis.*config\.yaml|config\.local\.yaml)/,
    reason:
      "Direct config file modification bypasses validation and audit. Use gateway tool's config.patch instead.",
  },
  {
    pattern:
      /(?:\.comis\/config|comis.*config\.yaml|config\.local\.yaml).*(?:sed|awk|tee|cat\s*>|echo\s*>)/,
    reason:
      "Direct config file modification bypasses validation and audit. Use gateway tool's config.patch instead.",
  },
  // Category G -- Code execution builtins
  { pattern: /\beval\s/, reason: "Shell eval executes arbitrary code" },
  {
    pattern: /\bsource\s/,
    reason: "Shell source executes arbitrary script file. For virtualenvs, call the venv binary directly (e.g. .venv/bin/python3, .venv/bin/pip) instead of sourcing activate",
  },
  {
    pattern: /^\.\s+\//,
    reason: "POSIX source (.) executes arbitrary script file. For virtualenvs, call the venv binary directly (e.g. .venv/bin/python3, .venv/bin/pip) instead of sourcing activate",
  },
  // Category H -- Indirect command execution
  {
    pattern: /\bfind\b.*-exec\s/,
    reason: "find -exec can execute arbitrary commands",
  },
  {
    pattern:
      /\bxargs\s+(?!-[0tI])(?:sudo\s+)?(?:rm|chmod|chown|mv|shred|dd|mkfs)\b/,
    reason: "xargs piping to dangerous command",
  },
  // Category J -- Shell encoding bypass
  {
    pattern: /\$'[^']*\\[xuU0-7]/,
    reason:
      "ANSI-C quoting ($'...') with escape sequences can encode arbitrary commands, bypassing command validation",
  },
  // Category K -- Sed dangerous operations
  {
    pattern: /\bsed\b.*'(?:\s*e\b|[^']*;\s*e\b)/,
    reason: "sed 'e' command executes pattern space as shell command",
  },
  {
    pattern: /\bsed\b.*'(?:\s*w\s|[^']*;\s*w\s)/,
    reason: "sed 'w' command writes pattern space to arbitrary file",
  },
  {
    pattern: /\bsed\b.*'[^']*\/[ew]\b/,
    reason: "sed substitution with 'e' (execute) or 'w' (write) flag",
  },
  // Category F -- Secret file modification bypass (write-specific patterns)
  // .env files contain credentials managed by SecretManager. Direct edits
  // bypass secret redaction, audit logging, and can leak credentials.
  // Note: Category D already blocks all access to .comis/.env (read + write).
  // These patterns are kept as defense-in-depth for write-specific error messages.
  {
    pattern: /(?:sed|awk|tee|cp|mv|perl|ruby)\b.*\.comis\/\.env/,
    reason:
      "Direct .env file modification bypasses SecretManager and audit. Credentials must be managed through secure channels.",
  },
  {
    pattern: /(?:echo|cat)\b.*>.*\.comis\/\.env/,
    reason:
      "Direct .env file modification bypasses SecretManager and audit. Credentials must be managed through secure channels.",
  },
  {
    pattern: /\.comis\/\.env.*(?:sed|awk|tee|cat\s*>|echo\s*>)/,
    reason:
      "Direct .env file modification bypasses SecretManager and audit. Credentials must be managed through secure channels.",
  },
  {
    pattern: /(?:sed|awk|tee|cp|mv|perl|ruby)\b.*\.comis\/auth-profiles\.json/,
    reason:
      "Direct OAuth credential store (auth-profiles.json) modification bypasses atomic-write, per-profile-lock, and schema-version validation in oauth-credential-store-file.ts. Use the gateway tool to manage OAuth profiles.",
  },
  {
    pattern: /(?:echo|cat)\b.*>.*\.comis\/auth-profiles\.json/,
    reason:
      "Direct OAuth credential store (auth-profiles.json) modification bypasses atomic-write, per-profile-lock, and schema-version validation in oauth-credential-store-file.ts. Use the gateway tool to manage OAuth profiles.",
  },
  {
    pattern: /\.comis\/auth-profiles\.json.*(?:sed|awk|tee|cat\s*>|echo\s*>)/,
    reason:
      "Direct OAuth credential store (auth-profiles.json) modification bypasses atomic-write, per-profile-lock, and schema-version validation in oauth-credential-store-file.ts. Use the gateway tool to manage OAuth profiles.",
  },
  // Category L -- Network reverse-shell primitives
  // Direct attack primitives that establish a remote shell without going
  // through a pipe (so the existing Gate 2 "pipe to bash/sh/curl/wget/nc"
  // wouldn't catch them). Defense-in-depth: the agent has no legitimate
  // reason to use any of these — the surrounding skills wrap network access
  // through the daemon's HTTP client. A network egress allowlist (iptables
  // --uid-owner) is the actual security boundary; these patterns just
  // surface intent earlier in the chain.
  {
    pattern: /\/dev\/tcp\//,
    reason:
      "Bash /dev/tcp/<host>/<port> opens a raw TCP socket — reverse-shell primitive.",
  },
  {
    pattern: /\bnc(?:at)?\b[^|;&]*\s-e\b/,
    reason:
      "netcat -e (--exec) attaches a process to the socket — reverse-shell primitive.",
  },
  {
    pattern: /\bsocat\b[^|;&]*\bexec\s*:/,
    reason:
      "socat exec: target attaches a process to the socket — reverse-shell primitive.",
  },
];

// --------------------------------------------------------------------------
// Gate 1: Command denylist (moved from exec-tool.ts)
// --------------------------------------------------------------------------

/**
 * Validate a command against the dangerous command denylist.
 * Returns an error message if blocked, null if allowed.
 *
 * This is defense-in-depth, not a sandbox. The actual security boundary
 * is the builtinTools.exec toggle and tool policy. Pattern matching on
 * raw command strings can be bypassed via shell quoting/encoding.
 */
export function validateCommand(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Command blocked: ${reason}`;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Gate 7: Zsh dangerous commands detection
// --------------------------------------------------------------------------

/** Zsh-specific builtins and modules that can compromise the system. */
const ZSH_DANGEROUS_COMMANDS = new Set([
  "zmodload", "emulate", "sysopen", "sysread", "syswrite", "sysseek",
  "zpty", "ztcp", "zsocket",
  "zf_rm", "zf_mv", "zf_ln", "zf_chmod", "zf_chown", "zf_mkdir", "zf_rmdir", "zf_chgrp",
]);

/** Zsh precommand modifiers that precede the actual command. */
const ZSH_PRECOMMAND_MODIFIERS = new Set([
  "command", "builtin", "noglob", "nocorrect",
]);

/**
 * Detect Zsh-specific dangerous commands in a command segment.
 * Strips env assignments (VAR=val) and precommand modifiers (command, builtin,
 * noglob, nocorrect) to find the base command. Also blocks `fc -e` (history
 * command with execute flag).
 *
 * @param segment - A single command segment (after compound splitting)
 * @returns Error message if dangerous Zsh command found, null if safe
 */
export function detectZshDangerousCommands(segment: string): string | null {
  const words = segment.trim().split(/\s+/);
  let baseCmd: string | undefined;

  for (const word of words) {
    // Skip VAR=value env assignments
    if (/^[A-Za-z_]\w*=/.test(word)) continue;
    // Skip precommand modifiers
    if (ZSH_PRECOMMAND_MODIFIERS.has(word)) continue;
    baseCmd = word;
    break;
  }

  if (!baseCmd) return null;

  if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    return `Zsh dangerous command '${baseCmd}' is blocked.`;
  }

  // Block fc -e (history execute)
  if (baseCmd === "fc" && /\s-\S*e/.test(segment)) {
    return "Zsh 'fc -e' (history execute) is blocked.";
  }

  return null;
}

// --------------------------------------------------------------------------
// Pipeline entry point
// --------------------------------------------------------------------------

/**
 * Unified exec command validation pipeline. Composes all security gates in
 * order: sanitize -> substitution -> pipe -> denylist -> IFS -> brace ->
 * proc -> desync -> split+denylist+paths+redirects+zsh -> env.
 * Used by both `createExecTool()` runtime and `tool-metadata-registry.ts`
 * pre-flight registration.
 *
 * @param command - The raw shell command to validate
 * @param env - Optional environment variable overrides to validate
 * @returns Object with `message` and `blocker` fields if blocked, null if valid
 */
export function validateExecCommand(
  command: string,
  env?: Record<string, string>,
): { message: string; blocker: string } | null {
  // Gate 0: invisible character sanitization
  const sanitizeError = sanitizeCommandInput(command);
  if (sanitizeError) return { message: sanitizeError, blocker: "sanitize" };

  // Gate 1: shell substitution detection
  const subError = detectShellSubstitutions(command);
  if (subError) return { message: subError, blocker: "substitution" };

  // Gate 2: dangerous pipe target detection (pre-split)
  const pipeError = detectDangerousPipeTargets(command);
  if (pipeError) return { message: pipeError, blocker: "pipe" };

  // Gate 2.5: pre-split denylist for patterns that span segment boundaries
  // (e.g. fork bomb ":(){ :|:& };:" contains | and ; which are segment delimiters)
  const preSplitError = validateCommand(command);
  if (preSplitError) return { message: preSplitError, blocker: "denylist" };

  // Gate 6: IFS injection
  const ifsError = detectIFSInjection(command);
  if (ifsError) return { message: ifsError, blocker: "ifs" };

  // Gate 8: Brace expansion
  const braceError = detectBraceExpansion(command);
  if (braceError) return { message: braceError, blocker: "brace" };

  // Gate 11: /proc/environ access
  const procError = detectProcEnvironAccess(command);
  if (procError) return { message: procError, blocker: "proc" };

  // Gate 12: Comment-quote desync
  const desyncError = detectCommentQuoteDesync(command);
  if (desyncError) return { message: desyncError, blocker: "desync" };

  // Gate 3+4: split compound commands, validate each segment against denylist
  const segments = splitCommandSegments(command);
  for (const segment of segments) {
    const cmdError = validateCommand(segment);
    if (cmdError) {
      return {
        message: `${cmdError} (in segment: ${segment.slice(0, 100)})`,
        blocker: "denylist",
      };
    }

    // Dangerous path protection for mutation commands
    const pathError = validateDangerousPaths(segment);
    if (pathError) return { message: pathError, blocker: "path" };

    // Redirect target protection
    const redirectError = validateRedirectTargets(segment);
    if (redirectError) return { message: redirectError, blocker: "redirect" };

    // Gate 7: Zsh dangerous commands
    const zshError = detectZshDangerousCommands(segment);
    if (zshError) return { message: zshError, blocker: "zsh" };
  }

  // Gate 5: env var validation
  if (env) {
    const envError = validateEnvVars(env);
    if (envError) return { message: envError, blocker: "env" };
  }

  return null;
}

// --------------------------------------------------------------------------
// Semantic exit code interpretation
// --------------------------------------------------------------------------

/**
 * Commands where non-zero exit codes have specific, non-error meanings.
 * Maps command basename -> exit code -> human-readable interpretation.
 */
const SEMANTIC_EXIT_CODES: ReadonlyMap<string, ReadonlyMap<number, string>> = new Map([
  ["grep", new Map([
    [0, "Pattern found"],
    [1, "No match found (this is normal, not an error)"],
  ])],
  ["rg", new Map([
    [0, "Pattern found"],
    [1, "No match found (this is normal, not an error)"],
  ])],
  ["egrep", new Map([
    [0, "Pattern found"],
    [1, "No match found (this is normal, not an error)"],
  ])],
  ["fgrep", new Map([
    [0, "Pattern found"],
    [1, "No match found (this is normal, not an error)"],
  ])],
  ["diff", new Map([
    [0, "Files are identical"],
    [1, "Files differ (this is normal, not an error)"],
  ])],
  ["cmp", new Map([
    [0, "Files are identical"],
    [1, "Files differ (this is normal, not an error)"],
  ])],
  ["test", new Map([
    [0, "Condition is true"],
    [1, "Condition is false (this is normal, not an error)"],
  ])],
  ["[", new Map([
    [0, "Condition is true"],
    [1, "Condition is false (this is normal, not an error)"],
  ])],
  ["find", new Map([
    [0, "Search completed successfully"],
    [1, "Search completed with some inaccessible directories (partial results returned)"],
  ])],
]);

/**
 * Interpret an exit code for a specific command. Returns a human-readable
 * string if the command has known semantic exit codes, undefined otherwise.
 *
 * For piped commands (containing |), the exit code comes from the LAST
 * command in the pipeline (bash default behavior). This function extracts
 * the last command's basename for interpretation. For non-piped commands,
 * the first word is used.
 *
 * Skipped when the command contains && or || (exit code semantics become
 * ambiguous with conditional chaining).
 *
 * @param command - The full command string
 * @param exitCode - The process exit code
 * @returns Interpretation string, or undefined if no semantic meaning known
 */
export function interpretExitCode(command: string, exitCode: number): string | undefined {
  // Skip interpretation for conditional chains -- exit code semantics are ambiguous
  if (command.includes("&&") || command.includes("||")) return undefined;

  // For pipes, exit code comes from the LAST command (bash default)
  let targetCommand: string;
  if (command.includes("|")) {
    const pipeSegments = command.split("|");
    targetCommand = pipeSegments[pipeSegments.length - 1].trim();
  } else {
    targetCommand = command.trim();
  }

  const firstWord = targetCommand.split(/\s/)[0];
  const basename = firstWord.includes("/") ? firstWord.split("/").pop()! : firstWord;

  const codeMap = SEMANTIC_EXIT_CODES.get(basename);
  if (!codeMap) return undefined;
  return codeMap.get(exitCode);
}

