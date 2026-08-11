// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  CAPABILITY_SERVICE_CONTROL_PROTOCOL,
  emitObservationalEventSafely,
  type CapabilityServiceActivationPlan,
  type CapabilityServiceEvidencePolicy,
  type CapabilityServiceScope,
  type ComisLogger,
  type PlannedManagedToolBinding,
  type PlannedCapabilityServiceDefinition,
  type PlannedCapabilityServiceInstance,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

export interface CapabilityServiceHealthHandshake {
  readonly protocolId: typeof CAPABILITY_SERVICE_CONTROL_PROTOCOL;
  readonly serviceInstanceId: string;
  readonly activeScopes: readonly CapabilityServiceScope[];
}

export interface CapabilityServiceRuntimeHandle {
  start(): Promise<Result<CapabilityServiceHealthHandshake, Error>>;
  close(): Promise<Result<void, Error>>;
}

export interface CapabilityServiceRuntimeActivator {
  readonly serviceDefinitionId: string;
  construct(
    instance: PlannedCapabilityServiceInstance,
  ): Promise<Result<CapabilityServiceRuntimeHandle, Error>>;
}

export interface ActiveCapabilityServiceDefinition {
  readonly contributionId: string;
  readonly serviceDefinitionId: string;
  readonly mcpServerName: string;
  readonly managedToolBindings: readonly Readonly<PlannedManagedToolBinding>[];
  readonly requestedScopes: readonly CapabilityServiceScope[];
  readonly evidencePolicies: readonly Readonly<CapabilityServiceEvidencePolicy>[];
}

export type CapabilityServiceInstanceFailureReason = "health_mismatch" | "start_failed";

export type ActiveCapabilityServiceInstance = Readonly<{
  contributionId: string;
  serviceDefinitionId: string;
  serviceInstanceId: string;
  mcpServerName: string;
  allowedAgents: readonly string[];
  allowedWorkspaceRoots: readonly string[];
  allowedRuntimeRoots: readonly string[];
  state: "active" | "failed";
  activeScopes: readonly CapabilityServiceScope[];
  reasonCode?: CapabilityServiceInstanceFailureReason;
  cleanupFailed?: boolean;
}>;

export interface ActiveCapabilityServiceView {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly publishedAtMs: number;
  readonly viewHash: string;
  readonly definitions: readonly ActiveCapabilityServiceDefinition[];
  readonly instances: readonly ActiveCapabilityServiceInstance[];
}

interface CleanupFailure {
  readonly serviceInstanceId: string;
  readonly reasonCode: "close_failed";
}

export type CapabilityServiceRuntimeError =
  | { readonly kind: "activation_in_progress"; readonly cleanupFailures: readonly CleanupFailure[] }
  | { readonly kind: "duplicate_activator"; readonly serviceDefinitionId: string; readonly cleanupFailures: readonly CleanupFailure[] }
  | { readonly kind: "missing_activator"; readonly serviceDefinitionId: string; readonly cleanupFailures: readonly CleanupFailure[] }
  | { readonly kind: "construction_failed"; readonly serviceInstanceId: string; readonly cleanupFailures: readonly CleanupFailure[] }
  | { readonly kind: "shutdown_cleanup_failed"; readonly cleanupFailures: readonly CleanupFailure[] };

export interface CapabilityServiceRuntime {
  getActiveView(): ActiveCapabilityServiceView;
  replace(
    plan: CapabilityServiceActivationPlan,
  ): Promise<Result<ActiveCapabilityServiceView, CapabilityServiceRuntimeError>>;
  shutdown(): Promise<Result<void, CapabilityServiceRuntimeError>>;
}

export interface CapabilityServiceRuntimeDeps {
  readonly activators: readonly CapabilityServiceRuntimeActivator[];
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
  readonly nowMs: () => number;
}

interface OwnedRuntimeHandle {
  readonly instance: PlannedCapabilityServiceInstance;
  readonly handle: CapabilityServiceRuntimeHandle;
}

function viewHash(
  definitions: readonly ActiveCapabilityServiceDefinition[],
  instances: readonly ActiveCapabilityServiceInstance[],
): string {
  return createHash("sha256").update(JSON.stringify({ definitions, instances })).digest("hex");
}

function emptyView(revision: number, publishedAtMs: number): ActiveCapabilityServiceView {
  const definitions = Object.freeze([]) as readonly ActiveCapabilityServiceDefinition[];
  const instances = Object.freeze([]) as readonly ActiveCapabilityServiceInstance[];
  return Object.freeze({
    schemaVersion: 1,
    revision,
    publishedAtMs,
    viewHash: viewHash(definitions, instances),
    definitions,
    instances,
  });
}

async function invokeResult<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

function sameScopes(
  actual: readonly CapabilityServiceScope[],
  expected: readonly CapabilityServiceScope[],
): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function definitionView(
  definition: PlannedCapabilityServiceDefinition,
): ActiveCapabilityServiceDefinition {
  return Object.freeze({
    contributionId: definition.contributionId,
    serviceDefinitionId: definition.serviceDefinitionId,
    mcpServerName: definition.mcpServerName,
    managedToolBindings: Object.freeze(definition.managedToolBindings.map((binding) => Object.freeze({
      ...binding,
      invocationSideEffects: Object.freeze([...binding.invocationSideEffects]),
    }))),
    requestedScopes: Object.freeze([...definition.requestedScopes]),
    evidencePolicies: Object.freeze(definition.evidencePolicies.map((policy) => Object.freeze({
      ...policy,
    }))),
  });
}

function instanceView(
  instance: PlannedCapabilityServiceInstance,
  state: "active" | "failed",
  activeScopes: readonly CapabilityServiceScope[],
  failure?: {
    readonly reasonCode: CapabilityServiceInstanceFailureReason;
    readonly cleanupFailed: boolean;
  },
): ActiveCapabilityServiceInstance {
  return Object.freeze({
    contributionId: instance.contributionId,
    serviceDefinitionId: instance.serviceDefinitionId,
    serviceInstanceId: instance.serviceInstanceId,
    mcpServerName: instance.mcpServerName,
    allowedAgents: Object.freeze([...instance.allowedAgents]),
    allowedWorkspaceRoots: Object.freeze([...instance.allowedWorkspaceRoots]),
    allowedRuntimeRoots: Object.freeze([...instance.allowedRuntimeRoots]),
    state,
    activeScopes: Object.freeze([...activeScopes]),
    ...(failure === undefined ? {} : failure),
  });
}

/** Own linked service handles and atomically publish their content-free active view. */
export function createCapabilityServiceRuntime(
  deps: CapabilityServiceRuntimeDeps,
): CapabilityServiceRuntime {
  let activeView = emptyView(0, deps.nowMs());
  let activeHandles: readonly OwnedRuntimeHandle[] = Object.freeze([]);
  let replacementInProgress = false;

  async function cleanup(
    handles: readonly OwnedRuntimeHandle[],
  ): Promise<readonly CleanupFailure[]> {
    const failures: CleanupFailure[] = [];
    for (const owned of [...handles].reverse()) {
      const closed = await invokeResult(() => owned.handle.close());
      if (!closed.ok) {
        failures.push(Object.freeze({
          serviceInstanceId: owned.instance.serviceInstanceId,
          reasonCode: "close_failed" as const,
        }));
        deps.logger.error({
          serviceInstanceId: owned.instance.serviceInstanceId,
          errorKind: "dependency" as const,
          hint: "Inspect the configured capability service and release its instance resources before retrying activation",
        }, "Capability-service instance cleanup failed");
      }
    }
    return Object.freeze(failures);
  }

  function emitActivationFailure(
    startedAtMs: number,
    error: Exclude<CapabilityServiceRuntimeError, { kind: "shutdown_cleanup_failed" }>,
  ): void {
    const completedAtMs = deps.nowMs();
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "capability_service:activation_failed",
      {
        reasonCode: error.kind,
        ...(error.kind === "construction_failed"
          ? { serviceInstanceId: error.serviceInstanceId }
          : {}),
        cleanupFailureCount: error.cleanupFailures.length,
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        timestamp: completedAtMs,
      },
    );
  }

  async function replace(
    plan: CapabilityServiceActivationPlan,
  ): Promise<Result<ActiveCapabilityServiceView, CapabilityServiceRuntimeError>> {
    const startedAtMs = deps.nowMs();
    if (replacementInProgress) {
      const failure = {
        kind: "activation_in_progress" as const,
        cleanupFailures: Object.freeze([]) as readonly CleanupFailure[],
      };
      emitActivationFailure(startedAtMs, failure);
      return err(failure);
    }
    replacementInProgress = true;

    const activatorIds = new Set<string>();
    for (const activator of deps.activators) {
      if (activatorIds.has(activator.serviceDefinitionId)) {
        const failure = {
          kind: "duplicate_activator" as const,
          serviceDefinitionId: activator.serviceDefinitionId,
          cleanupFailures: Object.freeze([]) as readonly CleanupFailure[],
        };
        replacementInProgress = false;
        emitActivationFailure(startedAtMs, failure);
        return err(failure);
      }
      activatorIds.add(activator.serviceDefinitionId);
    }
    for (const definition of plan.orderedDefinitions) {
      if (!activatorIds.has(definition.serviceDefinitionId)) {
        const failure = {
          kind: "missing_activator" as const,
          serviceDefinitionId: definition.serviceDefinitionId,
          cleanupFailures: Object.freeze([]) as readonly CleanupFailure[],
        };
        replacementInProgress = false;
        emitActivationFailure(startedAtMs, failure);
        return err(failure);
      }
    }

    const candidateHandles: OwnedRuntimeHandle[] = [];
    for (const instance of plan.orderedInstances) {
      const activator = deps.activators.find(
        (candidate) => candidate.serviceDefinitionId === instance.serviceDefinitionId,
      );
      if (activator === undefined) continue;
      deps.logger.debug({
        step: "capability-service-construct",
        serviceDefinitionId: instance.serviceDefinitionId,
        serviceInstanceId: instance.serviceInstanceId,
      }, "Constructing capability-service instance");
      const constructed = await invokeResult(() => activator.construct(instance));
      if (!constructed.ok) {
        const cleanupFailures = await cleanup(candidateHandles);
        const failure = {
          kind: "construction_failed" as const,
          serviceInstanceId: instance.serviceInstanceId,
          cleanupFailures,
        };
        deps.logger.error({
          serviceDefinitionId: instance.serviceDefinitionId,
          serviceInstanceId: instance.serviceInstanceId,
          errorKind: "dependency" as const,
          hint: "Verify the linked activator and the instance control configuration before retrying capability-service activation",
        }, "Capability-service candidate construction failed");
        replacementInProgress = false;
        emitActivationFailure(startedAtMs, failure);
        return err(failure);
      }
      candidateHandles.push(Object.freeze({ instance, handle: constructed.value }));
    }

    const activeCandidateHandles: OwnedRuntimeHandle[] = [];
    const instanceViews: ActiveCapabilityServiceInstance[] = [];
    for (const owned of candidateHandles) {
      const definition = plan.orderedDefinitions.find(
        (candidate) => candidate.serviceDefinitionId === owned.instance.serviceDefinitionId,
      );
      if (definition === undefined) continue;
      deps.logger.debug({
        step: "capability-service-start",
        serviceDefinitionId: owned.instance.serviceDefinitionId,
        serviceInstanceId: owned.instance.serviceInstanceId,
      }, "Starting capability-service instance");
      const started = await invokeResult(() => owned.handle.start());
      const matched = started.ok
        && started.value.protocolId === CAPABILITY_SERVICE_CONTROL_PROTOCOL
        && started.value.serviceInstanceId === owned.instance.serviceInstanceId
        && sameScopes(started.value.activeScopes, definition.requestedScopes);
      if (!matched) {
        const reasonCode = started.ok ? "health_mismatch" : "start_failed";
        const cleanupFailures = await cleanup([owned]);
        instanceViews.push(instanceView(owned.instance, "failed", [], {
          reasonCode,
          cleanupFailed: cleanupFailures.length > 0,
        }));
        deps.logger.warn({
          serviceDefinitionId: owned.instance.serviceDefinitionId,
          serviceInstanceId: owned.instance.serviceInstanceId,
          reasonCode,
          errorKind: "dependency" as const,
          hint: "Inspect the configured service health endpoint and confirm its protocol identity, instance identity, and active scopes",
        }, "Capability-service instance failed to start");
        emitObservationalEventSafely(
          { eventBus: deps.eventBus, logger: deps.logger },
          "capability_service:instance_failed",
          {
            serviceInstanceId: owned.instance.serviceInstanceId,
            serviceDefinitionId: owned.instance.serviceDefinitionId,
            reasonCode,
            cleanupFailed: cleanupFailures.length > 0,
            timestamp: deps.nowMs(),
          },
        );
        continue;
      }
      activeCandidateHandles.push(owned);
      instanceViews.push(instanceView(owned.instance, "active", started.value.activeScopes));
    }

    const definitions = Object.freeze(plan.orderedDefinitions.map(definitionView));
    const instances = Object.freeze(instanceViews);
    const completedAtMs = deps.nowMs();
    const candidateView: ActiveCapabilityServiceView = Object.freeze({
      schemaVersion: 1,
      revision: activeView.revision + 1,
      publishedAtMs: completedAtMs,
      viewHash: viewHash(definitions, instances),
      definitions,
      instances,
    });
    const retiredHandles = activeHandles;
    activeView = candidateView;
    activeHandles = Object.freeze(activeCandidateHandles);

    const activeCount = instances.filter((instance) => instance.state === "active").length;
    const failedCount = instances.length - activeCount;
    const durationMs = Math.max(0, completedAtMs - startedAtMs);
    deps.logger.info({
      revision: candidateView.revision,
      viewHash: candidateView.viewHash,
      activeCount,
      failedCount,
      durationMs,
    }, "Capability-service active view published");
    deps.logger.audit({
      decision: "publish",
      revision: candidateView.revision,
      viewHash: candidateView.viewHash,
      activeCount,
      failedCount,
    }, "Capability-service activation published");
    emitObservationalEventSafely(
      { eventBus: deps.eventBus, logger: deps.logger },
      "capability_service:activation_completed",
      {
        revision: candidateView.revision,
        viewHash: candidateView.viewHash,
        activeCount,
        failedCount,
        durationMs,
        timestamp: completedAtMs,
      },
    );
    await cleanup(retiredHandles);
    replacementInProgress = false;
    return ok(candidateView);
  }

  async function shutdown(): Promise<Result<void, CapabilityServiceRuntimeError>> {
    const retiredHandles = activeHandles;
    activeHandles = Object.freeze([]);
    activeView = emptyView(activeView.revision + 1, deps.nowMs());
    const cleanupFailures = await cleanup(retiredHandles);
    return cleanupFailures.length === 0
      ? ok(undefined)
      : err({ kind: "shutdown_cleanup_failed", cleanupFailures });
  }

  return Object.freeze({
    getActiveView: () => activeView,
    replace,
    shutdown,
  });
}
