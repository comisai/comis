// SPDX-License-Identifier: Apache-2.0
/**
 * The read model both operator handler groups answer from.
 *
 * It lives outside either handler module because a handler file may not import
 * another handler file — that rule keeps one RPC group from quietly depending
 * on another's internals, and a shared type is exactly the seam that would
 * otherwise smuggle such a dependency in.
 *
 * @module
 */
import type {
  CapabilityServiceScope,
  ManagedRunStorePort,
  PlannedCapabilityServiceInstance,
} from "@comis/core";
import type { ManagedRunCancellationCoordinator } from "../wiring/managed-run-cancellation-coordinator.js";

export interface ManagedRunInstanceState {
  readonly state: "active" | "connected" | "degraded" | "failed" | "stopped";
  readonly reasonCodes: readonly string[];
}

export interface ManagedRunOperatorContext {
  readonly store: Pick<
    ManagedRunStorePort,
    "getForAdministration" | "listForAdministration" | "listAttentionForAdministration"
  >;
  readonly cancellation: ManagedRunCancellationCoordinator;
  readonly instances: readonly PlannedCapabilityServiceInstance[];
  readonly definitionScopes: (serviceInstanceId: string) => readonly CapabilityServiceScope[];
  readonly instanceState: (serviceInstanceId: string) => ManagedRunInstanceState;
  readonly heartbeatMaxAgeMs: number;
  readonly nowMs: () => number;
}

export type ManagedRunApiDeps = { readonly managedRuns?: ManagedRunOperatorContext };
