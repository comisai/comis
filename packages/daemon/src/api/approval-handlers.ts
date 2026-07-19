// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Approval RPC handler module.
 * Handles approval gate admin RPC methods:
 *   admin.approval.pending, admin.approval.resolve,
 *   admin.approval.resolveAll, admin.approval.clearDenialCache
 * Follows the same factory pattern as session-handlers.ts,
 * cron-handlers.ts, etc.
 *
 * Uses the `@comis/core` contract registry. Method keys are
 * computed-property names (`[AdminApprovalPendingContract.method]:`) so
 * the bidirectional 1:1 architecture test resolves them through
 * `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/workspace.ts` (the workspace
 * umbrella file groups all 5 handlers that share the
 * `WorkspaceApiDeps` slice). The dispatcher-injected `_X` internal
 * fields are stripped via `stripInternalFields` BEFORE
 * `contract.request.parse(...)`.
 *
 * Two of the 4 methods (`resolveAll` + the test-only branch of
 * `clearDenialCache`) are NOT registered in setup-gateway-api.ts —
 * the gateway router only registers pending/resolve/clearDenialCache
 * at line 199-201. The bidirectional 1:1 architecture test walks
 * handler-factory keys (registration-plane-agnostic) so contracts
 * exist for all 4. The contract scope `["admin"]` documents the
 * intended trust model regardless of registration plane.
 *
 * The bespoke pre-Zod validation (missing-requestId, non-boolean
 * approved, unknown-requestId not-found) is intentionally retained
 * for user-friendly error UX matching the existing
 * approval-handlers.test.ts assertions.
 * @module
 */

import {
  AdminApprovalPendingContract,
  AdminApprovalResolveContract,
  AdminApprovalResolveAllContract,
  AdminApprovalClearDenialCacheContract,
  ConversationRefSchema,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: WorkspaceApiDeps (shared with workspace, browser,
// mcp, skill, notification handlers). The dispatcher constructs this handler
// only inside the `deps.approvalGate ? ...` truthy branch, so the alias
// narrows `approvalGate` to required (matching the handler body's direct
// `deps.approvalGate.method()` access).
import type { WorkspaceApiDeps } from "./types.js";
export type ApprovalHandlerDeps = WorkspaceApiDeps & {
  approvalGate: import("@comis/core").ApprovalGate;
};

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of approval RPC handlers bound to the given deps.
 */
export function createApprovalHandlers(deps: ApprovalHandlerDeps): Record<string, RpcHandler> {
  return {
    [AdminApprovalPendingContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = AdminApprovalPendingContract.request.parse(userParams);
      const conversationRef = ConversationRefSchema.parse(params.conversation_ref);
      const requests = deps.approvalGate.pending().filter((request) =>
        request.tenantId === params.tenant_id
        && request.agentId === params.agent_id
        && request.conversationRef === conversationRef);
      const result = { requests, total: requests.length };
      if (IS_DEV) AdminApprovalPendingContract.response.parse(result);
      return result;
    },

    [AdminApprovalResolveContract.method]: async (rawParams) => {
      // Bespoke pre-Zod for operator-friendly error messages matching
      // approval-handlers.test.ts assertions.
      if (!rawParams.requestId) throw new Error("Missing required parameter: requestId");

      if (typeof rawParams.approved !== "boolean") {
        throw new Error("Missing required parameter: approved (boolean)");
      }

      const userParams = stripInternalFields(rawParams);
      const params = AdminApprovalResolveContract.request.parse(userParams);

      const approvedBy = params.approvedBy ?? "operator";
      const reason = params.reason;

      // Verify the request exists before resolving
      const existing = deps.approvalGate.getRequest(params.requestId);
      if (!existing) {
        throw new Error(
          `Approval request not found: ${params.requestId} (may have already been resolved or timed out)`,
        );
      }
      const conversationRef = ConversationRefSchema.parse(params.conversation_ref);
      if (
        existing.tenantId !== params.tenant_id
        || existing.agentId !== params.agent_id
        || existing.conversationRef !== conversationRef
      ) {
        throw new Error("Approval request is outside the supplied authority scope");
      }

      deps.approvalGate.resolveApproval(params.requestId, params.approved, approvedBy, reason);

      const result = {
        requestId: params.requestId,
        approved: params.approved,
        approvedBy,
        reason: reason ?? null,
      };
      if (IS_DEV) AdminApprovalResolveContract.response.parse(result);
      return result;
    },

    [AdminApprovalResolveAllContract.method]: async (rawParams) => {
      if (typeof rawParams.approved !== "boolean") {
        throw new Error("Missing required parameter: approved (boolean)");
      }

      const userParams = stripInternalFields(rawParams);
      const params = AdminApprovalResolveAllContract.request.parse(userParams);

      const approvedBy = params.approvedBy ?? "operator";
      const reason = params.reason;

      const conversationRef = ConversationRefSchema.parse(params.conversation_ref);
      const matches = deps.approvalGate.pending().filter((request) =>
        request.tenantId === params.tenant_id
        && request.agentId === params.agent_id
        && request.conversationRef === conversationRef);

      const resolvedIds: string[] = [];
      for (const req of matches) {
        deps.approvalGate.resolveApproval(req.requestId, params.approved, approvedBy, reason);
        resolvedIds.push(req.requestId);
      }

      const result = { resolved: resolvedIds.length, requestIds: resolvedIds };
      if (IS_DEV) AdminApprovalResolveAllContract.response.parse(result);
      return result;
    },

    [AdminApprovalClearDenialCacheContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = AdminApprovalClearDenialCacheContract.request.parse(userParams);
      deps.approvalGate.clearDenialCache({
        tenantId: params.tenant_id,
        agentId: params.agent_id,
        conversationRef: ConversationRefSchema.parse(params.conversation_ref),
      });
      const result = { cleared: true as const };
      if (IS_DEV) AdminApprovalClearDenialCacheContract.response.parse(result);
      return result;
    },
  };
}
