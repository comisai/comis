// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { ConversationRefSchema } from "./conversation-scope.js";

const OpaqueIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/);
const TimestampMsSchema = z.number().int().nonnegative();

export const ManagedRunAttentionStatusSchema = z.enum([
  "open",
  "response_pending",
  "delivered",
  "resolved",
  "cancelled",
  "expired",
]);

export const ManagedRunAttentionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attentionId: OpaqueIdSchema,
  managedRunId: OpaqueIdSchema,
  serviceInstanceId: OpaqueIdSchema,
  tenantId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  principalId: z.string().min(1).max(256),
  conversationRef: ConversationRefSchema,
  externalKey: z.string().min(1).max(256).optional(),
  reportSequence: z.number().int().positive(),
  attentionRef: OpaqueIdSchema,
  status: ManagedRunAttentionStatusSchema,
  responseRef: OpaqueIdSchema.optional(),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema.optional(),
}).superRefine((record, context) => {
  if (record.updatedAtMs < record.createdAtMs) {
    context.addIssue({ code: "custom", path: ["updatedAtMs"], message: "attention update cannot precede creation" });
  }
  if (record.expiresAtMs !== undefined && record.expiresAtMs < record.createdAtMs) {
    context.addIssue({ code: "custom", path: ["expiresAtMs"], message: "attention expiry cannot precede creation" });
  }
  const requiresResponse = record.status === "response_pending" || record.status === "delivered";
  if (requiresResponse && record.responseRef === undefined) {
    context.addIssue({ code: "custom", path: ["responseRef"], message: "pending and delivered attention require exactly one response reference" });
  }
  if (record.status === "open" && record.responseRef !== undefined) {
    context.addIssue({ code: "custom", path: ["responseRef"], message: "open attention cannot carry a response reference" });
  }
});

export type ManagedRunAttentionStatus = z.infer<typeof ManagedRunAttentionStatusSchema>;
export type ManagedRunAttentionRecord = z.infer<typeof ManagedRunAttentionRecordSchema>;
