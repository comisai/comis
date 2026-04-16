/**
 * Session Lifecycle: Lifecycle wrapper around @comis/memory SessionStore.
 *
 * Wraps @comis/memory SessionStore for expiry/cleanup operations,
 * NOT for JSONL persistence (see comis-session-manager.ts for that).
 *
 * Provides convenience operations for agent session management:
 * - loadOrCreate: load existing session or return empty for new
 * - save: persist messages + optional metadata
 * - isExpired: check if session has exceeded idle timeout
 * - expire: delete a session
 * - cleanStale: remove sessions older than a threshold
 *
 * Does NOT own the database connection -- receives a pre-existing SessionStore.
 *
 * @module
 */

import type { SessionKey, HookRunner } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { SessionStore } from "@comis/memory";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration options for the session lifecycle manager.
 */
export interface SessionLifecycleOptions {
  /** Default idle timeout in milliseconds. Defaults to 4 hours (14_400_000). */
  defaultIdleTimeoutMs?: number;
  /** Optional hook runner for lifecycle hooks (no-op when absent). */
  hookRunner?: HookRunner;
  /** Optional agent identifier for hook context. */
  agentId?: string;
  /** Optional logger for hook error capture (no-op when absent). */
  logger?: ComisLogger;
}

/**
 * Session lifecycle manager.
 */
export interface SessionLifecycle {
  /** Load an existing session's messages, or return empty array for new sessions. */
  loadOrCreate(key: SessionKey): unknown[];
  /** Save messages (and optional metadata) for a session. */
  save(key: SessionKey, messages: unknown[], metadata?: Record<string, unknown>): void;
  /** Check whether a session has exceeded the idle timeout. Returns true if not found. */
  isExpired(key: SessionKey, idleTimeoutMs?: number): boolean;
  /** Delete a session. Returns true if it existed, false otherwise. */
  expire(key: SessionKey): boolean;
  /** Delete sessions older than maxAgeMs. Returns count of deleted sessions. */
  cleanStale(maxAgeMs?: number): number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** 4 hours in milliseconds. */
const DEFAULT_IDLE_TIMEOUT_MS = 14_400_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SessionLifecycle wrapping the given SessionStore.
 *
 * The session lifecycle manager adds lifecycle semantics (load-or-create, expiry
 * detection, stale cleanup) on top of the raw CRUD provided by SessionStore.
 */
export function createSessionLifecycle(
  store: SessionStore,
  options?: SessionLifecycleOptions,
): SessionLifecycle {
  const defaultTimeout = options?.defaultIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const hookRunner = options?.hookRunner;
  const agentId = options?.agentId;
  const logger = options?.logger;

  return {
    loadOrCreate(key: SessionKey): unknown[] {
      const data = store.load(key);
      if (data === undefined) {
        // New session -- fire session_start hook with isNew: true
        // Hook errors are caught internally by the runner (catchErrors: true)
        // Fire asynchronously (fire-and-forget) since loadOrCreate is synchronous
        hookRunner?.runSessionStart({ sessionKey: key, isNew: true }, { agentId })
          .catch((e: unknown) => {
            logger?.debug({ err: e }, "Session start hook error suppressed");
          });
        return [];
      }
      // Existing session loaded -- fire session_start hook with isNew: false
      hookRunner?.runSessionStart({ sessionKey: key, isNew: false }, { agentId })
        .catch((e: unknown) => {
          logger?.debug({ err: e }, "Session start hook error suppressed");
        });
      return data.messages;
    },

    save(key: SessionKey, messages: unknown[], metadata?: Record<string, unknown>): void {
      store.save(key, messages, metadata);
    },

    isExpired(key: SessionKey, idleTimeoutMs?: number): boolean {
      const timeout = idleTimeoutMs ?? defaultTimeout;
      const data = store.load(key);
      if (data === undefined) {
        return true;
      }
      return data.updatedAt + timeout < Date.now();
    },

    expire(key: SessionKey): boolean {
      // Fire session_end hook before deletion
      // Hook errors are caught internally by the runner (catchErrors: true)
      hookRunner?.runSessionEnd(
        { sessionKey: key, reason: "expire", durationMs: undefined },
        { agentId },
      ).catch((e: unknown) => {
        logger?.debug({ err: e }, "Session end hook error suppressed");
      });
      return store.delete(key);
    },

    cleanStale(maxAgeMs?: number): number {
      const age = maxAgeMs ?? defaultTimeout;
      return store.deleteStale(age);
    },
  };
}
