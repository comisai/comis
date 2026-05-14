// SPDX-License-Identifier: Apache-2.0
/**
 * Approval RPC handler module.
 * Handles approval gate admin RPC methods:
 *   admin.approval.pending, admin.approval.resolve,
 *   admin.approval.resolveAll, admin.approval.clearDenialCache
 * Extracted into a dedicated handler module following the same factory
 * pattern as session-handlers.ts, cron-handlers.ts, etc.
 *
 * Phase 35 Wave C (Plan 35-13 Task 2): refactored to use the
 * `@comis/core` contract registry. Method keys are computed-property
 * names (`[AdminApprovalPendingContract.method]:`) so the
 * bidirectional 1:1 architecture test resolves them through
 * `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/workspace.ts` (the workspace
 * umbrella file groups all 5 handlers that share the
 * `WorkspaceApiDeps` slice). The dispatcher-injected `_X` internal
 * fields are stripped via `stripInternalFields` BEFORE
 * `contract.request.parse(...)` (D-04 pitfall 6).
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
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts (Plan 34-08a).
// Single source of truth: WorkspaceApiDeps (shared with workspace, browser,
// mcp, skill, notification handlers). The dispatcher constructs this handler
// only inside the `deps.approvalGate ? ...` truthy branch, so the alias
// narrows `approvalGate` to required (matching the handler body's direct
// `deps.approvalGate.method()` access). DAEMON-API-03 Option A retarget +
// 34-08b narrowing — handler bodies unchanged.
import type { WorkspaceApiDeps } from "./types.js";
export type ApprovalHandlerDeps = WorkspaceApiDeps & {
  approvalGate: import("@comis/core").ApprovalGate;
};

// ---------------------------------------------------------------------------
// Dev-mode response parse helper (D-10)
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
      AdminApprovalPendingContract.request.parse(userParams);
      const requests = deps.approvalGate.pending();
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

      const pending = deps.approvalGate.pending();
      const matches = params.sessionKey
        ? pending.filter((r) => r.sessionKey === params.sessionKey)
        : pending;

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
      deps.approvalGate.clearDenialCache(params.sessionKey);
      const result = { cleared: true as const };
      if (IS_DEV) AdminApprovalClearDenialCacheContract.response.parse(result);
      return result;
    },
  };
}
