// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/** Session archive, reset, export, and complete conversation-forget handlers. */

import {
  SessionDeleteContract,
  SessionResetContract,
  SessionExportContract,
  SessionResetConversationContract,
  conversationScopeToSessionKey,
  parseFormattedSessionKey,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";
import type { ContextStoreScope } from "@comis/core";
import type { RpcHandler } from "../types.js";
import { findLcdConversation, IS_DEV, loadAuthorizedSession, type SessionHandlerDeps } from "./session-helpers.js";
import { AuthorizationError } from "../errors.js";
import { clearSessionDeliveryMirror } from "./session-delivery-mirror.js";
import { displaySessionKey, parseSessionAuthority } from "./session-authority.js";

/**
 * Bind the session archive/lifecycle handlers. Object-spread compatible with
 * `Record<string, RpcHandler>`.
 */
export function bindSessionArchiveHandlers(deps: SessionHandlerDeps): Record<string, RpcHandler> {
  const runtimeDisplayKey = (scope: import("@comis/core").ConversationScope) => {
    const projected = conversationScopeToSessionKey(scope);
    if (!projected.ok) throw projected.error;
    return projected.value;
  };
  return {
    [SessionDeleteContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: admin trust check + missing-key + not-found guards
      // FIRST (preserves user-friendly error messages matching the existing
      // handler-test assertions — see session-handlers.test.ts:73-92).
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");
      const userParams = stripInternalFields(rawParams);
      const params = SessionDeleteContract.request.parse(userParams);
      const authority = parseSessionAuthority({ tenant_id: params.tenant_id, agent_id: params.agent_id, conversation_ref: params.conversation_ref });
      const data = loadAuthorizedSession(deps, authority.scope, authority.conversationRef);
      if (!data) throw new Error(`Conversation not found: ${params.conversation_ref}`);
      const sessionKey = displaySessionKey(data);

      // Archive transcript before deletion
      const transcript = {
        messages: data.messages,
        metadata: data.metadata,
        messageCount: data.messages.length,
      };

      const deliveryMirrorRowsDeleted = await clearSessionDeliveryMirror(
        deps,
        {
          tenantId: authority.scope.tenantId,
          agentId: authority.scope.agentId,
          conversationRef: authority.conversationRef,
        },
        "session.delete",
      );
      const deleted = deps.sessionStore.deleteByRef(authority.scope, authority.conversationRef);
      if (!deleted.ok) throw deleted.error;

      // Clear approval cache entries for the deleted session to prevent
      // stale cached approvals from auto-approving in a new session with the same key.
      deps.approvalGate?.clearApprovalCache({
        tenantId: authority.scope.tenantId,
        agentId: authority.scope.agentId,
        conversationRef: authority.conversationRef,
      });

      // Drop executor session-scoped state so a reused key starts fresh.
      deps.clearAgentSessionState?.(sessionKey);

      // Also sever LCD and runtime transcripts; both are best-effort after the
      // contract-bearing store deletion.
      let lcdRowsDeleted = 0;
      if (deps.lcdStore) {
        const scope: ContextStoreScope = {
          conversationRef: data.conversationRef,
          agentId: data.conversationScope.agentId,
          tenantId: data.conversationScope.tenantId,
          sessionKey,
        };
        try {
          lcdRowsDeleted = await deps.lcdStore.runOnConversation(
            scope.conversationRef,
            () => deps.lcdStore!.deleteConversationLcd(scope),
          );
        } catch (e: unknown) {
          deps.logger.warn(
            {
              method: SessionDeleteContract.method,
              sessionKey,
              err: e instanceof Error ? e : new Error(String(e)),
              errorKind: "dependency" as const,
              hint: "LCD rows survive the delete — a recreated same-key session may re-read them",
            },
            "Session delete: LCD layer clear failed",
          );
        }
      }
      let runtimeSessionDestroyed = false;
      if (deps.destroyRuntimeSession) {
        runtimeSessionDestroyed = await deps.destroyRuntimeSession(
          data.conversationScope,
          runtimeDisplayKey(data.conversationScope),
        );
      }
      deps.logger.info(
        {
          method: SessionDeleteContract.method,
          sessionKey,
          messageCount: transcript.messageCount,
          deliveryMirrorRowsDeleted,
          lcdRowsDeleted,
          runtimeSessionDestroyed,
        },
        "Session deleted across store, LCD, and runtime layers",
      );

      return { conversationRef: authority.conversationRef, deleted: true, transcript };
    },

    [SessionResetContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: missing-key + not-found guards FIRST.
      const userParams = stripInternalFields(rawParams);
      const params = SessionResetContract.request.parse(userParams);
      const authority = parseSessionAuthority({ tenant_id: params.tenant_id, agent_id: params.agent_id, conversation_ref: params.conversation_ref });
      const data = loadAuthorizedSession(deps, authority.scope, authority.conversationRef);
      if (!data) throw new Error(`Conversation not found: ${params.conversation_ref}`);
      const sessionKey = displaySessionKey(data);

      const previousMessageCount = data.messages.length;

      const deliveryMirrorRowsDeleted = await clearSessionDeliveryMirror(
        deps,
        {
          tenantId: authority.scope.tenantId,
          agentId: authority.scope.agentId,
          conversationRef: authority.conversationRef,
        },
        "session.reset",
      );
      const saved = deps.sessionStore.save(data.conversationScope, [], data.metadata);
      if (!saved.ok) throw saved.error;

      // Clear the active runtime transcript as well as the structured session row.
      // Otherwise the file-backed execution session could repopulate the transcript
      // on the next turn.
      // Workspace identity remains untouched; only the transcript is cleared.
      let runtimeSessionDestroyed = false;
      if (deps.destroyRuntimeSession) {
        runtimeSessionDestroyed = await deps.destroyRuntimeSession(
          data.conversationScope,
          runtimeDisplayKey(data.conversationScope),
        );
      }

      deps.approvalGate?.clearApprovalCache({
        tenantId: authority.scope.tenantId,
        agentId: authority.scope.agentId,
        conversationRef: authority.conversationRef,
      });

      deps.logger.info(
        { method: SessionResetContract.method, sessionKey, previousMessageCount, deliveryMirrorRowsDeleted, runtimeSessionDestroyed },
        "Session reset (messages cleared, identity preserved)",
      );

      const result = { conversationRef: authority.conversationRef, reset: true as const, previousMessageCount };
      if (IS_DEV) SessionResetContract.response.parse(result);
      return result;
    },

    [SessionExportContract.method]: async (rawParams) => {
      // Bespoke pre-Zod: admin trust check + missing-key + not-found guards FIRST.
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");
      const userParams = stripInternalFields(rawParams);
      const params = SessionExportContract.request.parse(userParams);
      const authority = parseSessionAuthority({ tenant_id: params.tenant_id, agent_id: params.agent_id, conversation_ref: params.conversation_ref });
      const data = loadAuthorizedSession(deps, authority.scope, authority.conversationRef);
      if (!data) throw new Error(`Conversation not found: ${params.conversation_ref}`);

      return {
        conversationRef: authority.conversationRef,
        messages: data.messages,
        metadata: data.metadata,
        messageCount: data.messages.length,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    },

    // Clear every prompt-bearing layer needed for a clean slate:
    //   1. Delivery mirror (pending outbound text injected at prompt assembly)
    //   2. LCD store (dag mode: durable history read at turn-start)
    //   3. Daemon sessionStore (working transcript for the next turn)
    //   4. Pi runtime session (live JSONL that can repopulate the stores)
    // Empty LCD and absent session rows are valid, but an absent LCD adapter
    // fails closed. The handler also enforces the contract's admin scope.
    [SessionResetConversationContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") throw new AuthorizationError("Admin trust level required");

      // Fail-closed: lcdStore is optional on SessionsApiDeps; must not silently no-op.
      if (!deps.lcdStore) throw new Error("LCD store not available — daemon not fully initialized");
      const userParams = stripInternalFields(rawParams);
      const params = SessionResetConversationContract.request.parse(userParams);
      const authority = parseSessionAuthority({ tenant_id: params.tenant_id, agent_id: params.agent_id, conversation_ref: params.conversation_ref });
      const sessionData = loadAuthorizedSession(deps, authority.scope, authority.conversationRef);
      const lcdConversation = sessionData
        ? undefined
        : findLcdConversation(deps, authority.scope, authority.conversationRef);
      if (!sessionData && !lcdConversation) throw new Error(`Conversation not found: ${params.conversation_ref}`);
      const sessionKey = sessionData ? displaySessionKey(sessionData) : lcdConversation!.sessionKey;
      const runtimeSessionKey = parseFormattedSessionKey(sessionKey);
      if (!runtimeSessionKey) throw new Error("Stored conversation session key is invalid");

      const startMs = systemNowMs();

      const resolvedAgentId = authority.scope.agentId;
      const scope: ContextStoreScope = {
        conversationRef: authority.conversationRef,
        agentId: resolvedAgentId,
        tenantId: authority.scope.tenantId,
        sessionKey,
      };

      const deliveryMirrorRowsDeleted = await clearSessionDeliveryMirror(
        deps,
        {
          tenantId: authority.scope.tenantId,
          agentId: authority.scope.agentId,
          conversationRef: authority.conversationRef,
        },
        "session.reset_conversation",
      );

      const lcdRowsDeleted = await deps.lcdStore.runOnConversation(
        scope.conversationRef,
        () => deps.lcdStore!.deleteConversationLcd(scope),
      );

      // Layer 2: Daemon sessionStore — clear working transcript (keep identity/metadata).
      // Best-effort: if no session entry exists (e.g., dag conversation with LCD rows
      // but no live session, or pipeline session whose JSONL was already deleted),
      // skip the save and report 0.
      const sessionMessagesCleared = sessionData?.messages.length ?? 0;
      if (sessionData) {
        const saved = deps.sessionStore.save(sessionData.conversationScope, [], sessionData.metadata);
        if (!saved.ok) throw saved.error;
      }

      // Clear approval cache to prevent stale approvals from auto-approving in a
      // fresh context after the reset (same pattern as session.delete + session.reset).
      deps.approvalGate?.clearApprovalCache({
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        conversationRef: scope.conversationRef,
      });

      // Layer 3: pi runtime session. Without this
      // destroy, the surviving runtime JSONL re-ingests WHOLESALE on the next
      // turn (lcd-ingest epoch rebase — the deleted cursor makes live[0] a new
      // epoch) and the "forgotten" conversation resurrects into the DAG.
      // Best-effort like --memory: a runtime failure never undoes L1/L2.
      let runtimeSessionDestroyed = false;
      if (deps.destroyRuntimeSession) {
        runtimeSessionDestroyed = await deps.destroyRuntimeSession(
          sessionData?.conversationScope ?? authority.scope,
          runtimeSessionKey,
        );
      } else {
        deps.logger.warn(
          {
            method: SessionResetConversationContract.method,
            conversationRef: scope.conversationRef,
            submodule: "session-reset-conversation",
            errorKind: "precondition" as const,
            hint: "destroyRuntimeSession not wired — the pi runtime transcript survives this reset and the conversation may resurrect on the next turn (lcd-ingest re-ingests the surviving JSONL)",
          },
          "Runtime session layer not wired (reset is LCD + sessionStore only)",
        );
      }

      // A COMPLETE forget must also drop the executor's
      // session-scoped state for this key — most importantly the grammar
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
          conversationRef: scope.conversationRef,
          agentId: scope.agentId,
          tenantId: scope.tenantId,
          deliveryMirrorRowsDeleted,
          lcdRowsDeleted,
          sessionMessagesCleared,
          runtimeSessionDestroyed,
          durationMs: systemNowMs() - startMs,
          submodule: "session-reset-conversation",
        },
        "Conversation reset (delivery mirror + LCD + sessionStore + runtime)",
      );

      // --memory honest reset. Deletes the RAG-memory
      // rows by source_session_key — ONE query covers BOTH paired-conversation
      // memories AND lcd-distilled episodic memories — then unlinks them from
      // consolidated observations (orphan→delete, multi-source→keep). The
      // optional --purge-derived flag escalates to deleting EVERY observation
      // derived from this session (nuclear, opt-in). Every step is non-fatal: a
      // memory-store failure must not undo the LCD/sessionStore reset that already
      // succeeded — it degrades to a WARN. memoriesDeleted is included in the
      // result ONLY when --memory was requested (omitted otherwise).
      const result: {
        conversationRef: string;
        lcdRowsDeleted: number;
        sessionMessagesCleared: number;
        memoriesDeleted?: number;
        runtimeSessionDestroyed: boolean;
        resolvedAgentId: string;
      } = {
        conversationRef: authority.conversationRef,
        lcdRowsDeleted,
        sessionMessagesCleared,
        runtimeSessionDestroyed,
        resolvedAgentId, // state the agent acted on (no silent default)
      };

      const requestMemory = (rawParams.memory ?? false) as boolean;
      if (requestMemory) {
        // Left undefined in the graceful-degrade branch (memoryPort absent) so the
        // result OMITS memoriesDeleted — returning 0 would falsely imply an
        // attempted-but-empty RAG clear. Set to the real count once a delete runs.
        let memoriesDeleted: number | undefined;
        if (!deps.memoryPort?.deleteBySessionKey) {
          // Graceful degrade: the deployment did not wire a MemoryPort (or the
          // adapter lacks deleteBySessionKey). LCD + sessionStore are still cleared; the
          // --memory flag is honestly reported as ignored (no false success).
          deps.logger.warn(
            {
              method: SessionResetConversationContract.method,
              conversationRef: scope.conversationRef,
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

          // Capture THIS session's memory ids BEFORE the destructive
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
                  conversationRef: scope.conversationRef,
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
                conversationRef: scope.conversationRef,
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
              // Thread agentId so the unlink scope matches the delete's
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
                    conversationRef: scope.conversationRef,
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
                conversationRef: scope.conversationRef,
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
            // agentId scopes the purge to this agent; thisSessionIds
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
                  conversationRef: scope.conversationRef,
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
                  conversationRef: scope.conversationRef,
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
