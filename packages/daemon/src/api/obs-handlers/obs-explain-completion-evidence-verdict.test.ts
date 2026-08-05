// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { completionEvidenceGuardVerdict } from "./obs-explain-completion-evidence-verdict.js";

describe("completionEvidenceGuardVerdict", () => {
  it("returns the acute verdict for a matching denied audit event", () => {
    const verdict = completionEvidenceGuardVerdict([
      {
        traceId: "trace-1",
        action: "response.completion_evidence_guard",
        outcome: "denied",
      },
    ], "trace-1");

    expect(verdict?.code).toBe("unverified_completion_claim");
    expect(verdict?.detail).toMatch(/unrecovered failure/iu);
  });

  it("ignores audit events from a different trace", () => {
    expect(completionEvidenceGuardVerdict([
      {
        traceId: "trace-2",
        action: "response.completion_evidence_guard",
        outcome: "denied",
      },
    ], "trace-1")).toBeNull();
  });

  it("ignores non-denied completion guard outcomes", () => {
    expect(completionEvidenceGuardVerdict([
      {
        traceId: "trace-1",
        action: "response.completion_evidence_guard",
        outcome: "success",
      },
    ], "trace-1")).toBeNull();
  });
});
