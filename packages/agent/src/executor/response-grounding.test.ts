// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  enforceAgentUpdateNoOpGrounding,
  enforceOngoingWorkEvidence,
  enforceProviderModelFailureGrounding,
} from "./response-grounding.js";
import * as responseGrounding from "./response-grounding.js";

interface CompletionEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "unrecovered_tool_failure_completion_claim";
  correction?: "replaced" | "prefixed_partial";
}

interface SchedulerStateEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "missing_scheduler_state_evidence";
}

function schedulerStateEvidenceGuard(): (params: {
  response: string;
  toolExecResults?: readonly {
    toolName: string;
    action?: string;
    success: boolean;
  }[];
  honestResponse: string;
}) => SchedulerStateEvidenceGuardResult {
  const candidate = (responseGrounding as Record<string, unknown>)
    .enforceSchedulerStateEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as ReturnType<typeof schedulerStateEvidenceGuard>;
}

function completionEvidenceGuard(): (params: {
  response: string;
  unrecoveredToolFailures?: readonly string[];
  honestResponse: string;
  preservePartialResponse?: boolean;
}) => CompletionEvidenceGuardResult {
  const candidate = (responseGrounding as Record<string, unknown>)
    .enforceCompletionEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as ReturnType<typeof completionEvidenceGuard>;
}


describe("response grounding module", () => {
  it("rejects an already-set reminder claim without current scheduler evidence", () => {
    const honestResponse =
      "I did not verify the current reminder state in this turn, so I cannot say that it is set.";

    expect(schedulerStateEvidenceGuard()({
      response:
        "Got it—the reminder is already set for Thursday at 9:00 AM UTC.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_scheduler_state_evidence",
    });
  });

  it("keeps a reminder state claim grounded by a current cron receipt", () => {
    const response = "The reminder is set for Thursday at 9:00 AM UTC.";

    expect(schedulerStateEvidenceGuard()({
      response,
      toolExecResults: [{
        toolName: "cron",
        action: "list",
        success: true,
      }],
      honestResponse: "I could not verify the reminder.",
    })).toEqual({ response, corrected: false });
  });

  it("does not treat a removed cron receipt as proof that a reminder exists", () => {
    const honestResponse = "I could not verify the reminder.";

    expect(schedulerStateEvidenceGuard()({
      response: "Your reminder is already scheduled.",
      toolExecResults: [{
        toolName: "cron",
        action: "remove",
        success: true,
      }],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_scheduler_state_evidence",
    });
  });

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

  it("replaces a completion claim after an unrecovered tool failure", () => {
    const honestResponse =
      "I made changes, but I could not verify the request as complete because a tool step failed.";

    expect(completionEvidenceGuard()({
      response:
        "I found and fixed the implementation. The page now has working add and delete actions.",
      unrecoveredToolFailures: ["edit", "exec"],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "unrecovered_tool_failure_completion_claim",
      correction: "replaced",
    });
  });

  it("preserves a completion claim when every failed tool recovered", () => {
    const response = "I found and fixed the implementation.";

    expect(completionEvidenceGuard()({
      response,
      unrecoveredToolFailures: [],
      honestResponse: "The result is partial.",
    })).toEqual({ response, corrected: false });
  });

  it("preserves an honest failure when a tool remains unrecovered", () => {
    const response =
      "I changed the implementation, but validation failed and I could not verify the result.";

    expect(completionEvidenceGuard()({
      response,
      unrecoveredToolFailures: ["exec"],
      honestResponse: "The result is partial.",
    })).toEqual({ response, corrected: false });
  });

  it("keeps useful research beneath a runtime partial-result warning", () => {
    const response =
      "Research complete. The retrieved standards agree that storage is origin-scoped.";
    const honestResponse =
      "I could not verify the request as complete because one or more tool steps still failed. "
      + "Treat the result below as partial.";

    expect(completionEvidenceGuard()({
      response,
      unrecoveredToolFailures: ["web_fetch"],
      honestResponse,
      preservePartialResponse: true,
    })).toEqual({
      response: `${honestResponse}\n\n${response}`,
      corrected: true,
      reason: "unrecovered_tool_failure_completion_claim",
      correction: "prefixed_partial",
    });
  });

});
