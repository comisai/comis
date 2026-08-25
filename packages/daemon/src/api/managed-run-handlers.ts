// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — throws are converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Operator RPC over managed runs: `managedRuns.list|get|explain|cancel`.
 *
 * These are the platform half of diagnosing external work. The companion
 * product explains what its own task means; this explains whether the host
 * bound it correctly, whether its policy and capability snapshot resolved,
 * which host records it holds, and whether the service is still alive. An
 * operator who can only reach one of those halves is guessing.
 *
 * Nothing here returns a report body, a question, or an artifact. Those live in
 * the confined content store and reach a human through the owning product,
 * which is what keeps a support bundle safe to paste.
 *
 * @module
 */
import {
  ManagedRunsCancelContract,
  ManagedRunsExplainContract,
  ManagedRunsGetContract,
  ManagedRunsListContract,
  stripInternalFields,
  type ManagedRunAttentionRecord,
  type ManagedRunOwnerScope,
  type ManagedRunRecord,
} from "@comis/core";
import type { ManagedRunApiDeps, ManagedRunOperatorContext } from "./managed-run-context.js";
import type { RpcHandler } from "./types.js";

const DEFAULT_LIMIT = 100;
/** Custody and run-attributed process observation are a later stage; say so. */
const NOT_YET_SHIPPED = { available: false, reasonCode: "stage_not_enabled" } as const;


function requireContext(deps: ManagedRunApiDeps): ManagedRunOperatorContext {
  if (deps.managedRuns === undefined) {
    throw new Error("No capability service is configured, so no managed run exists to inspect");
  }
  return deps.managedRuns;
}

/**
 * Liveness is only meaningful when the owning definition asked for the health
 * scope. Reporting a service that never agreed to send beats as "stale" would
 * point an operator at a knob that does not exist for it.
 */
function livenessStale(context: ManagedRunOperatorContext, run: ManagedRunRecord): boolean {
  if (!context.definitionScopes(run.serviceInstanceId).includes("health")) return false;
  if (run.lastHeartbeatAtMs === undefined) return true;
  return context.nowMs() - run.lastHeartbeatAtMs > context.heartbeatMaxAgeMs;
}

function summary(context: ManagedRunOperatorContext, run: ManagedRunRecord) {
  return {
    schemaVersion: 1 as const,
    managedRunId: run.managedRunId,
    serviceInstanceId: run.serviceInstanceId,
    status: run.status,
    statusReason: run.statusReason,
    initiationSource: run.initiationSource,
    agentId: run.agentId,
    tenantId: run.tenantId,
    openAttentionCount: run.openAttentionCount,
    lastAcceptedReportSequence: run.lastAcceptedReportSequence,
    lastReducedReportSequence: run.lastReducedReportSequence,
    pendingContinuation: run.pendingContinuation,
    terminalSessionCount: run.terminalSessionIds.length,
    hasWorkspaceLease: run.workspaceLeaseId !== undefined,
    createdAtMs: run.createdAtMs,
    updatedAtMs: run.updatedAtMs,
    freshness: {
      capturedAtMs: context.nowMs(),
      stateSource: "durable_record" as const,
      ...(run.lastHeartbeatAtMs === undefined ? {} : { lastHeartbeatAtMs: run.lastHeartbeatAtMs }),
      livenessStale: livenessStale(context, run),
    },
  };
}

function detail(context: ManagedRunOperatorContext, run: ManagedRunRecord) {
  return {
    ...summary(context, run),
    principalId: run.principalId,
    conversationRef: run.conversationRef,
    rootRunId: run.rootRunId,
    workspacePolicyHash: run.workspacePolicyHash,
    capturedCapabilityViewHash: run.capturedCapabilityViewHash,
    capturedAgentCapabilities: [...run.capturedAgentCapabilities],
    capturedToolIds: [...run.capturedToolIds],
    ...(run.workspaceLeaseId === undefined ? {} : { workspaceLeaseId: run.workspaceLeaseId }),
    executionAttachmentIds: [...run.executionAttachmentIds],
    terminalSessionIds: [...run.terminalSessionIds],
    ...(run.managedRunGroupId === undefined ? {} : { managedRunGroupId: run.managedRunGroupId }),
    ...(run.terminalOutcome === undefined ? {} : { terminalOutcome: run.terminalOutcome }),
    custody: NOT_YET_SHIPPED,
    processSummary: NOT_YET_SHIPPED,
  };
}

/**
 * The owner scope a host-authority operation runs under. It is reconstructed
 * from the run's own durable record, never from the caller's request, so an
 * operator cannot address a run under a scope it does not actually belong to.
 */
function ownerScopeOf(run: ManagedRunRecord): ManagedRunOwnerScope {
  return {
    kind: "owner",
    tenantId: run.tenantId,
    agentId: run.agentId,
    principalId: run.principalId,
    conversationRef: run.conversationRef,
  };
}

interface Verdict {
  readonly code:
    | "awaiting_service_activation"
    | "healthy"
    | "liveness_stale"
    | "policy_unresolved"
    | "reduction_behind_reports"
    | "run_not_found"
    | "service_instance_absent"
    | "terminal_outcome_recorded"
    | "waiting_on_human";
  readonly hint: string;
  readonly nextSafeActions: readonly ("cancel" | "inspect_service" | "resolve_attention" | "wait")[];
}

/**
 * Deterministic, no model: the same record always produces the same verdict.
 * Ordering is deliberate — a configuration fault outranks a liveness gap, which
 * outranks a run merely waiting, because repairing the outer cause is what
 * makes the inner symptom go away.
 */
function diagnose(
  context: ManagedRunOperatorContext,
  run: ManagedRunRecord | undefined,
  attention: readonly ManagedRunAttentionRecord[],
): Verdict {
  if (run === undefined) {
    return {
      code: "run_not_found",
      hint: "No managed run carries that identifier in this daemon's store",
      nextSafeActions: [],
    };
  }
  const instance = context.instances.find(
    (candidate) => candidate.serviceInstanceId === run.serviceInstanceId,
  );
  if (instance === undefined) {
    return {
      code: "service_instance_absent",
      hint: `Run is bound to service instance ${run.serviceInstanceId}, which is not in the active capabilityServices.instances configuration`,
      nextSafeActions: ["cancel", "inspect_service"],
    };
  }
  if (run.terminalOutcome !== undefined) {
    return {
      code: "terminal_outcome_recorded",
      hint: `Run settled as ${run.terminalOutcome.kind}; nothing further is pending`,
      nextSafeActions: [],
    };
  }
  if (run.status === "preparing") {
    return {
      code: "awaiting_service_activation",
      hint: `Run is bound but service instance ${run.serviceInstanceId} has not acknowledged activation`,
      nextSafeActions: ["cancel", "inspect_service"],
    };
  }
  if (run.statusReason === "service_state_unavailable" && run.lastHeartbeatAtMs === undefined) {
    return {
      code: "policy_unresolved",
      hint: `Run reduced to unknown before any evidence resolved; check that service instance ${run.serviceInstanceId} is connected and reporting`,
      nextSafeActions: ["cancel", "inspect_service"],
    };
  }
  if (livenessStale(context, run)) {
    return {
      code: "liveness_stale",
      hint: `Service instance ${run.serviceInstanceId} declared the health scope but its last heartbeat is older than the configured bound`,
      nextSafeActions: ["cancel", "inspect_service"],
    };
  }
  if (run.openAttentionCount > 0 || attention.some((record) => record.status === "open")) {
    return {
      code: "waiting_on_human",
      hint: "Run is blocked on an unanswered question in its originating conversation",
      nextSafeActions: ["resolve_attention", "cancel", "wait"],
    };
  }
  if (run.lastReducedReportSequence < run.lastAcceptedReportSequence) {
    return {
      code: "reduction_behind_reports",
      hint: `Reports through ${run.lastAcceptedReportSequence} are accepted but only ${run.lastReducedReportSequence} are reduced; a continuation is still pending`,
      nextSafeActions: ["wait", "cancel"],
    };
  }
  return { code: "healthy", hint: "Run is active with current evidence", nextSafeActions: ["wait", "cancel"] };
}

/** Create the operator-only managed-run RPC handlers. */
export function createManagedRunHandlers(deps: ManagedRunApiDeps): Record<string, RpcHandler> {
  return {
    [ManagedRunsListContract.method]: async (rawParams) => {
      const context = requireContext(deps);
      const params = ManagedRunsListContract.request.parse(stripInternalFields(rawParams));
      const limit = params.limit ?? DEFAULT_LIMIT;
      const listed = await context.store.listForAdministration({
        kind: "administration",
        ...(params.serviceInstanceId === undefined ? {} : { serviceInstanceId: params.serviceInstanceId }),
        ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
        ...(params.status === undefined ? {} : { statuses: [params.status] }),
        limit,
      });
      if (!listed.ok) throw listed.error;
      return {
        rows: listed.value.map((run) => summary(context, run)),
        total: listed.value.length,
        truncated: listed.value.length >= limit,
      };
    },

    [ManagedRunsGetContract.method]: async (rawParams) => {
      const context = requireContext(deps);
      const params = ManagedRunsGetContract.request.parse(stripInternalFields(rawParams));
      const found = await findRun(context, params.managedRunId);
      return found === undefined ? {} : { run: detail(context, found) };
    },

    [ManagedRunsExplainContract.method]: async (rawParams) => {
      const context = requireContext(deps);
      const params = ManagedRunsExplainContract.request.parse(stripInternalFields(rawParams));
      const found = await findRun(context, params.managedRunId);
      const attention = found === undefined
        ? []
        : await context.store.listAttentionForAdministration({
          kind: "administration",
          managedRunId: found.managedRunId,
          limit: 50,
        }).then((result) => (result.ok ? result.value : []));
      const verdict = diagnose(context, found, attention);
      return {
        ...(found === undefined ? {} : { run: detail(context, found) }),
        likelyRootCause: { code: verdict.code, hint: verdict.hint },
        nextSafeActions: [...verdict.nextSafeActions],
      };
    },

    [ManagedRunsCancelContract.method]: async (rawParams) => {
      const context = requireContext(deps);
      const params = ManagedRunsCancelContract.request.parse(stripInternalFields(rawParams));
      const found = await findRun(context, params.managedRunId);
      if (found === undefined) return { outcome: "not_found" };
      const cancelled = await context.cancellation.cancel(ownerScopeOf(found), {
        operationId: params.operationId,
        managedRunId: params.managedRunId,
        reason: params.reason ?? "owner_cancelled",
      });
      if (!cancelled.ok) throw cancelled.error;
      const outcome = cancelled.value;
      if (outcome.kind === "not_found") return { outcome: "not_found" };
      if (outcome.kind === "already_terminal") {
        return { outcome: "already_terminal", status: outcome.status };
      }
      return {
        outcome: "cancelled",
        serviceAcknowledged: outcome.serviceAcknowledged,
        ...(outcome.serviceReasonCode === undefined
          ? {}
          : { serviceReasonCode: outcome.serviceReasonCode }),
      };
    },
  };
}

/**
 * Reads one run through the administration path so the operator surface never
 * has to guess an owner scope in order to look a run up by its identifier.
 */
async function findRun(
  context: ManagedRunOperatorContext,
  managedRunId: string,
): Promise<ManagedRunRecord | undefined> {
  const found = await context.store.getForAdministration({ kind: "administration", managedRunId });
  if (!found.ok) throw found.error;
  return found.value;
}
