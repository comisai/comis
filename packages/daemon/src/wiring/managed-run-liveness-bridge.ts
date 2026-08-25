// SPDX-License-Identifier: Apache-2.0
import type { ClockPort, ManagedRunStorePort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

export interface ManagedRunLivenessInput {
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly observedAtMs: number;
}

export type ManagedRunLivenessOutcome =
  | {
    readonly kind: "accepted";
    readonly managedRunId: string;
    readonly acceptedAtMs: number;
    readonly lastHeartbeatAtMs: number;
  }
  | {
    readonly kind: "rejected";
    readonly reasonCode:
      | "not_found"
      | "observed_time_out_of_bounds"
      | "ownership_mismatch"
      | "stale_observation"
      | "terminal_run";
  };

export interface ManagedRunLivenessBridge {
  recordHeartbeat(input: ManagedRunLivenessInput): Promise<Result<ManagedRunLivenessOutcome, Error>>;
}

export interface ManagedRunLivenessBridgeDeps {
  readonly store: Pick<ManagedRunStorePort, "recordHeartbeat">;
  readonly clock: ClockPort;
}

/**
 * Records that a service still owns one run. The observation time is advisory:
 * it orders beats from one service, but a service clock running ahead of the
 * host cannot buy freshness, because a future-dated beat would both overstate
 * liveness now and refuse every honest later beat as stale.
 */
export function createManagedRunLivenessBridge(
  deps: ManagedRunLivenessBridgeDeps,
): ManagedRunLivenessBridge {
  return {
    async recordHeartbeat(input) {
      const acceptedAtMs = deps.clock.now();
      if (
        !Number.isInteger(input.observedAtMs)
        || input.observedAtMs < 0
        || input.observedAtMs > acceptedAtMs
      ) return ok({ kind: "rejected", reasonCode: "observed_time_out_of_bounds" });
      const invoked = tryCatch(() => deps.store.recordHeartbeat(
        { kind: "service", serviceInstanceId: input.serviceInstanceId },
        { managedRunId: input.managedRunId, observedAtMs: input.observedAtMs },
      ));
      if (!invoked.ok) return err(invoked.error);
      const settled = await fromPromise(invoked.value);
      if (!settled.ok) return err(settled.error);
      if (!settled.value.ok) return settled.value;
      const outcome = settled.value.value;
      if (outcome.kind === "rejected") {
        return ok({ kind: "rejected", reasonCode: outcome.reasonCode });
      }
      return ok({
        kind: "accepted",
        managedRunId: outcome.record.managedRunId,
        acceptedAtMs,
        lastHeartbeatAtMs: outcome.record.lastHeartbeatAtMs ?? input.observedAtMs,
      });
    },
  };
}
