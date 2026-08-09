// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ManagedRunReportIndex } from "./managed-run-content.js";
import {
  reduceManagedRunState,
  type ManagedRunReductionInput,
} from "./managed-run-reducer.js";

const NOW_MS = 1_800_000_000_000;

function makeReport(
  sequence: number,
  kind: ManagedRunReportIndex["kind"],
  receivedAtMs = NOW_MS - 1_000,
): ManagedRunReportIndex {
  return {
    schemaVersion: 1,
    serviceInstanceId: "service-instance_a",
    managedRunId: "managed-run_a",
    serviceReportId: `report_${sequence}`,
    sequence,
    kind,
    contentRef: `content_${sequence}`,
    contentHash: "a".repeat(64),
    receivedAtMs,
    retainedUntilMs: NOW_MS + 60_000,
  };
}

function makeInput(overrides: Partial<ManagedRunReductionInput> = {}): ManagedRunReductionInput {
  return {
    currentStatus: "active",
    currentStatusReason: "activation_acknowledged",
    openAttentionCount: 0,
    reports: [makeReport(1, "progress")],
    throughReportSequence: 1,
    lastHeartbeatAtMs: NOW_MS - 1_000,
    heartbeatMaxAgeMs: 10_000,
    heartbeatRequired: true,
    evidenceHealth: "available",
    verifiedOutcome: "none",
    deliveryState: "not_required",
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe("managed-run deterministic state reduction", () => {
  it("applies the fixed precedence from revocation through verified delivery", () => {
    const cases: readonly [string, ManagedRunReductionInput, string, string][] = [
      ["revocation", makeInput({
        currentStatus: "cancelled",
        currentStatusReason: "authority_revoked",
        verifiedOutcome: "failed",
        openAttentionCount: 1,
      }), "cancelled", "authority_revoked"],
      ["verified failure", makeInput({
        verifiedOutcome: "failed",
        openAttentionCount: 1,
      }), "failed", "failure_verified"],
      ["invalid evidence", makeInput({
        evidenceHealth: "malformed",
        openAttentionCount: 1,
      }), "unknown", "required_evidence_invalid"],
      ["open attention", makeInput({
        openAttentionCount: 1,
        reports: [makeReport(1, "paused")],
      }), "waiting", "attention_pending"],
      ["explicit pause", makeInput({
        reports: [makeReport(1, "paused")],
      }), "paused", "service_paused"],
      ["service activity", makeInput(), "active", "report_activity"],
      ["completion candidate", makeInput({
        reports: [makeReport(1, "candidate_complete")],
      }), "candidate_complete", "verification_pending"],
      ["verified delivery", makeInput({
        reports: [makeReport(1, "candidate_complete")],
        verifiedOutcome: "succeeded",
        deliveryState: "verified",
      }), "succeeded", "outcome_verified"],
    ];

    for (const [label, input, status, reason] of cases) {
      expect(reduceManagedRunState(input), label).toMatchObject({ status, statusReason: reason });
    }
  });

  it("fails closed when heartbeat evidence is stale unavailable or in the future", () => {
    expect(reduceManagedRunState(makeInput({
      lastHeartbeatAtMs: NOW_MS - 10_001,
    }))).toMatchObject({ status: "unknown", statusReason: "required_evidence_stale" });
    expect(reduceManagedRunState(makeInput({
      lastHeartbeatAtMs: undefined,
    }))).toMatchObject({ status: "unknown", statusReason: "service_state_unavailable" });
    expect(reduceManagedRunState(makeInput({
      lastHeartbeatAtMs: NOW_MS + 1,
    }))).toMatchObject({ status: "unknown", statusReason: "required_evidence_invalid" });
    expect(reduceManagedRunState(makeInput({
      lastHeartbeatAtMs: undefined,
      heartbeatRequired: false,
    }))).toMatchObject({ status: "active", statusReason: "report_activity" });
  });

  it("fails closed on conflicting unavailable or noncontiguous report evidence", () => {
    expect(reduceManagedRunState(makeInput({
      evidenceHealth: "conflicting",
    }))).toMatchObject({ status: "unknown", statusReason: "required_evidence_invalid" });
    expect(reduceManagedRunState(makeInput({
      evidenceHealth: "unavailable",
    }))).toMatchObject({ status: "unknown", statusReason: "service_state_unavailable" });
    expect(reduceManagedRunState(makeInput({
      reports: [makeReport(1, "progress"), makeReport(3, "paused")],
      throughReportSequence: 3,
    }))).toMatchObject({ status: "unknown", statusReason: "required_evidence_invalid" });
  });

  it("does not claim success until outcome and required delivery are both verified", () => {
    expect(reduceManagedRunState(makeInput({
      reports: [makeReport(1, "candidate_complete")],
      verifiedOutcome: "succeeded",
      deliveryState: "missing",
    }))).toMatchObject({ status: "unknown", statusReason: "service_state_unavailable" });
    expect(reduceManagedRunState(makeInput({
      reports: [],
      throughReportSequence: 0,
      heartbeatRequired: false,
    }))).toMatchObject({ status: "unknown", statusReason: "service_state_unavailable" });
  });
});
