// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Session archive/lifecycle RPC handlers.
 *
 * Admin lifecycle operations on existing sessions:
 *   - session.delete: delete session + return transcript (admin-only)
 *   - session.reset: clear session messages while preserving metadata
 *   - session.export: dump full session payload (admin-only)
 *   - session.reset_conversation: COMPLETE cross-mode forget — clears BOTH
 *     the LCD lossless-store history AND the daemon sessionStore working
 *     transcript (Phase 164-06; supersedes Phase 164-03 context.reset_lcd).
 *
 * @module
 */

import {
  SessionDeleteContract,
  SessionResetContract,
  SessionExportContract,
  SessionResetConversationContract,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";
import type { ContextStoreScope } from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type SessionHandlerDeps } from "./session-helpers.js";

/**
 * Bind the session archive/lifecycle handlers. Object-spread compatible with
 * `Record<string, RpcHandler>`.
 */
export function bindSessionArchiveHandlers(deps: SessionHandlerDeps): Record<string, RpcHandler> {
  return {
    [SessionDeleteContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: admin trust check + missing-key + not-found guards
      // FIRST (preserves user-friendly error messages matching the existing
      // handler-test assertions — see session-handlers.test.ts:73-92).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      const userParams = stripInternalFields(rawParams);
      SessionDeleteContract.request.parse(userParams);

      const data = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (!data) throw new Error(`Session not found: ${sessionKey}`);

      // Archive transcript before deletion
      const transcript = {
        messages: data.messages,
        metadata: data.metadata,
        messageCount: data.messages.length,
      };

      deps.sessionStore.deleteByFormattedKey(sessionKey);

      // Clear approval cache entries for the deleted session to prevent
      // stale cached approvals from auto-approving in a new session with the same key.
      deps.approvalGate?.clearApprovalCache(sessionKey);

      // CR-02 (175-REVIEW): session destroy also drops the executor's
      // session-scoped state for this key (schema snapshots, the GBNF-02
      // strip-retry once-gate, JIT-guide delivery, cache latches) so a new
      // session reusing the key starts genuinely fresh.
      deps.clearAgentSessionState?.(sessionKey);

      return { sessionKey, deleted: true, transcript };
    },

    [SessionResetContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: missing-key + not-found guards FIRST.
      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      const userParams = stripInternalFields(rawParams);
      SessionResetContract.request.parse(userParams);

      const data = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (!data) throw new Error(`Session not found: ${sessionKey}`);

      const previousMessageCount = data.messages.length;

      // Clear messages but preserve metadata (identity)
      deps.sessionStore.saveByFormattedKey(sessionKey, [], data.metadata);

      // Clear approval cache entries for the reset session.
      deps.approvalGate?.clearApprovalCache(sessionKey);

      const result = { sessionKey, reset: true as const, previousMessageCount };
      if (IS_DEV) SessionResetContract.response.parse(result);
      return result;
    },

    [SessionExportContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: admin trust check + missing-key + not-found guards FIRST.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");
      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      const userParams = stripInternalFields(rawParams);
      SessionExportContract.request.parse(userParams);

      const data = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (!data) throw new Error(`Session not found: ${sessionKey}`);

      return {
        sessionKey,
        messages: data.messages,
        metadata: data.metadata,
        messageCount: data.messages.length,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    },

    // Phase 164-06: COMPLETE cross-mode conversation reset.
    // Supersedes Phase 164-03 context.reset_lcd (LCD-only).
    //
    // This operation clears BOTH layers to guarantee a clean slate in all modes:
    //   1. LCD store (dag mode: the durable history the model reads at turn-start)
    //   2. Daemon sessionStore (both modes: the working JSONL-backed transcript
    //      that feeds state.messages on the next turn)
    //
    // Best-effort on each layer — neither empty LCD nor absent sessionStore
    // is an error (pipeline sessions may have no LCD rows; a dag session may
    // have had its JSONL deleted by housekeeping before this reset).
    //
    // Defense-in-depth admin check (contract scopes:["admin"] +
    // in-handler _trustLevel check, mirrors SessionDeleteContract).
    // Fail-closed when lcdStore absent (never silently return 0).
    [SessionResetConversationContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      // Fail-closed: lcdStore is optional on SessionsApiDeps; must not silently no-op.
      if (!deps.lcdStore) throw new Error("LCD store not available — daemon not fully initialized");

      const userParams = stripInternalFields(rawParams);
      SessionResetConversationContract.request.parse(userParams);

      const startMs = systemNowMs();

      // Scope derived from trusted daemon context (never from user params).
      const scope: ContextStoreScope = {
        conversationId: sessionKey,
        agentId: deps.defaultAgentId,
        tenantId: deps.tenantId,
        sessionKey,
      };

      // Layer 1: LCD store — serialized against concurrent live ingest.
      const lcdRowsDeleted = await deps.lcdStore.runOnConversation(
        scope.conversationId,
        () => deps.lcdStore!.deleteConversationLcd(scope),
      );

      // Layer 2: Daemon sessionStore — clear working transcript (keep identity/metadata).
      // Best-effort: if no session entry exists (e.g., dag conversation with LCD rows
      // but no live session, or pipeline session whose JSONL was already deleted),
      // skip the save and report 0.
      let sessionMessagesCleared = 0;
      const sessionData = deps.sessionStore.loadByFormattedKey(sessionKey);
      if (sessionData) {
        sessionMessagesCleared = sessionData.messages.length;
        deps.sessionStore.saveByFormattedKey(sessionKey, [], sessionData.metadata);
      }

      // Clear approval cache to prevent stale approvals from auto-approving in a
      // fresh context after the reset (same pattern as session.delete + session.reset).
      deps.approvalGate?.clearApprovalCache(sessionKey);

      // CR-02 (175-REVIEW): a COMPLETE forget must also drop the executor's
      // session-scoped state for this key — most importantly the GBNF-02
      // strip-retry once-gate (a reset session previously inherited the
      // closed gate and terminal-failed its first grammar-400 with zero
      // repair attempts), plus tool-schema snapshots / JIT-guide delivery /
      // cache latches that would otherwise leak the old conversation's
      // executor state into the "fresh" one.
      deps.clearAgentSessionState?.(sessionKey);

      // Audit: INFO log with counts only — no message content.
      deps.logger.info(
        {
          method: SessionResetConversationContract.method,
          conversationId: scope.conversationId,
          agentId: scope.agentId,
          tenantId: scope.tenantId,
          lcdRowsDeleted,
          sessionMessagesCleared,
          durationMs: systemNowMs() - startMs,
          submodule: "session-reset-conversation",
        },
        "Conversation reset (LCD + sessionStore)",
      );

      // Phase 172-03 (DIST-05): --memory honest reset. Deletes the RAG-memory
      // rows by source_session_key — ONE query covers BOTH paired-conversation
      // memories AND lcd-distilled episodic memories — then unlinks them from
      // consolidated observations (orphan→delete, multi-source→keep). The
      // optional --purge-derived flag escalates to deleting EVERY observation
      // derived from this session (nuclear, opt-in). Every step is non-fatal: a
      // memory-store failure must not undo the LCD/sessionStore reset that already
      // succeeded — it degrades to a WARN. memoriesDeleted is included in the
      // result ONLY when --memory was requested (omitted otherwise).
      const result: {
        sessionKey: string;
        lcdRowsDeleted: number;
        sessionMessagesCleared: number;
        memoriesDeleted?: number;
      } = {
        sessionKey,
        lcdRowsDeleted,
        sessionMessagesCleared,
      };

      const requestMemory = (rawParams.memory ?? false) as boolean;
      if (requestMemory) {
        // Left undefined in the graceful-degrade branch (memoryPort absent) so the
        // result OMITS memoriesDeleted — returning 0 would falsely imply an
        // attempted-but-empty RAG clear. Set to the real count once a delete runs.
        let memoriesDeleted: number | undefined;
        if (!deps.memoryPort?.deleteBySessionKey) {
          // Graceful degrade: the deployment did not wire a MemoryPort (or the
          // adapter predates DIST-05). LCD + sessionStore are still cleared; the
          // --memory flag is honestly reported as ignored (no false success).
          deps.logger.warn(
            {
              method: SessionResetConversationContract.method,
              conversationId: scope.conversationId,
              submodule: "session-reset-conversation",
              errorKind: "precondition" as const,
              hint: "memoryPort not available in deps — --memory flag ignored; LCD + sessionStore cleared",
            },
            "--memory requested but memoryPort not wired (deployment may not support it)",
          );
        } else {
          // A real delete is attempted — report 0 even on failure (an honest
          // "attempted, nothing deleted"), never undefined.
          memoriesDeleted = 0;

          // WR-02: capture THIS session's memory ids BEFORE the destructive
          // delete, so --purge-derived can be session-scoped (source_ids ∩
          // thisSessionIds) instead of the coarse "any dangling source id" sweep
          // that would over-delete unrelated observations. Non-fatal: if the
          // capture fails (or the optional read method is absent), the purge falls
          // back to an empty set (purges nothing) rather than over-deleting.
          let thisSessionIds: string[] = [];
          if (deps.memoryPort.listMemoryIdsBySessionKey) {
            const idsResult = await deps.memoryPort.listMemoryIdsBySessionKey(sessionKey, {
              tenantId: scope.tenantId,
              agentId: scope.agentId,
            });
            if (idsResult.ok) {
              thisSessionIds = idsResult.value;
            } else {
              deps.logger.warn(
                {
                  method: SessionResetConversationContract.method,
                  conversationId: scope.conversationId,
                  submodule: "session-reset-conversation",
                  hint: "could not capture this-session memory ids before delete — --purge-derived will purge nothing (conservative); check DB",
                  errorKind: "dependency" as const,
                  err: idsResult.error.message,
                },
                "this-session memory id capture failed (non-fatal; purge falls back to empty)",
              );
            }
          }

          const memoriesResult = await deps.memoryPort.deleteBySessionKey(sessionKey, {
            tenantId: scope.tenantId,
            agentId: scope.agentId,
          });
          if (!memoriesResult.ok) {
            // Non-fatal: the LCD reset already succeeded — log + carry on.
            deps.logger.warn(
              {
                method: SessionResetConversationContract.method,
                conversationId: scope.conversationId,
                submodule: "session-reset-conversation",
                hint: "Memory delete by session key failed; LCD reset succeeded — retry --memory or check DB",
                errorKind: "dependency" as const,
                err: memoriesResult.error.message,
              },
              "RAG-memory clear failed (non-fatal)",
            );
          } else {
            memoriesDeleted = memoriesResult.value;
            // Unlink consolidated observations that referenced the now-deleted
            // sources — orphan→delete, multi-source→keep. Only when something was
            // deleted (nothing to unlink otherwise). Non-fatal.
            if (memoriesDeleted > 0 && deps.consolidationStore) {
              // WR-05: thread agentId so the unlink scope matches the delete's
              // (tenant, agent) scope exactly (a different agent's observation is
              // never touched).
              const unlinkResult = await deps.consolidationStore.unlinkDeletedSources(
                sessionKey,
                scope.tenantId,
                scope.agentId,
              );
              if (!unlinkResult.ok) {
                deps.logger.warn(
                  {
                    method: SessionResetConversationContract.method,
                    conversationId: scope.conversationId,
                    submodule: "session-reset-conversation",
                    hint: "Consolidated-observation unlink failed; deleted memories may still be referenced by observations",
                    errorKind: "dependency" as const,
                    err: unlinkResult.error.message,
                  },
                  "Consolidated-observation unlink failed (non-fatal)",
                );
              }
            }
            deps.logger.info(
              {
                method: SessionResetConversationContract.method,
                conversationId: scope.conversationId,
                memoriesDeleted,
                submodule: "session-reset-conversation",
              },
              "RAG-memory cleared by source_session_key",
            );
          }

          // --purge-derived: nuclear escalation — delete EVERY consolidated
          // observation derived from this session (ignores surviving multi-source
          // corroboration). Only fires when explicitly requested. Non-fatal.
          const purgeDerived = (rawParams.purge_derived ?? false) as boolean;
          if (purgeDerived && deps.consolidationStore) {
            // WR-05: agentId scopes the purge to this agent. WR-02: thisSessionIds
            // (captured before the delete) makes the purge match
            // source_ids ∩ thisSessionIds — only observations derived from THIS
            // session, never an unrelated observation with a prior dangling id.
            const purgeResult = await deps.consolidationStore.purgeConsolidatedDerivedFrom(
              sessionKey,
              scope.tenantId,
              scope.agentId,
              thisSessionIds,
            );
            if (!purgeResult.ok) {
              deps.logger.warn(
                {
                  method: SessionResetConversationContract.method,
                  conversationId: scope.conversationId,
                  submodule: "session-reset-conversation",
                  hint: "--purge-derived failed; some observations derived from this session may remain",
                  errorKind: "dependency" as const,
                  err: purgeResult.error.message,
                },
                "--purge-derived failed (non-fatal)",
              );
            } else {
              deps.logger.info(
                {
                  method: SessionResetConversationContract.method,
                  conversationId: scope.conversationId,
                  observationsPurged: purgeResult.value,
                  submodule: "session-reset-conversation",
                },
                "--purge-derived: consolidated observations derived from session purged",
              );
            }
          }
        }

        // Only surface the count when a delete was actually attempted (memoryPort
        // present). When absent it stays undefined → omitted from the result.
        if (memoriesDeleted !== undefined) result.memoriesDeleted = memoriesDeleted;
      }
      if (IS_DEV) SessionResetConversationContract.response.parse(result);
      return result;
    },
  };
}
