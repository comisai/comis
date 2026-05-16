// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).
/**
 * Session archive/lifecycle RPC handlers (Phase 43 split per FILE-SPLIT-04).
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
  stripInternalFields,
} from "@comis/core";
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
  };
}
