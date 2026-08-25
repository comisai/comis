// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for the capability-service system-health slice.
 *
 * The slice is a pure fold over the durable managed-run status counts: it must
 * stay content-free (counts, closed reason codes, one opaque run id), cap the
 * reason codes deterministically, and omit itself when the window held no
 * managed-run activity at all.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import type { ManagedRunHealthCounts, ManagedRunStatus } from "@comis/core";
import { computeCapabilityServicesSlice } from "./system-capability-services.js";

function counts(overrides: Partial<ManagedRunHealthCounts> = {}): ManagedRunHealthCounts {
  const byStatus: Record<ManagedRunStatus, number> = {
    preparing: 0,
    active: 0,
    waiting: 0,
    paused: 0,
    candidate_complete: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    unknown: 0,
  };
  return {
    byStatus,
    degradedReasonCodes: {},
    distinctServiceInstances: 0,
    degradedServiceInstances: 0,
    ...overrides,
  };
}

describe("computeCapabilityServicesSlice", () => {
  it("returns undefined when no counts are available (store unwired / offline)", () => {
    expect(computeCapabilityServicesSlice(undefined)).toBeUndefined();
  });

  it("omits itself when the window held no managed-run activity", () => {
    expect(computeCapabilityServicesSlice(counts())).toBeUndefined();
  });

  it("folds degraded runs, rate, service counts and capped top reason codes", () => {
    const slice = computeCapabilityServicesSlice(counts({
      byStatus: {
        preparing: 0, active: 3, waiting: 1, paused: 0, candidate_complete: 0,
        succeeded: 4, failed: 2, cancelled: 1, unknown: 5,
      },
      degradedReasonCodes: {
        service_state_unavailable: 4,
        failure_verified: 2,
        required_evidence_stale: 1,
      },
      distinctServiceInstances: 4,
      degradedServiceInstances: 2,
      worstManagedRunId: "managed-run_worst",
    }));

    expect(slice).toBeDefined();
    if (slice === undefined) return;
    // total = 3+1+4+2+1+5 = 16; degraded = failed(2) + unknown(5) = 7.
    expect(slice.runs).toEqual({ total: 16, degraded: 7, degradedRate: 7 / 16 });
    expect(slice.services).toEqual({ total: 4, degraded: 2 });
    // Sorted count-desc, code-asc tiebreak, content-free closed reason codes.
    expect(slice.topReasonCodes).toEqual([
      { code: "service_state_unavailable", count: 4 },
      { code: "failure_verified", count: 2 },
      { code: "required_evidence_stale", count: 1 },
    ]);
    expect(slice.worstManagedRunId).toBe("managed-run_worst");
  });

  it("caps the reason codes and breaks ties on the code name", () => {
    const slice = computeCapabilityServicesSlice(counts({
      byStatus: {
        preparing: 0, active: 0, waiting: 0, paused: 0, candidate_complete: 0,
        succeeded: 0, failed: 6, cancelled: 0, unknown: 0,
      },
      degradedReasonCodes: {
        // Six distinct reasons, all count 1: only the first five (code-asc) survive the cap.
        activation_outcome_unknown: 1,
        failure_verified: 1,
        recovery_join_missing: 1,
        required_evidence_invalid: 1,
        required_evidence_stale: 1,
        service_state_unavailable: 1,
      },
      distinctServiceInstances: 1,
      degradedServiceInstances: 1,
    }));

    expect(slice?.topReasonCodes).toHaveLength(5);
    expect(slice?.topReasonCodes.map((entry) => entry.code)).toEqual([
      "activation_outcome_unknown",
      "failure_verified",
      "recovery_join_missing",
      "required_evidence_invalid",
      "required_evidence_stale",
    ]);
    expect(slice?.worstManagedRunId).toBeUndefined();
  });
});
