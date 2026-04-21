// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionClassification } from "./action-classifier.js";

/**
 * Audit event schema for structured security logging.
 *
 * Every significant action produces an audit event with
 * classification, outcome, tracing, and timing information.
 */
export const AuditEventSchema = z.strictObject({
    /** Unique event identifier (UUIDv4). */
    id: z.guid(),
    /** ISO 8601 timestamp of when the event occurred. */
    timestamp: z.iso.datetime(),
    /** Tenant identifier for multi-tenant isolation. */
    tenantId: z.string().min(1),
    /** Agent that performed the action (may be system). */
    agentId: z.string().min(1),
    /** User who triggered or owns the action (may be "system"). */
    userId: z.string().min(1),
    /** The action that was performed (e.g., "file.delete"). */
    actionType: z.string().min(1),
    /** Risk classification of the action. */
    classification: z.enum(["read", "mutate", "destructive"]),
    /** Whether the action succeeded or failed. */
    outcome: z.enum(["success", "failure", "denied"]),
    /** Arbitrary metadata about the event. */
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** Distributed tracing identifier for correlating events. */
    traceId: z.string().optional(),
    /** Duration of the action in milliseconds. */
    duration: z.number().nonnegative().optional(),
  });

/** TypeScript type inferred from the AuditEvent Zod schema. */
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * Parameters for creating an audit event.
 * The id and timestamp are auto-generated; everything else must be provided.
 */
export interface CreateAuditEventParams {
  tenantId: string;
  agentId: string;
  userId: string;
  actionType: string;
  classification: ActionClassification;
  outcome: "success" | "failure" | "denied";
  metadata?: Record<string, unknown>;
  traceId?: string;
  duration?: number;
}

/**
 * Create a new audit event with auto-generated id and timestamp.
 *
 * @param params - Event parameters (id and timestamp are auto-generated)
 * @returns A validated AuditEvent
 */
export function createAuditEvent(params: CreateAuditEventParams): AuditEvent {
  const event: AuditEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    tenantId: params.tenantId,
    agentId: params.agentId,
    userId: params.userId,
    actionType: params.actionType,
    classification: params.classification,
    outcome: params.outcome,
    metadata: params.metadata ?? {},
    traceId: params.traceId,
    duration: params.duration,
  };

  // Validate through schema (strip undefined optional fields)
  return AuditEventSchema.parse(event);
}
