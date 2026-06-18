// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical log field vocabulary + structural Comis logger contract.
 *
 * These contracts live in @comis/core so non-daemon packages (agent,
 * channels, gateway, skills, scheduler) can import the structural
 * ComisLogger interface without coupling to @comis/infra.
 *
 * The Pino-backed runtime implementation lives in @comis/infra and is
 * assignable to ComisLogger (proven by
 * `expectTypeOf<PinoComisLogger>().toExtend<ComisLogger>()` in
 * `packages/infra/src/logging/__tests__/logger-contract.type-check.ts`).
 * Pino's runtime auto-redaction (apiKey, token, password, etc., 3 levels
 * deep) is a runtime feature of the Pino impl; this structural contract
 * does not (and cannot) enforce redaction.
 *
 * All LogFields are optional -- the interface serves as documentation and
 * type hints for structured logging calls. Subsystem code can pass
 * `Partial<LogFields>` to get autocomplete and type checking without
 * making any field mandatory.
 *
 * @module
 */

/** Valid Pino log level names (including custom audit level). */
export const VALID_LOG_LEVELS = new Set([
  "fatal", "error", "warn", "info", "audit", "debug", "trace", "silent",
]);

/** Validate a log level string against the known whitelist. */
export function isValidLogLevel(level: string): boolean {
  return VALID_LOG_LEVELS.has(level);
}

/**
 * Error classification for filtering and alerting.
 *
 * Categories:
 * - `config`       -- Configuration parsing, missing keys, schema violations
 * - `network`      -- TCP/HTTP failures, DNS resolution, connection resets
 * - `auth`         -- Authentication or authorization failures (401/403, bad token)
 * - `validation`   -- Input validation failures (bad request body, invalid params)
 * - `precondition` -- Caller violated a precondition (resource not in expected
 *                     state: e.g., "no active DAG conversation for this session").
 *                     Distinct from `validation` (which is input-shape failures);
 *                     classifying these as `warn`-level avoids polluting ERROR
 *                     alerting with routine caller-state mismatches.
 * - `timeout`      -- Operation exceeded deadline (LLM call, HTTP request, DB query)
 * - `resource`     -- Resource exhaustion (OOM, disk full, file descriptor limit)
 * - `dependency`   -- External service unavailable (LLM provider, embedding API)
 * - `internal`     -- Unexpected internal errors (assertion failures, logic bugs)
 * - `platform`     -- Chat platform API errors (Discord, Telegram, Slack rate limits)
 * - `sandbox_unavailable` -- No materializable OS sandbox jail (Linux bwrap) for a
 *                     fail-closed dynamic step (v2.26 Verified Learning skill
 *                     validation, SKILL-07). HONEST DEGRADATION, NOT a fault: the
 *                     work degrades to a reduced-coverage path (`static-only`)
 *                     rather than running unsandboxed — `Defer ≠ Retry`, so this
 *                     must NOT inflate failure metrics or trip a breaker.
 *
 * Closed 11-member union.
 */
export type ErrorKind =
  | "config"
  | "network"
  | "auth"
  | "validation"
  | "precondition"
  | "timeout"
  | "resource"
  | "dependency"
  | "internal"
  | "platform"
  | "sandbox_unavailable";

/**
 * Structural log-method signature.
 *
 * Pino's actual `LogFn` type is the overloaded
 *   `((obj: object, msg?: string, ...args: any[]): void) & ((msg: string, ...args: any[]): void)`.
 * Modeling the call signature with positional `...args: unknown[]` keeps
 * the structural contract:
 *   (a) compatible with Pino's overloaded LogFn at the call-site level
 *       (any caller passing `(obj, msg)` or `(msg)` resolves cleanly),
 *   (b) accepting of looser duck-type contracts in consumers
 *       (e.g., `(...args: unknown[]) => void` parameter-type call sites
 *       are assignable, because contravariant parameter checking
 *       collapses when the source type uses pure rest args).
 *
 * Pino runtime invariants (object-first logging;
 * never string-interpolate the message) are enforced by lint, not by
 * the structural contract.
 */
export type LogMethod = (...args: unknown[]) => void;

/**
 * Structural Comis logger contract -- Pino-free.
 *
 * Implementations (e.g., the Pino-backed @comis/infra logger) must be
 * assignable to this interface. The infra package's logger.ts retypes
 * ComisLogger as an alias of this contract; the type-assignability test
 * in `packages/infra/src/logging/__tests__/logger-contract.test.ts`
 * proves the Pino impl satisfies the structural shape via
 * `expectTypeOf<PinoComisLogger>().toExtend<CoreComisLogger>()`.
 *
 * Every WARN/ERROR call must include `errorKind`
 * (closed union, see ErrorKind above) and `hint` (actionable diagnostic).
 *
 * Pino redaction (`apiKey`, `token`, `password`, etc., 3 levels deep) is
 * a runtime feature of the Pino impl in @comis/infra; this structural
 * contract does not (and cannot) enforce redaction.
 */
export interface ComisLogger {
  /**
   * Current log level (one of `VALID_LOG_LEVELS`). Writable so the
   * daemon's `LogLevelManager` can re-tune levels at runtime via
   * `daemon.setLogLevel`. Pino's `Logger.level` satisfies this shape;
   * any other logger impl must also expose a writable `level: string`.
   */
  level: string;
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  audit: LogMethod;
  child(bindings: Record<string, unknown>): ComisLogger;
}

/**
 * Canonical structured log fields used across all Comis packages.
 *
 * Every field is optional. The interface exists to provide consistent
 * naming conventions and IDE autocompletion for log calls. Child loggers
 * bind a subset of these fields (e.g., `module`) so they appear on every
 * log line emitted through that logger.
 */
export interface LogFields {
  /** Agent identifier, present on all agent-scoped operations. */
  agentId: string;

  /** Distributed trace ID (UUID), injected by tracingMixin from AsyncLocalStorage. */
  traceId: string;

  /** Platform channel type (e.g., "telegram", "discord"). */
  channelType: string;

  /** Operation duration in milliseconds, required on boundary operations. */
  durationMs: number;

  /** Tool or skill name being executed. */
  toolName: string;

  /** RPC method, HTTP method, or operation name. */
  method: string;

  /**
   * Error object or message.
   *
   * Uses `err` (not `error`) to match Pino's standard error serializer,
   * which automatically extracts `message`, `stack`, and `type` from
   * Error objects when the field is named `err`.
   */
  err: unknown;

  /**
   * Actionable diagnostic hint for the agent.
   *
   * Required on all ERROR and WARN log lines. Should describe what the
   * operator or agent can do to resolve the issue, not just what failed.
   */
  hint: string;

  /** Error classification for filtering and alerting. */
  errorKind: ErrorKind;

  /**
   * Module name binding (e.g., "gateway", "agent", "scheduler").
   *
   * Set via `logLevelManager.getLogger(module)` which creates a child
   * logger with this field bound. Every log line includes the module
   * that produced it.
   */
  module: string;

  /**
   * Finer-grained scope inside an existing `module` binding.
   *
   * Use at call sites instead of overriding `module:` in the payload.
   * Pino concatenates parent-bound fields (pre-serialized JSON fragment)
   * with the call-site object without deduplication, so passing
   * `{ module: "agent.bridge.X" }` against a parent already bound with
   * `module: "agent"` emits BOTH keys on the same line. JSON parsers
   * keep the last, but the polluted output wastes bytes and confuses
   * log consumers.
   *
   * `submodule` sidesteps the duplicate-key emission entirely:
   * @example
   *   logger.info(
   *     { submodule: "bridge.hash-invariant", agentId, durationMs },
   *     "Hash invariant assertion ran",
   *   );
   *
   * Convention: omit any redundant parent-prefix from the value
   * (e.g., under `module: "agent"`, prefer `submodule: "bridge.X"`
   * over `submodule: "agent.bridge.X"`).
   */
  submodule: string;

  // --- Pipeline fields ---

  /**
   * Pipeline step name.
   * @example "response-filter" | "chunking" | "markdown-ir" | "media-compress"
   */
  step: string;

  /**
   * Reason a pipeline step took action (filter suppression, early return cause).
   * @example "NO_REPLY" | "empty" | "auto-reply-suppressed"
   */
  reason: string;

  /**
   * Input length in characters before a pipeline step.
   * @example 1500
   */
  inputLen: number;

  /**
   * Output length in characters after a pipeline step.
   * @example 1200
   */
  outputLen: number;

  /**
   * Count of items produced by a pipeline step (e.g., chunk count, attachment count).
   * @example 3
   */
  itemCount: number;

  /**
   * Whether a pipeline step completed successfully.
   * @example true
   */
  success: boolean;

  // --- Observability fields ---

  /** Daemon instance identifier (short UUID, bound to root logger at startup). */
  instanceId: string;
  /** Time from process start to daemon-ready in milliseconds. */
  startupDurationMs: number;
  /** Time from shutdown-initiated to shutdown-complete in milliseconds. */
  shutdownDurationMs: number;
  /** WebSocket connection lifetime in milliseconds. */
  connectionDurationMs: number;
  /** Current active WebSocket connection count. */
  activeConnections: number;
  /** WebSocket close code (1000 = normal, 1006 = abnormal). */
  closeCode: number;
  /** Human-readable close reason string from the WebSocket close event. */
  closeReason: string;
  /** Semantic categorization of the WebSocket close code (e.g., "normal", "abnormal", "no-status"). */
  closeType: string;
  /** Input message character length. */
  messageLen: number;
  /** First 12 hex chars of SHA-256 of input message; omitted when empty. Stable per content. */
  messageHash: string;
  /** Output response character length. */
  responseLen: number;
  /** Flat input token count for easy aggregation. */
  tokensIn: number;
  /** Flat output token count for easy aggregation. */
  tokensOut: number;
  /** Number of LLM round-trips in a single agent execution. */
  llmCalls: number;
  /** Messages removed by context window pruning. */
  prunedMessages: number;
  /** Messages in session before execution begins. */
  sessionMessageCount: number;
  /** Authenticated client identifier. */
  clientId: string;
  /** WebSocket connection identifier. */
  connectionId: string;
  /** Total token count (input + output). */
  tokensTotal: number;
  /** Number of tool invocations in a single agent execution. */
  toolCalls: number;
  /** LLM stop/finish reason (e.g., "stop", "toolUse", "length"). */
  stopReason: string;
  /** Prompt cache read (hit) token count. */
  cacheReadTokens: number;
  /** Prompt cache creation (write) token count. */
  cacheCreationTokens: number;
  /** Estimated total cost in USD for the operation. */
  estimatedCostUsd: number;
  /** Ordinal position in shutdown sequence. */
  shutdownOrder: number;
  /** Per-HTTP-request correlation ID (short UUID). */
  requestId: string;
  /** Short config file name for test-suite filtering (e.g., "agent-routing"). */
  configName: string;
  /** Whether the logged tool params were truncated from the original. */
  paramsTruncated: boolean;
  /** Whether the logged RAG query was truncated from the original. */
  queryTruncated: boolean;
}
