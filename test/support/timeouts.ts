/**
 * Shared timeout constants for integration test infrastructure.
 *
 * Centralizes all timing values so tests reference named constants
 * instead of scattered magic numbers. Each value is in milliseconds.
 *
 * @module
 */

/** Daemon startup + health check readiness timeout. */
export const DAEMON_STARTUP_MS = 60_000;

/** Gateway graceful shutdown + port release timeout. */
export const DAEMON_CLEANUP_MS = 30_000;

/** WebSocket connection open timeout. */
export const WS_CONNECT_MS = 10_000;

/** JSON-RPC response timeout for fast operations (config, status). */
export const RPC_FAST_MS = 30_000;

/** JSON-RPC response timeout for LLM calls (agent.execute, agent.stream). */
export const RPC_LLM_MS = 90_000;

/** Log entry polling timeout -- waiting for Pino async flush. */
export const LOG_POLL_MS = 5_000;

/** Log entry polling interval between checks. */
export const LOG_POLL_INTERVAL_MS = 50;

/** Default timeout for EventAwaiter wait operations. */
export const EVENT_WAIT_MS = 5_000;

/** Brief delay for background async operations to settle. */
export const ASYNC_SETTLE_MS = 200;
