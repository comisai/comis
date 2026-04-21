// SPDX-License-Identifier: Apache-2.0
/**
 * Exec command security validation pipeline.
 *
 * Pure validation module -- no I/O, no state, no process management.
 * Every function takes a string and returns `string | null` (error message
 * or null for valid). The pipeline entry point `validateExecCommand()`
 * composes all gates and is used by both `createExecTool()` and
 * `tool-metadata-registry.ts` pre-flight registration.
 *
 * @module
 */

import path from "node:path";
import os from "node:os";

// --------------------------------------------------------------------------
// ShellQuoteTracker -- quote-aware state machine
// --------------------------------------------------------------------------

type QuoteState = "NORMAL" | "SINGLE_QUOTE" | "DOUBLE_QUOTE" | "BACKTICK";

/**
 * Character-by-character shell quote state machine. Tracks whether the current
 * position is inside single quotes, double quotes, backticks, or normal context.
 * Handles backslash escaping in NORMAL and DOUBLE_QUOTE states (not SINGLE_QUOTE).
 */
export class ShellQuoteTracker {
  state: QuoteState = "NORMAL";
  escaped = false;

  feed(char: string): void {
    if (this.escaped) {
      this.escaped = false;
      return;
    }

    switch (this.state) {
      case "NORMAL":
        if (char === "\\") {
          this.escaped = true;
        } else if (char === "'") {
          this.state = "SINGLE_QUOTE";
        } else if (char === '"') {
          this.state = "DOUBLE_QUOTE";
        } else if (char === "`") {
          this.state = "BACKTICK";
        }
        break;
      case "SINGLE_QUOTE":
        // No escaping in single quotes -- only ' exits
        if (char === "'") this.state = "NORMAL";
        break;
      case "DOUBLE_QUOTE":
        if (char === "\\") {
          this.escaped = true;
        } else if (char === '"') {
          this.state = "NORMAL";
        }
        break;
      case "BACKTICK":
        if (char === "\\") {
          this.escaped = true;
        } else if (char === "`") {
          this.state = "NORMAL";
        }
        break;
    }
  }

  isInSingleQuote(): boolean {
    return this.state === "SINGLE_QUOTE";
  }
}

// --------------------------------------------------------------------------
// Shell substitution detection
// --------------------------------------------------------------------------

/**
 * Detect shell substitution patterns ($(), backticks, <()/>()) that could
 * enable injection. Single-quoted strings are excluded. Uses ShellQuoteTracker
 * for escape and quote-context awareness.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if dangerous substitution found, null if safe
 */
export function detectShellSubstitutions(command: string): string | null {
  const tracker = new ShellQuoteTracker();

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Check BEFORE feeding to tracker so we can use current state
    if (!tracker.escaped && !tracker.isInSingleQuote()) {
      // Command substitution: $(
      if (
        ch === "$" &&
        i + 1 < command.length &&
        command[i + 1] === "(" &&
        tracker.state !== "BACKTICK"
      ) {
        return "Shell command substitution $(...) detected";
      }

      // Backtick substitution (only in NORMAL or DOUBLE_QUOTE)
      if (
        ch === "`" &&
        (tracker.state === "NORMAL" || tracker.state === "DOUBLE_QUOTE")
      ) {
        return "Backtick substitution detected";
      }

      // Process substitution: <( or >(
      if (
        (ch === "<" || ch === ">") &&
        i + 1 < command.length &&
        command[i + 1] === "(" &&
        tracker.state === "NORMAL"
      ) {
        return "Process substitution detected";
      }

      // Zsh process substitution: =( at word boundary
      if (
        ch === "=" &&
        i + 1 < command.length &&
        command[i + 1] === "(" &&
        tracker.state === "NORMAL"
      ) {
        return "Zsh process substitution =(…) detected";
      }

      // Zsh equals expansion: =cmd at word start (not VAR=val)
      if (
        ch === "=" &&
        tracker.state === "NORMAL" &&
        (i === 0 || /[\s;&|]/.test(command[i - 1])) &&
        i + 1 < command.length &&
        /[a-zA-Z_]/.test(command[i + 1])
      ) {
        return "Zsh equals expansion (=cmd) detected";
      }
    }

    tracker.feed(ch);
  }

  return null;
}

// --------------------------------------------------------------------------
// Compound command splitting
// --------------------------------------------------------------------------

/**
 * Split a shell command on compound operators (&&, ||, ;, |, &) with
 * quote awareness. Returns individual command segments for independent
 * validation.
 *
 * @param command - The raw shell command to split
 * @returns Array of command segments (trimmed, non-empty)
 */
export function splitCommandSegments(command: string): string[] {
  const tracker = new ShellQuoteTracker();
  const segments: string[] = [];
  let current = "";

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (!tracker.escaped && tracker.state === "NORMAL") {
      // Two-char operators first
      if (i + 1 < command.length) {
        const two = command[i] + command[i + 1];
        if (two === "&&" || two === "||") {
          segments.push(current);
          current = "";
          i++; // skip second char
          continue;
        }
      }
      // Single-char operators
      if (ch === ";" || ch === "|" || ch === "&") {
        segments.push(current);
        current = "";
        continue;
      }
    }

    tracker.feed(ch);
    current += ch;
  }

  segments.push(current);
  return segments.filter((s) => s.trim() !== "").map((s) => s.trim());
}

// --------------------------------------------------------------------------
// Dangerous pipe target detection
// --------------------------------------------------------------------------

/**
 * Commands that are dangerous as pipe targets (data flows INTO them).
 * Standalone use is legitimate -- only the pipe-to pattern is suspicious.
 */
const DANGEROUS_PIPE_TARGETS = new Set([
  // Shell interpreters (migrated from Category C denylist)
  "sh", "bash", "zsh", "dash", "fish", "csh", "tcsh", "ksh",
  // Network exfiltration tools
  "nc", "ncat", "socat", "telnet", "curl", "wget",
]);

/**
 * Detect pipes to dangerous targets (shell interpreters, network tools).
 * Runs on the FULL command before compound splitting, because splitCommandSegments
 * splits on | and removes the pipe context from individual segments.
 *
 * @param command - The full raw shell command
 * @returns Error message if dangerous pipe target found, null if safe
 */
export function detectDangerousPipeTargets(command: string): string | null {
  if (!command.includes("|")) return null;

  const segments = splitCommandSegments(command);
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i].trimStart();
    const firstWord = segment.split(/\s/)[0];
    const basename = firstWord.includes("/")
      ? firstWord.split("/").pop()!
      : firstWord;
    if (DANGEROUS_PIPE_TARGETS.has(basename)) {
      return `Pipe to '${basename}' detected (potential data exfiltration or remote code execution). Piping data to shell interpreters or network tools is blocked.`;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * Environment variables safe to pass through to exec subprocesses.
 * Any env var NOT in this set is blocked when passed via the `env` parameter.
 * Allowlist (fail-closed): new attack variables are blocked by default.
 */
export const SAFE_ENV_VARS = new Set([
  // Locale & display
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY",
  "TZ", "TERM", "COLORTERM", "FORCE_COLOR", "NO_COLOR",
  "COLUMNS", "LINES",

  // Runtime behavior (non-executable)
  "NODE_ENV", "RUST_BACKTRACE", "RUST_LOG",
  "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED",
  "DEBUG", "VERBOSE", "LOG_LEVEL", "CI",

  // Build/package config (path-setting, no code execution)
  "HOME", "USER", "SHELL", "PATH",
  "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",

  // Platform signals
  "LS_COLORS", "CLICOLOR", "CLICOLOR_FORCE",
]);

export const SAFE_ENV_PREFIXES = ["LC_"];

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
    reason: "Shell source executes arbitrary script file",
  },
  {
    pattern: /^\.\s+\//,
    reason: "POSIX source (.) executes arbitrary script file",
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
];

// --------------------------------------------------------------------------
// Dangerous path protection constants
// --------------------------------------------------------------------------

/** Mutation commands that are blocked from targeting protected system paths. */
export const MUTATION_COMMANDS = new Set([
  "rm", "chmod", "chown", "mv", "cp", "truncate", "shred", "tee", "install", "ln",
]);

/** Exact system paths that mutation commands cannot target. */
export const PROTECTED_PATHS = new Set([
  "/", "/bin", "/sbin", "/usr/bin", "/usr/sbin",
  "/boot", "/dev", "/etc",
  "/lib", "/lib64", "/lib32",
  "/opt", "/proc", "/root", "/sys",
  "/usr", "/var", "/home", "/tmp",
  "/var/log", "/var/tmp", "/usr/local",
]);

/** Path prefixes where mutation commands are blocked on any subpath. */
export const PROTECTED_PATH_PREFIXES = [
  "/etc/",
  "/boot/",
  "/proc/",
  "/sys/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/local/",
  "/var/log/",
  "/var/tmp/",
];

/**
 * Check whether a command segment contains a mutation command targeting a
 * protected system path. Path traversal via `..` is normalized before checking.
 * Only absolute paths and `~`-prefixed paths are evaluated -- relative paths
 * pass through unchecked.
 *
 * @param segment - A single command segment (after compound splitting)
 * @returns Error message if a protected path is targeted, null if safe
 */
export function validateDangerousPaths(segment: string): string | null {
  const words = segment.trim().split(/\s+/);
  if (words.length === 0) return null;

  // Extract base command (strip path prefix like /usr/bin/rm -> rm)
  const baseCmd = words[0].includes("/") ? words[0].split("/").pop()! : words[0];
  if (!MUTATION_COMMANDS.has(baseCmd)) return null;

  // Check positional args (skip flags starting with -)
  for (let i = 1; i < words.length; i++) {
    const arg = words[i];
    if (arg.startsWith("-")) continue;

    // Only check absolute paths and ~-prefixed paths
    if (!arg.startsWith("/") && !arg.startsWith("~")) continue;

    // Normalize: expand ~ to homedir, resolve .. via path.resolve()
    let normalized = arg;
    if (normalized.startsWith("~")) {
      normalized = normalized.replace(/^~/, os.homedir());
    }
    normalized = path.resolve(normalized);

    // Check exact match against PROTECTED_PATHS
    if (PROTECTED_PATHS.has(normalized)) {
      return `Mutation command '${baseCmd}' targets protected path '${normalized}'`;
    }

    // Check prefix match against PROTECTED_PATH_PREFIXES
    for (const prefix of PROTECTED_PATH_PREFIXES) {
      if (normalized.startsWith(prefix)) {
        return `Mutation command '${baseCmd}' targets protected path '${normalized}' (under ${prefix})`;
      }
    }
  }

  return null;
}

// --------------------------------------------------------------------------
// Redirect target protection constants
// --------------------------------------------------------------------------

/**
 * Additional path prefixes checked ONLY for redirect targets.
 * Stored with ~ prefix -- resolved to actual homedir at validation time.
 */
const REDIRECT_SENSITIVE_PATTERNS = [
  "~/.ssh/",
  "~/.gnupg/",
  "~/.comis/",
  "~/.config/",
  "~/.bashrc",
  "~/.bash_profile",
  "~/.profile",
  "~/.zshrc",
];

/** Exported for testing -- the raw ~ patterns for redirect-sensitive paths. */
export const REDIRECT_SENSITIVE_PREFIXES: string[] = REDIRECT_SENSITIVE_PATTERNS;

/**
 * Check whether a command segment contains output redirections (>, >>, 2>, &>)
 * targeting protected system paths or sensitive user paths. Quote-aware via
 * ShellQuoteTracker -- redirects inside single/double quotes are ignored.
 *
 * @param segment - A single command segment (after compound splitting)
 * @returns Error message if a protected redirect target found, null if safe
 */
export function validateRedirectTargets(segment: string): string | null {
  const tracker = new ShellQuoteTracker();
  const homedir = os.homedir();

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    // Only detect redirects in NORMAL state (not inside quotes)
    if (!tracker.escaped && tracker.state === "NORMAL") {
      let isRedirect = false;
      let skipChars = 0;

      if (ch === ">" && (i === 0 || segment[i - 1] !== "\\")) {
        // > or >>
        isRedirect = true;
        if (i + 1 < segment.length && segment[i + 1] === ">") {
          skipChars = 1; // >>
        }
      } else if (ch === "&" && i + 1 < segment.length && segment[i + 1] === ">") {
        // &> or &>>
        isRedirect = true;
        skipChars = 1;
        if (i + 2 < segment.length && segment[i + 2] === ">") {
          skipChars = 2;
        }
      } else if (ch === "2" && i + 1 < segment.length && segment[i + 1] === ">") {
        // 2> or 2>>
        isRedirect = true;
        skipChars = 1;
        if (i + 2 < segment.length && segment[i + 2] === ">") {
          skipChars = 2;
        }
      }

      if (isRedirect) {
        // Skip the operator characters
        let targetStart = i + 1 + skipChars;
        // Skip whitespace after operator
        while (targetStart < segment.length && segment[targetStart] === " ") {
          targetStart++;
        }
        // Extract target path (until whitespace or end)
        let targetEnd = targetStart;
        while (targetEnd < segment.length && segment[targetEnd] !== " ") {
          targetEnd++;
        }
        const target = segment.slice(targetStart, targetEnd);

        if (target && (target.startsWith("/") || target.startsWith("~"))) {
          // Normalize path: expand ~ and resolve traversals
          let normalized = target;
          if (normalized.startsWith("~")) {
            normalized = normalized.replace(/^~/, homedir);
          }
          normalized = path.resolve(normalized);

          // Check against PROTECTED_PATHS (exact match)
          if (PROTECTED_PATHS.has(normalized)) {
            return `Output redirection targets protected path '${normalized}'`;
          }

          // Check against PROTECTED_PATH_PREFIXES (system directories)
          for (const prefix of PROTECTED_PATH_PREFIXES) {
            if (normalized.startsWith(prefix)) {
              return `Output redirection targets protected path '${normalized}' (under ${prefix})`;
            }
          }

          // Check against REDIRECT_SENSITIVE_PATTERNS (user paths)
          for (const pattern of REDIRECT_SENSITIVE_PATTERNS) {
            let resolvedPattern = pattern;
            if (resolvedPattern.startsWith("~")) {
              resolvedPattern = resolvedPattern.replace(/^~/, homedir);
            }
            // For directory patterns (ending with /), check startsWith
            // For exact file patterns (like ~/.bashrc), check equality or startsWith
            if (normalized === resolvedPattern || normalized.startsWith(resolvedPattern)) {
              return `Output redirection targets sensitive user path '${normalized}'`;
            }
          }
        }
      }
    }

    tracker.feed(ch);
  }

  return null;
}

// --------------------------------------------------------------------------
// Gate 0: Invisible character sanitization
// --------------------------------------------------------------------------

/**
 * Regex matching invisible or ambiguous Unicode characters that can bypass
 * regex-based validation. Ranges carefully exclude tab (0x09) and CR (0x0d).
 *
 * Ranges:
 * - \x00-\x08: C0 controls before tab
 * - \x0a-\x0c: LF, VT, FF (newline in command = injection vector)
 * - \x0e-\x1f: C0 controls after CR (SO, SI, DLE, ..., US)
 * - \u00A0: non-breaking space
 * - \u00AD: soft hyphen
 * - \u200B-\u200F: zero-width space, ZWNJ, ZWJ, LTR mark, RTL mark
 * - \u2060: word joiner
 * - \uFEFF: BOM / zero-width no-break space
 * - \x7F: DEL character
 * - \u1680: Ogham space mark
 * - \u2000-\u200A: en/em/thin/hair/figure spaces
 * - \u2028: line separator
 * - \u2029: paragraph separator
 * - \u202F: narrow no-break space
 * - \u205F: medium mathematical space
 * - \u3000: ideographic space
 */
const INVISIBLE_CHAR_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0a-\x0c\x0e-\x1f\x7F\u00A0\u00AD\u1680\u200B-\u200F\u2000-\u200A\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/;

/**
 * Reject commands containing invisible or ambiguous characters that can bypass
 * regex-based validation. First gate in the validation pipeline.
 *
 * @param command - The raw shell command to sanitize
 * @returns Error message if dangerous characters found, null if clean
 */
/**
 * Detect shell patterns where the LLM is trying to write a file
 * (cat/tee/echo/printf heredoc, or a `>` redirection). Used to swap
 * the Gate-0 newline-rejection hint toward the `write` tool instead of
 * `python3 -` with stdin — pointing the LLM at the correct alternative
 * prevents it from retrying more cat-heredocs (observed NVDA run:
 * 12 consecutive `[invalid_value]` failures before the exec tool was
 * circuit-broken).
 */
const FILE_WRITE_HEURISTIC =
  /^\s*(?:cat|tee|echo|printf)\b|>\s*["']?[^|<&\s]+\s*(?:<<|$)/;

export function sanitizeCommandInput(command: string): string | null {
  const match = INVISIBLE_CHAR_REGEX.exec(command);
  if (match) {
    const cp = match[0].codePointAt(0)!;
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    let msg = `Command contains invisible/ambiguous character U+${hex} at position ${match.index}. This can bypass security validation. Remove the character and retry.`;
    if (cp === 0x0a) {
      // Disambiguate: is the LLM writing a file (use `write` tool) or
      // running a multi-line script (use python3/node/bash with stdin)?
      // The heuristic fires on the line the newline was rejected on, so
      // the hint matches the LLM's actual intent.
      const looksLikeFileWrite = FILE_WRITE_HEURISTIC.test(command);
      msg += looksLikeFileWrite
        ? ` To write files, use the 'write' tool (or 'edit' for targeted changes) instead of a shell heredoc in exec.`
        : ` For multi-line scripts, use command='python3 -' (or 'node -', 'bash -') with the 'input' parameter for the script body.`;
    }
    return msg;
  }
  return null;
}

/**
 * Auto-extract heredoc patterns into command + input before security validation.
 *
 * LLMs frequently send heredoc syntax like `python3 - <<'PY'\nscript\nPY` to the
 * exec tool's command parameter. Gate 0 blocks newlines in commands (correctly,
 * for injection prevention). This function detects the heredoc pattern and splits
 * it into a clean command (`python3 -`) and input (the script body), allowing
 * the existing `input` stdin parameter to carry the script content.
 *
 * Only matches known stdin-capable interpreters followed by ` -` (stdin marker).
 * Returns null if no heredoc detected or if input is already provided.
 */
export function extractHeredoc(
  command: string,
  input: string | undefined,
): { command: string; input: string } | null {
  if (input) return null;

  const match = command.match(
    /^((?:python3?|node|bash|sh|ruby|perl|php)\s+-)\s*<<-?['"]?([A-Za-z_]\w*)['"]?\n([\s\S]*)\n\2\s*$/,
  );
  if (!match) return null;

  return { command: match[1], input: match[3] };
}

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
// Gate 2: Environment variable validation (moved from exec-tool.ts)
// --------------------------------------------------------------------------

/**
 * Validate environment variables against the security allowlist.
 * Only variables in SAFE_ENV_VARS (or matching SAFE_ENV_PREFIXES)
 * are permitted. Returns an error message for the first blocked
 * variable, null if all are safe.
 */
export function validateEnvVars(env: Record<string, string>): string | null {
  for (const key of Object.keys(env)) {
    if (SAFE_ENV_VARS.has(key)) continue;
    if (SAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    return `Environment variable '${key}' is not in the allowed list. Only safe variables (locale, display, build config) can be overridden.`;
  }
  return null;
}

// --------------------------------------------------------------------------
// Gate 6: IFS injection detection
// --------------------------------------------------------------------------

/**
 * Detect IFS variable usage that could bypass argument splitting security.
 * Blocks $IFS direct references and ${...IFS...} parameter expansions.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if IFS injection found, null if safe
 */
export function detectIFSInjection(command: string): string | null {
  if (/\$IFS|\$\{[^}]*IFS|\bIFS=/.test(command)) {
    return "Command contains IFS variable usage which could bypass security validation.";
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
// Gate 8: Brace expansion detection
// --------------------------------------------------------------------------

/**
 * Check if position in string is backslash-escaped by counting consecutive
 * backslashes before it. Odd count = escaped.
 */
function isEscaped(content: string, pos: number): boolean {
  let count = 0;
  let i = pos - 1;
  while (i >= 0 && content[i] === "\\") {
    count++;
    i--;
  }
  return count % 2 === 1;
}

/**
 * Detect dangerous brace expansion patterns in unquoted shell context.
 * Blocks comma-based ({rm,-rf,/}) and range-based ({a..z}) patterns while
 * allowing parameter expansion (${HOME}), quoted braces, and single braces
 * without comma/dots.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if dangerous brace expansion found, null if safe
 */
export function detectBraceExpansion(command: string): string | null {
  const tracker = new ShellQuoteTracker();

  // Build string of unquoted content, tracking positions
  let unquoted = "";
  const posMap: number[] = []; // maps unquoted index -> original command index

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const wasNormal = tracker.state === "NORMAL" && !tracker.escaped;
    tracker.feed(ch);
    if (wasNormal && tracker.state === "NORMAL") {
      unquoted += ch;
      posMap.push(i);
    } else if (wasNormal) {
      // Character triggered state change (e.g., opening quote) -- not unquoted content
    }
  }

  // Scan unquoted content for brace expansion patterns
  let depth = 0;
  let outerStart = -1;

  for (let i = 0; i < unquoted.length; i++) {
    const ch = unquoted[i];

    if (ch === "{" && !isEscaped(unquoted, i)) {
      // Skip parameter expansion: ${ is NOT brace expansion
      if (i > 0 && unquoted[i - 1] === "$") continue;

      if (depth === 0) outerStart = i;
      depth++;
    } else if (ch === "}" && !isEscaped(unquoted, i) && depth > 0) {
      depth--;
      if (depth === 0 && outerStart >= 0) {
        // Extract content between outermost braces
        const inner = unquoted.slice(outerStart + 1, i);
        // Check for comma-based expansion: {a,b} or {rm,-rf,/}
        if (inner.includes(",")) {
          return `Brace expansion with comma pattern detected: {${inner.slice(0, 40)}}`;
        }
        // Check for range expansion: {a..z} or {1..10}
        if (/\.\./.test(inner)) {
          return `Brace expansion with range pattern detected: {${inner.slice(0, 40)}}`;
        }
        outerStart = -1;
      }
    }
  }

  return null;
}

// --------------------------------------------------------------------------
// Gate 11: /proc/environ access detection
// --------------------------------------------------------------------------

/**
 * Detect access to /proc/{pid}/environ which leaks environment variables
 * including secrets. Matches /proc/self/environ, /proc/1/environ, etc.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if proc environ access found, null if safe
 */
export function detectProcEnvironAccess(command: string): string | null {
  if (/\/proc\/.*\/environ/.test(command)) {
    return "Access to /proc/*/environ is blocked (environment variable exfiltration).";
  }
  return null;
}

// --------------------------------------------------------------------------
// Gate 12: Comment-quote desync detection
// --------------------------------------------------------------------------

/**
 * Detect comment-quote desync patterns where an unquoted # character is
 * followed by quote characters in the same line. This can be used to inject
 * commands via multi-line input where the first line's comment contains
 * unbalanced quotes that change parsing of subsequent lines.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if comment-quote desync found, null if safe
 */
export function detectCommentQuoteDesync(command: string): string | null {
  const tracker = new ShellQuoteTracker();

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Check for unquoted # (shell comment start)
    if (ch === "#" && tracker.state === "NORMAL" && !tracker.escaped) {
      // Scan rest of line for quote characters
      const rest = command.slice(i + 1);
      const lineEnd = rest.indexOf("\n");
      const commentContent = lineEnd >= 0 ? rest.slice(0, lineEnd) : rest;
      if (/['"]/.test(commentContent)) {
        return "Comment-quote desync detected: unquoted # followed by quote characters could enable injection.";
      }
      // Skip to end of line since it's a comment
      if (lineEnd >= 0) {
        i += lineEnd + 1;
        continue;
      }
      break; // rest of command is comment
    }

    tracker.feed(ch);
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
