// SPDX-License-Identifier: Apache-2.0
/**
 * Exec command security — sandbox / env-var / path-protection primitives
 * (Phase 43 split per FILE-SPLIT-11).
 *
 * Extracted from `exec-security.ts` (1,153L monolith) on 2026-05-16. Owns
 * the low-level building blocks consumed by pre-check + allowlist:
 *   - ShellQuoteTracker (character-by-character quote-state machine)
 *   - SAFE_ENV_VARS, SAFE_ENV_PREFIXES + validateEnvVars
 *   - splitCommandSegments (compound-operator split)
 *   - MUTATION_COMMANDS / PROTECTED_PATHS / PROTECTED_PATH_PREFIXES /
 *     REDIRECT_SENSITIVE_PREFIXES + validateDangerousPaths + validateRedirectTargets
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
// SAFE env vars (allowlist)
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
