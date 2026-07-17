// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { err, ok, type Result } from "@comis/shared";

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
export const ApprovalCallbackOwnerSchema = z.strictObject({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  channelType: z.string().min(1),
  channelKey: z.string().min(1),
  threadId: z.string().min(1).optional(),
});

export const ApprovalRequestSchema = z.strictObject({
  /** Unique identifier for this approval request */
  requestId: z.string().uuid(),
  /** 12-char base62 callback-safe identifier minted by the approval-gate */
  shortId: z.string().length(12).regex(/^[0-9A-Za-z]+$/),
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
  /** Immutable principal allowed to answer this request through a channel callback. */
  callbackOwner: ApprovalCallbackOwnerSchema,
  /** Timestamp when the request was created (epoch ms) */
  createdAt: z.number(),
  /** How long before auto-deny (ms) */
  timeoutMs: z.number().int().positive(),
});

/** An approval request awaiting operator decision. */
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** Exact channel principal allowed to answer an approval callback. */
export type ApprovalCallbackOwner = ApprovalRequest["callbackOwner"];

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
  /** 12-char base62 callback-safe identifier minted by the approval-gate */
  shortId: z.string().length(12).regex(/^[0-9A-Za-z]+$/),
  toolName: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
  agentId: z.string(),
  sessionKey: z.string(),
  trustLevel: z.enum(["admin", "user", "guest"]),
  callbackOwner: ApprovalRequestSchema.shape.callbackOwner,
  createdAt: z.number(),
  timeoutMs: z.number().int().positive(),
});

/** A serialized approval request for persistence across restarts. */
export type SerializedApprovalRequest = z.infer<typeof SerializedApprovalRequestSchema>;

/** Validate an untrusted pending-approval restart record without throwing. */
export function parseSerializedApprovalRequest(
  raw: unknown,
): Result<SerializedApprovalRequest, z.ZodError> {
  const parsed = SerializedApprovalRequestSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}

/** Schema for a serialized approval cache entry (for restart persistence of cached approvals). */
export const SerializedApprovalCacheEntrySchema = z.strictObject({
  /** Opaque key for the exact session, principal, tool, action, and parameter digest. */
  cacheKey: z.string().startsWith("h1:").min(1),
  /** The cached approval resolution */
  resolution: z.strictObject({
    requestId: z.string().uuid(),
    approved: z.literal(true),
    approvedBy: z.string().min(1),
    reason: z.string().optional(),
    resolvedAt: z.number().int().nonnegative(),
  }),
  /** Absolute expiry timestamp (epoch ms) */
  expiresAt: z.number().int().positive(),
}).refine((entry) => entry.resolution.resolvedAt < entry.expiresAt, {
  path: ["expiresAt"],
  message: "Approval cache expiry must be after its resolution",
});

/** A serialized approval cache entry for persistence across restarts. */
export type SerializedApprovalCacheEntry = z.infer<typeof SerializedApprovalCacheEntrySchema>;

/** Validate an untrusted restart-cache record without throwing. */
export function parseSerializedApprovalCacheEntry(
  raw: unknown,
): Result<SerializedApprovalCacheEntry, z.ZodError> {
  const parsed = SerializedApprovalCacheEntrySchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
