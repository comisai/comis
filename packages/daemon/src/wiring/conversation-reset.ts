// SPDX-License-Identifier: Apache-2.0
/**
 * Complete-conversation-reset factory — the ONE routine that severs a
 * conversation across ALL THREE transcript layers.
 *
 * Live finding 2026-06-11 (LIVEMEM run): a DAG conversation survives every
 * existing "forget" surface because each one clears a different subset:
 *
 *   - `session.reset_conversation` cleared LCD (L1) + daemon sessionStore (L2)
 *     but left the pi runtime session JSONL (L3) intact — the next turn's
 *     `live` array still contained the full history, and the epoch-rebase
 *     branch in lcd-ingest.ts (RR2) faithfully RE-INGESTED all of it. The
 *     "COMPLETE cross-mode forget" resurrected 36/36 messages.
 *   - `/new` and `/reset` destroyed the runtime session (L3) via the pi
 *     adapter but left LCD (L1) intact — the DAG presented the old context
 *     items right back to the model on the next turn.
 *
 * Neither path could ever sever alone: LCD mirrors the runtime transcript
 * (lossless by design), so a reset that clears one layer is undone by the
 * survivor. This factory gives every caller the same three-layer routine:
 *
 *   L1  LCD store rows + ingest cursor (`deleteConversationLcd`, serialized
 *       via `runOnConversation` against concurrent live ingest)
 *   L2  daemon sessionStore working transcript (messages cleared, metadata
 *       preserved)
 *   L3  pi runtime session (adapter `destroySession` — rotates the JSONL so
 *       the next turn starts a fresh epoch)
 *
 * Every layer is best-effort: an absent dep degrades to a counted no-op
 * (callers report honest zeros/false), and a layer failure is WARN-logged
 * without undoing the layers that already succeeded. Content-free logging
 * (counts + keys only) per AGENTS.md §2.7.
 *
 * @module
 */

import type { ContextStorePort, SessionKey } from "@comis/core";
import { formatSessionKey, parseFormattedSessionKey } from "@comis/core";

/** Minimal logger surface (info/warn/debug). */
interface ResetLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

/** Minimal daemon sessionStore surface (the formatted-key transcript API). */
export interface ResetSessionStore {
  loadByFormattedKey(key: string): { messages: unknown[]; metadata?: Record<string, unknown> } | undefined;
  saveByFormattedKey(key: string, messages: unknown[], metadata?: Record<string, unknown>): void;
}

/** Minimal pi session adapter surface (runtime layer). */
export interface ResetRuntimeAdapter {
  destroySession(key: SessionKey): Promise<void>;
}

/** Deps for {@link createConversationReset} — all layers optional (graceful). */
export interface ConversationResetDeps {
  lcdStore?: Pick<ContextStorePort, "runOnConversation" | "deleteConversationLcd">;
  sessionStore?: ResetSessionStore;
  piSessionAdapters?: Pick<Map<string, ResetRuntimeAdapter>, "get">;
  tenantId: string;
  logger: ResetLogger;
}

/** Per-layer outcome of a complete conversation reset. */
export interface ConversationResetResult {
  lcdRowsDeleted: number;
  sessionMessagesCleared: number;
  runtimeSessionDestroyed: boolean;
}

/** The two reset entry points handed to wiring sites. */
export interface ConversationReset {
  /**
   * L3 only: destroy the pi runtime session for `formattedSessionKey` under
   * `agentId`. Returns true when an adapter destroy was actually invoked.
   * Used by `session.reset_conversation` (which performs L1+L2 itself and
   * reports per-layer counts).
   */
  destroyRuntimeSession(agentId: string, formattedSessionKey: string): Promise<boolean>;
  /**
   * L1+L2+L3: the complete three-layer forget for slash `/new` + `/reset`.
   * Accepts the SessionKey object those call sites already hold.
   */
  destroyConversationCompletely(agentId: string, key: SessionKey): Promise<ConversationResetResult>;
}

/**
 * Build the conversation-reset routines at the composition root (where the
 * LCD store, daemon sessionStore, and pi session adapters all live).
 */
export function createConversationReset(deps: ConversationResetDeps): ConversationReset {
  const { lcdStore, sessionStore, piSessionAdapters, tenantId, logger } = deps;

  async function destroyRuntime(agentId: string, key: SessionKey, formattedKey: string): Promise<boolean> {
    const adapter = piSessionAdapters?.get(agentId);
    if (!adapter) {
      logger.warn(
        {
          agentId,
          sessionKey: formattedKey,
          errorKind: "precondition",
          hint: "no pi session adapter for this agent — runtime transcript NOT destroyed; the conversation may resurrect on the next turn via LCD re-ingest",
        },
        "Conversation reset: runtime layer unavailable",
      );
      return false;
    }
    try {
      await adapter.destroySession(key);
      return true;
    } catch (e: unknown) {
      logger.warn(
        {
          agentId,
          sessionKey: formattedKey,
          err: e instanceof Error ? e : new Error(String(e)),
          errorKind: "dependency",
          hint: "runtime session destroy failed — the conversation may resurrect on the next turn via LCD re-ingest",
        },
        "Conversation reset: runtime destroy failed",
      );
      return false;
    }
  }

  return {
    async destroyRuntimeSession(agentId: string, formattedSessionKey: string): Promise<boolean> {
      const parsed = parseFormattedSessionKey(formattedSessionKey);
      if (!parsed) {
        logger.warn(
          {
            agentId,
            sessionKey: formattedSessionKey,
            errorKind: "validation",
            hint: "session key did not parse — runtime transcript NOT destroyed",
          },
          "Conversation reset: unparseable session key",
        );
        return false;
      }
      return destroyRuntime(agentId, parsed, formattedSessionKey);
    },

    async destroyConversationCompletely(agentId: string, key: SessionKey): Promise<ConversationResetResult> {
      const formattedKey = formatSessionKey(key);

      // L1: LCD rows + ingest cursor (serialized against concurrent ingest).
      let lcdRowsDeleted = 0;
      if (lcdStore) {
        try {
          const scope = { conversationId: formattedKey, agentId, tenantId, sessionKey: formattedKey };
          lcdRowsDeleted = await lcdStore.runOnConversation(
            scope.conversationId,
            () => lcdStore.deleteConversationLcd(scope),
          );
        } catch (e: unknown) {
          logger.warn(
            { agentId, sessionKey: formattedKey, err: e instanceof Error ? e : new Error(String(e)), errorKind: "dependency", hint: "LCD clear failed — DAG context may survive this reset" },
            "Conversation reset: LCD layer failed",
          );
        }
      }

      // L2: daemon sessionStore transcript (messages cleared, metadata kept).
      let sessionMessagesCleared = 0;
      if (sessionStore) {
        try {
          const data = sessionStore.loadByFormattedKey(formattedKey);
          if (data) {
            sessionMessagesCleared = data.messages.length;
            sessionStore.saveByFormattedKey(formattedKey, [], data.metadata);
          }
        } catch (e: unknown) {
          logger.warn(
            { agentId, sessionKey: formattedKey, err: e instanceof Error ? e : new Error(String(e)), errorKind: "dependency", hint: "sessionStore clear failed — working transcript may survive this reset" },
            "Conversation reset: sessionStore layer failed",
          );
        }
      }

      // L3: pi runtime session (the resurrection source when skipped).
      const runtimeSessionDestroyed = await destroyRuntime(agentId, key, formattedKey);

      logger.info(
        { agentId, sessionKey: formattedKey, lcdRowsDeleted, sessionMessagesCleared, runtimeSessionDestroyed, submodule: "conversation-reset" },
        "Conversation reset (complete three-layer forget)",
      );

      return { lcdRowsDeleted, sessionMessagesCleared, runtimeSessionDestroyed };
    },
  };
}
