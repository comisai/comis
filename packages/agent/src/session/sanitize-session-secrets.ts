/**
 * Post-execution JSONL secret sanitizer.
 *
 * Scans a session JSONL file for tool call blocks that contain sensitive
 * parameters (e.g., env_value in gateway env_set) and rewrites the file
 * with those values replaced by "[REDACTED]".
 *
 * Called after execution completes while the session write lock is still
 * held, so no concurrent reads can observe the unsanitized data window.
 *
 * Why post-execution rather than pre-write:
 * - The pi-coding-agent SDK writes tool_use blocks to JSONL synchronously
 *   via appendFileSync BEFORE calling tool.execute(). There is no SDK hook
 *   to intercept writes before they hit disk.
 * - Wrapping SessionManager to proxy appendMessage() is fragile and would
 *   break if the SDK adds new write paths.
 * - Post-execution rewrite within the lock is simple, reliable, and correct.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// API key pattern detection
// ---------------------------------------------------------------------------

/**
 * Well-known API key prefixes and patterns.
 * Each entry is a regex that matches the full value string.
 * Order: most specific first, generic catch-all last.
 */
const API_KEY_PATTERNS: RegExp[] = [
  /^AIza[A-Za-z0-9_-]{30,}$/,       // Google / Gemini API key
  /^sk-[A-Za-z0-9]{20,}$/,           // OpenAI / Anthropic style
  /^sk-ant-[A-Za-z0-9-]{20,}$/,      // Anthropic explicit
  /^sk-proj-[A-Za-z0-9-]{20,}$/,     // OpenAI project key
  /^gsk_[A-Za-z0-9]{20,}$/,          // Groq API key
  /^xai-[A-Za-z0-9]{20,}$/,          // xAI / Grok API key
  /^tvly-[A-Za-z0-9]{20,}$/,         // Tavily API key
  /^glg-[A-Za-z0-9-]{20,}$/,         // Google Cloud
  /^ghp_[A-Za-z0-9]{36,}$/,          // GitHub personal access token
  /^github_pat_[A-Za-z0-9_]{20,}$/,  // GitHub fine-grained PAT
  /^Bearer\s+[A-Za-z0-9._-]{20,}$/,  // Bearer tokens in commands
];

/** Argument names that are always sensitive regardless of value pattern. */
const SENSITIVE_ARG_NAMES = /^(api[_-]?key|apikey|token|secret|password|credential|auth[_-]?key|access[_-]?key|private[_-]?key)$/i;

/**
 * Check if a string value looks like an API key.
 */
export function looksLikeApiKey(value: string): boolean {
  if (value === "[REDACTED]") return false;
  return API_KEY_PATTERNS.some((re) => re.test(value));
}

/**
 * Non-anchored versions of API_KEY_PATTERNS for scanning within larger strings.
 * Uses word boundaries instead of ^ and $ to find keys embedded in commands.
 */
const API_KEY_PATTERNS_INLINE: RegExp[] = API_KEY_PATTERNS
  .filter((re) => !re.source.startsWith("^Bearer"))  // Skip Bearer — too noisy in commands
  .map((re) => {
    // Strip ^ and $ anchors and make global
    const inner = re.source.replace(/^\^/, "").replace(/\$$/, "");
    return new RegExp(inner, "g");
  });

/**
 * Redact API key patterns found in a shell command string.
 * Replaces the key portion with [REDACTED] while preserving command structure.
 */
function redactKeysInCommand(command: string): [string, boolean] {
  let changed = false;
  let result = command;
  for (const re of API_KEY_PATTERNS_INLINE) {
    // Reset lastIndex for global regex
    re.lastIndex = 0;
    const replaced = result.replace(re, () => {
      changed = true;
      return "[REDACTED]";
    });
    result = replaced;
  }
  return [result, changed];
}

// ---------------------------------------------------------------------------
// Sensitive tool parameter rules
// ---------------------------------------------------------------------------

/**
 * Rule that identifies a sensitive tool parameter and returns a sanitized copy.
 * Each rule checks a parsed toolCall block and returns true if it matched
 * (and mutated the arguments in place to redact sensitive values).
 */
interface SanitizationRule {
  /** Human-readable name for logging/debugging. */
  name: string;
  /**
   * Check if this toolCall block contains sensitive data.
   * If so, mutate `args` in place to redact values and return true.
   */
  match(toolName: string, args: Record<string, unknown>): boolean;
}

const SANITIZATION_RULES: SanitizationRule[] = [
  // Rule 1: gateway env_set (original rule)
  {
    name: "gateway:env_set",
    match(toolName, args) {
      if (
        toolName === "gateway" &&
        args.action === "env_set" &&
        "env_value" in args &&
        args.env_value !== "[REDACTED]"
      ) {
        args.env_value = "[REDACTED]";
        return true;
      }
      return false;
    },
  },

  // Rule 2: Sensitive argument names in ANY tool call
  // Catches: apiKey, token, secret, password, etc.
  {
    name: "sensitive-arg-names",
    match(_toolName, args) {
      let changed = false;
      for (const key of Object.keys(args)) {
        if (SENSITIVE_ARG_NAMES.test(key)) {
          const val = args[key];
          if (typeof val === "string" && val !== "[REDACTED]" && val.length > 0) {
            args[key] = "[REDACTED]";
            changed = true;
          }
        }
      }
      return changed;
    },
  },

  // Rule 3: API key patterns in ANY string argument value
  // Catches: Google AIza*, OpenAI sk-*, Groq gsk_*, etc.
  {
    name: "api-key-patterns",
    match(_toolName, args) {
      let changed = false;
      for (const key of Object.keys(args)) {
        const val = args[key];
        if (typeof val === "string" && looksLikeApiKey(val)) {
          args[key] = "[REDACTED]";
          changed = true;
        }
      }
      return changed;
    },
  },

  // Rule 4: API keys embedded in exec/bash command strings
  {
    name: "exec-command-keys",
    match(toolName, args) {
      if (toolName !== "exec" && toolName !== "bash") return false;
      const cmd = args.command;
      if (typeof cmd !== "string") return false;

      const [redacted, changed] = redactKeysInCommand(cmd);
      if (changed) {
        args.command = redacted;
      }
      return changed;
    },
  },
];

// ---------------------------------------------------------------------------
// Core sanitizer
// ---------------------------------------------------------------------------

/**
 * Sanitize a single JSONL line, returning the (possibly modified) line.
 * Returns the original line unchanged if no sensitive data was found.
 *
 * @returns [sanitizedLine, didChange]
 */
function sanitizeLine(line: string): [string, boolean] {
  if (!line.trim()) return [line, false];

  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return [line, false]; // Malformed line -- leave as-is
  }

  if (entry.type !== "message") return [line, false];

  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) return [line, false];

  // Check assistant messages for toolCall content blocks
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    let changed = false;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type !== "toolCall" && block.type !== "tool_use") continue;

      const toolName = block.name as string;
      const args = (block.arguments ?? block.input) as Record<string, unknown> | undefined;
      if (!toolName || !args) continue;

      for (const rule of SANITIZATION_RULES) {
        if (rule.match(toolName, args)) {
          changed = true;
        }
      }
    }
    if (changed) {
      return [JSON.stringify(entry), true];
    }
  }

  // Check toolResult messages for leaked sensitive values in text content
  if (msg.role === "toolResult" && Array.isArray(msg.content)) {
    // Tool results from gateway env_set already strip the value on the tool side,
    // but defense-in-depth: check for any result that might echo back secrets.
    // We don't redact here because we can't know which text is secret vs. normal.
    // The gateway tool already handles this (strips value from result).
  }

  return [line, false];
}

/**
 * Scan a JSONL session file and redact sensitive tool parameters in place.
 *
 * This is an idempotent operation: running it multiple times on the same
 * file produces the same result (already-redacted values are not modified).
 *
 * @param sessionPath - Absolute path to the JSONL session file
 * @returns Number of lines that were sanitized
 */
export function sanitizeSessionSecrets(sessionPath: string): number {
  let content: string;
  try {
    content = readFileSync(sessionPath, "utf-8");
  } catch {
    return 0; // File doesn't exist or can't be read
  }

  const lines = content.split("\n");
  let totalChanged = 0;

  for (let i = 0; i < lines.length; i++) {
    const [sanitized, changed] = sanitizeLine(lines[i]);
    if (changed) {
      lines[i] = sanitized;
      totalChanged++;
    }
  }

  if (totalChanged > 0) {
    writeFileSync(sessionPath, lines.join("\n"), "utf-8");
  }

  return totalChanged;
}
