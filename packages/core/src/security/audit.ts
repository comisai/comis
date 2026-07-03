// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionClassification } from "./action-classifier.js";
import { systemNowDate } from "../runtime/system-time.js";

/**
 * Audit event KIND — the closed event-family discriminator.
 *
 * The event FAMILY (`kind`, required, closed) is deliberately split from the
 * access-class (`classification`, optional, present only when meaningful —
 * chiefly the generic `audit` kind). Conflating the two into one required
 * `classification` enum (`read|mutate|destructive`) forces emit sites to pass
 * values OUTSIDE that enum (`"security"`/`"write"`/`"neutral"`) — a silent
 * violation, because the event-bus payload types `classification` as a loose
 * `string`.
 *
 * Closed string-literal union (AGENTS §2.8) — NEVER `kind: string`. Adding a
 * member here without handling it in {@link kindIsSecuritySignal} fails the
 * build via the `const _exhaustive: never` guard.
 *
 * `AUDIT_KINDS` is the single source of truth: the Zod schema uses
 * `z.enum(AUDIT_KINDS)` so the runtime validator and the static `AuditKind`
 * type can never drift.
 */
export const AUDIT_KINDS = [
  /** Generic audit record (the access-class `classification` is meaningful here). */
  "audit",
  /** A secret was accessed (secrets.get) — secrets-handlers.ts. */
  "secret_access",
  /** A prompt-injection attempt was detected (output/response guard) — executor-response-filter.ts. */
  "injection_detected",
  /** The per-session injection rate threshold was crossed — executor-input-guard.ts. */
  "injection_rate_exceeded",
  /** A canary token leaked into model output — critic isolation. */
  "canary_leak",
  /** An implied/unauthorized tool call was detected — critic isolation. */
  "implied_tool_call",
  /** A command was blocked by policy — command guard. */
  "command_blocked",
  /** A hook modified or blocked an action — hook-runner.ts. */
  "hook_blocked",
  /** An auth-state mutation (auth.set) — auth-handlers.ts. */
  "auth_mutation",
  /** A sandbox downgrade was refused (fail-closed) — sandbox governance. */
  "sandbox_downgrade_refused",
  /** A capability or deny-by-origin gate rejected a call — capability.ts /
   *  assert-not-agent-origin. */
  "capability_denied",
  /** An outbound URL was blocked by the SSRF guard (validateUrl) — metadata IP /
   *  RFC1918 / loopback / non-http target. */
  "ssrf_blocked",
] as const;

/** The closed audit event-family union (inferred from {@link AUDIT_KINDS}). */
export type AuditKind = (typeof AUDIT_KINDS)[number];

/**
 * Whether an audit kind represents a security signal (vs a routine audit
 * record). The `switch` is exhaustive over {@link AuditKind}; the
 * `const _exhaustive: never` guard (AGENTS §2.8) fails the build if a kind is
 * added to {@link AUDIT_KINDS} without being classified here.
 */
export function kindIsSecuritySignal(kind: AuditKind): boolean {
  switch (kind) {
    case "secret_access":
    case "injection_detected":
    case "injection_rate_exceeded":
    case "canary_leak":
    case "implied_tool_call":
    case "command_blocked":
    case "hook_blocked":
    case "sandbox_downgrade_refused":
    case "capability_denied":
    case "ssrf_blocked":
      return true;
    case "audit":
    case "auth_mutation":
      return false;
    default: {
      // Exhaustiveness guard — adding an AuditKind without handling it here
      // is a compile error. Fail-closed at runtime: treat an unknown kind as
      // a security signal so it is never silently downgraded.
      const _exhaustive: never = kind;
      void _exhaustive;
      return true;
    }
  }
}

/**
 * Audit event schema for structured security logging.
 *
 * Every significant action produces an audit event with a `kind` (event
 * family), an optional `classification` (risk class), outcome, tracing, and
 * timing information.
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
    /** Event family (closed union — the single source is AUDIT_KINDS). */
    kind: z.enum(AUDIT_KINDS),
    /**
     * Risk classification of the action — OPTIONAL. Present only when
     * meaningful (chiefly the generic `audit` kind); security-signal kinds
     * leave it unset.
     */
    classification: z.enum(["read", "mutate", "destructive"]).optional(),
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
 *
 * `kind` (the event family) is required; `classification` is optional
 * (present only when the access-class is meaningful).
 */
export interface CreateAuditEventParams {
  tenantId: string;
  agentId: string;
  userId: string;
  actionType: string;
  kind: AuditKind;
  classification?: ActionClassification;
  outcome: "success" | "failure" | "denied";
  metadata?: Record<string, unknown>;
  traceId?: string;
  duration?: number;
}

/**
 * Create a new audit event with auto-generated id and timestamp.
 *
 * This is the SOLE constructor for an {@link AuditEvent} — every emit site
 * routes through it so every event is schema-valid before it can be
 * persisted by the audit sink. `classification` is only included when
 * provided (the schema makes it optional).
 *
 * @param params - Event parameters (id and timestamp are auto-generated)
 * @returns A validated AuditEvent
 */
export function createAuditEvent(params: CreateAuditEventParams): AuditEvent {
  const event = {
    id: randomUUID(),
    timestamp: systemNowDate().toISOString(),
    tenantId: params.tenantId,
    agentId: params.agentId,
    userId: params.userId,
    actionType: params.actionType,
    kind: params.kind,
    // Only carry classification when meaningful (present chiefly for
    // the generic `audit` kind; security-signal kinds leave it unset).
    ...(params.classification !== undefined ? { classification: params.classification } : {}),
    outcome: params.outcome,
    metadata: params.metadata ?? {},
    traceId: params.traceId,
    duration: params.duration,
  };

  // Validate through schema (strip undefined optional fields)
  return AuditEventSchema.parse(event);
}
