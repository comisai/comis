// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  isManagedRunTrajectoryEvent,
  translateManagedRunPayload,
} from "./translate-managed-run-payload.js";

describe("managed-run trajectory payload translation", () => {
  it("recognizes only the managed-run bridge event names", () => {
    expect(isManagedRunTrajectoryEvent("managed_run:attention_opened")).toBe(true);
    expect(isManagedRunTrajectoryEvent("managed_run:evidence_rejected")).toBe(true);
    expect(isManagedRunTrajectoryEvent("managed_run:revoked")).toBe(true);
    expect(isManagedRunTrajectoryEvent("tool:started")).toBe(false);
  });

  it("forwards content-free attention identity and drops the report body and timestamp", () => {
    for (const name of ["managed_run:attention_opened", "managed_run:attention_resolved"] as const) {
      const data = translateManagedRunPayload(name, {
        managedRunId: "run_a",
        serviceInstanceId: "svc_a",
        attentionId: "att_a",
        timestamp: 1,
        summary: "secret body",
      });
      expect(data).toEqual({ managedRunId: "run_a", serviceInstanceId: "svc_a", attentionId: "att_a" });
      expect(JSON.stringify(data)).not.toContain("secret body");
      expect(data).not.toHaveProperty("timestamp");
    }
  });

  it("forwards evidence acceptance facts without the evidence body", () => {
    const data = translateManagedRunPayload("managed_run:evidence_accepted", {
      managedRunId: "run_a",
      serviceInstanceId: "svc_a",
      evidenceRef: "ev_a",
      verificationLevel: "adapter_verified",
      deliveryKind: "reference",
      timestamp: 2,
      bodyBase64: "c2VjcmV0",
    });
    expect(data).toEqual({
      managedRunId: "run_a",
      serviceInstanceId: "svc_a",
      evidenceRef: "ev_a",
      verificationLevel: "adapter_verified",
      deliveryKind: "reference",
    });
    expect(JSON.stringify(data)).not.toContain("c2VjcmV0");
  });

  it("forwards the evidence rejection reason and omits absent identity", () => {
    const data = translateManagedRunPayload("managed_run:evidence_rejected", {
      reasonCode: "invalid_evidence",
      timestamp: 3,
    });
    expect(data).toEqual({ reasonCode: "invalid_evidence" });
  });

  it("forwards the revoked reason code content-free", () => {
    const data = translateManagedRunPayload("managed_run:revoked", {
      managedRunId: "run_a",
      serviceInstanceId: "svc_a",
      reasonCode: "authority_revoked",
      timestamp: 4,
    });
    expect(data).toEqual({
      managedRunId: "run_a",
      serviceInstanceId: "svc_a",
      reasonCode: "authority_revoked",
    });
  });
});
