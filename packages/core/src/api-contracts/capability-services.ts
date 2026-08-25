// SPDX-License-Identifier: Apache-2.0
/**
 * Operator surface over installed capability-service instances and the durable
 * attention records their runs raise.
 *
 * Admin-only with no `rpc` route, for the same reason as the managed-run group:
 * an installed service must not be able to enumerate its siblings, and a model
 * turn must not be able to cancel a question another principal is waiting on.
 *
 * Instance rows are content-free by construction. They carry the configured
 * identity, the scopes the definition declared, the activation state, and
 * counts — never a socket path, a credential reference, or a resolved secret,
 * because an operator diagnosing a degraded instance needs to know which
 * instance and which scope, and a support bundle carrying either of the others
 * would be a disclosure rather than a diagnostic.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";
import { CapabilityServiceScopeSchema } from "../config/capability-service-contributions.js";

/** Whether an instance is usable right now, and why not when it is not. */
export const CapabilityServiceInstanceStateSchema = z.enum([
  "active",
  "connected",
  "degraded",
  "failed",
  "stopped",
]);

/** One configured instance as the operator surface renders it. */
export const CapabilityServiceInstanceSummarySchema = z.object({
  schemaVersion: z.literal(1),
  serviceInstanceId: z.string().min(1),
  serviceDefinitionId: z.string().min(1),
  enabled: z.boolean(),
  state: CapabilityServiceInstanceStateSchema,
  /** Closed reason codes only — never a raw error string from the service. */
  reasonCodes: z.array(z.string().min(1)).max(16),
  /** The scopes the definition declared, which bound what the instance may call. */
  requestedScopes: z.array(CapabilityServiceScopeSchema),
  allowedAgents: z.array(z.string().min(1)),
  mcpServerName: z.string().min(1),
  /** Managed runs currently bound to this instance and not yet terminal. */
  activeRunCount: z.number().int().nonnegative(),
  /** Runs this instance owns that reduced to unknown — the number an operator acts on. */
  degradedRunCount: z.number().int().nonnegative(),
  capturedAtMs: z.number().int().nonnegative(),
});

/** Every configured instance, including the ones that failed to start. */
export const CapabilityServicesListContract = defineContract({
  method: "capabilityServices.list",
  request: z.object({}),
  response: z.object({
    rows: z.array(CapabilityServiceInstanceSummarySchema),
    total: z.number().int().nonnegative(),
  }),
  scopes: ["admin"] as const,
});

/** One instance, including the workspace and runtime roots it may lease under. */
export const CapabilityServicesGetContract = defineContract({
  method: "capabilityServices.get",
  request: z.object({ serviceInstanceId: z.string().min(1) }),
  response: z.object({
    instance: CapabilityServiceInstanceSummarySchema.extend({
      allowedWorkspaceRoots: z.array(z.string().min(1)),
      allowedRuntimeRoots: z.array(z.string().min(1)),
      /** True when the definition declared health and the host therefore requires liveness. */
      livenessRequired: z.boolean(),
    }).optional(),
  }),
  scopes: ["admin"] as const,
});

/**
 * One open question a run is waiting on. The question body stays in the
 * confined content store: an operator needs to know that a run is blocked on a
 * human and in which conversation, not to read what was asked, which belongs to
 * the principal the question was routed to.
 */
export const ManagedAttentionSummarySchema = z.object({
  schemaVersion: z.literal(1),
  attentionId: z.string().min(1),
  managedRunId: z.string().min(1),
  status: z.enum(["open", "response_pending", "delivered", "resolved", "cancelled", "expired"]),
  /** The service's own key for the question — an identifier, not the question. */
  externalKey: z.string().min(1).optional(),
  createdAtMs: z.number().int().nonnegative(),
  resolvedAtMs: z.number().int().nonnegative().optional(),
});

export const ManagedAttentionListContract = defineContract({
  method: "managedAttention.list",
  request: z.object({
    managedRunId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  response: z.object({
    rows: z.array(ManagedAttentionSummarySchema),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

export const ManagedAttentionGetContract = defineContract({
  method: "managedAttention.get",
  request: z.object({ attentionId: z.string().min(1) }),
  response: z.object({ attention: ManagedAttentionSummarySchema.optional() }),
  scopes: ["admin"] as const,
});

export const CAPABILITY_SERVICES_CONTRACTS = [
  CapabilityServicesListContract,
  CapabilityServicesGetContract,
  ManagedAttentionListContract,
  ManagedAttentionGetContract,
] as const;
