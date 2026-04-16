/**
 * Canonical log field vocabulary for Comis.
 *
 * All fields are optional -- the interface serves as documentation and
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
 * - `config`      -- Configuration parsing, missing keys, schema violations
 * - `network`     -- TCP/HTTP failures, DNS resolution, connection resets
 * - `auth`        -- Authentication or authorization failures (401/403, bad token)
 * - `validation`  -- Input validation failures (bad request body, invalid params)
 * - `timeout`     -- Operation exceeded deadline (LLM call, HTTP request, DB query)
 * - `resource`    -- Resource exhaustion (OOM, disk full, file descriptor limit)
 * - `dependency`  -- External service unavailable (LLM provider, embedding API)
 * - `internal`    -- Unexpected internal errors (assertion failures, logic bugs)
 * - `platform`    -- Chat platform API errors (Discord, Telegram, Slack rate limits)
 */
export type ErrorKind =
  | "config"
  | "network"
  | "auth"
  | "validation"
  | "timeout"
  | "resource"
  | "dependency"
  | "internal"
  | "platform";

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
  /** Whether the logged message text was truncated from the original. */
  messageTruncated: boolean;
  /** Input message character length. */
  messageLen: number;
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
