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
  reason?: "missing_scheduler_state_evidence" | "pending_scheduler_confirmation";
}

interface RuntimeSelfReportEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "missing_runtime_self_report_evidence" | "unsupported_runtime_self_report_evidence";
}

function runtimeSelfReportEvidenceGuard(): (params: {
  request: string;
  response: string;
  toolExecResults?: readonly {
    toolName: string;
    success: boolean;
    observabilityEvidenceLimits?: {
      cost?: "runtime_estimate";
      providerInvoice?: "unverified";
      crossExecutionDurationRanking?: "unavailable";
    };
  }[];
  honestResponse: string;
  unsupportedResponse?: string;
}) => RuntimeSelfReportEvidenceGuardResult {
  const candidate = (responseGrounding as Record<string, unknown>)
    .enforceRuntimeSelfReportEvidence;
  expect(candidate).toBeTypeOf("function");
  return candidate as ReturnType<typeof runtimeSelfReportEvidenceGuard>;
}

function schedulerStateEvidenceGuard(): (params: {
  response: string;
  toolExecResults?: readonly {
    toolName: string;
    action?: string;
    success: boolean;
    requiresConfirmation?: boolean;
    schedulerPolicyEvidence?: readonly ("holiday" | "weekday" | "weekend")[];
  }[];
  honestResponse: string;
  pendingConfirmationResponse?: string;
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
  it("rejects a weekly runtime-work report without current observability evidence", () => {
    const honestResponse =
      "I could not verify my runtime activity for that period in this turn.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "what did you even do this week",
      response:
        "This week I set up a schedule, checked its history, and answered a few messages.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_runtime_self_report_evidence",
    });
  });

  it("keeps a runtime self-report grounded by a current obs_query receipt", () => {
    const response = "The current report shows 45 sessions and 1,228 model calls.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "what did you even do this week",
      response,
      toolExecResults: [{ toolName: "obs_query", success: true }],
      honestResponse: "I could not verify runtime activity.",
    })).toEqual({ response, corrected: false });
  });

  it("does not treat a failed observability query as self-report evidence", () => {
    const honestResponse = "I could not verify runtime cost in this turn.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "how much have you cost me",
      response: "I cost about five dollars.",
      toolExecResults: [{ toolName: "obs_query", success: false }],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_runtime_self_report_evidence",
    });
  });

  it("requires observability for the elliptical latency follow-up", () => {
    const honestResponse = "I could not verify the runtime cause in this turn.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "why was that so slow",
      response: "It was slow because the context was large.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_runtime_self_report_evidence",
    });
  });

  it("requires observability for durable-job restart chronology", () => {
    const honestResponse =
      "I could not verify whether the durable job resumed across the restart.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "resume the durable synthetic job after the restart",
      response:
        "The durable job completed before the restart, so there is nothing to resume.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_runtime_self_report_evidence",
    });
  });

  it("requires duration-ranking evidence for a slowest-execution claim", () => {
    const honestResponse = "I could not verify which execution was slowest.";
    const unsupportedResponse = "The current report does not rank execution duration.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "why was the slowest bit slow?",
      response: "The slowest bit was the failed TTS sub-agent path.",
      toolExecResults: [{
        toolName: "obs_query",
        success: true,
        observabilityEvidenceLimits: {
          crossExecutionDurationRanking: "unavailable",
        },
      }],
      honestResponse,
      unsupportedResponse,
    })).toEqual({
      response: unsupportedResponse,
      corrected: true,
      reason: "unsupported_runtime_self_report_evidence",
    });
  });

  it("recognizes the direct slowest-execution question as a runtime self-report", () => {
    const honestResponse = "I could not verify which execution was slowest.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "why was the slowest bit slow?",
      response: "The slowest bit was the failed TTS sub-agent path.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_runtime_self_report_evidence",
    });
  });

  it("requires runtime-estimate and provider-invoice qualification for cost claims", () => {
    const honestResponse = "I could not verify provider-billed cost.";
    const unsupportedResponse = "The runtime estimate is not a verified provider invoice.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "how much have you cost me?",
      response: "I have cost $5.00.",
      toolExecResults: [{
        toolName: "obs_query",
        success: true,
        observabilityEvidenceLimits: {
          cost: "runtime_estimate",
          providerInvoice: "unverified",
        },
      }],
      honestResponse,
      unsupportedResponse,
    })).toEqual({
      response: unsupportedResponse,
      corrected: true,
      reason: "unsupported_runtime_self_report_evidence",
    });
  });

  it("keeps a qualified runtime cost estimate", () => {
    const response =
      "The runtime estimate is $5.00; I cannot verify the provider invoice.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "how much have you cost me?",
      response,
      toolExecResults: [{
        toolName: "obs_query",
        success: true,
        observabilityEvidenceLimits: {
          cost: "runtime_estimate",
          providerInvoice: "unverified",
        },
      }],
      honestResponse: "I could not verify provider-billed cost.",
    })).toEqual({ response, corrected: false });
  });

  it.each([
    "so it was exactly $5 total because telegram was down, right?",
    "pretty sure you only did 12 turns and cost 3 cents this week — confirm?",
    "the slowness was definitely the telegram 429 and the whole week cost $1, yeah?",
  ])("requires observability before confirming a runtime premise: %s", (request) => {
    const honestResponse = "I could not verify that runtime premise in this turn.";

    expect(runtimeSelfReportEvidenceGuard()({
      request,
      response: "Yes, that is correct.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_runtime_self_report_evidence",
    });
  });

  it("leaves unrelated reports outside the runtime self-report guard", () => {
    const response = "The weekly project report has three sections.";

    expect(runtimeSelfReportEvidenceGuard()({
      request: "what did the project report cover this week",
      response,
      toolExecResults: [],
      honestResponse: "I could not verify runtime activity.",
    })).toEqual({ response, corrected: false });
  });

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

  it("rejects a listed holiday policy absent from the current scheduler receipt", () => {
    const honestResponse = "I could not verify that holiday policy in the current job.";

    expect(schedulerStateEvidenceGuard()({
      response: "The Saturday briefing skips U.S. federal holidays.",
      toolExecResults: [{
        toolName: "cron",
        action: "list",
        success: true,
        schedulerPolicyEvidence: [],
      }],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_scheduler_state_evidence",
    });
  });

  it("keeps a listed holiday policy present in the current scheduler receipt", () => {
    const response = "The Saturday briefing skips U.S. federal holidays.";

    expect(schedulerStateEvidenceGuard()({
      response,
      toolExecResults: [{
        toolName: "cron",
        action: "list",
        success: true,
        schedulerPolicyEvidence: ["holiday"],
      }],
      honestResponse: "I could not verify that holiday policy.",
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

  it("replaces a pending cron removal overclaim with a neutral confirmation request", () => {
    const pendingConfirmationResponse =
      "Please confirm that you want me to remove the scheduled job. Nothing has been removed yet.";

    expect(schedulerStateEvidenceGuard()({
      response:
        "The reminder is set. Please confirm that you want me to remove it.",
      toolExecResults: [{
        toolName: "cron",
        action: "remove",
        success: true,
        requiresConfirmation: true,
      }],
      honestResponse: "I could not verify the reminder.",
      pendingConfirmationResponse,
    })).toEqual({
      response: pendingConfirmationResponse,
      corrected: true,
      reason: "pending_scheduler_confirmation",
    });
  });

  it("rejects a future recurring-job policy claim inherited from conversation history", () => {
    const honestResponse = "I did not verify the scheduled job in this turn.";

    expect(schedulerStateEvidenceGuard()({
      response:
        "Confirmed: U.S. federal holidays. The Saturday briefing will skip them.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_scheduler_state_evidence",
    });
  });

  it("rejects a confirmed recurring-job policy stated in the present tense", () => {
    const honestResponse = "I did not verify the scheduled job in this turn.";

    expect(schedulerStateEvidenceGuard()({
      response: "Confirmed: the briefing skips U.S. federal holidays.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_scheduler_state_evidence",
    });
  });

  it("rejects an unverified recurring policy phrased with a present participle", () => {
    const honestResponse = "I did not verify the scheduled job in this turn.";

    expect(schedulerStateEvidenceGuard()({
      response:
        "Yes, weekly planning is every Saturday at 7:00 AM ET, skipping U.S. federal holidays.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_scheduler_state_evidence",
    });
  });

  it("rejects a bare temporal policy confirmation inherited from scheduling context", () => {
    const honestResponse = "I did not verify the scheduled job in this turn.";

    expect(schedulerStateEvidenceGuard()({
      response: "Confirmed: U.S. federal holidays.",
      toolExecResults: [],
      honestResponse,
    })).toEqual({
      response: honestResponse,
      corrected: true,
      reason: "missing_scheduler_state_evidence",
    });
  });

  it("does not classify an ordinary remembered weekday correction as scheduler state", () => {
    const response = "Updated — your test runs are Wednesday mornings now.";

    expect(schedulerStateEvidenceGuard()({
      response,
      toolExecResults: [],
      honestResponse: "I could not verify a scheduled job.",
    })).toEqual({ response, corrected: false });
  });

  it("does not classify an ordinary promise to omit prose as scheduler state", () => {
    const response = "I will skip that section in the draft.";

    expect(schedulerStateEvidenceGuard()({
      response,
      toolExecResults: [],
      honestResponse: "I could not verify the scheduled job.",
    })).toEqual({ response, corrected: false });
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
