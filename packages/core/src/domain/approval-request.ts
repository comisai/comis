// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * ApprovalRequest: A pending approval for a privileged agent action.
 *
 * When an agent invokes a tool classified as requiring human confirmation,
 * the approval gate creates an ApprovalRequest and pauses execution until
 * an operator approves, denies, or the request times out.
 *
 * Captures who, what, and why for audit.
 *
 * @module
 */

/**
 * Schema for an approval request submitted by the approval gate.
 *
 * Fields capture the full context needed for an operator to make an
 * informed approve/deny decision.
 */
export const ApprovalRequestSchema = z.strictObject({
  /** Unique identifier for this approval request */
  requestId: z.string().uuid(),
  /** Name of the tool being invoked */
  toolName: z.string(),
  /** The classified action (e.g., "agents.delete") */
  action: z.string(),
  /** Tool parameters (sanitized, no secrets) */
  params: z.record(z.string(), z.unknown()),
  /** The agent that triggered the action */
  agentId: z.string(),
  /** Session context identifier */
  sessionKey: z.string(),
  /** Trust level of the requesting user */
  trustLevel: z.enum(["admin", "user", "guest"]),
  /** Timestamp when the request was created (epoch ms) */
  createdAt: z.number(),
  /** How long before auto-deny (ms) */
  timeoutMs: z.number().int().positive(),
});

/** An approval request awaiting operator decision. */
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * Schema for the resolution of an approval request.
 *
 * Created when an operator approves/denies or the request times out.
 */
export const ApprovalResolutionSchema = z.strictObject({
  /** The request being resolved */
  requestId: z.string().uuid(),
  /** Whether the action was approved */
  approved: z.boolean(),
  /** Who approved/denied (operator ID or "system:timeout") */
  approvedBy: z.string(),
  /** Optional reason for the decision */
  reason: z.string().optional(),
  /** Timestamp when the resolution was made (epoch ms) */
  resolvedAt: z.number(),
});

/** The resolution outcome of an approval request. */
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

/** Schema for a serialized pending approval request (for restart persistence). */
export const SerializedApprovalRequestSchema = z.strictObject({
  requestId: z.string().uuid(),
  toolName: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
  agentId: z.string(),
  sessionKey: z.string(),
  trustLevel: z.enum(["admin", "user", "guest"]),
  createdAt: z.number(),
  timeoutMs: z.number().int().positive(),
});

/** A serialized approval request for persistence across restarts. */
export type SerializedApprovalRequest = z.infer<typeof SerializedApprovalRequestSchema>;

/** Schema for a serialized approval cache entry (for restart persistence of cached approvals). */
export const SerializedApprovalCacheEntrySchema = z.strictObject({
  /** The cache key: "${sessionKey}::${action}" */
  cacheKey: z.string(),
  /** The cached approval resolution */
  resolution: z.strictObject({
    requestId: z.string().uuid(),
    approved: z.boolean(),
    approvedBy: z.string(),
    reason: z.string().optional(),
    resolvedAt: z.number(),
  }),
  /** Absolute expiry timestamp (epoch ms) */
  expiresAt: z.number(),
});

/** A serialized approval cache entry for persistence across restarts. */
export type SerializedApprovalCacheEntry = z.infer<typeof SerializedApprovalCacheEntrySchema>;
