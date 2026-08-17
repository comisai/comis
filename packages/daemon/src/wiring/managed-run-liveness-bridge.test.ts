// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ok, type Result } from "@comis/shared";
import type { ManagedRunHeartbeatInput, ManagedRunHeartbeatOutcome, ManagedRunRecord } from "@comis/core";
import { createManagedRunLivenessBridge } from "./managed-run-liveness-bridge.js";

function record(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    lastHeartbeatAtMs: 1_800_000_000_000,
    ...overrides,
  } as ManagedRunRecord;
}

function bridgeWith(
  outcome: ManagedRunHeartbeatOutcome,
  observed?: (input: ManagedRunHeartbeatInput) => void,
  nowMs = 1_800_000_000_500,
) {
  return createManagedRunLivenessBridge({
    store: {
      recordHeartbeat: (
        _scope,
        input,
      ): Promise<Result<ManagedRunHeartbeatOutcome, Error>> => {
        observed?.(input);
        return Promise.resolve(ok(outcome));
      },
    },
    clock: { now: () => nowMs },
  });
}

describe("managed-run liveness bridge", () => {
  it("accepts an advancing observation and answers with the host's own clock", async () => {
    const seen: ManagedRunHeartbeatInput[] = [];
    const bridge = bridgeWith(
      { kind: "committed", record: record({ lastHeartbeatAtMs: 1_800_000_000_400 }) },
      (input) => seen.push(input),
    );

    const result = await bridge.recordHeartbeat({
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      observedAtMs: 1_800_000_000_400,
    });

    expect(result.ok && result.value).toEqual({
      kind: "accepted",
      managedRunId: "managed-run_a",
      acceptedAtMs: 1_800_000_000_500,
      lastHeartbeatAtMs: 1_800_000_000_400,
    });
    expect(seen).toEqual([{
      managedRunId: "managed-run_a",
      observedAtMs: 1_800_000_000_400,
    }]);
  });

  it("refuses an observation dated after the host's own clock", async () => {
    // A service clock running ahead would otherwise buy itself freshness it has
    // not earned, and every later real beat would be refused as stale.
    const bridge = bridgeWith({ kind: "committed", record: record() });

    const result = await bridge.recordHeartbeat({
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      observedAtMs: 1_800_000_001_000,
    });

    expect(result.ok && result.value).toEqual({
      kind: "rejected",
      reasonCode: "observed_time_out_of_bounds",
    });
  });

  it("carries the store's refusal reason without inventing an outcome", async () => {
    for (const reasonCode of ["not_found", "ownership_mismatch", "terminal_run", "stale_observation"] as const) {
      const bridge = bridgeWith({ kind: "rejected", reasonCode });

      const result = await bridge.recordHeartbeat({
        serviceInstanceId: "service-instance_a",
        managedRunId: "managed-run_a",
        observedAtMs: 1_800_000_000_400,
      });

      expect(result.ok && result.value).toEqual({ kind: "rejected", reasonCode });
    }
  });
});
