// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { isDeliveredFinishReason, resolveSubAgentOutcome } from "./sub-agent-outcome.js";

describe("resolveSubAgentOutcome", () => {
  it("reports completed when the model stopped cleanly and the contract is satisfied", () => {
    expect(resolveSubAgentOutcome({ modelDelivered: true, missingContractedOutputs: [] }))
      .toEqual({ success: true, reason: "completed", missingOutputs: [] });
  });

  // The live failure: a run stopped on its own after collecting every page of a
  // paginated report, wrote no file, and was still announced to the parent as
  // "completed". The parent then discarded it and started over.
  it("does not report completed when a contracted output is missing", () => {
    const outcome = resolveSubAgentOutcome({
      modelDelivered: true,
      missingContractedOutputs: ["reports/activity.xlsx"],
    });
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe("contract_unsatisfied");
    expect(outcome.missingOutputs).toEqual(["reports/activity.xlsx"]);
  });

  it("reports every missing path, not just the first", () => {
    const outcome = resolveSubAgentOutcome({
      modelDelivered: true,
      missingContractedOutputs: ["a.xlsx", "b.csv"],
    });
    expect(outcome.missingOutputs).toEqual(["a.xlsx", "b.csv"]);
  });

  // A halted model explains the missing files, so it stays the reported cause —
  // "contract_unsatisfied" would bury the actual reason the run stopped.
  it("keeps the model halt as the reason when the model did not stop cleanly", () => {
    const outcome = resolveSubAgentOutcome({
      modelDelivered: false,
      missingContractedOutputs: ["reports/activity.xlsx"],
    });
    expect(outcome.success).toBe(false);
    expect(outcome.reason).toBe("model_halted");
  });

  it("reports a halted model even when no contract was declared", () => {
    expect(resolveSubAgentOutcome({ modelDelivered: false, missingContractedOutputs: [] }))
      .toEqual({ success: false, reason: "model_halted", missingOutputs: [] });
  });

  it("leaves a run with no declared contract unaffected", () => {
    // No expected_outputs ⇒ nothing to be missing ⇒ behaviour is unchanged.
    expect(resolveSubAgentOutcome({ modelDelivered: true, missingContractedOutputs: [] }).success)
      .toBe(true);
  });
});

describe("isDeliveredFinishReason", () => {
  // Live incident: a sub-agent searched for used-car listings, hit bot
  // protection on 3 of many web_fetch calls across 21 turns, and returned a
  // complete answer naming the sources it could not verify. Its finish reason
  // was `completed_with_tool_errors`, which is not "stop"/"end_turn", so the
  // outcome resolved to `model_halted` and the parent announced
  // "Status: Failed" over a perfectly good result.
  it("treats a completed-with-tool-errors finish as delivered rather than halted", () => {
    expect(isDeliveredFinishReason("completed_with_tool_errors")).toBe(true);

    expect(resolveSubAgentOutcome({
      modelDelivered: isDeliveredFinishReason("completed_with_tool_errors"),
      missingContractedOutputs: [],
    })).toEqual({ success: true, reason: "completed", missingOutputs: [] });
  });

  it("accepts the two clean stops and nothing else", () => {
    expect(isDeliveredFinishReason("stop")).toBe(true);
    expect(isDeliveredFinishReason("end_turn")).toBe(true);
    // Genuine halts stay halts — the ceiling, the loop guard, and a hard error
    // all mean the model did NOT get to deliver.
    for (const halted of ["max_steps", "error", "context_exhausted", "loop_detected", "budget_exceeded"]) {
      expect(isDeliveredFinishReason(halted)).toBe(false);
    }
    expect(isDeliveredFinishReason(undefined)).toBe(false);
  });

  it("does not let a delivered finish paper over an unsatisfied output contract", () => {
    // The contract gate is independent: delivering prose is not writing the
    // files the child's own prompt promised.
    expect(resolveSubAgentOutcome({
      modelDelivered: isDeliveredFinishReason("completed_with_tool_errors"),
      missingContractedOutputs: ["report.xlsx"],
    })).toEqual({ success: false, reason: "contract_unsatisfied", missingOutputs: ["report.xlsx"] });
  });
});
