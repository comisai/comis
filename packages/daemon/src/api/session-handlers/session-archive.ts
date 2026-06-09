// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Session archive/lifecycle RPC handlers.
 *
 * Admin lifecycle operations on existing sessions:
 *   - session.delete: delete session + return transcript (admin-only)
 *   - session.reset: clear session messages while preserving metadata
 *   - session.export: dump full session payload (admin-only)
 *
 * @module
 */

import {
  SessionDeleteContract,
  SessionResetContract,
  SessionExportContract,
  ContextResetLcdContract,
  stripInternalFields,
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

    // RR4 (Phase 164-03): admin-gated explicit LCD history reset.
    // T-164-reset-authz: dual-layer admin check (contract scopes:["admin"] +
    // in-handler _trustLevel check for defense-in-depth).
    // T-164-reset-scope: scope derived from (sessionKey, defaultAgentId,
    // tenantId) — all from trusted daemon context, never from user params.
    // T-164-09: fail-closed when lcdStore is absent (no silent 0 return).
    [ContextResetLcdContract.method]: async (rawParams) => {
      // Defense-in-depth admin check (mirrors SessionDeleteContract pattern).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new Error("Admin trust level required");

      const sessionKey = rawParams.session_key as string;
      if (!sessionKey) throw new Error("Missing required parameter: session_key");

      // Fail-closed: lcdStore is optional on SessionsApiDeps; must not silently no-op.
      if (!deps.lcdStore) throw new Error("LCD store not available — daemon not fully initialized");

      const userParams = stripInternalFields(rawParams);
      ContextResetLcdContract.request.parse(userParams);

      const startMs = Date.now();

      // DEFINITIVE scope (RESEARCH.md Q3 / T-164-reset-scope): the formatted
      // sessionKey IS the conversationId; agentId/tenantId come from the
      // trusted daemon request context — never re-derived from user params.
      // Refuse the reset if any scope column is empty/blank (fail-closed).
      const scope: ContextStoreScope = {
        conversationId: sessionKey,
        agentId: deps.defaultAgentId,
        tenantId: deps.tenantId,
        sessionKey,
      };

      // Run inside the single-flight serializer so the delete serializes
      // against any concurrent live ingest on this conversation.
      const lcdRowsDeleted = await deps.lcdStore.runOnConversation(
        scope.conversationId,
        () => deps.lcdStore!.deleteConversationLcd(scope),
      );

      // RR4 audit: INFO log with count only — no message content (T-164-10).
      deps.logger.info(
        {
          method: ContextResetLcdContract.method,
          conversationId: scope.conversationId,
          agentId: scope.agentId,
          tenantId: scope.tenantId,
          lcdRowsDeleted,
          durationMs: Date.now() - startMs,
          submodule: "context-reset-lcd",
        },
        "LCD history reset",
      );

      const result = {
        sessionKey,
        lcdRowsDeleted,
        memoriesDeleted: 0 as const, // --memory stub: RAG clear is a thin second step
      };
      if (IS_DEV) ContextResetLcdContract.response.parse(result);
      return result;
    },
  };
}
