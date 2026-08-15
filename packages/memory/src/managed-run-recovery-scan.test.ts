// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { mapManagedRunRecoveryRows } from "./managed-run-recovery-scan.js";

describe("managed-run recovery row mapping", () => {
  it("quarantines invalid rows while preserving the stable cursor", () => {
    expect(mapManagedRunRecoveryRows([{
      managed_run_id: "managed-run_invalid",
      service_instance_id: "service-instance_a",
    }], 1)).toEqual({
      ok: true,
      value: {
        records: [],
        invalid: [{
          managedRunId: "managed-run_invalid",
          serviceInstanceId: "service-instance_a",
          reason: "record_validation_failed",
        }],
        nextAfterManagedRunId: "managed-run_invalid",
      },
    });
  });
});
