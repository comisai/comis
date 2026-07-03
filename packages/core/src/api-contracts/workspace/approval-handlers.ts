// SPDX-License-Identifier: Apache-2.0
/**
 * Approval-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/approval-handlers.ts` (4 methods).
 * Spread order in `APPROVAL_HANDLERS_CONTRACTS` fixes this slice's
 * position within `WORKSPACE_CONTRACTS`, keeping
 * `contracts.generated.*` artifacts byte-identical.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// Shared sub-schemas (allowlist shapes only).
// ===========================================================================

/**
 * Loose-record value type. Same definition as in `workspace-handlers.ts`
 * — module-private (not exported) so the cross-file duplication is safe.
 */
const LooseRecord = z.record(z.string(), z.unknown());

// ===========================================================================
// --- approval-handlers.ts ---
// ===========================================================================

/**
 * Approval-request projection for the `admin.approval.pending` listing.
 * Loose record — the server-side `ApprovalRequest` schema uses
 * `z.strictObject` plus `z.string().uuid()` refinement which is OUTSIDE
 * the 12-shape allowlist. Modeling each pending request as a loose
 * record preserves the wire shape (the gate emits the full
 * ApprovalRequest object) without dragging refinements into the
 * contract surface.
 */
const ApprovalRequestSchema = LooseRecord;

/**
 * `admin.approval.pending` — list all pending approval requests
 * awaiting operator decision. ADMIN scope. Read-only.
 *
 * Request: `{}` (no params).
 *
 * Response: `{ requests: ApprovalRequest[], total: number }`. The
 * handler returns `requests: deps.approvalGate.pending()` directly
 * plus a derived `total` count.
 */
export const AdminApprovalPendingContract = defineContract({
  method: "admin.approval.pending",
  request: z.object({}),
  response: z.object({
    requests: z.array(ApprovalRequestSchema),
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `admin.approval.resolve` — resolve a single pending request (approve
 * or deny, with optional reason). ADMIN scope. Bespoke pre-Zod guards
 * (approval-handlers.ts:45-56) produce operator-friendly errors for
 * missing `requestId`, missing/non-boolean `approved`, and unknown
 * `requestId`.
 *
 * Request: `{ requestId, approved, approvedBy?, reason? }`.
 * `approvedBy` defaults to `"operator"` (handler:50).
 *
 * Response: `{ requestId, approved, approvedBy, reason }`. `reason` is
 * nullable (when omitted the handler passes through `null` per
 * handler:65) — modeled as `z.string().nullable()`.
 */
export const AdminApprovalResolveContract = defineContract({
  method: "admin.approval.resolve",
  request: z.object({
    requestId: z.string().min(1),
    approved: z.boolean(),
    approvedBy: z.string().optional(),
    reason: z.string().optional(),
  }),
  response: z.object({
    requestId: z.string(),
    approved: z.boolean(),
    approvedBy: z.string(),
    reason: z.string().nullable(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `admin.approval.resolveAll` — bulk-resolve all pending requests
 * (optionally filtered to a single session). ADMIN scope.
 *
 * The handler factory exposes `resolveAll` which is NOT registered in
 * setup-gateway-api.ts (the gateway router only registers pending/
 * resolve/clearDenialCache). The bidirectional 1:1 architecture test
 * walks handler-factory PropertyAssignment keys
 * (registration-plane-agnostic), so a contract is MANDATORY for the
 * 1:1 mapping to pass.
 *
 * The contract scope `["admin"]` reflects the namespace prefix
 * (`admin.approval.`) — every admin.approval.* handler is admin-gated
 * by intent regardless of router registration.
 *
 * Request: `{ sessionKey?, approved, approvedBy?, reason? }`. When
 * `sessionKey` is provided, only requests with that sessionKey are
 * resolved; otherwise all pending requests are.
 *
 * Response: `{ resolved: number, requestIds: string[] }`.
 */
export const AdminApprovalResolveAllContract = defineContract({
  method: "admin.approval.resolveAll",
  request: z.object({
    sessionKey: z.string().optional(),
    approved: z.boolean(),
    approvedBy: z.string().optional(),
    reason: z.string().optional(),
  }),
  response: z.object({
    resolved: z.number(),
    requestIds: z.array(z.string()),
  }),
  scopes: ["admin"] as const,
});

/**
 * `admin.approval.clearDenialCache` — clear cached denial entries
 * (optionally scoped to one sessionKey). ADMIN scope.
 *
 * Request: `{ sessionKey? }`. When absent, the entire denial cache
 * is flushed.
 *
 * Response: `{ cleared: true }`.
 */
export const AdminApprovalClearDenialCacheContract = defineContract({
  method: "admin.approval.clearDenialCache",
  request: z.object({
    sessionKey: z.string().optional(),
  }),
  response: z.object({
    cleared: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

/**
 * approval-handlers slice (4 contracts). Spread order is
 * determinism-critical for codegen output stability.
 */
export const APPROVAL_HANDLERS_CONTRACTS = [
  AdminApprovalPendingContract,
  AdminApprovalResolveContract,
  AdminApprovalResolveAllContract,
  AdminApprovalClearDenialCacheContract,
] as const;
