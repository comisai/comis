/**
 * Approval RPC handler module.
 * Handles approval gate admin RPC methods:
 *   admin.approval.pending, admin.approval.resolve
 * Extracted into a dedicated handler module following the same factory
 * pattern as session-handlers.ts, cron-handlers.ts, etc.
 * @module
 */

import type { ApprovalGate } from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by approval RPC handlers. */
export interface ApprovalHandlerDeps {
  approvalGate: ApprovalGate;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of approval RPC handlers bound to the given deps.
 */
export function createApprovalHandlers(deps: ApprovalHandlerDeps): Record<string, RpcHandler> {
  return {
    "admin.approval.pending": async () => {
      const requests = deps.approvalGate.pending();
      return { requests, total: requests.length };
    },

    "admin.approval.resolve": async (params) => {
      const requestId = params.requestId as string;
      if (!requestId) throw new Error("Missing required parameter: requestId");

      const approved = params.approved as boolean;
      if (typeof approved !== "boolean") throw new Error("Missing required parameter: approved (boolean)");

      const approvedBy = (params.approvedBy as string) ?? "operator";
      const reason = params.reason as string | undefined;

      // Verify the request exists before resolving
      const existing = deps.approvalGate.getRequest(requestId);
      if (!existing) {
        throw new Error(`Approval request not found: ${requestId} (may have already been resolved or timed out)`);
      }

      deps.approvalGate.resolveApproval(requestId, approved, approvedBy, reason);

      return {
        requestId,
        approved,
        approvedBy,
        reason: reason ?? null,
      };
    },

    "admin.approval.resolveAll": async (params) => {
      const sessionKey = params.sessionKey as string | undefined;
      const approved = params.approved as boolean;
      if (typeof approved !== "boolean") throw new Error("Missing required parameter: approved (boolean)");

      const approvedBy = (params.approvedBy as string) ?? "operator";
      const reason = params.reason as string | undefined;

      const pending = deps.approvalGate.pending();
      const matches = sessionKey
        ? pending.filter((r) => r.sessionKey === sessionKey)
        : pending;

      const resolvedIds: string[] = [];
      for (const req of matches) {
        deps.approvalGate.resolveApproval(req.requestId, approved, approvedBy, reason);
        resolvedIds.push(req.requestId);
      }

      return { resolved: resolvedIds.length, requestIds: resolvedIds };
    },

    "admin.approval.clearDenialCache": async (params) => {
      const sessionKey = params.sessionKey as string | undefined;
      deps.approvalGate.clearDenialCache(sessionKey);
      return { cleared: true };
    },
  };
}
