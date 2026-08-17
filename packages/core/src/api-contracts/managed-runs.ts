// SPDX-License-Identifier: Apache-2.0
/**
 * Operator surface over installed capability services and their managed runs.
 *
 * Every method here is `admin` and carries no `rpc` route, which puts the whole
 * group in the deny-by-origin control plane: an agent turn — including a
 * prompt-injected one — can never reach it. Observing, explaining, and
 * cancelling another principal's external work is an operator's authority, not
 * a model capability, and a service cannot grant itself these methods by
 * describing a tool differently.
 *
 * Two content rules hold throughout. Summary rows carry identifiers, closed
 * enums, counts, hashes, and timing — never a report body, a question, an
 * objective, a path, or a repository label. Run detail may name the host
 * records a run is bound to, because an operator cannot repair a lease or a
 * terminal they cannot identify, but it still never carries service-authored
 * content: the bodies live in the confined content store and reach a human
 * through the owning product's own diagnostics.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";
import { ManagedRunStatusSchema, ManagedRunStatusReasonSchema } from "../domain/managed-run.js";

/**
 * How fresh the answer is and where it came from. A caller that renders a run
 * must be able to say whether it is reading a durable record or a degraded
 * projection; an unlabelled snapshot invites reporting stale state as current.
 */
export const ManagedRunFreshnessSchema = z.object({
  capturedAtMs: z.number().int().nonnegative(),
  stateSource: z.enum(["durable_record", "reduced_snapshot"]),
  /** Absent when the run has never reported liveness. */
  lastHeartbeatAtMs: z.number().int().nonnegative().optional(),
  /** True when the owning service declared the health scope and its last beat is older than the configured bound. */
  livenessStale: z.boolean(),
});

/** One summary row. Identifiers, enums, counts, and timing only. */
export const ManagedRunSummarySchema = z.object({
  schemaVersion: z.literal(1),
  managedRunId: z.string().min(1),
  serviceInstanceId: z.string().min(1),
  status: ManagedRunStatusSchema,
  statusReason: ManagedRunStatusReasonSchema,
  initiationSource: z.enum(["user_request", "schedule", "service_event"]),
  agentId: z.string().min(1),
  tenantId: z.string().min(1),
  openAttentionCount: z.number().int().nonnegative(),
  lastAcceptedReportSequence: z.number().int().nonnegative(),
  lastReducedReportSequence: z.number().int().nonnegative(),
  pendingContinuation: z.boolean(),
  terminalSessionCount: z.number().int().nonnegative(),
  hasWorkspaceLease: z.boolean(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  freshness: ManagedRunFreshnessSchema,
});

/**
 * A host capability whose stage has not shipped. Naming it explicitly is the
 * point: a caller that renders an absent capability as an empty or healthy
 * value tells an operator that something was checked when nothing was.
 */
export const ManagedRunUnavailableCapabilitySchema = z.object({
  available: z.literal(false),
  reasonCode: z.enum(["stage_not_enabled", "scope_not_requested", "backend_unsupported"]),
});

/** Run detail: the summary row plus the host records the run is bound to. */
export const ManagedRunDetailSchema = ManagedRunSummarySchema.extend({
  principalId: z.string().min(1),
  conversationRef: z.string().min(1),
  rootRunId: z.string().min(1),
  workspacePolicyHash: z.string().min(1),
  capturedCapabilityViewHash: z.string().min(1),
  capturedAgentCapabilities: z.array(z.string().min(1)),
  capturedToolIds: z.array(z.string().min(1)),
  workspaceLeaseId: z.string().min(1).optional(),
  executionAttachmentIds: z.array(z.string().min(1)),
  terminalSessionIds: z.array(z.string().min(1)),
  managedRunGroupId: z.string().min(1).optional(),
  terminalOutcome: z.object({
    kind: z.enum(["succeeded", "failed", "cancelled"]),
    recordedAtMs: z.number().int().nonnegative(),
  }).optional(),
  /** Present until execution custody ships; never rendered as "no operator holds custody". */
  custody: ManagedRunUnavailableCapabilitySchema,
  /** Present until run-attributed process observation ships. */
  processSummary: ManagedRunUnavailableCapabilitySchema,
});

/** Cross-run operator view. Absent filters mean every run this daemon holds. */
export const ManagedRunsListContract = defineContract({
  method: "managedRuns.list",
  request: z.object({
    serviceInstanceId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    status: ManagedRunStatusSchema.optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  response: z.object({
    rows: z.array(ManagedRunSummarySchema),
    total: z.number().int().nonnegative(),
    /** True when `limit` cut the result. A caller must not report a capped page as the complete set. */
    truncated: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

/** One run's durable authority record. */
export const ManagedRunsGetContract = defineContract({
  method: "managedRuns.get",
  request: z.object({ managedRunId: z.string().min(1) }),
  response: z.object({ run: ManagedRunDetailSchema.optional() }),
  scopes: ["admin"] as const,
});

/**
 * The one-call diagnosis. `likelyRootCause` is a deterministic verdict over the
 * same durable record the other methods return — no model, same input, same
 * answer — and `nextSafeActions` names only operations that are actually
 * reachable for the run's current state.
 */
export const ManagedRunsExplainContract = defineContract({
  method: "managedRuns.explain",
  request: z.object({ managedRunId: z.string().min(1) }),
  response: z.object({
    run: ManagedRunDetailSchema.optional(),
    likelyRootCause: z.object({
      code: z.enum([
        "awaiting_service_activation",
        "healthy",
        "liveness_stale",
        "policy_unresolved",
        "reduction_behind_reports",
        "run_not_found",
        "service_instance_absent",
        "terminal_outcome_recorded",
        "waiting_on_human",
      ]),
      /** Operator-facing sentence naming the exact knob or missing dependency. */
      hint: z.string().min(1),
    }),
    nextSafeActions: z.array(z.enum(["cancel", "inspect_service", "resolve_attention", "wait"])),
  }),
  scopes: ["admin"] as const,
});

/**
 * Cancel one run on host authority. The durable transition commits before the
 * service is told, so `serviceAcknowledged: false` still means cancelled — it
 * reports that the service has not confirmed yet, not that the cancel failed.
 */
export const ManagedRunsCancelContract = defineContract({
  method: "managedRuns.cancel",
  request: z.object({
    managedRunId: z.string().min(1),
    operationId: z.string().min(1),
    reason: z.enum(["owner_cancelled", "authority_revoked", "budget_exhausted"]).optional(),
  }),
  response: z.object({
    outcome: z.enum(["cancelled", "already_terminal", "not_found"]),
    status: ManagedRunStatusSchema.optional(),
    serviceAcknowledged: z.boolean().optional(),
    serviceReasonCode: z.string().min(1).optional(),
  }),
  scopes: ["admin"] as const,
});

export const MANAGED_RUNS_CONTRACTS = [
  ManagedRunsListContract,
  ManagedRunsGetContract,
  ManagedRunsExplainContract,
  ManagedRunsCancelContract,
] as const;
