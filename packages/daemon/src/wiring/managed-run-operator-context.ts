// SPDX-License-Identifier: Apache-2.0
/**
 * Builds the read model the operator RPC group answers from.
 *
 * It reads the same activation plan and live active view the runtime publishes,
 * so an operator asking about an instance sees what the daemon actually
 * activated rather than what the configuration file asked for. A configured
 * instance the runtime never published is reported as `stopped`, and one it
 * published as failed keeps its failure reason — both are states an operator
 * has to act on, and omitting either would render a broken deployment as an
 * empty healthy one.
 *
 * @module
 */
import type { ClockPort } from "@comis/core";
import type {
  ManagedRunInstanceState,
  ManagedRunOperatorContext,
} from "../api/managed-run-context.js";
import type { CapabilityServicePlatform } from "./setup-capability-services.js";
import { definitionForInstance } from "./setup-capability-services.js";

/**
 * How stale a heartbeat may be before liveness counts as lost. One constant so
 * the reducer's verdict and the operator view's `livenessStale` flag can never
 * disagree about whether the same run is current.
 */
export const MANAGED_RUN_HEARTBEAT_MAX_AGE_MS = 300_000;

export interface ManagedRunOperatorContextDeps {
  readonly platform: CapabilityServicePlatform;
  readonly clock: ClockPort;
  readonly heartbeatMaxAgeMs: number;
}

/**
 * Undefined when the deployment configured no instance at all. The handlers
 * then say so explicitly rather than reporting an empty result, which would read
 * as "nothing is wrong" instead of "nothing is installed".
 */
export function buildManagedRunOperatorContext(
  deps: ManagedRunOperatorContextDeps,
): ManagedRunOperatorContext | undefined {
  const { platform } = deps;
  if (platform.plan.orderedInstances.length === 0) return undefined;
  return {
    store: platform.store,
    cancellation: platform.cancellationCoordinator,
    instances: platform.plan.orderedInstances,
    definitionScopes: (serviceInstanceId) => (
      definitionForInstance(platform.plan, serviceInstanceId)?.requestedScopes ?? []
    ),
    instanceState: (serviceInstanceId): ManagedRunInstanceState => {
      const published = platform.runtime.getActiveView().instances.find(
        (candidate) => candidate.serviceInstanceId === serviceInstanceId,
      );
      if (published === undefined) return { state: "stopped", reasonCodes: [] };
      return published.state === "failed"
        ? {
          state: "failed",
          reasonCodes: published.reasonCode === undefined ? [] : [published.reasonCode],
        }
        : { state: "active", reasonCodes: [] };
    },
    heartbeatMaxAgeMs: deps.heartbeatMaxAgeMs,
    nowMs: () => deps.clock.now(),
  };
}
