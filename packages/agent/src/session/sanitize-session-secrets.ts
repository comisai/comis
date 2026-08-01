// SPDX-License-Identifier: Apache-2.0
/**
 * Session-persistence secret projection and durable-file repair.
 *
 * The SDK persistence boundary projects secret-bearing values out of every
 * entry before its first write while leaving the current model/tool value
 * available in memory. The file repair keeps owner-only permissions and
 * cleans records written by older processes or unsupported write paths.
 *
 * Both paths run while the session write lock is held. A guarded SDK canary
 * fails the build if the private persistence seam changes.
 *
 * @module
 */

import { chmodSync, lstatSync, readFileSync } from "node:fs";
import { scrubSecretsFromText, type ComisLogger } from "@comis/core";
import { writeRegularFile } from "@comis/observability";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { formatValidationError } from "../safety/validation-error-formatter.js";

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
const SENSITIVE_ARG_NAMES =
  /(?:^|[_-])(?:api[_-]?key|apikey|secret|password|credential|auth[_-]?key|access[_-]?key|private[_-]?key|username|env[_-]?value|(?:access|auth|refresh|bearer|id|api|session|oauth|csrf|xsrf)[_-]?token)(?:$|[_-])/i;

/**
 * A parameter named exactly `token` — no qualifier to disambiguate it. Treated
 * as always-sensitive: on its own the word most often names a credential.
 */
const BARE_TOKEN_ARG_NAME = /^token$/i;

/**
 * Names carrying `token` as a component without a credential qualifier —
 * `range_token`, `page_token`, `continuation_token`. These are usually opaque
 * cursors or plain enums, so they are redacted only when the VALUE could
 * plausibly be a credential.
 *
 * Redacting one of these unconditionally is corrupting rather than merely
 * cautious: the placeholder is persisted, replayed into the model's context on
 * the next turn, and copied forward as a literal argument — the replay hazard
 * scrub-redacted-tool-calls.ts documents for `env_value`. Observed live against
 * an MCP tool whose `range_token` is a fixed date-range enum: three consecutive
 * schema-validation failures while paginating, each re-sending "[REDACTED]".
 */
const QUALIFIED_TOKEN_ARG_NAMES = /(?:^|[_-])token(?:$|[_-])/i;

/**
 * True when a value cannot plausibly be a credential: a short, all-lowercase
 * identifier such as an enum member or a cursor keyword. Anything longer,
 * mixed-case, or shaped like an encoded digest fails this test and stays
 * redacted. `looksLikeApiKey` still runs afterwards as a second line of defence.
 */
function isImplausibleSecretValue(value: string): boolean {
  if (value.length === 0 || value.length > 24) return false;
  if (!/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(value)) return false;
  if (/^[a-f0-9]{16,}$/.test(value)) return false; // lowercase hex digest
  return true;
}

/**
 * Whether an argument must be redacted on the strength of its NAME.
 * Value-blind for unambiguous credential names; value-gated for the ambiguous
 * `*_token` family so a public enum is not destroyed.
 */
function isSensitiveArgName(name: string, value: string): boolean {
  if (SENSITIVE_ARG_NAMES.test(name) || BARE_TOKEN_ARG_NAME.test(name)) return true;
  if (QUALIFIED_TOKEN_ARG_NAMES.test(name)) return !isImplausibleSecretValue(value);
  return false;
}

// eslint-disable-next-line no-restricted-syntax -- durable-session redaction sentinel (not the Pino censor literal)
const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Check if a string value looks like an API key.
 */
export function looksLikeApiKey(value: string): boolean {
  // eslint-disable-next-line no-restricted-syntax -- session-secret sentinel for "already-redacted" detection (not the Pino censor literal)
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
      // eslint-disable-next-line no-restricted-syntax -- session shell-command redaction sentinel (not the Pino censor literal)
      return "[REDACTED]";
    });
    result = replaced;
  }
  return [result, changed];
}

export interface PersistenceSecretProjection<T> {
  readonly value: T;
  readonly redactions: number;
}

function isSafePersistencePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === REDACTION_PLACEHOLDER
    || (trimmed.startsWith("${") && trimmed.endsWith("}"));
}

/**
 * A Comis-minted conversation reference: `cv_` plus 43 base64url chars.
 *
 * Mirrors `ConversationRefSchema`. Matched here so the projector can recognize
 * the shape without importing the schema into the persistence hot path.
 */
const CONVERSATION_REF_SHAPE = /^cv_[A-Za-z0-9_-]{43}$/u;

/**
 * Whether a field carries a structural identifier the projector must leave alone.
 *
 * A conversation ref is a machine-minted, fixed-shape identity — high-entropy by
 * construction and therefore indistinguishable from an API key to the entropy
 * heuristics below. Redacting it does not protect anything (it is derived from
 * already-stored conversation scope, not a credential) and it corrupts the record:
 * a persisted `conversationRef` of `[REDACTED]` no longer parses, so the
 * delivered-assistant idempotency scan skipped the stored attempt and appended a
 * duplicate on every retry.
 *
 * Deliberately narrow — the field name AND the exact ref shape must both hold, so
 * a credential parked under this key is still redacted.
 */
function isStructuralIdentifier(fieldName: string | undefined, value: string): boolean {
  return fieldName === "conversationRef" && CONVERSATION_REF_SHAPE.test(value);
}

function isToolProtocolIdentity(
  container: Record<string, unknown>,
  fieldName: string,
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  if (
    (fieldName === "name" || fieldName === "id")
    && (container.type === "toolCall" || container.type === "tool_use")
  ) {
    return true;
  }
  return (fieldName === "toolName" || fieldName === "toolCallId")
    && (
      container.role === "toolResult"
      || container.role === "tool"
      || (
        fieldName === "toolName"
        && container.status === "backgrounded"
        && typeof container.taskId === "string"
      )
    );
}

function projectPersistenceValue(
  value: unknown,
  fieldName: string | undefined,
  seen: WeakSet<object>,
): PersistenceSecretProjection<unknown> {
  if (typeof value === "string") {
    const formattedValidation = formatValidationError(value);
    const safeText = formattedValidation ?? value;
    const validationRedactions = formattedValidation === null ? 0 : 1;
    if (
      fieldName !== undefined
      && safeText.length > 0
      && isSensitiveArgName(fieldName, safeText)
      && !isSafePersistencePlaceholder(safeText)
    ) {
      return { value: REDACTION_PLACEHOLDER, redactions: 1 };
    }
    if (isStructuralIdentifier(fieldName, safeText)) {
      return { value: safeText, redactions: validationRedactions };
    }
    if (looksLikeApiKey(safeText)) {
      return { value: REDACTION_PLACEHOLDER, redactions: 1 };
    }
    const scrubbed = scrubSecretsFromText(safeText);
    return {
      value: scrubbed.text,
      redactions: validationRedactions + scrubbed.redactions,
    };
  }
  if (value === null || typeof value !== "object") {
    return { value, redactions: 0 };
  }
  if (seen.has(value)) {
    return { value, redactions: 0 };
  }
  if (Array.isArray(value)) {
    seen.add(value);
    let redactions = 0;
    let changed = false;
    const projected = value.map((item) => {
      const next = projectPersistenceValue(item, undefined, seen);
      redactions += next.redactions;
      if (next.value !== item) changed = true;
      return next.value;
    });
    seen.delete(value);
    return {
      value: changed ? projected : value,
      redactions,
    };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { value, redactions: 0 };
  }

  seen.add(value);
  let redactions = 0;
  let changed = false;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // Tool names and call IDs are protocol identities, not unstructured content.
    // Redacting an entropy-shaped identity corrupts durable replay and can make
    // the provider reject the next request before it consumes the tool result.
    // Tool arguments and result content still traverse the secret scrubber.
    const next = isToolProtocolIdentity(value as Record<string, unknown>, key, item)
      ? { value: item, redactions: 0 }
      : projectPersistenceValue(item, key, seen);
    projected[key] = next.value;
    redactions += next.redactions;
    if (next.value !== item) changed = true;
  }
  seen.delete(value);
  return {
    value: changed ? projected : value,
    redactions,
  };
}

/**
 * Produce a secret-free persistence projection without mutating the live value
 * used by the current model/tool execution.
 */
export function projectSessionValueForPersistence<T>(
  value: T,
): PersistenceSecretProjection<T> {
  const projected = projectPersistenceValue(value, undefined, new WeakSet<object>());
  return {
    value: projected.value as T,
    redactions: projected.redactions,
  };
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
        // eslint-disable-next-line no-restricted-syntax -- gateway env_set already-redacted sentinel (not the Pino censor literal)
        args.env_value !== "[REDACTED]"
      ) {
        // eslint-disable-next-line no-restricted-syntax -- gateway env_set redaction value (not the Pino censor literal)
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
        {
          const val = args[key];
          // eslint-disable-next-line no-restricted-syntax -- session sensitive-arg already-redacted sentinel (not the Pino censor literal)
          if (typeof val === "string" && val !== "[REDACTED]" && val.length > 0
            && isSensitiveArgName(key, val)) {
            // eslint-disable-next-line no-restricted-syntax -- session sensitive-arg redaction (not the Pino censor literal)
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
          // eslint-disable-next-line no-restricted-syntax -- session api-key-pattern redaction (not the Pino censor literal)
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

  const fullProjection = projectSessionValueForPersistence(entry);
  if (fullProjection.redactions > 0) {
    return [JSON.stringify(fullProjection.value), true];
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
 * Restrict a JSONL session file to owner-only access and redact sensitive
 * tool parameters in place.
 *
 * This is an idempotent operation: running it multiple times on the same
 * file produces the same result (already-redacted values are not modified).
 *
 * @param sessionPath - Absolute path to the JSONL session file
 * @returns Number of lines that were sanitized
 */
function enforceSessionFileMode(sessionPath: string): Result<void, Error> {
  const statResult = tryCatch(() => lstatSync(sessionPath));
  if (!statResult.ok) return statResult;
  if (statResult.value.isSymbolicLink() || !statResult.value.isFile()) {
    return err(new Error("Session transcript path is not a regular file"));
  }
  if ((statResult.value.mode & 0o777) === 0o600) return ok(undefined);
  return tryCatch(() => chmodSync(sessionPath, 0o600));
}

export function sanitizeSessionSecrets(sessionPath: string, logger?: ComisLogger): number {
  let content: string;
  try {
    content = readFileSync(sessionPath, "utf-8");
  } catch {
    return 0; // File doesn't exist or can't be read
  }

  const modeResult = enforceSessionFileMode(sessionPath);
  if (!modeResult.ok) {
    logger?.warn(
      {
        err: modeResult.error,
        hint: "Ensure the session transcript is a writable regular file owned by the daemon service user",
        errorKind: "resource" as const,
        submodule: "session-secret-sanitizer",
      },
      "Session transcript permission correction failed",
    );
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
    // Route through @comis/observability fs-safe substrate so the
    // rewritten session JSONL lands at mode 0o600 (file-mode confidentiality
    // invariant). `confinedBaseDir` is intentionally
    // omitted — the caller (`comis-session-manager.ts`) holds the
    // session write-lock and constructs `sessionPath` via
    // `sessionKeyToPath` + the SDK's `sessionBaseDir`, so the
    // ancestor-symlink defense lives at that boundary; this writer
    // remains a leaf consumer.
    //
    // Substrate Result.err is intentionally discarded: the contract is
    // best-effort — sanitization runs inside the session manager's
    // try/finally while the write lock is held, and must never throw out
    // of that finally. The next reader still observes the unredacted
    // on-disk state if the rewrite fails, but the `finally` semantics
    // around the JSONL write lock are preserved.
    writeRegularFile({ path: sessionPath, content: lines.join("\n") });
  }

  return totalChanged;
}
