// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { resolveSubAgentOutcome } from "./sub-agent-outcome.js";

describe("resolveSubAgentOutcome", () => {
  it("reports completed when the model stopped cleanly and the contract is satisfied", () => {
    expect(resolveSubAgentOutcome({ modelStoppedCleanly: true, missingContractedOutputs: [] }))
      .toEqual({ success: true, reason: "completed", missingOutputs: [] });
  });

  // The live failure: a run stopped on its own after collecting every page of a
  // paginated report, wrote no file, and was still announced to the parent as
  // "completed". The parent then discarded it and started over.
  it("does not report completed when a contracted output is missing", () => {
    const outcome = resolveSubAgentOutcome({
      modelStoppedCleanly: true,
      missingContractedOutputs: ["reports/activity.xlsx"],
    });
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe("contract_unsatisfied");
    expect(outcome.missingOutputs).toEqual(["reports/activity.xlsx"]);
  });

  it("reports every missing path, not just the first", () => {
    const outcome = resolveSubAgentOutcome({
      modelStoppedCleanly: true,
      missingContractedOutputs: ["a.xlsx", "b.csv"],
    });
    expect(outcome.missingOutputs).toEqual(["a.xlsx", "b.csv"]);
  });

  // A halted model explains the missing files, so it stays the reported cause —
  // "contract_unsatisfied" would bury the actual reason the run stopped.
  it("keeps the model halt as the reason when the model did not stop cleanly", () => {
    const outcome = resolveSubAgentOutcome({
      modelStoppedCleanly: false,
      missingContractedOutputs: ["reports/activity.xlsx"],
    });
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe("model_halted");
  });

  it("reports a halted model even when no contract was declared", () => {
    expect(resolveSubAgentOutcome({ modelStoppedCleanly: false, missingContractedOutputs: [] }))
      .toEqual({ success: false, reason: "model_halted", missingOutputs: [] });
  });

  it("leaves a run with no declared contract unaffected", () => {
    // No expected_outputs ⇒ nothing to be missing ⇒ behaviour is unchanged.
    expect(resolveSubAgentOutcome({ modelStoppedCleanly: true, missingContractedOutputs: [] }).success)
      .toBe(true);
  });
});
