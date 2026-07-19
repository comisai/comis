// SPDX-License-Identifier: Apache-2.0
/** Lifecycle semantics over authority-scoped session persistence. */

import {
  systemNowMs,
  type ComisLogger,
  type ConversationScope,
  type HookRunner,
  type SessionQueryScope,
  type SessionStoreError,
  type SessionStorePort,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";

export interface SessionLifecycleOptions {
  defaultIdleTimeoutMs?: number;
  hookRunner?: HookRunner;
  logger?: ComisLogger;
}

export interface SessionLifecycle {
  loadOrCreate(scope: ConversationScope): Result<unknown[], SessionStoreError>;
  save(scope: ConversationScope, messages: unknown[], metadata?: Record<string, unknown>): Result<void, SessionStoreError>;
  isExpired(scope: ConversationScope, idleTimeoutMs?: number): Result<boolean, SessionStoreError>;
  expire(scope: ConversationScope): Result<boolean, SessionStoreError>;
  cleanStale(scope: SessionQueryScope, maxAgeMs?: number): Result<number, SessionStoreError>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 14_400_000;

export function createSessionLifecycle(
  store: SessionStorePort,
  options?: SessionLifecycleOptions,
): SessionLifecycle {
  const defaultTimeout = options?.defaultIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const hookRunner = options?.hookRunner;
  const logger = options?.logger;

  function observeHookFailure(promise: Promise<void>, hookName: string): void {
    promise.catch((error: unknown) => {
      logger?.debug({ err: error, hookName }, "Session lifecycle hook failed");
    });
  }

  return {
    loadOrCreate(scope) {
      const loaded = store.load(scope);
      if (!loaded.ok) return loaded;
      observeHookFailure(
        hookRunner?.runSessionStart(
          { conversationScope: scope, isNew: loaded.value === undefined },
          { agentId: scope.agentId },
        ) ?? Promise.resolve(),
        "session_start",
      );
      return ok(loaded.value?.messages ?? []);
    },

    save(scope, messages, metadata) {
      return store.save(scope, messages, metadata);
    },

    isExpired(scope, idleTimeoutMs) {
      const loaded = store.load(scope);
      if (!loaded.ok) return loaded;
      if (loaded.value === undefined) return ok(true);
      return ok(loaded.value.updatedAt + (idleTimeoutMs ?? defaultTimeout) < systemNowMs());
    },

    expire(scope) {
      observeHookFailure(
        hookRunner?.runSessionEnd(
          { conversationScope: scope, reason: "expire", durationMs: undefined },
          { agentId: scope.agentId },
        ) ?? Promise.resolve(),
        "session_end",
      );
      return store.delete(scope);
    },

    cleanStale(scope, maxAgeMs) {
      return store.deleteStale(scope, maxAgeMs ?? defaultTimeout);
    },
  };
}
