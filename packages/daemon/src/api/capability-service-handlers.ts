// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — throws are converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * Operator RPC over installed capability-service instances and the attention
 * records their runs raise: `capabilityServices.list|get`,
 * `managedAttention.list|get`.
 *
 * These answer the two questions the managed-run views cannot: which services
 * this deployment actually installed and whether each is usable, and which runs
 * are blocked on a human rather than on the machine.
 *
 * Instance rows carry no socket path, credential reference, or resolved secret.
 * An operator repairing a degraded instance needs its identity, its declared
 * scopes, and a closed reason code; the other fields would turn a support
 * bundle into a disclosure.
 *
 * @module
 */
import {
  CapabilityServicesGetContract,
  CapabilityServicesListContract,
  ManagedAttentionGetContract,
  ManagedAttentionListContract,
  stripInternalFields,
  type ManagedRunAttentionRecord,
  type ManagedRunRecord,
} from "@comis/core";
import type { ManagedRunOperatorContext } from "./managed-run-context.js";
import type { RpcHandler } from "./types.js";

const DEFAULT_LIMIT = 100;
const OPEN_STATUSES: ReadonlySet<ManagedRunAttentionRecord["status"]> = new Set([
  "open",
  "response_pending",
  "delivered",
]);
const SETTLED_STATUSES: ReadonlySet<ManagedRunAttentionRecord["status"]> = new Set([
  "cancelled",
  "expired",
  "resolved",
]);

export type CapabilityServiceApiDeps = { readonly managedRuns?: ManagedRunOperatorContext };

function requireContext(deps: CapabilityServiceApiDeps): ManagedRunOperatorContext {
  if (deps.managedRuns === undefined) {
    throw new Error("No capability service is configured in capabilityServices.instances");
  }
  return deps.managedRuns;
}

function attentionRow(record: ManagedRunAttentionRecord) {
  return {
    schemaVersion: 1 as const,
    attentionId: record.attentionId,
    managedRunId: record.managedRunId,
    status: record.status,
    ...(record.externalKey === undefined ? {} : { externalKey: record.externalKey }),
    createdAtMs: record.createdAtMs,
    // The record carries one update timestamp; it only means "settled at" once
    // the status is settled, so it is surfaced under that name only then rather
    // than presenting an ordinary update as a resolution.
    ...(SETTLED_STATUSES.has(record.status) ? { resolvedAtMs: record.updatedAtMs } : {}),
  };
}

/**
 * Counts the runs an operator would act on for one instance. `degraded` is the
 * number reduced to unknown, which is the only count that reliably means
 * something needs a human — an active run is doing its job.
 */
async function runCounts(
  context: ManagedRunOperatorContext,
  serviceInstanceId: string,
): Promise<{ active: number; degraded: number }> {
  const listed = await context.store.listForAdministration({
    kind: "administration",
    serviceInstanceId,
    limit: 10_000,
  });
  if (!listed.ok) throw listed.error;
  const open = listed.value.filter((run: ManagedRunRecord) => (
    run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled"
  ));
  return {
    active: open.length,
    degraded: open.filter((run) => run.status === "unknown").length,
  };
}

async function instanceSummary(context: ManagedRunOperatorContext, serviceInstanceId: string) {
  const instance = context.instances.find(
    (candidate) => candidate.serviceInstanceId === serviceInstanceId,
  );
  if (instance === undefined) return undefined;
  const state = context.instanceState(serviceInstanceId);
  const counts = await runCounts(context, serviceInstanceId);
  return {
    schemaVersion: 1 as const,
    serviceInstanceId: instance.serviceInstanceId,
    serviceDefinitionId: instance.serviceDefinitionId,
    enabled: instance.enabled,
    state: state.state,
    reasonCodes: [...state.reasonCodes],
    requestedScopes: [...context.definitionScopes(serviceInstanceId)],
    allowedAgents: [...instance.allowedAgents],
    mcpServerName: instance.mcpServerName,
    activeRunCount: counts.active,
    degradedRunCount: counts.degraded,
    capturedAtMs: context.nowMs(),
  };
}

/** Create the operator-only capability-service and attention RPC handlers. */
export function createCapabilityServiceHandlers(
  deps: CapabilityServiceApiDeps,
): Record<string, RpcHandler> {
  return {
    [CapabilityServicesListContract.method]: async (rawParams) => {
      const context = requireContext(deps);
      CapabilityServicesListContract.request.parse(stripInternalFields(rawParams));
      const rows = [];
      for (const instance of context.instances) {
        const row = await instanceSummary(context, instance.serviceInstanceId);
        if (row !== undefined) rows.push(row);
      }
      return { rows, total: rows.length };
    },

    [CapabilityServicesGetContract.method]: async (rawParams) => {
      const context = requireContext(deps);
      const params = CapabilityServicesGetContract.request.parse(stripInternalFields(rawParams));
      const row = await instanceSummary(context, params.serviceInstanceId);
      if (row === undefined) return {};
      const instance = context.instances.find(
        (candidate) => candidate.serviceInstanceId === params.serviceInstanceId,
      );
      return {
        instance: {
          ...row,
          allowedWorkspaceRoots: [...(instance?.allowedWorkspaceRoots ?? [])],
          allowedRuntimeRoots: [...(instance?.allowedRuntimeRoots ?? [])],
          livenessRequired: row.requestedScopes.includes("health"),
        },
      };
    },

    [ManagedAttentionListContract.method]: async (rawParams) => {
      const context = requireContext(deps);
      const params = ManagedAttentionListContract.request.parse(stripInternalFields(rawParams));
      const limit = params.limit ?? DEFAULT_LIMIT;
      const listed = await context.store.listAttentionForAdministration({
        kind: "administration",
        ...(params.managedRunId === undefined ? {} : { managedRunId: params.managedRunId }),
        limit,
      });
      if (!listed.ok) throw listed.error;
      return {
        rows: listed.value.map(attentionRow),
        total: listed.value.length,
        truncated: listed.value.length >= limit,
      };
    },

    [ManagedAttentionGetContract.method]: async (rawParams) => {
      const context = requireContext(deps);
      const params = ManagedAttentionGetContract.request.parse(stripInternalFields(rawParams));
      // The administration read is the only scope-free path, and it is keyed by
      // run rather than by attention id, so a single lookup filters the page.
      const listed = await context.store.listAttentionForAdministration({
        kind: "administration",
        limit: 10_000,
      });
      if (!listed.ok) throw listed.error;
      const found = listed.value.find((record) => record.attentionId === params.attentionId);
      return found === undefined ? {} : { attention: attentionRow(found) };
    },
  };
}

/** Whether an attention record still awaits a human. Exported for the cross-run views. */
export function isOpenAttention(record: ManagedRunAttentionRecord): boolean {
  return OPEN_STATUSES.has(record.status);
}
