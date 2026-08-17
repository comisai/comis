// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ManagedRunRecord, ManagedRunServiceScope } from "@comis/core";
import { decideManagedRunHeartbeat } from "./managed-run-liveness.js";

const SCOPE: ManagedRunServiceScope = { kind: "service", serviceInstanceId: "service-instance_a" };

function record(overrides: Partial<ManagedRunRecord> = {}): ManagedRunRecord {
  return {
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    status: "active",
    updatedAtMs: 1_800_000_000_000,
    lastHeartbeatAtMs: 1_800_000_000_000,
    ...overrides,
  } as ManagedRunRecord;
}

describe("managed-run heartbeat admissibility", () => {
  it("refuses an observation time that is not a whole non-negative instant", () => {
    // The wire schema already rejects these, and the daemon bridge bounds the
    // value against the host clock. This guard exists for a direct store caller
    // — a recovery path or a migration — so a malformed instant can never be
    // written into the field the reducer treats as proof of life.
    for (const observedAtMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      const decided = decideManagedRunHeartbeat(record(), SCOPE, {
        managedRunId: "managed-run_a",
        observedAtMs,
      });

      expect(decided.ok && decided.value).toEqual({
        kind: "rejected",
        reasonCode: "stale_observation",
      });
    }
  });

  it("refuses a beat for a run that does not exist", () => {
    const decided = decideManagedRunHeartbeat(undefined, SCOPE, {
      managedRunId: "managed-run_a",
      observedAtMs: 1_800_000_000_100,
    });

    expect(decided.ok && decided.value).toEqual({ kind: "rejected", reasonCode: "not_found" });
  });

  it("carries the record's own update time forward when a beat lands behind it", () => {
    // A beat proves the service is alive; it must not rewind the record's
    // update time, which other readers use to order state changes.
    const decided = decideManagedRunHeartbeat(
      record({ updatedAtMs: 1_800_000_000_900, lastHeartbeatAtMs: undefined }),
      SCOPE,
      { managedRunId: "managed-run_a", observedAtMs: 1_800_000_000_100 },
    );

    expect(decided.ok && decided.value.kind).toBe("committed");
    if (!decided.ok || decided.value.kind !== "committed") return;
    expect(decided.value.record.updatedAtMs).toBe(1_800_000_000_900);
    expect(decided.value.record.lastHeartbeatAtMs).toBe(1_800_000_000_100);
  });
});
