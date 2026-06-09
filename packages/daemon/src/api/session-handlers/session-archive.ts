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

      // DEFERRED: conversation-scoped RAG-memory clear spans ~12 memory stores.
      // --memory is accepted without error but not yet implemented.
      const requestMemory = (rawParams.memory ?? false) as boolean;
      if (requestMemory) {
        deps.logger.warn(
          {
            method: SessionResetConversationContract.method,
            conversationId: scope.conversationId,
            submodule: "session-reset-conversation",
            errorKind: "precondition" as const,
            hint: "RAG-memory clearing (--memory) is not yet implemented; cleared LCD history and sessionStore only — see Phase 164 deferred follow-up",
          },
          "--memory requested but RAG-memory clear is not yet implemented — LCD + sessionStore cleared only",
        );
      }

      // memoriesDeleted is intentionally OMITTED: returning 0 would falsely
      // imply an attempted-but-empty RAG clear.
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
      if (IS_DEV) SessionResetConversationContract.response.parse(result);
      return result;
    },
  };
}
