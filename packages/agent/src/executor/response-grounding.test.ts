// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  enforceAgentUpdateNoOpGrounding,
  enforceOngoingWorkEvidence,
  enforceProviderModelFailureGrounding,
} from "./response-grounding.js";

describe("response grounding module", () => {
  it("uses the latest agent-update receipt as the no-op authority", () => {
    const honestResponse =
      "No configuration change was needed. This agent already uses provider_a / model_a.";

    expect(enforceAgentUpdateNoOpGrounding({
      response: "I can change models.",
      toolExecResults: [{
        toolName: "agents_manage",
        action: "update",
        success: true,
        changed: false,
      }],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "agent_update_noop_grounding",
    });
  });

  it("keeps provider rejection grounding beside no-op grounding", () => {
    expect(enforceProviderModelFailureGrounding({
      response: "The provider is a model.",
      toolExecResults: [{
        toolName: "agents_manage",
        action: "update",
        success: false,
        failureCode: "provider_requires_model",
      }],
      honestResponse: "An exact model is required.",
    }).corrected).toBe(true);
  });

  it("rejects terminal wait promises when no ongoing work exists", () => {
    const honestResponse =
      "I did not start ongoing work in this turn. A required step failed, so there is nothing running to wait for.";

    expect(enforceOngoingWorkEvidence({
      response:
        "I am attempting to check your account status now. Please hold on a moment.",
      toolExecResults: [
        { toolName: "message", success: false },
        { toolName: "process", success: true },
      ],
      ongoingWorkEvidence: false,
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_ongoing_work_evidence",
    });
  });

  it("preserves a wait promise backed by a background receipt", () => {
    const response = "I am working on that now. Please wait for the result.";

    expect(enforceOngoingWorkEvidence({
      response,
      toolExecResults: [
        { toolName: "exec", success: true, backgrounded: true },
      ],
      ongoingWorkEvidence: false,
      honestResponse: "No work is running.",
    })).toEqual({ response, corrected: false });
  });

  it("preserves an honest terminal failure without a wait promise", () => {
    const response = "The connection failed, so I did not complete the request.";

    expect(enforceOngoingWorkEvidence({
      response,
      toolExecResults: [{ toolName: "mcp_manage", success: false }],
      ongoingWorkEvidence: false,
      honestResponse: "No work is running.",
    })).toEqual({ response, corrected: false });
  });
});
