import { tryGetContext } from "@comis/core";
import { createLogger, type LoggerOptions, type ComisLogger } from "@comis/infra";

/**
 * Options for creating a tracing logger.
 * Extends standard LoggerOptions — tracing is automatic via AsyncLocalStorage mixin.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional extension point for future tracing-specific options
export interface TracingLoggerOptions extends LoggerOptions {
  // All standard LoggerOptions; tracing fields injected automatically
}

/**
 * Pino mixin that reads traceId, tenantId, userId, and sessionKey
 * from the current AsyncLocalStorage request context.
 * Returns an empty object when called outside a request scope,
 * producing clean log lines with no trace fields.
 * Synchronous and minimal:
 * only reads from AsyncLocalStorage.getStore() (nanosecond-scale).
 */
const tracingMixin = (): Record<string, unknown> => {
  const ctx = tryGetContext();
  if (!ctx) return {};
  return {
    traceId: ctx.traceId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    sessionKey: ctx.sessionKey,
  };
};

/**
 * Create a Pino logger that automatically injects traceId, tenantId,
 * userId, and sessionKey from AsyncLocalStorage into every log line.
 * When called outside a request context (no runWithContext scope),
 * log lines are emitted without trace fields.
 * Uses the mixin option on @comis/infra's createLogger, which
 * calls the mixin synchronously on every log call for zero-overhead
 * automatic context injection.
 */
export function createTracingLogger(options: TracingLoggerOptions): ComisLogger {
  return createLogger({
    ...options,
    mixin: tracingMixin,
  });
}
